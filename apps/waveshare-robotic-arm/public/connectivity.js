const LIVE_AFTER_MS = 5_000;
const OFFLINE_AFTER_MS = 15_000;
const MAX_BACKOFF_MS = 15_000;

function timestampMs(value) {
  if (value instanceof Date) {
    const result = value.getTime();
    return Number.isFinite(result) ? result : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const result = Date.parse(value);
    return Number.isFinite(result) ? result : null;
  }
  return null;
}

export function classifyFreshness({ updatedAt, now = Date.now(), connected } = {}) {
  if (!Number.isFinite(now)) throw new TypeError('now must be a finite timestamp');
  const timestamp = timestampMs(updatedAt);
  const ageMs = timestamp === null ? null : now - timestamp;
  let state;
  if (connected !== true || (ageMs !== null && ageMs > OFFLINE_AFTER_MS)) state = 'offline';
  else if (ageMs === null || ageMs < 0 || ageMs > LIVE_AFTER_MS) state = 'stale';
  else state = 'live';
  return { state, ageMs, label: state[0].toUpperCase() + state.slice(1) };
}

/**
 * Poll a status-only function serially. fetchStatus receives `{signal}` and must
 * perform a read only GET; this poller never owns or replays user commands.
 */
export function createPoller({ fetchStatus, onStatus = () => {}, onError = () => {}, intervalMs = 1_500 } = {}) {
  if (typeof fetchStatus !== 'function') throw new TypeError('fetchStatus must be a function');
  if (typeof onStatus !== 'function' || typeof onError !== 'function') throw new TypeError('callbacks must be functions');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new TypeError('intervalMs must be positive and finite');

  let running = false;
  let generation = 0;
  let timer = null;
  let inFlight = null;
  let activeController = null;
  let failures = 0;

  const isCurrent = (value) => running && value === generation;

  function delayAfterFailure() {
    return Math.min(intervalMs * (2 ** Math.min(failures, 30)), MAX_BACKOFF_MS);
  }

  function schedule(value, delay) {
    if (!isCurrent(value)) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void poll(value);
    }, delay);
  }

  async function poll(value) {
    if (!isCurrent(value) || inFlight !== null) return;
    const controller = new AbortController();
    activeController = controller;
    const request = Promise.resolve().then(() => fetchStatus({ signal: controller.signal }));
    inFlight = request;
    try {
      const status = await request;
      if (!isCurrent(value) || controller.signal.aborted) return;
      failures = 0;
      await onStatus(status);
    } catch (error) {
      if (isCurrent(value) && !controller.signal.aborted) {
        failures += 1;
        try { onError(error); } catch { /* Keep the polling loop bounded if the reporter itself fails. */ }
      }
    } finally {
      if (activeController === controller) activeController = null;
      if (inFlight === request) inFlight = null;
      if (running) schedule(generation, failures > 0 ? delayAfterFailure() : intervalMs);
    }
  }

  function start() {
    if (running) return;
    running = true;
    generation += 1;
    failures = 0;
    if (inFlight === null) void poll(generation);
  }

  function stop() {
    if (!running && inFlight === null) return;
    running = false;
    generation += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    activeController?.abort();
  }

  return { start, stop };
}
