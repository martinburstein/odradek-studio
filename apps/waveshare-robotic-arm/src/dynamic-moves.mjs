import { normalizeMove } from './motion-config.mjs';
import { SIMULATOR_SEED } from './simulator.mjs';
import { validateJoints } from './safety.mjs';

const PLAYBACK_MS_PER_STEP = 900;
const PHYSICAL_QUALIFICATION = 'unqualified; each new trajectory requires Controller/Pilot physical admission';

const definitions = [
  {
    name: 'sentry-scan', title: 'Sentry Scan',
    description: 'A compact left-right scan with a short upward glance, returning to the starting pose.',
    moves: [
      { joint: 'base', degrees: -7 }, { joint: 'elbow', degrees: 6 },
      { joint: 'base', degrees: 14 }, { joint: 'elbow', degrees: -6 },
      { joint: 'base', degrees: -7 }
    ], pausesMs: [350, 150, 700, 250, 500]
  },
  {
    name: 'double-take', title: 'Double Take',
    description: 'Two base out-and-back looks: the first is brief, the second lingers, then the elbow gives a small check.',
    moves: [
      { joint: 'base', degrees: 6 }, { joint: 'base', degrees: -6 },
      { joint: 'base', degrees: 10 }, { joint: 'base', degrees: -10 },
      { joint: 'elbow', degrees: 6 }, { joint: 'elbow', degrees: -6 }
    ], pausesMs: [100, 140, 650, 900, 300, 520]
  },
  {
    name: 'triple-nod', title: 'Triple Nod',
    description: 'Three distinct elbow nods that grow in size, each returning before the next begins.',
    moves: [
      { joint: 'elbow', degrees: 3 }, { joint: 'elbow', degrees: -3 },
      { joint: 'elbow', degrees: 6 }, { joint: 'elbow', degrees: -6 },
      { joint: 'elbow', degrees: 10 }, { joint: 'elbow', degrees: -10 }
    ], pausesMs: [180, 140, 300, 220, 450, 800]
  },
  {
    name: 'pulse-wave', title: 'Pulse Wave',
    description: 'Three elbow pulses that expand in size, each returning to center before the next.',
    moves: [
      { joint: 'elbow', degrees: 2 }, { joint: 'elbow', degrees: -2 },
      { joint: 'elbow', degrees: 5 }, { joint: 'elbow', degrees: -5 },
      { joint: 'elbow', degrees: 9 }, { joint: 'elbow', degrees: -9 }
    ], pausesMs: [120, 160, 260, 220, 420, 800]
  },
  {
    name: 'butterfly', title: 'Butterfly',
    description: 'Two gentle claw open-close flutters followed by a shallow left-right base sweep.',
    moves: [
      { joint: 'gripper', degrees: -5 }, { joint: 'gripper', degrees: 5 },
      { joint: 'gripper', degrees: -8 }, { joint: 'gripper', degrees: 8 },
      { joint: 'base', degrees: -5 }, { joint: 'base', degrees: 5 },
      { joint: 'base', degrees: 8 }, { joint: 'base', degrees: -8 }
    ], pausesMs: [160, 180, 220, 300, 220, 180, 420, 760]
  },
  {
    name: 'corkscrew', title: 'Corkscrew',
    description: 'An expanding alternating base-and-elbow spiral that unwinds along the same small steps.',
    moves: [
      { joint: 'base', degrees: 3 }, { joint: 'elbow', degrees: 3 },
      { joint: 'base', degrees: 7 }, { joint: 'elbow', degrees: 7 },
      { joint: 'base', degrees: -3 }, { joint: 'elbow', degrees: -3 },
      { joint: 'base', degrees: -7 }, { joint: 'elbow', degrees: -7 }
    ], pausesMs: [160, 220, 260, 330, 300, 360, 450, 720]
  },
  {
    name: 'conductor', title: 'Conductor',
    description: 'A measured six-beat cue with alternating base and elbow accents.',
    moves: [
      { joint: 'base', degrees: 5 }, { joint: 'elbow', degrees: 6 },
      { joint: 'base', degrees: -10 }, { joint: 'elbow', degrees: -10 },
      { joint: 'base', degrees: 5 }, { joint: 'elbow', degrees: 4 }
    ], pausesMs: [500, 240, 180, 520, 260, 900]
  },
  {
    name: 'pincer-flourish', title: 'Pincer Flourish',
    description: 'A small claw opening and return framed by two light elbow accents.',
    moves: [
      { joint: 'elbow', degrees: 6 }, { joint: 'gripper', degrees: -8 },
      { joint: 'elbow', degrees: -10 }, { joint: 'gripper', degrees: 6 },
      { joint: 'elbow', degrees: 4 }, { joint: 'gripper', degrees: 2 }
    ], pausesMs: [260, 180, 420, 180, 500, 850]
  },
  {
    name: 'stalking-peek', title: 'Stalking Peek',
    description: 'A quiet forward glance, a low elbow dip, and a careful return.',
    moves: [
      { joint: 'base', degrees: 6 }, { joint: 'elbow', degrees: 8 },
      { joint: 'base', degrees: -10 }, { joint: 'elbow', degrees: -10 },
      { joint: 'base', degrees: 4 }, { joint: 'elbow', degrees: 2 }
    ], pausesMs: [700, 500, 260, 620, 360, 950]
  },
  {
    name: 'odradek-fanfare', title: 'Odradek Fanfare',
    description: 'A short flourish combining a claw pulse, base accent, elbow rise, and a final small claw open-close.',
    moves: [
      { joint: 'elbow', degrees: 8 }, { joint: 'gripper', degrees: -6 },
      { joint: 'base', degrees: 6 }, { joint: 'elbow', degrees: -10 },
      { joint: 'gripper', degrees: 4 }, { joint: 'base', degrees: -6 },
      { joint: 'elbow', degrees: 2 }, { joint: 'gripper', degrees: 2 },
      { joint: 'gripper', degrees: -3 }, { joint: 'gripper', degrees: 3 }
    ], pausesMs: [240, 180, 220, 420, 180, 300, 520, 500, 220, 850]
  }
].map(definition => ({
  ...definition,
  moves: definition.moves.map(normalizeMove)
}));

