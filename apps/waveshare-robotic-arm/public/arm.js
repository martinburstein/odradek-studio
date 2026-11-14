import { forwardKinematics, GEOMETRY } from './kinematics.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const COLORS = Object.freeze({ orange: '#ff7a00', hot: '#ff9d2e', body: '#ffd9b0', muted: '#d08a43', cool: '#4aa3dd', green: '#53f0a2', dark: '#080304', line: '#462000' });
const DEFAULT_SEED = Object.freeze({ base: 0, shoulder: 0.8, elbow: 1.2, gripper: 1.57 });
const PIXELS_PER_MM = 0.34;
let renderSequence = 0;

function element(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  parent?.append(node);
  return node;
}

function text(parent, x, y, value, attrs = {}) {
  const node = element('text', { x, y, ...attrs }, parent);
  node.textContent = value;
  return node;
}

function validJoints(value) {
  if (!value || typeof value !== 'object') return null;
  const joints = value.joints ?? value.target ?? value.commanded ?? value;
  if (!joints || typeof joints !== 'object' || !['base', 'shoulder', 'elbow', 'gripper'].every(key => Number.isFinite(joints[key]))) return null;
  return Object.fromEntries(['base', 'shoulder', 'elbow', 'gripper'].map(key => [key, joints[key]]));
}

function directCartesian(value) {
  if (!value || typeof value !== 'object') return null;
  const point = value.cartesian ?? value.point ?? value.target ?? value;
  if (!point || typeof point !== 'object' || !['x', 'y', 'z', 't'].every(key => Number.isFinite(point[key]))) return null;
  return { x: point.x, y: point.y, z: point.z, t: point.t };
}

/** Exact millimetre endpoints from the pinned nominal source geometry. */
export function projectPose(joints, { centerX = 323, groundY = 340, pixelsPerMm = PIXELS_PER_MM } = {}) {
  const end = forwardKinematics(joints);
  const shoulderAngle = joints.shoulder + GEOMETRY.t2rad;
  const elbow = {
    radial: GEOMETRY.l2 * Math.sin(shoulderAngle),
    z: GEOMETRY.l2 * Math.cos(shoulderAngle)
  };
  const radial = Math.hypot(end.x, end.y);
  const px = value => Number((centerX + value * pixelsPerMm).toFixed(6));
  const py = value => Number((groundY - value * pixelsPerMm).toFixed(6));
  return {
    base: { x: centerX, y: groundY },
    elbow: { radial: elbow.radial, z: elbow.z, x: px(elbow.radial), y: py(elbow.z) },
    endEffector: { radial, x: px(radial), y: py(end.z), z: end.z },
    cartesian: end,
    yaw: joints.base
  };
}

function drawLayer(svg, joints, { color, label, dashed = false, opacity = 1 }) {
  const p = projectPose(joints);
  const strokeWidth = dashed ? 5 : 10;
  const attrs = { fill: 'none', stroke: color, 'stroke-width': strokeWidth, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity };
  if (dashed) attrs['stroke-dasharray'] = '8 7';
  const group = element('g', { role: 'img', 'aria-label': `${label} nominal geometry projection` }, svg);
  element('path', { d: `M ${p.base.x} ${p.base.y} L ${p.elbow.x} ${p.elbow.y} L ${p.endEffector.x} ${p.endEffector.y}`, ...attrs }, group);
  for (const [point, radius] of [[p.base, 11], [p.elbow, 9], [p.endEffector, 7]]) {
    element('circle', { cx: point.x, cy: point.y, r: radius, fill: COLORS.dark, stroke: color, 'stroke-width': dashed ? 3 : 4, opacity }, group);
  }

  // Jaw shape is a visual cue only: no calibrated opening or tool geometry is known.
  const grip = p.endEffector;
  const orientation = joints.shoulder + joints.elbow + joints.gripper;
  const gap = Math.max(3, Math.min(11, Math.abs(Math.sin(joints.gripper)) * 9));
  const length = 30;
  const dx = Math.cos(orientation), dy = -Math.sin(orientation);
  const nx = -dy, ny = dx;
  const tip = { x: grip.x + dx * length, y: grip.y + dy * length };
  const jaw = { stroke: color, 'stroke-width': dashed ? 3 : 4, 'stroke-linecap': 'round', opacity };
  if (dashed) jaw['stroke-dasharray'] = '6 5';
  element('path', { d: `M ${grip.x + nx * gap} ${grip.y + ny * gap} L ${tip.x + nx * gap * 1.5} ${tip.y + ny * gap * 1.5} M ${grip.x - nx * gap} ${grip.y - ny * gap} L ${tip.x - nx * gap * 1.5} ${tip.y - ny * gap * 1.5}`, fill: 'none', ...jaw }, group);

  // Top view shows base yaw separately from the radial side elevation.
  const cx = 610, cy = 92, radius = 36;
  element('circle', { cx, cy, r: radius, fill: 'none', stroke: COLORS.line, 'stroke-width': 2 }, group);
  element('line', { x1: cx, y1: cy, x2: cx + radius * Math.cos(joints.base), y2: cy - radius * Math.sin(joints.base), stroke: color, 'stroke-width': 3, 'stroke-linecap': 'round', ...(dashed ? { 'stroke-dasharray': '6 5' } : {}) }, group);
}

