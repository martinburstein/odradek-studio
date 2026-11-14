import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const CAMERA_KEYS = Object.freeze([
  'inspectedBy', 'cameraSessionId', 'sequence', 'observedAt', 'commandId',
  'confirmedShowsArm', 'fullSweepVisible', 'visibleObstacles', 'frameSaved'
]);
const INSPECTION_KEYS = Object.freeze(['stationary', 'noContact', 'cablesSlack', 'noUnusualNoise']);
const JOINTS = Object.freeze(['base', 'shoulder', 'elbow', 'gripper']);
const activeTargets = new Set();
const sha256 = value => createHash('sha256').update(value).digest('hex');

export class PilotCameraProofError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PilotCameraProofError';
    this.code = code;
  }
}

function fail(code, message) { throw new PilotCameraProofError(code, message); }
function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function abortIfNeeded(signal) {
  if (signal?.aborted) fail('CANCELLED', 'Proof staging was cancelled; no Pilot command was submitted.');
}

function validatePredecessor(row) {
  const clean = row?.mode === 'serial' && row.state === 'complete' &&
    row.result?.outcome === 'telemetry-reached' && row.result?.cleanupVerified === true &&
    row.result?.requiresReconciliation === false && row.result?.completion?.mode === 'shadow' &&
    row.result.completion.candidate && typeof row.result.completion.candidate === 'object' && row.result.completion.lateDeparture === false &&
    row.plan?.movementJoint === 'elbow' && typeof row.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.id) &&
    Number.isFinite(Date.parse(row.finishedAt)) && row.result.observed &&
    JOINTS.every(joint => Number.isFinite(row.result.observed[joint]));
  if (!clean) fail('PREDECESSOR_INVALID', 'A clean completed elbow movement receipt is required.');
  return row;
}

export function validatePilotCameraProof({ proof, predecessor, now = Date.now() } = {}) {
  validatePredecessor(predecessor);
  if (!Number.isFinite(now) || !exactKeys(proof, ['cameraObservation', 'inspection']) ||
      !exactKeys(proof.cameraObservation, CAMERA_KEYS) || !exactKeys(proof.inspection, INSPECTION_KEYS)) {
    fail('PROOF_SHAPE_INVALID', 'Root camera proof has an unsupported shape.');
  }
  const camera = proof.cameraObservation;
  const observedAt = Date.parse(camera.observedAt);
  const priorCamera = predecessor.finiteElbowGesture?.cameraObservation;
  if (camera.inspectedBy !== 'root' || camera.confirmedShowsArm !== true || camera.fullSweepVisible !== true ||
      camera.visibleObstacles !== false || camera.frameSaved !== false || camera.commandId !== predecessor.id ||
      typeof camera.cameraSessionId !== 'string' || !camera.cameraSessionId.trim() ||
      typeof camera.observedAt !== 'string' || !Number.isSafeInteger(camera.sequence) || camera.sequence < 1 || !Number.isFinite(observedAt) ||
      observedAt < Date.parse(predecessor.finishedAt) || observedAt > now || now - observedAt > 60000 ||
      (priorCamera?.cameraSessionId === camera.cameraSessionId &&
        (!Number.isSafeInteger(priorCamera.sequence) || camera.sequence <= priorCamera.sequence)) ||
      INSPECTION_KEYS.some(key => proof.inspection[key] !== true)) {
    fail('PROOF_STALE_OR_UNBOUND', 'Root proof must be fresh, complete, unobstructed, and bound to the clean predecessor.');
  }
  const cameraObservation = Object.fromEntries(CAMERA_KEYS.map(key => [key, camera[key]]));
  const inspection = Object.fromEntries(INSPECTION_KEYS.map(key => [key, proof.inspection[key]]));
  const bytes = Buffer.from(JSON.stringify({ ...cameraObservation, inspection }), 'utf8');
  return Object.freeze({ cameraObservation, inspection, metadataBytes: bytes, metadataSha256: sha256(bytes) });
}

