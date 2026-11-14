import { mountWireArm } from './wire-arm.js';

const timeLabel = (value) => {
  if (!value) return "No update received";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Update time unavailable" : date.toLocaleString();
};

const escapeText = (value) => String(value ?? "—");
const element = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
};

/** Mount an observation-only robot check-in view. The host owns polling and authentication. */
export function mountCheckin(container, { api } = {}) {
  if (!container || typeof container.replaceChildren !== "function") throw new TypeError("container must be a DOM element");
  const root = document.createElement("section");
  root.className = "checkin";
  root.setAttribute("aria-label", "Robot check-in");
  const header = element("header", "checkin-header");
  const brand = element("div");
  brand.append(element("p", "checkin-kicker", "PERSONAL CHECK-IN"), element("h1", "", "RoArm-M2"));
  const presence = element("span", "checkin-presence", "Waiting for status");
  presence.dataset.presence = "";
  presence.setAttribute("role", "status");
  presence.setAttribute("aria-live", "polite");
  header.append(brand, presence);
  const updated = element("p", "checkin-updated", "Last telemetry: waiting"); updated.dataset.updated = "";

  const grid = element("div", "checkin-grid");
  const taskCard = element("article", "checkin-card checkin-task");
  taskCard.append(element("h2", "", "Current task"));
  const taskName = element("p", "checkin-task-name", "—"); taskName.dataset.task = "";
  const progressText = element("p", "", "Progress unavailable"); progressText.dataset.progress = "";
  const progress = element("div", "checkin-progress"); progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-label", "Task progress"); progress.setAttribute("aria-valuemin", "0"); progress.setAttribute("aria-valuemax", "100");
  const bar = element("span"); bar.dataset.bar = ""; progress.append(bar);
  taskCard.append(taskName, progressText, progress);

  const stateCard = element("article", "checkin-card"); stateCard.append(element("h2", "", "Robot state"));
  const details = element("dl");
  for (const [label, key, initial] of [["Connection", "connection", "Unknown"], ["Armed", "armed", "Unknown"], ["Access", "access", "Session status unavailable"], ["Pairing", "pairing", "Pairing status unavailable"]]) {
    const row = element("div"); row.append(element("dt", "", label));
    const value = element("dd", "", initial); value.dataset[key] = ""; row.append(value); details.append(row);
  }
  const error = element("p", "checkin-error"); error.dataset.error = ""; error.hidden = true;
  stateCard.append(details, error);

  const cameraCard = element("article", "checkin-card checkin-camera");
  const cameraHeader = element("div", "checkin-card-head"); cameraHeader.append(element("h2", "", "Camera"));
  const cameraState = element("span", "", "Not configured"); cameraState.dataset.cameraState = ""; cameraHeader.append(cameraState);
  const cameraSlot = element("div", "checkin-camera-slot"); cameraSlot.dataset.camera = "";
  cameraSlot.append(element("p", "", "Camera feed unavailable"), element("small", "", "A camera must be configured and verified by the host application."));
  cameraCard.append(cameraHeader, cameraSlot);

  const historyCard = element("article", "checkin-card checkin-history"); historyCard.append(element("h2", "", "Recent actions"));
  const history = element("ol"); history.dataset.history = ""; history.append(element("li", "", "No recent actions reported")); historyCard.append(history);
  grid.append(taskCard, stateCard, cameraCard, historyCard);
  const wireSlot = element('div');
  const wireArm = mountWireArm(wireSlot);
  root.append(header, updated, wireSlot, grid, element("p", "checkin-boundary", "Observation view · no motion controls. Status and history reflect reports from the authenticated host."));
  container.replaceChildren(root);
  let cameraHandle = null;
  let mountedCameraUrl = Symbol("not-mounted");
  let destroyed = false;
  const put = (selector, value) => { const el = root.querySelector(selector); if (el) el.textContent = escapeText(value); };

  function update(status = {}) {
    if (destroyed) return;
    if (!status || typeof status !== "object" || Array.isArray(status)) status = {};
    wireArm.update(status);
    const observed = Date.parse(status.telemetryUpdatedAt || "");
    const age = Date.now() - observed;
    const freshness = !status.connected || status.freshness === "offline" || (Number.isFinite(age) && age > 15000)
      ? "offline"
      : status.stale || status.freshness === "stale" || !Number.isFinite(observed) || age < 0 || age > 5000
        ? "stale"
        : "live";
    const presence = root.querySelector("[data-presence]");
    presence.textContent = freshness === "live" ? "Live" : freshness === "stale" ? "Stale" : "Offline";
    presence.dataset.state = ["live", "stale", "offline"].includes(freshness) ? freshness : "offline";
    put("[data-updated]", `Last telemetry: ${timeLabel(status.telemetryUpdatedAt)}`);
    const taskActive = status.task?.active === true || status.zLift?.active === true;
    put("[data-task]", status.zLift?.active ? "Supervised 2 mm lift" : taskActive ? (status.task?.name || "Active task") : "No active task");
    const numeric = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
    const done = numeric(status.task?.progress) ? Number(status.task.progress) : null;
    const total = numeric(status.task?.total) ? Number(status.task.total) : null;
    const percent = numeric(status.task?.progressPercent) ? Number(status.task.progressPercent) : done !== null && total !== null && total > 0 ? done / total * 100 : null;
    const validProgress = taskActive && percent !== null ? Math.max(0, Math.min(100, percent)) : null;
    const progressLabel = validProgress === null ? (taskActive ? "Progress not reported" : "No task in progress") : `${Math.round(validProgress)}% complete${done !== null && total !== null ? ` (${Math.max(0, done)} of ${Math.max(0, total)} steps)` : ""}`;
    put("[data-progress]", progressLabel);
    const bar = root.querySelector("[data-bar]");
    const progressBar = root.querySelector("[role=progressbar]");
    progressBar.hidden = !taskActive;
    bar.style.width = `${validProgress ?? 0}%`;
    if (validProgress === null) progressBar.removeAttribute("aria-valuenow");
    else progressBar.setAttribute("aria-valuenow", String(Math.round(validProgress)));
    progressBar.setAttribute("aria-valuetext", progressLabel);
    put("[data-connection]", status.connectionLabel || (status.connected ? `Connected · ${status.mode || "mode unknown"}` : "Disconnected"));
    put("[data-armed]", status.zLift?.active ? "One supervised lift active" : typeof status.armed === "boolean" ? (status.armed ? "Armed" : "Disarmed") : "Unknown");
    const session = status.session || api?.session || {};
    const role = status.role || session.role;
    const locality = session.proxied === true ? " · private remote session" : session.local === true ? " · local session" : "";
    const access = role === "observer" ? `Observer · observation only${locality}` : role === "control" ? `Control role · this view stays read-only${locality}` : role === "admin" ? `Administrator session · this view stays read-only${locality}` : "Authenticated session status unavailable";
    put("[data-access]", status.accessLabel || access);
    const paired = typeof status.paired === "boolean" ? status.paired : typeof session.paired === "boolean" ? session.paired : null;
    const pairing = typeof status.pairingStatus === "string" ? status.pairingStatus : paired === true ? "Paired device session" : paired === false ? "Not paired" : role === "admin" ? "Not applicable · administrator session" : "Pairing status unavailable";
    put("[data-pairing]", pairing);
    const error = root.querySelector("[data-error]");
    error.hidden = !status.error;
    error.textContent = status.error ? "An error was reported. Open the authenticated host for available details." : "";
    const history = root.querySelector("[data-history]");
    history.replaceChildren();
    const entries = Array.isArray(status.history) ? status.history.slice(-6).reverse() : [];
    if (!entries.length) history.append(element("li", "", "No recent actions reported"));
    for (const entry of entries) {
      const li = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = escapeText(entry.name || entry.action || entry.outcome || "Action");
      const detail = document.createElement("span");
      detail.textContent = `${entry.outcome ? `${entry.outcome} · ` : ""}${timeLabel(entry.at || entry.timestamp)}`;
      li.append(title, detail); history.append(li);
    }
    const cameraUrl = status.camera?.configured === true && typeof status.camera.url === "string" ? status.camera.url : null;
    if (api?.camera?.mount && !cameraHandle) {
      try {
        cameraHandle = api.camera.mount(root.querySelector("[data-camera]"), { url: cameraUrl });
        mountedCameraUrl = cameraUrl;
        put("[data-camera-state]", cameraUrl ? "Configured · feed not verified" : "Unavailable · not configured");
      } catch { put("[data-camera-state]", "Unavailable"); }
    } else if (cameraHandle?.setUrl && mountedCameraUrl !== cameraUrl) {
      cameraHandle.setUrl(cameraUrl);
      mountedCameraUrl = cameraUrl;
      put("[data-camera-state]", cameraUrl ? "Configured · feed not verified" : "Unavailable · not configured");
    }
  }

  function destroy() {
    destroyed = true;
    if (cameraHandle?.destroy) cameraHandle.destroy();
    wireArm.destroy();
    root.remove();
  }
  return { update, destroy };
}