const excursionLimits = Object.freeze({ base: 10, elbow: 10, gripper: 10 });
const names = new Set(definitions.map(definition => definition.name));
if (names.size !== 10) throw new Error('Dynamic move catalog must contain ten unique IDs');

for (const definition of definitions) {
  if (definition.moves.length < 3 || definition.moves.length > 10 || definition.pausesMs.length !== definition.moves.length) {
    throw new Error(`Invalid dynamic move shape: ${definition.name}`);
  }
  const sum = { base: 0, elbow: 0, gripper: 0 };
  const min = { ...sum }, max = { ...sum };
  const joints = { ...SIMULATOR_SEED };
  for (const [index, move] of definition.moves.entries()) {
    if (!Number.isInteger(definition.pausesMs[index]) || definition.pausesMs[index] < 0 || definition.pausesMs[index] > 1500) {
      throw new Error(`Invalid pause in dynamic move: ${definition.name}`);
    }
    sum[move.joint] += move.degrees;
    if (sum.gripper > 0) throw new Error('A dynamic routine cannot close beyond its starting claw position');
    min[move.joint] = Math.min(min[move.joint], sum[move.joint]);
    max[move.joint] = Math.max(max[move.joint], sum[move.joint]);
    joints[move.joint] += move.degrees * Math.PI / 180;
    validateJoints(joints);
  }
  for (const joint of Object.keys(sum)) {
    if (Math.abs(sum[joint]) > 1e-9 || Math.max(Math.abs(min[joint]), Math.abs(max[joint])) > excursionLimits[joint]) {
      throw new Error(`Dynamic move does not return safely to its start: ${definition.name}/${joint}`);
    }
  }
}

function copyMove(definition) {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    moves: definition.moves.map(move => ({ ...move })),
    pausesMs: [...definition.pausesMs],
    seconds: 300
  };
}

export function dynamicMove(name) {
  const definition = definitions.find(candidate => candidate.name === name);
  if (!definition) throw new Error(`Unknown dynamic move: ${name}`);
  return copyMove(definition);
}

export function dynamicMoves() {
  return definitions.map(definition => ({
    name: definition.name,
    title: definition.title,
    description: definition.description,
    axes: [...new Set(definition.moves.map(move => move.joint))],
    estimatedPlaybackMs: definition.pausesMs.reduce((sum, pause) => sum + pause, 0) + definition.moves.length * PLAYBACK_MS_PER_STEP,
    physicalQualification: PHYSICAL_QUALIFICATION
  }));
}
