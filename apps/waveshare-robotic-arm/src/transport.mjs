import { isIP } from 'node:net';
import { parseBridgeResponse, validateBridgeRequest } from './hardware-bridge-feedback.mjs';

const DEFAULT_TIMEOUT_MS = 2500;
const FEEDBACK_QUERY = { T: 105 };

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function positiveInteger(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 65535) throw new Error(`${name} must be an integer from 1 to 65535`);
  return resolved;
}

export function encodeJoints(joints, { spd = 65, acc = 1 } = {}) {
  if (!joints || typeof joints !== 'object' || Array.isArray(joints)) throw new Error('Joint target must be an object');
  for (const key of ['base', 'shoulder', 'elbow', 'gripper']) finite(joints[key], key);
  if (!Number.isInteger(spd) || spd < 0 || spd > 65535) throw new Error('spd must be an integer from 0 to 65535; zero requests maximum speed');
  if (!Number.isInteger(acc) || acc < 0 || acc > 255) throw new Error('acc must be an integer from 0 to 255');
  return { T: 102, base: joints.base, shoulder: joints.shoulder, elbow: joints.elbow, hand: joints.gripper, spd, acc };
}

export function encodeCartesian(point, { spd = 0.25 } = {}) {
  if (!point || typeof point !== 'object' || Array.isArray(point)) throw new Error('Cartesian target must be an object');
  for (const key of ['x', 'y', 'z', 't']) finite(point[key], key);
  finite(spd, 'spd');
  if (spd <= 0) throw new Error('Cartesian spd must be greater than zero');
  return { T: 104, x: point.x, y: point.y, z: point.z, t: point.t, spd };
}

function numericField(object, name) {
  return typeof object[name] === 'number' && Number.isFinite(object[name]);
}

export function parseFeedback(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw.trim()); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.T !== 1051) return null;
  const fields = ['x', 'y', 'z', 'b', 's', 'e', 't'];
  if (!fields.every(key => numericField(value, key))) return null;
  const torqueFields = ['torB', 'torS', 'torE', 'torH'];
  if (torqueFields.some(key => value[key] !== undefined && !numericField(value, key))) return null;
  const feedback = {
    joints: { base: value.b, shoulder: value.s, elbow: value.e, gripper: value.t },
    cartesian: { x: value.x, y: value.y, z: value.z, t: value.t },
    raw: value,
    source: 'hardware',
    observedAt: new Date().toISOString()
  };
  if (torqueFields.some(key => value[key] !== undefined)) {
    feedback.torques = Object.fromEntries(torqueFields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  }
  return feedback;
}

function isPrivateIPv4(host) {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value, index) => !/^\d{1,3}$/.test(host.split('.')[index]) || value < 0 || value > 255)) return false;
  const [a, b] = octets;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export function isAllowedHost(host) {
  if (typeof host !== 'string' || !host.trim() || host.includes('%')) return false;
  const value = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (value === 'localhost') return true;
  const ipVersion = isIP(value);
  if (ipVersion === 4) return isPrivateIPv4(value);
  if (ipVersion === 6) return value === '::1' || /^(fc|fd|fe8|fe9|fea|feb)/i.test(value);
  return false;
}

