"""Finite stdin camera comparisons. Images stay in memory; no robot access."""
import argparse
import importlib.util
import json
from pathlib import Path
import queue
import sys
import threading
import time

spec = importlib.util.spec_from_file_location('camera_metrics', Path(__file__).with_name('live-perception-observer.py'))
metrics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metrics)


class CameraComparison:
    def __init__(self, capture=metrics.read_frame, now=time.time, monotonic=time.monotonic, sleep=time.sleep, tracking_method="median"):
        if tracking_method not in ("median", "affine"):
            raise ValueError("Unknown image tracking method")
        self.tracking_method = tracking_method
        self.capture = capture
        self.now = now
        self.monotonic = monotonic
        self.sleep = sleep
        self.reference = None
        self.metadata = None
        self.initial_reference = None
        self.initial_metadata = None
        self.last_sequence = None

    def fresh_capture(self):
        requested_at = self.now()
        deadline = self.monotonic()+1.0
        while self.monotonic() < deadline:
            image, metadata = self.capture(self.last_sequence)
            if self.monotonic() >= deadline:
                break
            self.last_sequence = metadata['sequence']
            if metrics.timestamp(metadata['frameReceivedAt']) >= requested_at:
                return image, metadata
            self.sleep(.005)
        raise ValueError('No newly received camera frame within capture deadline')

    def set_reference(self):
        image, metadata = self.fresh_capture()
        self.reference = image.copy()
        self.metadata = dict(metadata)
        if self.initial_reference is None:
            self.initial_reference = image.copy()
            self.initial_metadata = dict(metadata)
        self.last_sequence = metadata['sequence']
        return {'reference': self.metadata, 'initialReference': self.initial_metadata,
                'initialTipTracking': metrics.tracked_motion(self.initial_reference, image, metrics.TIP_ROI, include_affine=self.tracking_method == 'affine'),
                'imagesSaved': False}

    def compare(self):
        if self.reference is None:
            raise ValueError('Capture a reference before comparison')
        image, metadata = self.fresh_capture()
        if metadata['sequence'] <= self.metadata['sequence']:
            raise ValueError('Comparison requires a newer camera frame')
        interval = (metrics.timestamp(metadata['frameReceivedAt'])-metrics.timestamp(self.metadata['frameReceivedAt']))*1000
        if interval <= 0 or interval > 300000:
            raise ValueError('Comparison interval is invalid')
        self.last_sequence = metadata['sequence']
        result = {'reference': self.metadata, 'current': metadata, 'frameIntervalMs': interval,
                'imageRegion': metrics.FOREARM_ROI, 'processingSize': [640, 360],
                'change': metrics.motion_metrics(self.reference, image, metrics.FOREARM_ROI),
                'tracking': metrics.tracked_motion(self.reference, image, metrics.FOREARM_ROI),
                'tipRegion': metrics.TIP_ROI,
                'tipTracking': metrics.tracked_motion(self.reference, image, metrics.TIP_ROI, include_affine=self.tracking_method == 'affine'),
                'initialReference': self.initial_metadata,
                'initialTipTracking': metrics.tracked_motion(self.initial_reference, image, metrics.TIP_ROI, include_affine=self.tracking_method == 'affine'),
                'referenceAdvanced': True, 'imagesSaved': False, 'scope': 'Image displacement only; no calibrated joint pose, obstacle clearance, physical stop or supervision inference.'}
        self.reference = image.copy()
        self.metadata = dict(metadata)
        return result

    def close(self):
        self.reference = None
        self.metadata = None
        self.initial_reference = None
        self.initial_metadata = None


def run(seconds, tracking_method="median"):
    if not 1 <= seconds <= 300:
        raise ValueError('Camera comparison duration must be 1–300 seconds')
    metrics.cv2.setNumThreads(1)
    inbox = queue.Queue(maxsize=4)
    def read_input():
        while True:
            line = sys.stdin.readline(4097)
            try:
                inbox.put(line, timeout=1)
            except queue.Full:
                return
            if not line or len(line) > 4096:
                return
    threading.Thread(target=read_input, daemon=True).start()
    deadline = time.monotonic()+seconds
    camera = CameraComparison(tracking_method=tracking_method)
    def emit(value):
        print(json.dumps(value, allow_nan=False), flush=True)
    emit({'event': 'ready', 'imagesSaved': False, 'hardwareAccess': False, 'trackingMethod': tracking_method})
    try:
        while time.monotonic() < deadline:
            try:
                line = inbox.get(timeout=max(.001, deadline-time.monotonic()))
            except queue.Empty:
                break
            if not line:
                break
            request = None
            try:
                if len(line) > 4096:
                    raise ValueError('Camera request too large')
                request = json.loads(line)
                if not isinstance(request, dict) or set(request) != {'id', 'action'} or not isinstance(request['id'], str) or not 1 <= len(request['id']) <= 64 or request['action'] not in ('reference', 'compare', 'close'):
                    raise ValueError('Invalid camera request')
                if request['action'] == 'close':
                    emit({'id': request['id'], 'ok': True, 'result': {'closed': True}})
                    return 0
                result = camera.set_reference() if request['action'] == 'reference' else camera.compare()
                if time.monotonic() >= deadline:
                    raise ValueError('Camera comparison deadline expired')
                emit({'id': request['id'], 'ok': True, 'result': result})
            except Exception as error:
                emit({'id': request.get('id') if isinstance(request, dict) else None, 'ok': False, 'error': str(error)[:300]})
                return 1
        emit({'event': 'closed', 'reason': 'input ended or finite deadline reached'})
        return 0
    finally:
        camera.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=int, required=True)
    parser.add_argument('--tracking-method', choices=('median', 'affine'), default='median')
    args = parser.parse_args()
    raise SystemExit(run(args.seconds, args.tracking_method))
