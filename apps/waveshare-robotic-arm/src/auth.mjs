import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
const DEFAULT_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PAIRING_ATTEMPT_WINDOW_MS = 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 20;
const MAX_ATTEMPTS_PER_CODE = 5;
const MAX_PENDING_PAIRINGS = 20;
const MAX_DEVICES = 100;
const ADMIN_DEVICE_ID = 'local-admin';

const sha256 = (value) => createHash('sha256').update(value).digest();
const validRole = (role) => role === 'observer' || role === 'control';
const validDeviceId = (id) => typeof id === 'string' && /^dev_[A-Za-z0-9_-]{20,80}$/.test(id);
const safeEqual = (left, right) => left.length === right.length && timingSafeEqual(left, right);

function extractCredential(req) {
  const headers = req?.headers ?? {};
  const authorization = headers.authorization ?? headers.Authorization;
  const cookieHeader = headers.cookie ?? headers.Cookie ?? '';
  let bearer = null;
  if (authorization !== undefined) {
    if (typeof authorization !== 'string') return null;
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(authorization);
    if (!match) return null;
    bearer = match[1];
  }

  let cookie = null;
  if (typeof cookieHeader === 'string') {
    const matches = [...cookieHeader.matchAll(/(?:^|;)\s*robot_session=([^;]*)/g)];
    if (matches.length > 1) return null;
    if (matches.length === 1) {
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(matches[0][1])) return null;
      cookie = matches[0][1];
    }
  } else if (cookieHeader !== undefined) {
    return null;
  }
  if (bearer && cookie && !safeEqual(Buffer.from(bearer), Buffer.from(cookie))) return null;
  return bearer ?? cookie;
}

function validateStore(store) {
  if (!store || store.version !== 1 || !Array.isArray(store.devices) || store.devices.length > MAX_DEVICES) {
    throw new Error('Invalid authentication device store');
  }
  for (const device of store.devices) {
    if (!validDeviceId(device.id) || !validRole(device.role) ||
        typeof device.salt !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(device.salt) ||
        typeof device.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(device.tokenHash) ||
        !Number.isFinite(device.createdAt) || !Number.isFinite(device.expiresAt) ||
        !(device.revokedAt === null || Number.isFinite(device.revokedAt))) {
      throw new Error('Invalid authentication device store entry');
    }
  }
  return store;
}

