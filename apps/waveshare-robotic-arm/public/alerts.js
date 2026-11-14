const hasNotification = () => typeof globalThis.Notification !== "undefined";

/** Create transition-based, page-local alerts for the check-in view. */
export function createAlerts({ onAlert = () => {} } = {}) {
  if (typeof onAlert !== "function") throw new TypeError("onAlert must be a function");
  let previous = null;
  let destroyed = false;

  function emit(id, message) {
    if (destroyed) return;
    const alert = { id, message };
    onAlert(alert);
    if (hasNotification() && Notification.permission === "granted") {
      try { new Notification("Robot check-in", { body: message, tag: id }); } catch { /* Page alert remains available. */ }
    }
  }

  function update(status) {
    if (destroyed) return;
    if (!status || typeof status !== "object") throw new TypeError("status must be an object");
    const task = status.task && typeof status.task === "object" ? status.task : {};
    const active = task.active === true;
    const taskId = String(task.name || "task");
    const error = task.lastError || task.stopError || status.error;
    const freshness = status.freshness;

    if (!previous) {
      previous = { active, taskId, progress: task.progress, total: task.total, armed: status.armed, freshness, error: error ? `error:${taskId}:${error}` : null, completionReported: task.completed === true || (Number(task.total) > 0 && Number(task.progress) >= Number(task.total)) };
      if (error) emit(`error:${taskId}:${error}`, "Task or controller reported an error.");
      if (freshness === "stale" || freshness === "offline") emit(`freshness:${freshness}`, freshness === "stale" ? "Robot telemetry is stale." : "Robot connection is offline.");
      return;
    }

    if (active && (!previous.active || previous.taskId !== taskId)) {
      previous.completionReported = false;
      previous.error = null;
    }

    if (error) {
      const errorId = `error:${taskId}:${error}`;
      if (previous.error !== errorId) emit(errorId, "Task or controller reported an error.");
    }
    if (freshness === "stale" || freshness === "offline") {
      if (previous.freshness !== freshness) emit(`freshness:${freshness}`, freshness === "stale" ? "Robot telemetry is stale." : "Robot connection is offline.");
    }
    if (previous.armed === true && status.armed === false && (previous.active || active)) {
      emit(`disarmed:${previous.taskId}`, "Arm disarmed during a task. Queue cancellation is a software request and does not confirm that hardware stopped.");
    }
    const totalStepsReported = Number(task.total) > 0 && Number(task.progress) >= Number(task.total);
    const reachedReportedTotal = Number(previous.total) > 0 && Number(previous.progress) < Number(previous.total) && totalStepsReported;
    const completionTransition = task.completed === true || (previous.active && previous.taskId === taskId && !active && Number(previous.total) > 0 && Number(previous.progress) >= Number(previous.total)) || (active && reachedReportedTotal);
    if (!error && !previous.completionReported && completionTransition) {
      emit(`complete:${taskId}:${previous.total}`, `Task steps reported complete: ${taskId}. This is software progress, not verified physical movement.`);
    }

    previous = { active, taskId, progress: task.progress, total: task.total, armed: status.armed, freshness, error: error ? `error:${taskId}:${error}` : null, completionReported: previous.completionReported || task.completed === true || totalStepsReported };
  }

  async function requestPermission() {
    if (!hasNotification() || typeof Notification.requestPermission !== "function") return "unavailable";
    return Notification.requestPermission();
  }

  function destroy() { destroyed = true; previous = null; }
  return { update, requestPermission, destroy };
}
