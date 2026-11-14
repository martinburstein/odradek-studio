"""Local-only webcam preview and fresh snapshots; never accesses the robot.

Requires the existing imageio_ffmpeg Python package. Frames stay in memory.
Run: python tools/webcam.py --device "SD webcam 5160"
"""
import argparse
import datetime
import json
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import imageio_ffmpeg


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", default="SD webcam 5160")
    parser.add_argument("--input-format", choices=["mjpeg", "yuyv422", "nv12"], default="mjpeg")
    parser.add_argument("--capture-fps", type=int, choices=[5, 10, 15, 30], default=15,
                        help="Latest in-memory frame rate; browser preview stays at 5 fps")
    parser.add_argument("--port", type=int, default=8788)
    args = parser.parse_args()
    lock = threading.Lock()
    state = {"frame": None, "sequence": 0, "at": None, "mono": 0, "error": None}
    stopped = threading.Event()
    process = subprocess.Popen([
        imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "warning",
        "-f", "dshow", "-video_size", "1280x720", "-framerate", "30",
        *(["-vcodec", "mjpeg"] if args.input_format == "mjpeg" else ["-pixel_format", args.input_format]),
        "-i", "video=" + args.device,
        "-an", "-vf", f"fps={args.capture_fps}", "-c:v", "mjpeg", "-q:v", "4",
        "-f", "image2pipe", "pipe:1",
    ], stdout=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)

    def read_frames():
        pending = bytearray()
        try:
            while not stopped.is_set():
                chunk = process.stdout.read1(65536)
                if not chunk:
                    raise RuntimeError("Webcam capture ended; close other camera apps and restart this service")
                pending.extend(chunk)
                while True:
                    start = pending.find(b"\xff\xd8")
                    end = pending.find(b"\xff\xd9", max(start, 0) + 2)
                    if start < 0 or end < 0:
                        break
                    frame = bytes(pending[start:end + 2])
                    del pending[:end + 2]
                    with lock:
                        state.update(frame=frame, sequence=state["sequence"] + 1,
                                     at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                     mono=time.monotonic(), error=None)
                if len(pending) > 2 * 1024 * 1024:
                    raise RuntimeError("Camera frame exceeded the size bound")
        except Exception as exc:
            with lock:
                state.update(frame=None, error=str(exc))
        finally:
            if process.poll() is None:
                process.terminate()

    threading.Thread(target=read_frames, daemon=True).start()
    origins = {f"http://127.0.0.1:{args.port}", f"http://localhost:{args.port}"}
    hosts = {f"127.0.0.1:{args.port}", f"localhost:{args.port}"}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def send(self, status, body, content_type="application/json", headers=None):
            self.send_response(status)
            for key, value in {"Content-Type": content_type, "Content-Length": str(len(body)),
                               "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                               "Cross-Origin-Resource-Policy": "same-origin",
                               "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
                               **(headers or {})}.items():
                self.send_header(key, value)
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def allowed(self):
            return (self.headers.get("Host") in hosts
                    and self.headers.get("Origin") in origins | {None}
                    and self.headers.get("Sec-Fetch-Site") in {None, "same-origin", "none"})

        def do_GET(self):
            if not self.allowed():
                return self.send(403, b'{"error":"Local same-origin access only"}')
            route = urlsplit(self.path).path
            with lock:
                current = dict(state)
            age = time.monotonic() - current["mono"]
            fresh = current["frame"] is not None and age <= 2
            if route == "/status":
                return self.send(200, json.dumps({"device": args.device, "requestedResolution": [1280, 720],
                    "previewFps": 5, "captureFps": args.capture_fps,
                    "fresh": fresh, "sequence": current["sequence"],
                    "receivedAt": current["at"], "frameAgeMs": round(age * 1000) if current["frame"] else None,
                    "error": current["error"], "robotAccess": False}).encode())
            if route == "/snapshot":
                if not fresh:
                    return self.send(503, b'{"error":"No fresh camera frame"}')
                return self.send(200, current["frame"], "image/jpeg", {
                    "X-Frame-Sequence": str(current["sequence"]), "X-Frame-Received-At": current["at"]})
            if route == "/":
                html = """<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Arm camera</title><style>body{margin:0;background:#000;color:#eee;font:12px system-ui}
main{height:100dvh;position:relative}h1,main>p:not(#status){display:none}
img{width:100%;height:100%;object-fit:contain;background:#000}
button,#status{position:absolute;bottom:8px;margin:0;padding:5px 9px;background:#000a;color:#ddd;border:0;border-radius:3px}
button{right:8px;opacity:0}main:hover button,button:focus-visible{opacity:1}#status{left:8px;font-size:10px}</style><main><h1>Arm camera</h1>
<p>Local preview · 1280 × 720 · 5 frames/second · No robot controls</p>
<img id="frame" alt="Waiting for a fresh webcam frame"><p id="status">Connecting…</p>
<button id="stop">Stop camera</button><p>Images stay in memory unless a snapshot is explicitly saved.
Codex can inspect requested snapshots; it does not continuously watch this preview.</p></main>
<script>let active=true;const frame=document.getElementById('frame'),status=document.getElementById('status');
async function refresh(){if(!active)return;try{const r=await fetch('/status',{cache:'no-store'});const s=await r.json();
if(s.fresh){frame.src='/snapshot?t='+s.sequence;status.textContent='Live · frame '+s.sequence+' · '+new Date(s.receivedAt).toLocaleTimeString();}
else{frame.removeAttribute('src');status.textContent=s.error||'Waiting for the camera — close Windows Camera if it is open.';}}
catch(e){frame.removeAttribute('src');status.textContent='Camera service unavailable';}if(active)setTimeout(refresh,200);}
document.getElementById('stop').onclick=async()=>{active=false;await fetch('/shutdown',{method:'POST'});frame.removeAttribute('src');status.textContent='Camera stopped';};refresh();</script></html>"""
                return self.send(200, html.encode(), "text/html; charset=utf-8")
            self.send(404, b'{"error":"Not found"}')

        def do_POST(self):
            if not self.allowed():
                return self.send(403, b'{"error":"Local same-origin access only"}')
            if self.path != "/shutdown":
                return self.send(404, b'{"error":"Not found"}')
            self.send(200, b'{"stopped":true}')
            threading.Thread(target=self.server.shutdown, daemon=True).start()

    server = None
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
        print(json.dumps({"preview": f"http://127.0.0.1:{args.port}", "device": args.device}), flush=True)
        server.serve_forever(poll_interval=0.2)
    finally:
        stopped.set()
        if server:
            server.server_close()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        process.stdout.close()


if __name__ == "__main__":
    main()
