import { createPilotOwnerTrace } from './pilot-owner-trace.mjs';

const COUNTER_MAX = Number.MAX_SAFE_INTEGER;
const BOUNDARIES = new Set(['claim', 'renew', 'release', 'task-admit', 'task-begin', 'task-end', 'prepare', 'dispatch']);
const PHASES = new Set(['started', 'completed', 'failed']);
const FAILURE_CLASSES = new Set(['same-owner-already-assigned', 'lease-expired', 'owner-mismatch', 'operation-failed']);
const CALLBACK_BOUNDARIES = Object.freeze({
  claim: 'claim', renew: 'renew', release: 'release', beginTask: 'task-begin', endTask: 'task-end',
  prepare: 'prepare', execute: 'dispatch'
});

function increment(state, name) {
  if (state[name] < COUNTER_MAX) state[name]++;
}

function canonicalEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
      !BOUNDARIES.has(event.boundary) || !PHASES.has(event.phase) ||
      !(event.at === null || (typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)))) ||
      !(event.durationMs === null || (Number.isFinite(event.durationMs) && event.durationMs >= 0)) ||
      (event.failureClass !== undefined && !FAILURE_CLASSES.has(event.failureClass)) ||
      (event.phase === 'failed') !== (event.failureClass !== undefined)) return null;
  return Object.freeze({
    sequence: event.sequence,
    boundary: event.boundary,
    phase: event.phase,
    at: event.at === null ? null : new Date(Date.parse(event.at)).toISOString(),
    durationMs: event.durationMs,
    ...(event.failureClass ? { failureClass: event.failureClass } : {})
  });
}

/**
 * Create an in-memory, bounded, minimized observer for existing Pilot owner callbacks.
 * This module deliberately does not fingerprint production sources: the integrating lead
 * must review loaded/disk source identity and restart/rebind separately before wiring it.
 */
export function createPilotOwnerObserver({ capacity = 64, now = Date.now } = {}) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 256) throw Error('Pilot owner observer capacity must be an integer from 1 to 256');
  const retained = [];
  const sinkState = { droppedEvents: 0, observerFailures: 0 };
  function emit(event) {
    const safe = canonicalEvent(event);
    if (!safe) {
      increment(sinkState, 'droppedEvents');
      increment(sinkState, 'observerFailures');
      return;
    }
    if (retained.length >= capacity) {
      retained.shift();
      increment(sinkState, 'droppedEvents');
    }
    retained.push(safe);
  }
  const trace = createPilotOwnerTrace({ emit, now });

  function wrapCallbacks(callbacks) {
    if (!callbacks || typeof callbacks !== 'object' || Array.isArray(callbacks)) throw Error('Pilot observer callbacks must be an object');
    const wrapped = { ...callbacks };
    for (const [name, boundary] of Object.entries(CALLBACK_BOUNDARIES)) {
      if (callbacks[name] === undefined) continue;
      if (typeof callbacks[name] !== 'function') throw Error(`Pilot observer callback ${name} must be a function`);
      wrapped[name] = trace.wrap(boundary, callbacks[name]);
    }
    return Object.freeze(wrapped);
  }

  function wrapContext(context) {
    if (!context || typeof context !== 'object' || Array.isArray(context) || typeof context.admit !== 'function') {
      throw Error('Pilot observer context requires an admission function');
    }
    return Object.freeze({ ...context, admit: trace.wrap('task-admit', context.admit) });
  }

  function events() {
    return Object.freeze(retained.map(event => Object.freeze({ ...event })));
  }

  function status() {
    const traceStatus = trace.status();
    const sinkStatus = Object.freeze({
      capacity,
      retained: retained.length,
      droppedEvents: sinkState.droppedEvents,
      observerFailures: sinkState.observerFailures
    });
    return Object.freeze({
      sink: sinkStatus,
      trace: traceStatus,
      droppedEvents: Math.min(COUNTER_MAX, sinkStatus.droppedEvents + traceStatus.droppedEvents),
      observerFailures: Math.min(COUNTER_MAX, sinkStatus.observerFailures + traceStatus.observerFailures)
    });
  }

  return Object.freeze({ wrap: trace.wrap, wrapCallbacks, wrapContext, events, status });
}
