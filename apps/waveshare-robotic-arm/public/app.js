import { renderArm } from "./arm.js";
import {createExperience} from './session-ui.js';
import {createPoller} from './connectivity.js';
import {createZLiftPanel} from './z-lift.js';

const byId = (id) => document.getElementById(id);
const ui = {
  message: byId("app-message"),
  mode: byId("connection-mode"),
  connectionForm: byId("connection-form"),
  serialFields: byId("serial-fields"),
  httpFields: byId("http-fields"),
  ownerForm: byId("owner-form"),
  ownerName: byId("owner-name"),
  commissionForm: byId("commission-form"),
  calibrationForm: byId("calibration-form"),
  motionForm: byId("motion-form"),
  motionKind: byId("motion-kind"),
  jointFields: byId("joint-target-fields"),
  cartesianFields: byId("cartesian-target-fields"),
  poseForm: byId("pose-form"),
  gripperForm: byId("gripper-form"),
  arm: byId("arm-visualization"),
};

let status = null;
let apiOnline = false;
let actionBusy = false;
let stopBusy = false;
let pollInFlight = false;
let sequenceSteps = [];
let lastFetchAt = null;
let session=null;
const experience=createExperience({request,onMessage:setMessage,onClearMessage:message=>{if(ui.message.textContent===message)setMessage("");},onSession:next=>{session=next;syncControls();}});
const liftPanel=createZLiftPanel({request,perform,owner:requireOwner});

function setMessage(message, tone = "info") {
  ui.message.textContent = message;
  ui.message.className = `app-message tone-${tone}`;
  ui.message.hidden = !message;
}

async function request(path, body, signal) {
  const options = { method: body === undefined ? "GET" : "POST", credentials: "same-origin", headers: {} };
  const deadline=AbortSignal.timeout(path==='/api/task'?Math.min(65000,Number(body?.maxDurationMs??60000)+5000):body===undefined?5000:12000);
  options.signal=signal?AbortSignal.any([signal,deadline]):deadline;
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error(`API returned a malformed response (${response.status})`); }
  if (!response.ok) throw new Error(payload?.error || `API request failed (${response.status})`);
  return payload;
}