export function createAuth({
  directory,
  now = Date.now,
  pairingTtlMs = DEFAULT_PAIRING_TTL_MS,
  deviceTtlMs = DEFAULT_DEVICE_TTL_MS,
} = {}) {
  if (typeof directory !== 'string' || !directory) throw new Error('directory is required');
  if (typeof now !== 'function') throw new Error('now must be a function');
  if (!Number.isFinite(pairingTtlMs) || pairingTtlMs <= 0 || pairingTtlMs > DEFAULT_PAIRING_TTL_MS) {
    throw new Error('pairingTtlMs must be positive and no more than five minutes');
  }
  if (!Number.isFinite(deviceTtlMs) || deviceTtlMs <= 0) throw new Error('deviceTtlMs must be positive');

  const accessPath = path.join(directory, 'access.json');
  const devicesPath = path.join(directory, 'auth-devices.json');
  const pairings = new Map();
  const redemptionTimes = [];
  let adminToken;
  let store;
  let initialization;
  let writeQueue = Promise.resolve();

  function currentTime() {
    const value = now();
    if (!Number.isFinite(value)) throw new Error('Clock returned an invalid time');
    return value;
  }

  async function loadOrCreateAdminCredential() {
    try {
      const parsed = JSON.parse(await fs.readFile(accessPath, 'utf8'));
      if (typeof parsed.token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(parsed.token)) {
        throw new Error('Invalid local administrator credential');
      }
      return parsed.token;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const token = randomBytes(32).toString('base64url');
    try {
      await fs.writeFile(accessPath, `${JSON.stringify({ token })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return token;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const parsed = JSON.parse(await fs.readFile(accessPath, 'utf8'));
      if (typeof parsed.token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(parsed.token)) {
        throw new Error('Invalid local administrator credential');
      }
      return parsed.token;
    }
  }

  async function persist() {
    const serialized = `${JSON.stringify(store, null, 2)}\n`;
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      const tempPath = `${devicesPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        await fs.writeFile(tempPath, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await fs.rename(tempPath, devicesPath);
      } finally {
        await fs.rm(tempPath, { force: true }).catch(() => {});
      }
    });
    return writeQueue;
  }

  async function initialize() {
    if (!initialization) {
      initialization = (async () => {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        adminToken = await loadOrCreateAdminCredential();
        try {
          store = validateStore(JSON.parse(await fs.readFile(devicesPath, 'utf8')));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          store = { version: 1, devices: [] };
          await persist();
        }
      })().catch((error) => {
        initialization = null;
        throw error;
      });
    }
    await initialization;
  }

  async function authenticate(req) {
    await initialize();
    const credential = extractCredential(req);
    if (!credential) return null;
    const candidateHash = sha256(credential);
    if (safeEqual(candidateHash, sha256(adminToken))) return { role: 'admin', deviceId: ADMIN_DEVICE_ID };

    const time = currentTime();
    for (const device of store.devices) {
      if (device.revokedAt !== null || time >= device.expiresAt) continue;
      const salt = Buffer.from(device.salt, 'base64url');
      const expected = Buffer.from(device.tokenHash, 'hex');
      const actual = sha256(Buffer.concat([salt, Buffer.from(credential)]));
      if (safeEqual(actual, expected)) return { role: device.role, deviceId: device.id };
    }
    return null;
  }

  async function issuePairing({ role } = {}) {
    await initialize();
    if (!validRole(role)) throw new Error('Pairing role must be observer or control');
    const time = currentTime();
    for (const [key, pairing] of pairings) if (time >= pairing.expiresAt) pairings.delete(key);
    if (pairings.size >= MAX_PENDING_PAIRINGS) throw new Error('Too many pending pairings');
    const code = randomBytes(24).toString('base64url');
    const expiresAt = time + pairingTtlMs;
    pairings.set(sha256(code).toString('hex'), { role, expiresAt, attempts: 0 });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  async function redeemPairing(code) {
    await initialize();
    const time = currentTime();
    while (redemptionTimes.length && time - redemptionTimes[0] >= PAIRING_ATTEMPT_WINDOW_MS) redemptionTimes.shift();
    if (redemptionTimes.length >= MAX_PAIRING_ATTEMPTS) throw new Error('Pairing redemption rate limit reached');
    redemptionTimes.push(time);

    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(code)) throw new Error('Invalid or expired pairing code');
    const key = sha256(code).toString('hex');
    const pairing = pairings.get(key);
    if (!pairing) throw new Error('Invalid or expired pairing code');
    pairing.attempts += 1;
    if (time >= pairing.expiresAt) {
      pairings.delete(key);
      throw new Error('Invalid or expired pairing code');
    }
    if (pairing.attempts > MAX_ATTEMPTS_PER_CODE) {
      pairings.delete(key);
      throw new Error('Pairing attempt limit reached');
    }
    // Consume synchronously before the first persistence await, so racing calls cannot redeem twice.
    pairings.delete(key);
    if (store.devices.length >= MAX_DEVICES) throw new Error('Device limit reached');

    const token = randomBytes(32).toString('base64url');
    const salt = randomBytes(16);
    const createdAt = time;
    const device = {
      id: `dev_${randomBytes(18).toString('base64url')}`,
      role: pairing.role,
      salt: salt.toString('base64url'),
      tokenHash: sha256(Buffer.concat([salt, Buffer.from(token)])).toString('hex'),
      createdAt,
      expiresAt: createdAt + deviceTtlMs,
      revokedAt: null,
    };
    store.devices.push(device);
    try {
      await persist();
    } catch (error) {
      store.devices = store.devices.filter((entry) => entry.id !== device.id);
      throw error;
    }
    return { token, role: device.role, deviceId: device.id };
  }

  async function revoke(deviceId) {
    await initialize();
    if (!validDeviceId(deviceId)) throw new Error('Invalid device identifier');
    const device = store.devices.find((entry) => entry.id === deviceId);
    if (!device || device.revokedAt !== null) return false;
    device.revokedAt = currentTime();
    try {
      await persist();
    } catch (error) {
      device.revokedAt = null;
      throw error;
    }
    return true;
  }

  async function listDevices() {
    await initialize();
    const time = currentTime();
    return store.devices.map(({ id, role, createdAt, expiresAt, revokedAt }) => ({
      deviceId: id,
      role,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      revokedAt: revokedAt === null ? null : new Date(revokedAt).toISOString(),
      active: revokedAt === null && time < expiresAt,
    }));
  }

  return { initialize, authenticate, issuePairing, redeemPairing, revoke, listDevices };
}
