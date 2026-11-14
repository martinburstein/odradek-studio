import { GEOMETRY, forwardKinematics } from './kinematics.js';

export const REST_POSE = Object.freeze({ base: 0, shoulder: 0.8, elbow: 1.2, gripper: 1.57 });
export const JOINT_KEYS = Object.freeze(['base', 'shoulder', 'elbow', 'gripper']);
const valid = pose => pose && JOINT_KEYS.every(key => typeof pose[key] === 'number' && Number.isFinite(pose[key]));

/** Only observations can drive the live drawing. Command targets are deliberately ignored. */
export function selectWireObservation(status = {}, now = Date.now()) {
  const source = status.mode === 'simulator' ? 'simulator' : status.mode === 'serial' ? 'hardware' : null;
  const pose = source === 'simulator' ? status.simulated : source === 'hardware' ? status.measured : null;
  const observed = Date.parse(status.telemetryUpdatedAt || '');
  const age = now - observed;
  const state = !status.connected || status.freshness === 'offline' || age > 15000 ? 'offline'
    : !source || !valid(pose) || status.stale || status.freshness === 'stale' || !Number.isFinite(age) || age < 0 || age > 5000 ? 'stale' : 'live';
  return { source, state, observedAt: Number.isFinite(observed) ? observed : null,
    pose: state === 'live' ? Object.fromEntries(JOINT_KEYS.map(key => [key, pose[key]])) : null };
}

export function blendPose(from, to, fraction) {
  const t = Math.max(0, Math.min(1, fraction));
  return Object.fromEntries(JOINT_KEYS.map(key => [key, from[key] + (to[key] - from[key]) * t]));
}

/** Local illustration only; never passed to a transport, API or task runner. */
export function previewPose(seconds) {
  return { base: Math.sin(seconds * 0.36) * 0.65, shoulder: 0.22 + Math.sin(seconds * 0.48) * 0.32,
    elbow: 0.88 + Math.cos(seconds * 0.41) * 0.35, gripper: 1.12 + Math.sin(seconds * 0.7) * 0.4 };
}

/** Wire edges in real 3D coordinates. Link endpoints match the pinned EEMode-0 FK. */
export function buildWireScene(pose) {
  const tip = forwardKinematics(pose);
  const r = GEOMETRY.l2 * Math.sin(pose.shoulder + GEOMETRY.t2rad);
  const elbow = [r * Math.cos(pose.base), r * Math.sin(pose.base), GEOMETRY.l2 * Math.cos(pose.shoulder + GEOMETRY.t2rad)];
  const shoulder = [0, 0, 0], end = [tip.x, tip.y, tip.z];
  const across = [-Math.sin(pose.base), Math.cos(pose.base), 0];
  const edges = [];
  const edge = (a, b, kind = 'arm') => edges.push({ a, b, kind });
  const add = (a, b, scale = 1) => a.map((v, i) => v + b[i] * scale);
  function box(x, y, z, w, d, h, kind) {
    const p = [[x,y,z],[x+w,y,z],[x+w,y+d,z],[x,y+d,z],[x,y,z+h],[x+w,y,z+h],[x+w,y+d,z+h],[x,y+d,z+h]];
    for (const [a,b] of [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]]) edge(p[a],p[b],kind);
  }
  function beam(a, b, width) {
    const axis = b.map((v,i) => v-a[i]), length = Math.hypot(...axis);
    const normal = [-axis[2]*Math.cos(pose.base)/length,-axis[2]*Math.sin(pose.base)/length,(axis[0]*Math.cos(pose.base)+axis[1]*Math.sin(pose.base))/length];
    const corners = point => [-1,1].flatMap(side => [-1,1].map(face => add(add(point,across,side*width),normal,face*9)));
    const p = corners(a), q = corners(b);
    for (let i=0;i<4;i++) edge(p[i],q[i]);
    for (const points of [p,q]) for (const [i,j] of [[0,1],[1,3],[3,2],[2,0]]) edge(points[i],points[j]);
    edge(p[0],q[1],'detail'); edge(p[3],q[2],'detail');
  }
  function hinge(center, radius, halfWidth) {
    const radial = [Math.cos(pose.base), Math.sin(pose.base), 0];
    const rings = [-halfWidth,halfWidth].map(offset => Array.from({length:24},(_,i) => {
      const angle=i*Math.PI/12;
      return add(add(add(center,across,offset),radial,Math.cos(angle)*radius),[0,0,1],Math.sin(angle)*radius);
    }));
    for (const ring of rings) for(let i=0;i<24;i++) edge(ring[i],ring[(i+1)%24],'joint');
    for(let i=0;i<24;i+=6) edge(rings[0][i],rings[1][i],'joint');
  }
  // Keyboard and pedestal are decorative context, not a proposed physical mounting fixture.
  box(-130,-170,-110,650,340,13,'keyboard');
  for(let row=0;row<5;row++) for(let col=0;col<14;col++) {
    if(row===4 && col>3 && col<10) continue;
    box(-108+col*43,-147+row*58,-94,37,46,4,'key');
  }
  box(64,85,-94,253,46,4,'key');
  box(-55,-55,-89,110,110,18,'base');
  box(-31,-31,-71,62,62,60,'base');
  beam(shoulder,elbow,24); beam(elbow,end,18);
  hinge(shoulder,37,32); hinge(elbow,28,25); hinge(end,18,21);
  const direction = [Math.sin(pose.shoulder+pose.elbow)*Math.cos(pose.base),Math.sin(pose.shoulder+pose.elbow)*Math.sin(pose.base),Math.cos(pose.shoulder+pose.elbow)];
  const palm = add(end,direction,27);
  edge(end,palm,'joint');
  const opening = 10 + 20 * Math.abs(Math.sin(pose.gripper));
  for(const side of [-1,1]) {
    const jaw=add(palm,across,side*opening), finger=add(jaw,direction,45);
    edge(add(palm,across,side*10),jaw,'joint'); edge(jaw,finger,'joint'); edge(finger,add(finger,across,-side*10),'joint');
  }
  return { edges, joints: [shoulder,elbow,end], tip: end };
}

export function projectWirePoint(point, { yaw = -0.65, pitch = 0.48, width, height } = {}) {
  const [x,y,z] = [point[0]-140, point[1], point[2]-120];
  const u=x*Math.cos(yaw)-y*Math.sin(yaw), depth=x*Math.sin(yaw)+y*Math.cos(yaw);
  const v=z*Math.cos(pitch)-depth*Math.sin(pitch), distance=depth*Math.cos(pitch)+z*Math.sin(pitch);
  const perspective=1600/(1600-distance), scale=Math.min(width/930,height/670);
  return { x: width/2+u*scale*perspective, y: height/2-v*scale*perspective, depth: distance };
}