function withDeadline(operation, { signal, timeoutMs, message = 'Transport operation timed out; result may be unknown', abortController }) {
  if (signal?.aborted) return Promise.reject(new Error('Transport operation aborted; result may be unknown'));
  let timer;
  let abortHandler;
  const gates = [Promise.resolve().then(operation)];
  gates.push(new Promise((_, reject) => {
    timer = setTimeout(() => { abortController?.abort(); reject(new Error(message)); }, timeoutMs);
    if (signal) {
      abortHandler = () => reject(new Error('Transport operation aborted; result may be unknown'));
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  }));
  return Promise.race(gates).finally(() => {
    clearTimeout(timer);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  });
}

function makeUrl(host, port) {
  if (!isAllowedHost(host)) throw new Error('HTTP host must be a literal private, loopback, or link-local address');
  const normalizedHost = host.trim().replace(/^\[|\]$/g, '');
  const urlHost = isIP(normalizedHost) === 6 ? `[${normalizedHost}]` : normalizedHost;
  return `http://${urlHost}:${port}/js`;
}

async function readJsonResponse(response, timeoutMs, signal, abortController) {
  if (response.status >= 300 && response.status < 400) throw new Error('HTTP redirects are not allowed');
  if (!response.ok) throw new Error(`HTTP transport returned ${response.status}; command outcome unknown`);
  const responseText = await withDeadline(() => response.text(), { signal, timeoutMs, message: 'HTTP response timed out; command outcome unknown', abortController });
  let responseJson;
  try { responseJson = JSON.parse(responseText); }
  catch { throw new Error('HTTP transport returned malformed JSON; command outcome unknown'); }
  if (!responseJson || typeof responseJson !== 'object' || Array.isArray(responseJson)) throw new Error('HTTP transport returned an invalid JSON response; command outcome unknown');
  return { responseText, responseJson };
}

async function loadSerialPort() {
  const module = await import('serialport');
  return module.SerialPort;
}

export function createTransport({ mode, host, port, timeoutMs = DEFAULT_TIMEOUT_MS, serialPortFactory } = {}) {
  if (!['serial', 'http'].includes(mode)) throw new Error('Transport mode must be serial or http');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('timeoutMs must be 1..60000');
  const resolvedPort = mode === 'http' ? positiveInteger(port, 80, 'port') : port;
  const endpoint = mode === 'http' ? makeUrl(host, resolvedPort) : null;
  let serial;
  let opened = false;
  let serialBuffer = '';
  let feedbackWaiter = null;
  let lastFeedback = null;
  let serialOperation = null;
  let bridgeIdentity = null;

  const rejectFeedback = error => {
    if (!feedbackWaiter) return;
    const waiter = feedbackWaiter;
    feedbackWaiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  };

  const onData = data => {
    serialBuffer += Buffer.from(data).toString('utf8');
    if (serialBuffer.length > 65536) { serialBuffer = ''; rejectFeedback(new Error('Serial response exceeded 65536 bytes')); return; }
    const lines = serialBuffer.split(/\r?\n/);
    serialBuffer = lines.pop() || '';
    for (const line of lines) {
      if (feedbackWaiter?.kind === 'bridge') {
        try {
          const parsed = parseBridgeResponse(line, feedbackWaiter.binding);
          if (parsed) {
            const waiter = feedbackWaiter;
            feedbackWaiter = null;
            clearTimeout(waiter.timer);
            bridgeIdentity = { buildId: parsed.buildId, bootId: parsed.bootId };
            if (parsed.T === 1051) lastFeedback = parsed;
            waiter.resolve(parsed);
          }
        } catch (error) { rejectFeedback(error); }
        continue;
      }
      if (/Servo ID:\s*\d+\s+status:\s*failed\./i.test(line)) {
        rejectFeedback(new Error('Servo feedback read failed; inspect motor power and servo connections'));
        continue;
      }
      const parsed = parseFeedback(line);
      if (!parsed) continue;
      lastFeedback = parsed;
      if (feedbackWaiter) {
        const waiter = feedbackWaiter;
        feedbackWaiter = null;
        clearTimeout(waiter.timer);
        waiter.resolve(parsed);
      }
    }
  };

  async function connect() {
    if (opened) return { connected: true };
    if (mode === 'http') {
      // T:105 only requests read-only servo telemetry; its response is not treated
      // as motion feedback over HTTP (the SDK documents HTTP as send-only).
      const url = `${endpoint}?json=${encodeURIComponent(JSON.stringify(FEEDBACK_QUERY))}`;
      const abortController = new AbortController();
      const response = await withDeadline(() => fetch(url, { method: 'GET', signal: abortController.signal, redirect: 'manual' }), { timeoutMs, message: 'HTTP connection probe timed out', abortController });
      if (response.status >= 300 && response.status < 400) throw new Error('HTTP redirects are not allowed');
      if (response.status < 200 || response.status >= 300) throw new Error(`HTTP connection probe returned ${response.status}`);
      // A successful empty body proves endpoint reachability only; HTTP remains send-only.
      const probeText = (await withDeadline(() => response.text(), { timeoutMs, message: 'HTTP connection probe timed out', abortController })).trim();
      if (probeText) {
        try {
          const parsed = JSON.parse(probeText);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        } catch { throw new Error('HTTP transport returned malformed JSON; command outcome unknown'); }
      }
      return { connected: true, mode: 'http', feedbackAvailable: false };
    }
    if (typeof port !== 'string' || !/^COM\d+$/i.test(port)) throw new Error('serial port must be a Windows COM name such as COM3');
    if (!serialPortFactory) {
      const SerialPort = await loadSerialPort();
      serialPortFactory = options => new SerialPort(options);
    }
    serial = serialPortFactory({ path: port.toUpperCase(), baudRate: 115200, autoOpen: false });
    const openingPort = serial;
    openingPort.on('data', onData);
    openingPort.on('error', error => rejectFeedback(new Error(`Serial port error: ${error.message}`)));
    let abandoned = false;
    try {
      await withDeadline(() => new Promise((resolve, reject) => openingPort.open(error => {
        if (error) { reject(error); return; }
        if (abandoned) { openingPort.close(() => {}); reject(new Error('Serial open completed after timeout')); return; }
        resolve();
      })), { timeoutMs, message: 'Serial open timed out' });
    } catch (error) {
      abandoned = true;
      if (openingPort.isOpen) await new Promise(resolve => openingPort.close(() => resolve())).catch(() => {});
      if (serial === openingPort) serial = null;
      throw error;
    }
    opened = true;
    return { connected: true, mode: 'serial', port: port.toUpperCase(), baudRate: 115200 };
  }

  async function writeSerial(command, signal) {
    if (!opened || !serial?.isOpen) throw new Error('Serial transport is not connected');
    if (signal?.aborted) throw new Error('Transport operation aborted; result may be unknown');
    if (serialOperation) throw new Error('A serial operation is still unresolved; wait for settlement or verified disconnect');
    const line = `${JSON.stringify(command)}\n`;
    if (signal?.aborted) throw new Error('Transport operation aborted; result may be unknown');
    const operation = Promise.resolve().then(() => {
      if (signal?.aborted) throw new Error('Transport operation aborted; result may be unknown');
      return new Promise((resolve, reject) => serial.write(line, error => error ? reject(error) : serial.drain(drainError => drainError ? reject(drainError) : resolve())));
    });
    serialOperation = operation;
    operation.then(() => { if (serialOperation === operation) serialOperation = null; }, () => { if (serialOperation === operation) serialOperation = null; });
    await withDeadline(() => operation, { signal, timeoutMs, message: 'Serial write timed out; command outcome unknown' });
  }

  async function send(command, { signal } = {}) {
    if (!command || typeof command !== 'object' || Array.isArray(command) || !Number.isInteger(command.T)) throw new Error('Command must be a firmware JSON object with integer T');
    if (mode === 'http') {
      const url = `${endpoint}?json=${encodeURIComponent(JSON.stringify(command))}`;
      const abortController = new AbortController();
      const abortFromCaller = () => abortController.abort();
      signal?.addEventListener('abort', abortFromCaller, { once: true });
      let response;
      try {
        response = await withDeadline(() => {
          if (signal?.aborted) throw new Error('Transport operation aborted; result may be unknown');
          return fetch(url, { method: 'GET', signal: abortController.signal, redirect: 'manual' });
        }, { signal, timeoutMs, message: 'HTTP request timed out; command outcome unknown', abortController });
        const { responseText, responseJson } = await readJsonResponse(response, timeoutMs, signal, abortController);
        // HTTP 2xx proves only the server response, not motion completion.
        return { sent: true, acknowledged: false, source: 'hardware', responseText, response: responseJson };
      } finally { abortController.abort(); signal?.removeEventListener('abort', abortFromCaller); }
    }
    await writeSerial(command, signal);
    return { sent: true, acknowledged: false, source: 'hardware' };
  }

  async function feedback({ signal } = {}) {
    if (mode === 'http') throw new Error('HTTP transport is send-only; use serial for measured feedback');
    if (!opened) throw new Error('Serial transport is not connected');
    if (feedbackWaiter) throw new Error('A telemetry request is already pending');
    const response = new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        if (feedbackWaiter === waiter) feedbackWaiter = null;
        reject(new Error('T:105 telemetry timed out; measured state unavailable'));
      }, timeoutMs);
      feedbackWaiter = waiter;
    });
    // Attach rejection handling before writeSerial can hang or time out.
    response.catch(() => {});
    try {
      await writeSerial(FEEDBACK_QUERY, signal);
      return await withDeadline(() => response, { signal, timeoutMs, message: 'T:105 telemetry timed out; measured state unavailable' });
    } catch (error) {
      rejectFeedback(error);
      throw error;
    }
  }

  async function bridgeRequest(command, { expectedBuildId, signal } = {}) {
    const expectedType = validateBridgeRequest(command, expectedBuildId);
    if (mode !== 'serial' || !opened) throw new Error('Bridge requests require a connected serial transport');
    if (feedbackWaiter || serialOperation) throw new Error('A serial operation is already pending');
    const response = new Promise((resolve, reject) => {
      const waiter = { kind: 'bridge', resolve, reject,
        binding: { expectedType, expectedBuildId, requestId: command.requestId } };
      waiter.timer = setTimeout(() => {
        if (feedbackWaiter === waiter) feedbackWaiter = null;
        reject(new Error('Bound hardware bridge response timed out; outcome unknown'));
      }, timeoutMs);
      feedbackWaiter = waiter;
    });
    response.catch(() => {});
    try {
      await writeSerial(command, signal);
      return await withDeadline(() => response, { signal, timeoutMs, message: 'Bound hardware bridge response timed out; outcome unknown' });
    } catch (error) { rejectFeedback(error); throw error; }
  }

  async function disconnect() {
    rejectFeedback(new Error('Serial transport disconnected'));
    bridgeIdentity = null;
    if (mode !== 'serial' || !serial || !opened) { opened = false; return { disconnected: true }; }
    try {
      await new Promise((resolve, reject) => serial.close(error => error ? reject(error) : resolve()));
      serialOperation = null;
    } finally {
      opened = false;
      serial = null;
    }
    return { disconnected: true };
  }

  async function stop() {
    // T:0 is only safe for the attested serial bridge. It revokes future writes,
    // but cannot stop a motor already moving. Factory firmware is never sent T:0.
    if (bridgeIdentity && opened && !feedbackWaiter && !serialOperation) {
      const { randomUUID } = await import('node:crypto');
      await bridgeRequest({ T: 0, requestId: randomUUID() }, { expectedBuildId: bridgeIdentity.buildId });
      return { requested: true, permitRevoked: true, physicalStop: false };
    }
    // No safe, verified controlled-stop command is available through this interface.
    // Never substitute torque disable, T:0, or a guessed hold target.
    return { requested: false, physicalStop: false, reason: 'No verified controlled hardware stop is implemented; cancel the local queue and use the physical safety procedure.' };
  }

  return { connect, disconnect, send, feedback, bridgeRequest, stop };
}
