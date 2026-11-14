import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const FORMAT_VERSION = 1;
const FILE_NAME = 'history.json';
const MAX_EVENT_BYTES = 4 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DEPTH = 16;
const MAX_ARRAY_ITEMS = 200;
const MAX_STRING_LENGTH = 4096;
const REDACTED = '[REDACTED]';

const SENSITIVE_KEY = /(?:secret|token|password|passwd|passphrase|credential|authorization|bearer|cookie|api.?key|access.?key|private.?key|session.?key)/i;
const WIFI_KEY = /^(?:wifi|wlan|wireless)(?:.*)?$|^(?:(?:ap|sta)(?:ssid|password|passwd|pwd|psk|key|credential|passphrase))$|^(?:ssid|psk|wpa(?:psk|key)|ap|sta|network|networkconfig|networksettings|networkcredentials|networkkey|networkpsk|networkpassword|networkpassphrase)$/i;

function canonicalKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sensitiveKey(key) {
  return SENSITIVE_KEY.test(key) || WIFI_KEY.test(canonicalKey(key));
}

function redactString(input) {
  return input
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(authorization|password|passwd|passphrase|token|secret|api[_-]?key|access[_-]?key|ssid|psk|wpa[_-]?(?:psk|key)|network[_-]?(?:key|psk|password|passphrase))\b(\s*[:=]\s*)(["']?)[^\s,;"'}]+/gi, `$1$2${REDACTED}`)
    .replace(/\b((?:wifi|wlan|wireless)[_-]?(?:ssid|password|passwd|pwd|psk|key|credential|passphrase)|(?:ap|sta)[_-](?:ssid|password|passwd|pwd|psk|key|credential|passphrase))\b(\s*[:=]\s*)(["']?)[^\s,;"'}]+/gi, `$1$2${REDACTED}`)
    .replace(/([?&](?:token|password|passwd|secret|api[_-]?key|ssid|psk)=)[^&#\s]+/gi, `$1${REDACTED}`)
    .slice(0, MAX_STRING_LENGTH);
}

function sanitize(value, depth = 0, seen = new WeakSet()) {
  if (depth > MAX_DEPTH) throw new TypeError('Telemetry event exceeds maximum nesting depth');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Telemetry values must be finite JSON numbers');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('Telemetry event must contain JSON-safe values');
  if (seen.has(value)) throw new TypeError('Telemetry event cannot contain circular references');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) throw new TypeError(`Telemetry arrays are limited to ${MAX_ARRAY_ITEMS} items`);
    result = value.map((item) => sanitize(item, depth + 1, seen));
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('Telemetry event must use plain JSON objects');
    result = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      const safeKey = redactString(key);
      result[safeKey] = sensitiveKey(key) ? REDACTED : sanitize(item, depth + 1, seen);
    }
  }
  seen.delete(value);
  return result;
}

function timestamp(value) {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Telemetry timestamp must be a valid date');
  return date.toISOString();
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('Telemetry event must be an object');
  const clean = sanitize(event);
  const at = timestamp(clean.at ?? clean.timestamp);
  const outcome = clean.outcome === undefined ? 'unknown' : clean.outcome;
  if (typeof outcome !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(outcome)) {
    throw new TypeError('Telemetry outcome must be a lowercase structured label');
  }
  const evidenceClass = ({
    sent: 'command-sent',
    acknowledged: 'transport-acknowledgment',
    observed: 'telemetry-observed',
    simulated: 'simulator-only',
    unknown: 'uncertain',
  })[outcome] ?? 'lifecycle';
  const normalized = Object.assign(Object.create(null), clean, { at, outcome, evidenceClass });
  const bytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
  if (bytes > MAX_EVENT_BYTES) throw new TypeError(`Telemetry event exceeds ${MAX_EVENT_BYTES} bytes after redaction`);
  return normalized;
}

function recoveryEvent(reason) {
  return normalizeEvent({
    kind: 'storage-warning',
    outcome: 'unknown',
    message: `Malformed or oversized history storage was recovered: ${reason}. Previous file contents were discarded.`,
    at: new Date().toISOString(),
  });
}

/**
 * Bounded append-only activity history. Stored data is redacted before it is
 * written and again when read. `list()` always returns a newest-last array;
 * a repaired store contains a visible storage-warning entry.
 */
export function createHistory({ directory, maxEntries = 500 } = {}) {
  if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('History directory is required');
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000) {
    throw new RangeError('maxEntries must be an integer from 1 to 100000');
  }
  const file = path.join(directory, FILE_NAME);
  let pending = Promise.resolve();

  const serialized = (operation) => {
    const next = pending.then(operation, operation);
    pending = next.catch(() => {});
    return next;
  };

  async function write(entries) {
    await fs.mkdir(directory, { recursive: true });
    const payload = JSON.stringify({ version: FORMAT_VERSION, entries }, null, 2);
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, payload, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temp, file);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function load() {
    let raw;
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_FILE_BYTES) throw new Error('history file exceeded the storage limit');
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      if (error.message === 'history file exceeded the storage limit') {
        const warning = recoveryEvent('file size limit exceeded');
        await write([warning]);
        return [warning];
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed) ? parsed : parsed?.version === FORMAT_VERSION && Array.isArray(parsed.entries) ? parsed.entries : null;
      if (!entries) throw new Error('invalid history envelope');
      const clean = [];
      for (const entry of entries.slice(-maxEntries)) clean.push(normalizeEvent(entry));
      if (entries.length > maxEntries || JSON.stringify(clean) !== JSON.stringify(entries.slice(-maxEntries))) await write(clean);
      return clean;
    } catch {
      const warning = recoveryEvent('invalid JSON or event structure');
      await write([warning]);
      return [warning];
    }
  }

  return {
    async record(event) {
      const clean = normalizeEvent(event);
      return serialized(async () => {
        const entries = await load();
        entries.push(clean);
        const bounded = entries.slice(-maxEntries);
        await write(bounded);
        return clean;
      });
    },
    async list() {
      return serialized(load);
    },
  };
}

export { MAX_EVENT_BYTES, MAX_FILE_BYTES };
