#!/usr/bin/env node
// Codex-facing client for the local robot HTTP API. This file never opens a transport.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = (process.env.ROBOT_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
let activeCredential;

async function token() {
  if (process.env.ROBOT_TOKEN) return activeCredential = process.env.ROBOT_TOKEN;
  try {
    const access = JSON.parse(await readFile(resolve('runtime/access.json'), 'utf8'));
    if (typeof access.token === 'string' && access.token) return activeCredential = access.token;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read runtime/access.json');
  }
  return undefined;
}

function safeError(message, credential = activeCredential) {
  let text = String(message);
  if (credential) text = text.split(credential).join('[redacted]');
  const privateKey = String.raw`[\w.-]*(?:token|authorization|password|passphrase|secret|credential|ssid|psk|wifi|networkkey)[\w.-]*`;
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(new RegExp(String.raw`(["']?${privateKey}["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)`, 'gi'), '$1"[redacted]"');
}

function safeOutput(value, credential) {
  if (Array.isArray(value)) return value.map(item => safeOutput(item, credential));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, /token|authorization|password|passphrase|secret|credential|ssid|psk|wifi|networkkey/i.test(key) ? '[redacted]' : safeOutput(item, credential)]));
  }
  if (typeof value === 'string') {
    return safeError(value, credential);
  }
  return value;
}

async function api(path, method = 'GET', body) {
  const credential = await token();
  const headers = { accept: 'application/json' };
  if (credential) headers.authorization = `Bearer ${credential}`;
  const payload = method === 'POST' ? (body ?? {}) : body;
  if (payload !== undefined) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method, headers, signal: AbortSignal.timeout(10000),
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
    });
  } catch {
    throw new Error(`API request failed (${method} ${path}); check ROBOT_URL and that the local server is running`);
  }
  let result;
  try { result = await response.json(); } catch { throw new Error(`API returned non-JSON (${response.status})`); }
  if (!response.ok || result?.error) throw new Error(`API ${response.status}: ${safeError(result?.error || response.statusText, credential)}`);
  return result;
}

function parse(argv) {
  const [command, ...rest] = argv;
  if (!command || !['status','connect','commission','owner','arm','move','task','stop','demo'].includes(command)) {
    throw new Error('Usage: node tools/robot.mjs <status|connect|commission|owner|arm|move|task|stop|demo> [JSON object]');
  }
  let data = {};
  if (rest.length) {
    try { data = JSON.parse(rest.join(' ')); } catch { throw new Error('Optional argument must be one JSON object'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Argument must be a JSON object');
  }
  return { command, data };
}

async function runDemo() {
  const before = await api('/api/status');
  if (before.mode === 'http' || before.mode === 'serial') throw new Error('Demo refused: currently selected mode is physical');
  if (before.armed === true || before.task?.active === true) {
    throw new Error('Demo refused: an existing setup is armed or has an active task');
  }
  let armRequested = false;
  const evidence = {};
  let failure;
  let stopResponse;
  let disarmed;
  let stopError;
  let disarmError;
  try {
    evidence.connected = await api('/api/connect', 'POST', { mode: 'simulator' });
    const state = await api('/api/status');
    if (state.mode !== 'simulator' || !state.simulated || typeof state.simulated !== 'object') {
      throw new Error('Demo stopped: API did not confirm simulator mode and simulated joint state');
    }
    evidence.commissioned = await api('/api/commission', 'POST', {
      variant: 'simulator', firmware: 'simulator', fixtureConfirmed: true,
      clearanceConfirmed: true, limitsConfirmed: true
    });
    evidence.claimed = await api('/api/owner', 'POST', { owner: 'codex-demo' });
    armRequested = true;
    evidence.armed = await api('/api/arm', 'POST', { armed: true, owner: 'codex-demo' });
    evidence.moved = await api('/api/move', 'POST', {
      kind: 'joints', target: { base: 0, shoulder: 0.8, elbow: 1.2, gripper: 1.57 }, owner: 'codex-demo'
    });
    evidence.task = await api('/api/task', 'POST', {
      name: 'codex-demo', owner: 'codex-demo', maxDurationMs: 5000,
      steps: [{ kind: 'joints', target: { base: 0.05, shoulder: 0.8, elbow: 1.2, gripper: 1.57 }, dwellMs: 100 }]
    });
  } catch (error) {
    failure = error;
  } finally {
    if (armRequested) {
      try {
        disarmed = await api('/api/arm', 'POST', { armed: false, owner: 'codex-demo' });
      } catch (error) {
        disarmError = error;
      }
      try {
        stopResponse = await api('/api/stop', 'POST', {});
      } catch (error) {
        stopError = error;
      }
    }
  }
  if (failure) {
    let message = safeError(failure.message);
    if (stopError) message += '; software stop was not verified';
    if (disarmError) message += '; disarming was not verified';
    throw new Error(message);
  }
  if (stopError) throw new Error(`Demo operations completed, but software stop was not verified: ${safeError(stopError.message)}`);
  if (disarmError) throw new Error(`Demo stop was verified, but disarming was not verified: ${safeError(disarmError.message)}`);
  return { simulated: true, evidence: { ...evidence, stopped: stopResponse, disarmed } };
}

try {
  const { command, data } = parse(process.argv.slice(2));
  const routes = {
    status: () => api('/api/status'), connect: () => api('/api/connect','POST',data),
    commission: () => api('/api/commission','POST',data), owner: () => api('/api/owner','POST',data),
    arm: () => api('/api/arm','POST',data), move: () => api('/api/move','POST',data),
    task: () => api('/api/task','POST',data), stop: () => api('/api/stop','POST',data), demo: runDemo
  };
  const result = await routes[command]();
  process.stdout.write(`${JSON.stringify(safeOutput(result, await token()), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${safeError(error.message)}\n`);
  process.exitCode = 1;
}
