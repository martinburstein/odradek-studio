// Conservative application envelopes around the simulator's nominal seed.
// These are software assumptions, not measured or vendor-certified robot limits.
export const LIMITS = Object.freeze({
  base: Object.freeze([-0.2, 0.2]),
  shoulder: Object.freeze([0.6, 1.0]),
  elbow: Object.freeze([1.0, 1.4]),
  gripper: Object.freeze([1.37, 1.77])
});

export const CARTESIAN_LIMITS = Object.freeze({
  x: Object.freeze([300, 500]),
  y: Object.freeze([-125, 125]),
  z: Object.freeze([-25, 250]),
  t: Object.freeze([1.37, 1.77])
});

// T:102 spd is integer servo steps/second, not rad/s. This provisional
// integer is approximately 0.1 rad/s for the documented 4096-step/rev servo.
// It and acceleration still require physical verification on the exact unit.
export const COMMISSIONING_MOTION = Object.freeze({
  maxJointSpeedRadPerSecond: 0.1,
  t102SpeedStepsPerSecond: 65,
  t102Acceleration: 1,
  maxJointStepRad: 0.08
});

const JOINT_KEYS = Object.freeze(Object.keys(LIMITS));
const CARTESIAN_KEYS = Object.freeze(Object.keys(CARTESIAN_LIMITS));
const COMMISSIONING_KEYS = Object.freeze([
  'variant', 'firmware', 'fixtureConfirmed', 'clearanceConfirmed', 'limitsConfirmed'
]);
const VARIANTS = new Set(['simulator', 'RoArm-M2-S', 'RoArm-M2-Pro']);

function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${name} must be an object`);
  return value;
}

function exactKeys(value, required, name) {
  const actual = Object.keys(value);
  const unknown = actual.find(key => !required.includes(key));
  if (unknown) throw Error(`${name} contains unknown field: ${unknown}`);
  const missing = required.find(key => !Object.hasOwn(value, key));
  if (missing) throw Error(`${name} is missing field: ${missing}`);
}

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw Error(`${name} must be a finite number`);
  return value;
}

function within(value, bounds, name) {
  finite(value, name);
  if (value < bounds[0] || value > bounds[1]) throw Error(`${name} must be within [${bounds[0]}, ${bounds[1]}]`);
  return value;
}

export function validateJoints(joints) {
  record(joints, 'joints');
  exactKeys(joints, JOINT_KEYS, 'joints');
  return Object.fromEntries(JOINT_KEYS.map(key => [key, within(joints[key], LIMITS[key], key)]));
}

// Observation is not permission to move. Uncommissioned hardware can report a
// startup pose outside our motion envelope; preserve it without clipping.
export function validateObservedJoints(joints) {
  record(joints, 'joint feedback');
  exactKeys(joints, JOINT_KEYS, 'joint feedback');
  const observed = Object.fromEntries(JOINT_KEYS.map(key => [key, finite(joints[key], key)]));
  // Pinned Waveshare firmware converts zero-initialized encoder positions to
  // this tuple even when servo reads fail. Observed with motor power absent.
  // Reject the signature; this check alone cannot establish servo health.
  const unavailable = { base: Math.PI, shoulder: -Math.PI, elbow: -Math.PI / 2, gripper: 0 };
  if (JOINT_KEYS.every(key => Math.abs(observed[key] - unavailable[key]) < 1e-6)) {
    throw Error('Servo feedback unavailable: zero-position fallback; check motor power and servo connections');
  }
  return observed;
}

export function validateCartesian(point) {
  record(point, 'Cartesian target');
  exactKeys(point, CARTESIAN_KEYS, 'Cartesian target');
  return Object.fromEntries(CARTESIAN_KEYS.map(key => [key, within(point[key], CARTESIAN_LIMITS[key], key)]));
}

export function validateSequence(steps) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) {
    throw Error('steps must contain 1..20 motion steps');
  }
  return steps.map((step, index) => {
    const label = `step ${index + 1}`;
    record(step, label);
    const allowed = ['kind', 'target', 'dwellMs'];
    const unknown = Object.keys(step).find(key => !allowed.includes(key));
    if (unknown) throw Error(`${label} contains unknown field: ${unknown}`);
    if (!Object.hasOwn(step, 'kind') || !Object.hasOwn(step, 'target')) throw Error(`${label} requires kind and target`);
    if (step.kind !== 'joints' && step.kind !== 'cartesian') throw Error(`${label} kind must be joints or cartesian`);
    const target = step.kind === 'joints' ? validateJoints(step.target) : validateCartesian(step.target);
    const normalized = { kind: step.kind, target };
    if (Object.hasOwn(step, 'dwellMs')) {
      if (!Number.isInteger(step.dwellMs) || step.dwellMs < 0 || step.dwellMs > 5000) {
        throw Error(`${label} dwellMs must be an integer from 0 to 5000`);
      }
      normalized.dwellMs = step.dwellMs;
    }
    return normalized;
  });
}

export function validateCommissioning(config) {
  record(config, 'commissioning config');
  exactKeys(config, COMMISSIONING_KEYS, 'commissioning config');
  if (typeof config.variant !== 'string' || !VARIANTS.has(config.variant)) {
    throw Error('variant must be simulator, RoArm-M2-S, or RoArm-M2-Pro');
  }
  if (typeof config.firmware !== 'string' || !config.firmware.trim()) throw Error('firmware must be a nonempty string');
  for (const key of ['fixtureConfirmed', 'clearanceConfirmed', 'limitsConfirmed']) {
    if (config[key] !== true) throw Error(`${key} must be explicitly confirmed`);
  }
  if ((config.variant === 'simulator') !== (config.firmware === 'simulator')) {
    throw Error('simulator variant and simulator firmware must be specified together');
  }
  // Returning confirmation fields does not verify hardware. Controller separately
  // requires its ignored, evidence-backed physical profile before commissioning.
  return {
    variant: config.variant,
    firmware: config.firmware.trim(),
    fixtureConfirmed: true,
    clearanceConfirmed: true,
    limitsConfirmed: true
  };
}
