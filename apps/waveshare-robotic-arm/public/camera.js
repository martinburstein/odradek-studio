const REFRESH_MS = 5000;

function safeCameraPath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let url;
  try { url = new URL(value, window.location.href); } catch { throw new TypeError("Camera URL is invalid"); }
  const localDevelopment = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash) throw new TypeError("Camera URL cannot contain credentials, query parameters, or fragments");
  if (url.origin !== window.location.origin || !(window.location.protocol === "https:" || localDevelopment)) throw new TypeError("Camera must use this authenticated same-origin HTTPS application");
  if (!url.pathname.startsWith("/camera/") || url.pathname.includes("..") || url.pathname.includes("\\")) throw new TypeError("Camera endpoint must be under /camera/");
  return `${url.pathname}${url.pathname.endsWith("/") ? "snapshot" : ""}`;
}

/** Mount a snapshot-only camera panel. No webcam permission or cross-origin stream is requested. */
export function mountCamera(container, { url = null } = {}) {
  if (!container || typeof container.replaceChildren !== "function") throw new TypeError("container must be a DOM element");
  const panel = document.createElement("div");
  panel.className = "camera-view";
  panel.setAttribute("aria-label", "Camera observation");
  const state = document.createElement("p");
  state.className = "camera-view-state";
  state.setAttribute("role", "status");
  state.setAttribute("aria-live", "polite");
  const image = document.createElement("img");
  image.alt = "Live camera snapshot";
  image.hidden = true;
  const time = document.createElement("p");
  time.className = "camera-view-time";
  time.textContent = "No image received";
  panel.append(state, image, time);
  container.replaceChildren(panel);

  let endpoint = null;
  let timer = null;
  let destroyed = false;
  let generation = 0;
  const setState = (text) => { state.textContent = text; };
  const stopRefresh = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const refresh = () => {
    stopRefresh();
    if (destroyed || document.hidden || !endpoint) return;
    const requestId = ++generation;
    setState("Loading camera image…");
    image.hidden = true;
    const separator = endpoint.includes("?") ? "&" : "?";
    image.src = `${endpoint}${separator}_snapshot=${Date.now()}`;
    image.onload = () => {
      if (destroyed || requestId !== generation) return;
      image.hidden = false;
      time.textContent = `Image received ${new Date().toLocaleTimeString()}`;
      setState("Camera available · snapshot loaded");
      timer = setTimeout(refresh, REFRESH_MS);
    };
    image.onerror = () => {
      if (destroyed || requestId !== generation) return;
      image.hidden = true;
      setState("Camera unavailable · image could not be loaded");
      timer = setTimeout(refresh, REFRESH_MS);
    };
  };
  const onVisibility = () => {
    if (document.hidden) { stopRefresh(); generation++; }
    else refresh();
  };
  document.addEventListener("visibilitychange", onVisibility);

  function setUrl(nextUrl) {
    stopRefresh(); generation++;
    image.removeAttribute("src"); image.hidden = true;
    time.textContent = "No image received";
    try { endpoint = safeCameraPath(nextUrl); }
    catch (error) { endpoint = null; setState(`Camera URL rejected · ${error.message}`); return; }
    if (!endpoint) { setState("Camera unavailable · no source configured"); return; }
    setState("Camera configured · waiting for snapshot");
    refresh();
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true; stopRefresh(); generation++;
    document.removeEventListener("visibilitychange", onVisibility);
    image.removeAttribute("src");
    panel.remove();
  }
  setUrl(url);
  return { setUrl, destroy };
}
