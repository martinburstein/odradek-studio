import { forwardKinematics, inverseKinematics } from './kinematics.mjs';
import { validateCartesian, validateJoints } from './safety.mjs';

export const SIMULATOR_SEED = Object.freeze({ base: 0, shoulder: 0.8, elbow: 1.2, gripper: 1.57 });

const FAULTS = Object.freeze(['timeout', 'disconnect', 'malformed']);
const JOINT_COMMAND_KEYS = Object.freeze(['T', 'base', 'shoulder', 'elbow', 'hand', 'spd', 'acc']);
const CARTESIAN_COMMAND_KEYS = Object.freeze(['T', 'x', 'y', 'z', 't', 'spd']);

function exactKeys(value, keys, name) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} must contain exactly ${keys.join(', ')}`);
  }
}

function validateCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('Simulator command must be an object');
  if (command.T === 102) {
    exactKeys(command, JOINT_COMMAND_KEYS, 'T:102 command');
    if (!Number.isInteger(command.spd) || command.spd < 0 || command.spd > 65535) throw new Error('T:102 spd must be an integer from 0 to 65535');
    if (!Number.isInteger(command.acc) || command.acc < 0 || command.acc > 255) throw new Error('T:102 acc must be an integer from 0 to 255');
    return { kind: 'joints', target: validateJoints({
      base: command.base, shoulder: command.shoulder, elbow: command.elbow, gripper: command.hand
    }) };
  }
  if (command.T === 104) {
    exactKeys(command, CARTESIAN_COMMAND_KEYS, 'T:104 command');
    if (typeof command.spd !== 'number' || !Number.isFinite(command.spd) || command.spd <= 0) {
      throw new Error('T:104 spd must be a finite number greater than zero');
    }
    const target = validateCartesian({ x: command.x, y: command.y, z: command.z, t: command.t });
    return { kind: 'cartesian', target, joints: validateJoints(inverseKinematics(target)) };
  }
  throw new Error('Simulator accepts only T:102 joint and T:104 Cartesian commands');
}

function timeoutError() {
  const error = new Error('Simulator injected timeout; command was not applied');
  error.name = 'TimeoutError';
  return error;
}

function waitForDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Simulator command aborted'));
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (callback, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason instanceof Error ? signal.reason : new Error('Simulator command aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(resolve), ms);
  });
}

export function createSimulator({ latencyMs = 30 } = {}) {
  if (!Number.isInteger(latencyMs) || latencyMs < 0 || latencyMs > 60000) {
    throw new Error('latencyMs must be an integer from 0 to 60000');
  }

  let connected = false;
  let requiresReconnect = false;
  let joints = { ...SIMULATOR_SEED };
  let observedAt = new Date().toISOString();
  let pending = null;
  const faults = { timeout: false, disconnect: false, malformed: false };

  const cartesian = () => forwardKinematics(joints);
  const feedbackValue = () => ({
    joints: { ...joints },
    cartesian: cartesian(),
    source: 'simulator',
    observedAt,
    physicalMovementVerified: false
  });
  const markDisconnected = (reason, { cancelPending = true, requireReconnect = true } = {}) => {
    connected = false;
    requiresReconnect = requireReconnect;
    if (cancelPending && pending) pending.cancel(reason);
  };
  const assertConnected = () => {
    if (!connected || requiresReconnect) throw new Error('Simulator is disconnected; explicitly call connect() to recover');
  };

  async function connect() {
    if (faults.disconnect) throw new Error('Simulator disconnect fault is active; clear it before reconnecting');
    if (pending) throw new Error('Simulator cannot reconnect while a command is active');
    connected = true;
    requiresReconnect = false;
    observedAt = new Date().toISOString();
    return { connected: true, mode: 'simulator', simulated: true };
  }

  async function disconnect() {
    markDisconnected('Simulator disconnected', { requireReconnect: false });
    const active = pending;
    if (active?.promise) await active.promise.catch(() => {});
    return { connected: false, disconnected: true, simulated: true };
  }

  async function send(command, { signal } = {}) {
    assertConnected();
    if (pending) throw new Error('Simulator already has a command in flight');
    const parsed = validateCommand(command);
    if (faults.disconnect) {
      markDisconnected('Simulator injected disconnect');
      throw new Error('Simulator injected disconnect; explicitly reconnect after clearing the fault');
    }

    const internal = new AbortController();
    const onExternalAbort = () => internal.abort(signal.reason instanceof Error ? signal.reason : new Error('Simulator command aborted'));
    if (signal?.aborted) onExternalAbort();
    else signal?.addEventListener('abort', onExternalAbort, { once: true });
    const active = {
      promise: null,
      cancel: reason => internal.abort(new Error(reason))
    };
    pending = active;
    active.promise = (async () => {
      try {
        await waitForDelay(latencyMs, internal.signal);
        assertConnected();
        if (faults.timeout) {
          markDisconnected('Simulator injected timeout', { cancelPending: false });
          throw timeoutError();
        }
        const nextJoints = parsed.kind === 'joints' ? parsed.target : parsed.joints;
        joints = { ...nextJoints };
        observedAt = new Date().toISOString();
        return { acknowledged: true, simulated: true, source: 'simulator', physicalMovementVerified: false };
      } finally {
        signal?.removeEventListener('abort', onExternalAbort);
        if (pending === active) pending = null;
      }
    })();
    return active.promise;
  }

  async function feedback({ signal } = {}) {
    assertConnected();
    if (faults.disconnect) {
      markDisconnected('Simulator injected disconnect');
      throw new Error('Simulator injected disconnect; explicitly reconnect after clearing the fault');
    }
    await waitForDelay(latencyMs, signal);
    assertConnected();
    if (faults.timeout) {
      markDisconnected('Simulator injected timeout', { cancelPending: false });
      throw timeoutError();
    }
    if (faults.malformed) {
      markDisconnected('Simulator injected malformed feedback');
      return { joints: null, cartesian: null, source: 'simulator', observedAt };
    }
    observedAt = new Date().toISOString();
    return feedbackValue();
  }

  async function stop() {
    const active = pending;
    if (active) {
      active.cancel('Simulator command cancelled by stop');
      if (active.promise) await active.promise.catch(() => {});
    }
    return { stopped: true, simulated: true, physicalStopVerified: false };
  }

  function setFault(name, value) {
    if (!FAULTS.includes(name)) throw new Error(`Unsupported simulator fault: ${name}`);
    if (typeof value !== 'boolean') throw new Error(`Simulator fault ${name} must be a boolean`);
    faults[name] = value;
    if (name === 'disconnect' && value) markDisconnected('Simulator injected disconnect');
    return { [name]: faults[name], connected, requiresReconnect };
  }

  return {
    connect,
    disconnect,
    send,
    feedback,
    stop,
    setFault,
    get status() { return { mode: 'simulator', connected, simulated: true, requiresReconnect }; }
  };
}