function appendLegend(parent, color, label, detail, dashed = false) {
  const item = document.createElement('div');
  item.style.cssText = 'display:flex;align-items:center;gap:7px;min-width:0;font:12px Segoe UI,sans-serif;color:#ffd9b0';
  const mark = document.createElement('span');
  mark.setAttribute('aria-hidden', 'true');
  mark.style.cssText = `display:inline-block;width:22px;height:0;border-top:3px ${dashed ? 'dashed' : 'solid'} ${color};flex:0 0 auto`;
  const labelNode = document.createElement('span');
  labelNode.textContent = `${label} · ${detail}`;
  item.append(mark, labelNode);
  parent.append(item);
}

function row(parent, label, values, color, units, absent) {
  const line = document.createElement('div');
  line.style.cssText = 'display:grid;grid-template-columns:minmax(145px,1.3fr) repeat(4,minmax(0,1fr));gap:5px;padding:6px 0;border-bottom:1px solid rgba(143,67,0,.38);font:11px Consolas,monospace;min-width:0';
  const labelNode = document.createElement('span'); labelNode.textContent = label; labelNode.style.color = color; line.append(labelNode);
  for (const [index, key] of ['base', 'shoulder', 'elbow', 'gripper'].entries()) {
    const node = document.createElement('span');
    node.textContent = values ? `${values[key].toFixed(2)} ${units}` : '—';
    node.title = values ? `${key}: ${values[key].toFixed(3)} ${units}` : absent;
    node.style.color = values ? COLORS.body : COLORS.muted;
    line.append(node);
  }
  parent.append(line);
}

function pointRow(parent, label, point, color, absent) {
  const line = document.createElement('div');
  line.style.cssText = 'display:grid;grid-template-columns:minmax(145px,1.3fr) repeat(4,minmax(0,1fr));gap:5px;padding:6px 0;border-bottom:1px solid rgba(143,67,0,.38);font:11px Consolas,monospace;min-width:0';
  const labelNode = document.createElement('span'); labelNode.textContent = label; labelNode.style.color = color; line.append(labelNode);
  for (const key of ['x', 'y', 'z', 't']) {
    const node = document.createElement('span');
    node.textContent = point ? `${point[key].toFixed(1)} ${key === 't' ? 'rad' : 'mm'}` : '—';
    node.title = point ? `${key.toUpperCase()}: ${point[key].toFixed(2)} ${key === 't' ? 'rad' : 'mm'}` : absent;
    node.style.color = point ? COLORS.body : COLORS.muted;
    line.append(node);
  }
  parent.append(line);
}

function freshHardwareMeasurement(state, joints) {
  const sample = state.measured;
  if (!joints || !sample || typeof sample !== 'object' || sample.source !== 'hardware' || state.connected !== true || !['serial', 'http'].includes(state.mode)) return false;
  const timestamp = sample.observedAt ?? state.telemetryUpdatedAt;
  const age = Date.now() - Date.parse(timestamp);
  return Number.isFinite(age) && age >= 0 && age <= 5000;
}