async function restorePrior({ io, targetPath, previousBytes, existed, stagedBytes }) {
  try {
    const current = await io.readFile(targetPath);
    if (!Buffer.from(current).equals(stagedBytes)) return;
    if (!existed) {
      await io.unlink(targetPath).catch(() => {});
      return;
    }
    const restorePath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}.restore`);
    try {
      await io.writeFile(restorePath, previousBytes, { flag: 'wx', mode: 0o600 });
      await io.rename(restorePath, targetPath);
    } finally {
      await io.unlink(restorePath).catch(() => {});
    }
  } catch { /* Sanitized fail-closed result is reported by the caller. */ }
}

/**
 * Atomically stages the camera metadata consumed by the existing Pilot preparation path,
 * reads it back and verifies its hash before making one client callback. This module does
 * not inspect a camera, establish authority, or call an API itself.
 */
export async function stagePilotCameraProof({ proof, predecessor, targetPath, submit, clock = Date.now, signal, io = fs } = {}) {
  if (typeof targetPath !== 'string' || !targetPath.trim() || typeof submit !== 'function') {
    fail('INPUT_INVALID', 'A fixed metadata destination and one submit callback are required.');
  }
  const target = path.resolve(targetPath);
  if (activeTargets.has(target)) fail('BUSY', 'Proof staging is already active for this metadata destination.');
  if (typeof clock !== 'function') fail('INPUT_INVALID', 'A clock function is required for freshness checks.');
  const validated = validatePilotCameraProof({ proof, predecessor, now: clock() });
  abortIfNeeded(signal);
  activeTargets.add(target);
  let previousBytes, existed = true, tempPath = null, committed = false, callbackStarted = false;
  try {
    try { previousBytes = Buffer.from(await io.readFile(target)); }
    catch (error) {
      if (error?.code !== 'ENOENT') fail('READ_FAILED', 'Existing proof metadata could not be read; no command was submitted.');
      existed = false;
    }
    abortIfNeeded(signal);
    tempPath = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    await io.writeFile(tempPath, validated.metadataBytes, { flag: 'wx', mode: 0o600 });
    abortIfNeeded(signal);
    await io.rename(tempPath, target);
    tempPath = null;
    committed = true;
    abortIfNeeded(signal);
    const readback = Buffer.from(await io.readFile(target));
    if (sha256(readback) !== validated.metadataSha256 || !readback.equals(validated.metadataBytes)) {
      fail('READBACK_MISMATCH', 'Staged proof readback did not match; no command was submitted.');
    }
    const parsed = JSON.parse(readback.toString('utf8'));
    const expectedMetadata = { ...validated.cameraObservation, inspection: validated.inspection };
    if (JSON.stringify(parsed) !== JSON.stringify(expectedMetadata)) {
      fail('READBACK_MISMATCH', 'Staged proof readback did not match; no command was submitted.');
    }
    abortIfNeeded(signal);
    // Recheck freshness after asynchronous staging and immediately before dispatch.
    validatePilotCameraProof({ proof, predecessor, now: clock() });
    abortIfNeeded(signal);
    callbackStarted = true;
    const result = await submit(Object.freeze({
      cameraObservation: Object.freeze(validated.cameraObservation),
      inspection: validated.inspection,
      predecessorId: predecessor.id,
      metadataSha256: validated.metadataSha256
    }));
    return Object.freeze({ staged: true, submitted: true, metadataSha256: validated.metadataSha256,
      callbackStarted, accepted: result?.accepted === true,
      ...(typeof result?.job?.id === 'string' && /^[\w-]{1,128}$/.test(result.job.id) ? { jobId: result.job.id } : {}),
      ...(typeof result?.job?.phase === 'string' && /^[a-z-]{1,32}$/.test(result.job.phase) ? { phase: result.job.phase } : {}) });
  } catch (error) {
    if (committed && !callbackStarted) await restorePrior({ io, targetPath: target, previousBytes, existed, stagedBytes: validated.metadataBytes });
    if (error instanceof PilotCameraProofError) throw error;
    const code = tempPath ? 'WRITE_FAILED' : committed ? 'STAGING_FAILED' : 'SUBMIT_FAILED';
    const message = code === 'WRITE_FAILED' ? 'Proof metadata could not be staged; no command was submitted.' :
      code === 'SUBMIT_FAILED' ? 'Pilot callback failed; automatic retry is disabled.' :
      'Proof staging or callback failed; automatic retry is disabled.';
    throw new PilotCameraProofError(code, message);
  } finally {
    if (tempPath) await io.unlink(tempPath).catch(() => {});
    activeTargets.delete(target);
  }
}
