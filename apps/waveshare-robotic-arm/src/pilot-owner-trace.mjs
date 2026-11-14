const BOUNDARIES = new Set([
  'claim', 'renew', 'release', 'task-admit', 'task-begin', 'task-end', 'prepare', 'dispatch'
]);

function failureClass(error) {
  let message = '';
  try { if (typeof error?.message === 'string') message = error.message; } catch { /* Keep classification opaque. */ }
  if (message === 'Ownership lease must be renewed or released') return 'same-owner-already-assigned';
  if (message === 'Command ownership lease expired; disarm and release before takeover') return 'lease-expired';
  if (message === 'Command owner mismatch') return 'owner-mismatch';
  return 'operation-failed';
}

/**
 * Create a minimized, attributable observer for asynchronous or synchronous lifecycle calls.
 * It records boundary and outcome only. It never inspects arguments/results or changes authority.
 */
export function createPilotOwnerTrace({ emit, now = Date.now } = {}) {
  if (typeof emit !== 'function') throw Error('Pilot owner trace requires an event sink');
  if (typeof now !== 'function') throw Error('Pilot owner trace requires a clock');
  let sequence = 0;
  let droppedEvents = 0;
  let observerFailures = 0;

  const increment = name => {
    if (name === 'droppedEvents' && droppedEvents < Number.MAX_SAFE_INTEGER) droppedEvents++;
    if (name === 'observerFailures' && observerFailures < Number.MAX_SAFE_INTEGER) observerFailures++;
  };

  function safeNow() {
    try {
      const value = now();
      if (!Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) throw Error('invalid clock');
      return value;
    } catch {
      increment('observerFailures');
      return null;
    }
  }

  function record(boundary, phase, startedAt, error) {
    const endedAt = safeNow();
    const event = {
      sequence: ++sequence,
      boundary,
      phase,
      at: endedAt === null ? null : new Date(endedAt).toISOString(),
      durationMs: endedAt !== null && startedAt !== null ? Math.max(0, endedAt - startedAt) : null
    };
    if (error !== undefined) event.failureClass = failureClass(error);
    try {
      const result = emit(Object.freeze(event));
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).then(undefined, () => {
          increment('observerFailures');
          increment('droppedEvents');
        });
      }
    } catch {
      increment('observerFailures');
      increment('droppedEvents');
    }
  }

  function wrap(boundary, operation) {
    if (!BOUNDARIES.has(boundary)) throw Error(`Unsupported Pilot owner trace boundary: ${String(boundary)}`);
    if (typeof operation !== 'function') throw Error('Pilot owner trace operation must be a function');
    return function tracedOperation(...args) {
      const startedAt = safeNow();
      record(boundary, 'started', startedAt);
      let result;
      try {
        result = operation.apply(this, args);
      } catch (error) {
        record(boundary, 'failed', startedAt, error);
        throw error;
      }
      if (result instanceof Promise) {
        try {
          Promise.prototype.then.call(result,
            () => record(boundary, 'completed', startedAt),
            error => record(boundary, 'failed', startedAt, error));
        } catch {
          increment('observerFailures');
        }
        return result;
      }
      record(boundary, 'completed', startedAt);
      return result;
    };
  }

  function status() {
    return Object.freeze({ droppedEvents, observerFailures });
  }

  return Object.freeze({ wrap, status });
}