export function renderArm(container, state = {}) {
  if (!container || typeof container.replaceChildren !== 'function' || typeof document === 'undefined') throw new TypeError('renderArm requires a DOM container');
  const data = state && typeof state === 'object' ? state : {};
  const id = ++renderSequence;
  const commanded = validJoints(data.commanded);
  const measuredCandidate = validJoints(data.measured);
  const measured = freshHardwareMeasurement(data, measuredCandidate) ? measuredCandidate : null;
  const simulatedValue = data.simulated && typeof data.simulated === 'object' ? data.simulated : null;
  const simulated = data.simulated === true || simulatedValue ? validJoints(simulatedValue) : null;
  const commandedCartesian = directCartesian(data.commanded);
  const measuredCartesianCandidate = directCartesian(data.measured);
  const measuredCartesian = measured ? measuredCartesianCandidate : null;
  const simulatedCartesian = directCartesian(simulatedValue);
  const commandedEstimate = commanded && !commandedCartesian ? forwardKinematics(commanded) : null;
  const simulatedEstimate = simulated && !simulatedCartesian ? forwardKinematics(simulated) : null;

  const root = document.createElement('section');
  root.className = 'arm-visualization';
  root.setAttribute('aria-label', 'RoArm-M2 nominal linkage visualization and state provenance');
  root.style.cssText = "display:grid;gap:9px;color:#ffd9b0;font-family:'Segoe UI',sans-serif;min-width:0;width:100%;box-sizing:border-box";
  const svg = element('svg', { viewBox: '0 0 720 410', role: 'img', 'aria-labelledby': `arm-title-${id} arm-desc-${id}`, preserveAspectRatio: 'xMidYMid meet', style: 'display:block;width:100%;height:auto;min-height:210px;background:radial-gradient(ellipse at 48% 65%,rgba(143,67,0,.12),transparent 55%),rgba(6,6,6,.35);border:1px solid rgba(143,67,0,.48);border-radius:10px' });
  const titleNode = element('title', { id: `arm-title-${id}` }, svg); titleNode.textContent = 'RoArm-M2 nominal EEMode 0 linkage projection';
  const desc = element('desc', { id: `arm-desc-${id}` }, svg); desc.textContent = 'Side projection uses pinned nominal firmware link lengths and shoulder plus elbow angles; a separate top-view cue shows base yaw. It is not calibrated physical geometry.';
  for (let x = 28; x <= 700; x += 34) element('line', { x1: x, y1: 25, x2: x, y2: 365, stroke: 'rgba(255,122,0,.06)', 'stroke-width': 1 }, svg);
  for (let y = 35; y <= 375; y += 34) element('line', { x1: 20, y1: y, x2: 700, y2: y, stroke: 'rgba(255,122,0,.06)', 'stroke-width': 1 }, svg);
  text(svg, 25, 20, 'SIDE ELEVATION · RADIAL / Z', { fill: COLORS.muted, 'font-size': 10, 'font-family': 'Consolas,monospace' });
  text(svg, 574, 20, 'TOP VIEW · BASE YAW', { fill: COLORS.muted, 'font-size': 10, 'font-family': 'Consolas,monospace', 'text-anchor': 'middle' });
  text(svg, 574, 145, 'yaw direction', { fill: COLORS.muted, 'font-size': 9, 'font-family': 'Consolas,monospace', 'text-anchor': 'middle' });
  // Fixed structure is a static schematic cue, never a pose fallback.
  element('path', { d: 'M 272 367 L 272 350 Q 272 342 284 342 L 362 342 Q 374 342 374 350 L 374 367 Z', fill: '#1b0b0e', stroke: COLORS.line, 'stroke-width': 2 }, svg);
  element('ellipse', { cx: 323, cy: 342, rx: 51, ry: 10, fill: '#251015', stroke: COLORS.orange, 'stroke-width': 2 }, svg);
  element('line', { x1: 323, y1: 336, x2: 323, y2: 110, stroke: COLORS.line, 'stroke-width': 5 }, svg);
  text(svg, 323, 390, `Nominal l2 ${GEOMETRY.l2.toFixed(1)} mm · l3 ${GEOMETRY.l3.toFixed(1)} mm · l1 ${GEOMETRY.l1.toFixed(1)} mm base dimension`, { fill: COLORS.muted, 'font-size': 9, 'font-family': 'Consolas,monospace', 'text-anchor': 'middle' });

  const staticPose = element('g', { role: 'img', 'aria-label': 'Static schematic silhouette, not live pose' }, svg);
  // Neutral outline is explicitly static and deliberately not supplied by any unknown state.
  const ref = projectPose(DEFAULT_SEED);
  element('path', { d: `M ${ref.base.x} ${ref.base.y} L ${ref.elbow.x} ${ref.elbow.y} L ${ref.endEffector.x} ${ref.endEffector.y}`, fill: 'none', stroke: '#8b6038', 'stroke-width': 5, 'stroke-dasharray': '7 7', opacity: 0.42 }, staticPose);
  const layers = [
    { joints: simulated, color: COLORS.green, label: 'Simulated', dashed: false, opacity: 0.9 },
    { joints: measured, color: COLORS.cool, label: 'Measured hardware feedback', dashed: false, opacity: 0.86 },
    { joints: commanded, color: COLORS.hot, label: 'Commanded target', dashed: true, opacity: 0.95 }
  ];
  for (const layer of layers) if (layer.joints) drawLayer(svg, layer.joints, layer);

  const axes = element('g', { 'aria-label': 'Side projection axes' }, svg);
  element('line', { x1: 44, y1: 342, x2: 93, y2: 342, stroke: COLORS.orange, 'stroke-width': 2 }, axes);
  element('line', { x1: 44, y1: 342, x2: 44, y2: 294, stroke: COLORS.cool, 'stroke-width': 2 }, axes);
  text(axes, 96, 346, '+radial', { fill: COLORS.orange, 'font-size': 9 }); text(axes, 48, 290, '+Z', { fill: COLORS.cool, 'font-size': 9 });

  const legend = document.createElement('div'); legend.setAttribute('aria-label', 'Pose source legend'); legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:7px 15px;padding:2px';
  appendLegend(legend, COLORS.hot, 'Commanded', commanded ? 'target' : 'unavailable', true);
  appendLegend(legend, COLORS.cool, 'Measured', measured ? 'fresh hardware sample' : 'no fresh hardware sample');
  appendLegend(legend, COLORS.green, 'Simulated', simulated ? 'simulator state' : data.simulated ? 'pose unavailable' : 'inactive');
  appendLegend(legend, '#8b6038', 'Schematic', 'static silhouette', true);

  const jointRows = document.createElement('div'); jointRows.setAttribute('aria-label', 'Source-qualified joint values in radians'); jointRows.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr);min-width:0';
  const header = document.createElement('div'); header.style.cssText = 'display:grid;grid-template-columns:minmax(145px,1.3fr) repeat(4,minmax(0,1fr));gap:5px;font:10px Consolas,monospace;color:#d08a43';
  for (const heading of ['JOINT STATE', 'BASE', 'SHOULDER', 'ELBOW', 'GRIPPER']) { const h = document.createElement('span'); h.textContent = heading; header.append(h); }
  jointRows.append(header);
  row(jointRows, 'Commanded · rad', commanded, COLORS.hot, 'rad', 'No command target');
  row(jointRows, 'Measured hardware · rad', measured, COLORS.cool, 'rad', 'No fresh explicitly sourced hardware feedback');
  row(jointRows, 'Simulated · rad', simulated, COLORS.green, 'rad', 'No simulator pose');

  const points = document.createElement('div'); points.setAttribute('aria-label', 'Source-qualified Cartesian position in millimetres and radians'); points.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr);min-width:0';
  const pointHeader = document.createElement('div'); pointHeader.style.cssText = 'display:grid;grid-template-columns:minmax(145px,1.3fr) repeat(4,minmax(0,1fr));gap:5px;font:10px Consolas,monospace;color:#d08a43';
  for (const heading of ['CARTESIAN SOURCE', 'X · MM', 'Y · MM', 'Z · MM', 'T · RAD']) { const h = document.createElement('span'); h.textContent = heading; pointHeader.append(h); }
  points.append(pointHeader);
  pointRow(points, 'Model estimate · command', commandedCartesian ?? commandedEstimate, COLORS.hot, 'No Cartesian target or joint target');
  pointRow(points, 'Hardware telemetry', measuredCartesian, COLORS.cool, 'No fresh hardware Cartesian telemetry');
  pointRow(points, 'Simulator point', simulatedCartesian ?? simulatedEstimate, COLORS.green, 'No simulator Cartesian point');

  const note = document.createElement('p');
  note.textContent = `Nominal firmware geometry only · EEMode 0 · pinned ${GEOMETRY.firmwareRevision.slice(0, 12)} · l1 ${GEOMETRY.l1.toFixed(2)} mm is documented but omitted from this FK projection · jaw dimensions are illustrative and uncalibrated. Model estimates are not telemetry; physical geometry and calibration remain unverified.`;
  note.style.cssText = 'margin:0;color:#d08a43;font:11px Segoe UI,sans-serif;line-height:1.45';
  root.append(svg, legend, jointRows, points, note);
  container.replaceChildren(root);
  return root;
}

export { DEFAULT_SEED };