function finiteInput(id, label) {
  const input = byId(id);
  const value = Number(input.value);
  if (input.value.trim() === "" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function jointTarget() {
  return {
    base: finiteInput("target-base", "Base yaw"),
    shoulder: finiteInput("target-shoulder", "Shoulder"),
    elbow: finiteInput("target-elbow", "Elbow"),
    gripper: finiteInput("target-gripper", "Gripper"),
  };
}

function cartesianTarget() {
  return {
    x: finiteInput("target-x", "X"),
    y: finiteInput("target-y", "Y"),
    z: finiteInput("target-z", "Z"),
    t: finiteInput("target-t", "Tool angle"),
  };
}

function currentTarget() {
  const kind = ui.motionKind.value;
  return { kind, target: kind === "joints" ? jointTarget() : cartesianTarget() };
}

function ownerIsCurrent() {
  const owner = ui.ownerName.value.trim();
  return Boolean(owner && status?.owner === owner && status?.ownership?.ownedByThisDevice && session && session.role!=='observer');
}

function telemetryAgeMs() {
  if (!status?.telemetryUpdatedAt) return Infinity;
  const time = Date.parse(status.telemetryUpdatedAt);
  return Number.isFinite(time) ? Date.now() - time : Infinity;
}

function physicalFeedbackFresh() {
  const age = telemetryAgeMs();
  return status?.mode === "serial" && Boolean(status.measured) && age >= 0 && age <= 5000;
}

function hasFreshPose() {
  if (status?.mode === "simulator") return Boolean(status.simulated && telemetryAgeMs() >= 0 && telemetryAgeMs() <= 5000);
  return physicalFeedbackFresh();
}

function motionAllowed() {
  if (!apiOnline || actionBusy || !status?.connected || !status.armed || !status.commissioned || !ownerIsCurrent()) return false;
  if (status.task?.active || status.execution?.busy || status.execution?.lifecycle || status.execution?.cleanupPending || status.execution?.outstandingTransportOperations) return false;
  if (!hasFreshPose()) return false;
  if (status.mode !== "simulator" && ui.motionKind.value === "cartesian") return false;
  return true;
}

function sequenceAllowed() {
  if (!apiOnline || actionBusy || !sequenceSteps.length || sequenceSteps.length > 20 || !status?.connected || !status.armed || !status.commissioned || !ownerIsCurrent()) return false;
  return status.mode === "simulator" || (physicalFeedbackFresh() && sequenceSteps.every((step) => step.kind === "joints"));
}

function setChip(id, text, stateClass = "") {
  const node = byId(id);
  node.textContent = text;
  node.className = `state-chip ${stateClass}`.trim();
}

function shortTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function renderPoses(poses) {
  const list = byId("pose-list");
  list.replaceChildren();
  if (!Array.isArray(poses) || !poses.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No saved poses.";
    list.append(empty);
    return;
  }
  for (const saved of poses.slice(0, 50)) {
    const row = document.createElement("div");
    row.className = "pose-row";
    const name = document.createElement("div");
    name.className = "pose-name";
    const title = document.createElement("strong");
    title.textContent = String(saved?.name || "Unnamed pose");
    const subtitle = document.createElement("span");
    const joints = saved?.joints ?? saved?.pose ?? saved;
    subtitle.textContent = joints && Number.isFinite(joints.base) && Number.isFinite(joints.shoulder)
      ? `B ${joints.base.toFixed(2)} · S ${joints.shoulder.toFixed(2)} · E ${Number(joints.elbow).toFixed(2)} · G ${Number(joints.gripper).toFixed(2)} rad`
      : "Target unavailable";
    name.append(title, subtitle);
    const use = document.createElement("button");
    use.type = "button";
    use.className = "secondary compact-button";
    use.textContent = "Use target";
    use.setAttribute("aria-label", `Load ${title.textContent} into joint target fields; this does not move the arm`);
    use.disabled = !joints || !["base", "shoulder", "elbow", "gripper"].every((key) => Number.isFinite(joints[key]));
    use.addEventListener("click", () => {
      ui.motionKind.value = "joints";
      toggleTargetFields();
      for (const key of ["base", "shoulder", "elbow", "gripper"]) byId(`target-${key}`).value = joints[key];
      setMessage(`${title.textContent} copied into joint target fields. No command was sent.`, "info");
      syncControls();
    });
    row.append(name, use);
    list.append(row);
  }
}

function renderHistory(events) {
  const body = byId("history-body");
  body.replaceChildren();
  const recent = Array.isArray(events) ? events.slice(-40).reverse() : [];
  byId("history-count").textContent = `${Array.isArray(events) ? events.length : 0} EVENTS`;
  if (!recent.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "empty-state";
    cell.textContent = "No activity recorded yet.";
    row.append(cell);
    body.append(row);
    return;
  }
  for (const item of recent) {
    const row = document.createElement("tr");
    for (const value of [shortTime(item?.at), item?.kind || "event", item?.outcome || "unknown", item?.evidenceClass || "uncertain", item?.mode || "—"]) {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      row.append(cell);
    }
    body.append(row);
  }
}

function renderSequence() {
  const list = byId("sequence-list");
  list.replaceChildren();
  if (!sequenceSteps.length) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = "No steps queued.";
    list.append(empty);
  } else {
    sequenceSteps.forEach((step, index) => {
      const row = document.createElement("li");
      const summary = document.createElement("span");
      const values = Object.entries(step.target).map(([key, value]) => `${key} ${value}`).join(" · ");
      summary.textContent = `${String(index + 1).padStart(2, "0")} / ${step.kind} · ${values} · dwell ${step.dwellMs} ms`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "text-button";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove step ${index + 1}`);
      remove.addEventListener("click", () => {
        sequenceSteps.splice(index, 1);
        renderSequence();
        syncControls();
      });
      row.append(summary, remove);
      list.append(row);
    });
  }
  byId("run-sequence-button").disabled = !sequenceAllowed();
  byId("add-step-button").disabled = actionBusy || sequenceSteps.length >= 20;
  byId("clear-steps-button").disabled = actionBusy || !sequenceSteps.length;
}

function renderStatus(next) {
  status = next;
  experience.update(next);
  if (next.error) setMessage(`Controller: ${next.error}`, "error");
  const connected = Boolean(next.connected);
  const mode = next.mode || "disconnected";
  const age = telemetryAgeMs();
  const fresh = age >= 0 && age <= 5000;
  const modeLabel = mode === "simulator" ? "SIMULATOR" : mode === "serial" ? "USB SERIAL" : mode === "http" ? "HTTP SEND-ONLY" : "DISCONNECTED";
  setChip("connection-chip", connected ? modeLabel : "OFFLINE", connected ? (mode === "simulator" ? "is-sim" : "is-online") : "is-offline");
  setChip("arm-chip", next.zLift?.active ? "LIFT TEST ACTIVE" : next.armed ? "ARMED" : "DISARMED", next.armed||next.zLift?.active ? "is-armed" : "");
  const telemetryLabel = !connected ? "NO TELEMETRY" : mode === "http" ? "SEND ONLY" : !fresh ? "STALE" : mode === "simulator" ? "SIMULATED" : "LIVE FEEDBACK";
  setChip("telemetry-chip", telemetryLabel, mode === "simulator" && connected ? "is-sim" : mode === "serial" && fresh ? "is-online" : "");
  byId("setup-state").textContent = connected ? modeLabel : "DISCONNECTED";
  byId("visual-link-state").textContent = connected ? modeLabel : "DISCONNECTED";
  byId("firmware-state").textContent = String(next.firmware || "UNKNOWN");
  byId("telemetry-time").textContent = next.telemetryUpdatedAt ? shortTime(next.telemetryUpdatedAt) : "NEVER";
  byId("owner-value").textContent = String(next.owner || "NONE");
  byId("task-state").textContent = next.zLift?.active ? "SUPERVISED LIFT" : next.task?.active ? `${next.task.name || "ACTIVE"} · ${next.task.progress || 0}/${next.task.total || 0}` : "IDLE";
  byId("command-state").textContent = next.commanded?.kind ? `${next.commanded.kind.toUpperCase()} TARGET` : "NONE";
  byId("updated-state").textContent = shortTime(next.updatedAt || lastFetchAt);
  byId("measured-source").textContent = connected && next.measured && mode === "serial" && fresh ? "FRESH USB FEEDBACK" : "UNAVAILABLE";
  byId("measured-summary").textContent = connected && next.measured && mode === "serial" && fresh
    ? `B ${Number(next.measured.base).toFixed(2)} · S ${Number(next.measured.shoulder).toFixed(2)} · E ${Number(next.measured.elbow).toFixed(2)} · G ${Number(next.measured.gripper).toFixed(2)} rad`
    : "—";
  byId("simulated-summary").textContent = next.simulated && mode === "simulator"
    ? `B ${Number(next.simulated.base).toFixed(2)} · S ${Number(next.simulated.shoulder).toFixed(2)} · E ${Number(next.simulated.elbow).toFixed(2)} · G ${Number(next.simulated.gripper).toFixed(2)} rad`
    : "INACTIVE";
  const banner = byId("simulator-banner");
  if (connected && mode === "simulator") {
    banner.className = "simulator-banner is-simulator";
    banner.firstElementChild.textContent = "SIMULATOR MODE · NO PHYSICAL MOTION";
    banner.lastElementChild.textContent = "Joint state and outcomes belong to the software simulator. They are not measured hardware feedback.";
  } else if (connected) {
    banner.className = "simulator-banner is-hardware";
    banner.firstElementChild.textContent = mode === "http" ? "HTTP LINK · SEND ONLY" : "HARDWARE LINK · MEASURED FEEDBACK REQUIRED";
    banner.lastElementChild.textContent = mode === "http"
      ? "Endpoint reachability is not motion evidence; HTTP feedback is unavailable, so physical arming is blocked."
      : "Fresh serial telemetry is required for physical commissioning and arming. Commands and acknowledgments do not prove arrival.";
  } else {
    banner.className = "simulator-banner";
    banner.firstElementChild.textContent = "DISCONNECTED · SELECT A CONNECTION";
    banner.lastElementChild.textContent = "USB serial COM4 is the saved default. Connect to read the arm; controls remain disarmed. Simulator is available for development.";
  }
  try { renderArm(ui.arm, { ...next, mode, connected }); }
  catch (error) { ui.arm.textContent = "Arm schematic unavailable."; setMessage(`Visualization error: ${error.message}`, "error"); }
  renderPoses(next.poses);
  renderHistory(next.history);
  byId("motion-gate").textContent = next.armed && next.commissioned && ownerIsCurrent() ? "READY · EXPLICIT ARM" : "LOCKED";
  syncControls();
}

function syncControls() {
  liftPanel.update(status,{session,owned:ownerIsCurrent(),online:apiOnline,busy:actionBusy});
  const connected = Boolean(status?.connected);
  const owned = ownerIsCurrent();
  const idle = !status?.task?.active && !actionBusy;
  const simulator = status?.mode === "simulator";
  const hardwareSerial = status?.mode === "serial";
  const hasPose = hasFreshPose();
  const kind = ui.motionKind.value;
  const variant = byId("variant").value;
  const commissionReady = simulator
    ? variant === "simulator"
    : hardwareSerial && physicalFeedbackFresh() && ["RoArm-M2-S", "RoArm-M2-Pro"].includes(variant);
  ui.serialFields.hidden = ui.mode.value !== "serial";
  ui.httpFields.hidden = ui.mode.value !== "http";
  byId("arm-button").disabled = !apiOnline || !connected || !status?.commissioned || (!simulator && !physicalFeedbackFresh()) || !owned || !idle;
  byId("arm-button").textContent = status?.armed ? "Disarm controls" : "Arm controls";
  byId("commission-button").disabled = !apiOnline || !connected || !commissionReady || Boolean(status?.armed) || !idle;
  byId("capture-calibration-button").disabled = !apiOnline || !connected || Boolean(status?.armed) || !owned || !idle;
  byId("move-button").disabled = !motionAllowed();
  byId("gripper-button").disabled = !apiOnline || !connected || !status?.armed || !status?.commissioned || !owned || !idle || !hasPose;
  byId("gripper-target").disabled = !hasPose;
  byId("motion-kind").disabled = actionBusy;
  byId("joint-target-fields").querySelectorAll("input").forEach((input) => { input.disabled = actionBusy; });
  byId("cartesian-target-fields").querySelectorAll("input").forEach((input) => { input.disabled = actionBusy; });
  const runSequence = sequenceAllowed();
  byId("run-sequence-button").disabled = !runSequence;
  byId("add-step-button").disabled = actionBusy || sequenceSteps.length >= 20;
  byId("clear-steps-button").disabled = actionBusy || !sequenceSteps.length;
  if (!simulator && kind === "cartesian") byId("move-button").title = "Physical Cartesian control is not accepted by the current contract.";
  else byId("move-button").removeAttribute("title");
  if (!simulator && sequenceSteps.some((step) => step.kind === "cartesian")) byId("run-sequence-button").title = "Physical Cartesian steps are blocked.";
  else byId("run-sequence-button").removeAttribute("title");
  byId("disconnect-button").disabled = !apiOnline || !connected || actionBusy;
  byId("connect-button").disabled = !apiOnline || actionBusy;
  byId("owner-name").disabled = actionBusy || Boolean(status?.task?.active);
  ui.ownerForm.querySelector("button[type='submit']").disabled = !apiOnline || actionBusy || Boolean(status?.task?.active);
  ui.poseForm.querySelector("button[type='submit']").disabled = !apiOnline || actionBusy;
  byId("stop-button").disabled = stopBusy;
  byId('renew-owner').disabled=!apiOnline||!owned||actionBusy;
  byId('release-owner').disabled=!apiOnline||!owned||actionBusy;
  if(!session||session.role==='observer')byId('control-view').querySelectorAll('button').forEach(node=>{node.disabled=true;});
  for (const option of byId("variant").options) {
    if (option.value !== "simulator") option.disabled = ui.mode.value === "simulator";
  }
}

function toggleTargetFields() {
  const joints = ui.motionKind.value === "joints";
  ui.jointFields.hidden = !joints;
  ui.cartesianFields.hidden = joints;
  syncControls();
}

async function refreshStatus({ quiet = false,signal,propagate=false } = {}) {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    try{experience.setSession(await request('/api/session',undefined,signal));}catch(error){experience.setSession(null);throw error;}
    const result = await request("/api/status",undefined,signal);
    apiOnline = true;
    lastFetchAt = new Date().toISOString();
    renderStatus(result);
    if (!quiet) setMessage("Local controller status refreshed.", "success");
  } catch (error) {
    apiOnline = false;
    experience.offline();
    syncControls();
    setChip("connection-chip", "API OFFLINE", "is-offline");
    byId("telemetry-chip").textContent = "UNAVAILABLE";
    byId("telemetry-chip").className = "state-chip is-offline";
    byId("setup-state").textContent = "API OFFLINE";
    byId("visual-link-state").textContent = "API OFFLINE";
    const banner = byId("simulator-banner");
    banner.className = "simulator-banner";
    banner.firstElementChild.textContent = "CONTROLLER UNAVAILABLE · STATE UNKNOWN";
    banner.lastElementChild.textContent = "The controller API is unavailable. Connection, arming and physical motion cannot be confirmed. No command will be replayed on recovery.";
    if (!quiet) setMessage(`Controller API unavailable: ${error.message}`, "error");
    try { renderArm(ui.arm, {}); } catch { ui.arm.textContent = "Arm schematic unavailable."; }
    if(propagate)throw error;
  } finally { pollInFlight = false; }
}

async function perform(action, successMessage) {
  if (actionBusy) return;
  actionBusy = true;
  syncControls();
  try {
    const result = await action();
    setMessage(result?.message || successMessage, "success");
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error), "error");
  } finally {
    actionBusy = false;
    await refreshStatus({ quiet: true });
    syncControls();
  }
}

function requireOwner() {
  const owner = ui.ownerName.value.trim();
  if (!owner) throw new Error("Enter the current command owner ID first.");
  if (status?.owner !== owner) throw new Error("Claim this command owner before arming or sending targets.");
  return owner;
}

function setJointTarget(joints) {
  for (const key of ["base", "shoulder", "elbow", "gripper"]) {
    const value = Number(joints[key]);
    if (!Number.isFinite(value)) throw new Error(`Saved pose has an invalid ${key} value.`);
    byId(`target-${key}`).value = value;
  }
  ui.motionKind.value = "joints";
  toggleTargetFields();
}

ui.connectionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void perform(async () => {
    const mode = ui.mode.value;
    let config = { mode };
    if (mode === "serial") config.port = byId("serial-port").value.trim();
    if (mode === "http") {
      config.host = byId("http-host").value.trim();
      config.port = finiteInput("http-port", "HTTP port");
    }
    const result = await request("/api/connect", config);
    if (mode === "simulator" && result.mode !== "simulator") throw new Error("Controller did not confirm simulator mode.");
    return result;
  }, "Connection request completed.");
});

byId("disconnect-button").addEventListener("click", () => void perform(() => request("/api/disconnect", {}), "Disconnected."));

ui.ownerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void perform(() => request("/api/owner", { owner: ui.ownerName.value.trim() }), "Command owner claimed.");
});

byId("arm-button").addEventListener("click", () => void perform(() => {
  const owner = requireOwner();
  return request("/api/arm", { armed: !status?.armed, owner });
}, status?.armed ? "Controls disarmed." : "Controls armed."));

byId("stop-button").addEventListener("click", () => {
  if (stopBusy) return;
  stopBusy = true;
  byId("stop-button").disabled = true;
  void (async () => {
    try {
      const result = await request("/api/stop", {});
      setMessage(result.message || "Software queue stop requested. Servo motion may continue; physical intervention may be required.", "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), "error");
    } finally {
      stopBusy = false;
      byId("stop-button").disabled = false;
      await refreshStatus({ quiet: true });
      syncControls();
    }
  })();
});

ui.commissionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void perform(() => request("/api/commission", {
    variant: byId("variant").value,
    firmware: byId("firmware").value.trim(),
    fixtureConfirmed: byId("fixture-confirmed").checked,
    clearanceConfirmed: byId("clearance-confirmed").checked,
    limitsConfirmed: byId("limits-confirmed").checked,
  }), "Commissioning request completed.");
});

ui.calibrationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void perform(() => request("/api/calibration", { name: byId("calibration-name").value.trim(), owner: requireOwner() }), "Calibration reference captured. No hardware calibration was applied.");
});

ui.motionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void perform(() => {
    const target = currentTarget();
    return request("/api/move", { ...target, owner: requireOwner() });
  }, "Target submitted to the controller.");
});

ui.gripperForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void perform(() => {
    if (!hasFreshPose()) throw new Error("Fresh measured or simulated state is required to preserve the other joints.");
    const base = status.mode === "simulator" ? status.simulated : status.measured;
    const target = Object.fromEntries(['base','shoulder','elbow','gripper'].map(key=>[key,base[key]]));target.gripper=finiteInput("gripper-target", "Gripper");
    return request("/api/move", { kind: "joints", target, owner: requireOwner() });
  }, "Gripper target submitted with current joint state.");
});

ui.poseForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void perform(() => request("/api/poses", { name: byId("pose-name").value.trim(), joints: jointTarget() }), "Named pose saved.");
});

byId("add-step-button").addEventListener("click", () => {
  try {
    if (sequenceSteps.length >= 20) throw new Error("A sequence is limited to 20 steps.");
    const dwellMs = finiteInput("step-dwell", "Step dwell");
    if (!Number.isInteger(dwellMs) || dwellMs < 0 || dwellMs > 5000) throw new Error("Step dwell must be an integer from 0 to 5000 ms.");
    sequenceSteps.push({ ...currentTarget(), dwellMs });
    renderSequence();
    syncControls();
    setMessage(`Added step ${sequenceSteps.length} of 20.`, "info");
  } catch (error) { setMessage(error.message, "error"); }
});

byId("clear-steps-button").addEventListener("click", () => {
  sequenceSteps = [];
  renderSequence();
  syncControls();
  setMessage("Sequence cleared.", "info");
});

byId("run-sequence-button").addEventListener("click", () => void perform(() => {
  const maxDurationMs = finiteInput("sequence-deadline", "Sequence deadline");
  if (!Number.isInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 60000) throw new Error("Sequence deadline must be an integer from 1 to 60000 ms.");
  if (sequenceSteps.length < 1 || sequenceSteps.length > 20) throw new Error("Sequence must contain 1 to 20 steps.");
  return request("/api/task", { name: byId("sequence-name").value.trim(), steps: sequenceSteps, maxDurationMs, owner: requireOwner() });
}, "Bounded sequence submitted to the controller."));

ui.mode.addEventListener("change", () => {
  if (ui.mode.value === "simulator") {
    byId("variant").value = "simulator";
    byId("firmware").value = "simulator";
  }
  syncControls();
});
ui.motionKind.addEventListener("change", toggleTargetFields);
ui.ownerName.addEventListener("input", syncControls);
byId("variant").addEventListener("change", () => {
  const variant = byId("variant").value;
  if (variant === "simulator") byId("firmware").value = "simulator";
  else if (byId("firmware").value === "simulator") byId("firmware").value = "";
});

renderArm(ui.arm, {});
toggleTargetFields();
renderSequence();
void refreshStatus();
const poller=createPoller({fetchStatus:({signal}={})=>refreshStatus({quiet:true,signal,propagate:true}),onStatus:()=>{},onError:()=>{apiOnline=false;experience.offline();syncControls();}});poller.start();
byId('renew-owner').addEventListener('click',()=>void perform(()=>request('/api/renew',{owner:requireOwner()}),'Control lease renewed.'));
byId('release-owner').addEventListener('click',()=>void perform(()=>request('/api/release',{owner:requireOwner()}),'Controls released and disarmed.'));
window.addEventListener('pagehide',()=>{poller.stop();experience.destroy();},{once:true});
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
