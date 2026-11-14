import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { validateJoints } from './safety.mjs';

const STORE_FILE = 'poses.json';
const MAX_POSES = 100;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;

function validateName(name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name) || name.trim() !== name) {
    throw Error('pose name must be 1..40 letters, digits, spaces, underscores or hyphens and start with a letter or digit');
  }
  return name;
}

function freshPose(name, joints) {
  return { name, joints: { ...joints } };
}

export function createPoseStore({ directory } = {}) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw Error('directory must be a nonempty path');
  }

  const resolvedDirectory = path.resolve(directory);
  const storePath = path.join(resolvedDirectory, STORE_FILE);
  let tail = Promise.resolve();

  // Serialize mutations through this store instance so overlapping saves do not
  // overwrite each other's read/modify/write cycle.
  function exclusive(operation) {
    const result = tail.then(operation, operation);
    tail = result.catch(() => {});
    return result;
  }

  async function readStore() {
    let raw;
    try {
      raw = await readFile(storePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, poses: Object.create(null) };
      throw error;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw Error('pose store is not valid JSON');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).sort().join(',') !== 'poses,version' || data.version !== 1
      || !data.poses || typeof data.poses !== 'object' || Array.isArray(data.poses)) {
      throw Error('pose store has an unsupported format');
    }

    const names = Object.keys(data.poses);
    if (names.length > MAX_POSES) throw Error(`pose store exceeds ${MAX_POSES} poses`);
    const poses = Object.create(null);
    for (const name of names) {
      validateName(name);
      poses[name] = validateJoints(data.poses[name]);
    }
    return { version: 1, poses };
  }

  async function writeStore(store) {
    await mkdir(resolvedDirectory, { recursive: true });
    const temporaryPath = path.join(resolvedDirectory, `.poses-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, storePath);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async function list() {
    const { poses } = await readStore();
    return Object.keys(poses).sort((a, b) => a.localeCompare(b)).map(name => freshPose(name, poses[name]));
  }

  async function save(name, joints) {
    validateName(name);
    const validatedJoints = validateJoints(joints);
    return exclusive(async () => {
      const store = await readStore();
      const existingName = Object.keys(store.poses).find(key => key.toLowerCase() === name.toLowerCase());
      if (existingName && existingName !== name) {
        throw Error(`pose name conflicts with existing name: ${existingName}`);
      }
      if (!existingName && Object.keys(store.poses).length >= MAX_POSES) {
        throw Error(`pose store is limited to ${MAX_POSES} poses`);
      }
      store.poses[name] = validatedJoints;
      await writeStore(store);
      return freshPose(name, validatedJoints);
    });
  }

  async function get(name) {
    validateName(name);
    const { poses } = await readStore();
    return Object.hasOwn(poses, name) ? freshPose(name, poses[name]) : null;
  }

  async function remove(name) {
    validateName(name);
    return exclusive(async () => {
      const store = await readStore();
      if (!Object.hasOwn(store.poses, name)) return false;
      delete store.poses[name];
      await writeStore(store);
      return true;
    });
  }

  return Object.freeze({ list, save, get, remove });
}
