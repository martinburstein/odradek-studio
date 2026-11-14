export const JOINTS = [
  {key:'base', name:'Base', servo:'SERVO 11', detail:'Signed motor angle · not compass heading', offset:0},
  {key:'shoulder', name:'Shoulder', servo:'SERVOS 12 + 13', detail:'Paired motors · only servo 12 reports position', offset:90},
  {key:'elbow', name:'Elbow', servo:'SERVO 14', detail:'Bend the forearm', offset:0},
  {key:'gripper', name:'Gripper', servo:'SERVO 15', detail:'Motor angle · not jaw opening', offset:0},
];
export const degrees = (key, radians) => radians * 180 / Math.PI + JOINTS.find(j=>j.key===key).offset;
export const radians = (key, value) => (value - JOINTS.find(j=>j.key===key).offset) * Math.PI / 180;
// Manufacturer command ranges for the stock clamp, not collision-free travel.
// The radian clamp documentation starts at 1.08 rad (~61.9 motor degrees).
// Its separate 45-degree example conflicts with the pinned 700-tick clamp.
export const DOCUMENTED_DEGREES=Object.freeze({base:[-180,180],shoulder:[0,180],elbow:[0,180],gripper:[61.9,179.9]});
export function displayBounds(key,status){return status?.mode==='simulator'?bounds(key,status.limits):DOCUMENTED_DEGREES[key];}
// Round inward: a rounded endpoint must never offer travel outside the server envelope.
export function bounds(key, limits) {
  const raw=limits?.[key];
  if(!Array.isArray(raw)||raw.length!==2||!raw.every(Number.isFinite)||raw[0]>=raw[1])throw Error('Controller limits unavailable');
  return [Math.ceil(degrees(key,raw[0])*10)/10, Math.floor(degrees(key,raw[1])*10)/10];
}
export function poseOf(status) { return status?.mode==='simulator'?status.simulated:status?.measured; }
export function blockedReason(status, now=Date.now(), allowAcquire=false) {
  if(!status?.connected)return 'Connect a setup to begin.';
  if(status.mode==='simulator'&&!status.commissioned)return 'Simulator setup required.';
  if(status.mode!=='simulator'&&(status.armed||status.commissioned))return 'Disable legacy controls before manual requests.';
  if(status.mode!=='simulator'&&status.manual?.ready!==true)return status.manual?.reason||'All-joint calibration is not yet complete.';
  if(status.mode!=='simulator'&&status.movement?.historyReady!==true)return 'Movement history needs reconciliation.';
  if(status.ownership?.active&&!status.ownership.ownedByThisDevice)return 'Another control session owns these controls.';
  if(!allowAcquire&&(!status.ownership?.ownedByThisDevice||!status.ownership.active))return 'This console needs control ownership.';
  if(status.mode==='simulator'&&!status.armed)return 'Moves are disabled. Enable when ready.';
  const e=status.execution??{};
  if(status.task?.active||e.busy||e.lifecycle||e.cleanupPending||e.outstandingTransportOperations||e.recoveryRequired)return 'Controller busy or waiting for cleanup.';
  const age=now-Date.parse(status.telemetryUpdatedAt);
  if(!Number.isFinite(age)||age<0||age>5000||!poseOf(status))return 'Waiting for fresh position feedback.';
  return '';
}
export function moveRequest(status, key, value, now=Date.now()) {
  const reason=blockedReason(status,now);if(reason)throw Error(reason);
  if(!JOINTS.some(j=>j.key===key))throw Error('Unknown joint');
  if(typeof value==='string'&&!value.trim())throw Error('Enter a target angle.');
  const numeric=Number(value), [min,max]=displayBounds(key,status);
  if(!Number.isFinite(numeric)||numeric<min||numeric>max)throw Error(`Choose ${min}° to ${max}°.`);
  const current=poseOf(status), target={};
  if(status.mode!=='simulator'){
    if(!JOINTS.every(j=>Number.isFinite(current[j.key])))throw Error('Complete measured pose required.');
    const steps=Math.round((numeric-degrees(key,current[key]))/(360/4096));
    if(Math.abs(steps)<2)throw Error('Choose a target at least two encoder ticks away.');
    return {owner:status.owner,move:{joint:key,targetDegrees:numeric}};
  }
  for(const j of JOINTS){
    const raw=current[j.key], range=status.limits[j.key];
    if(!Number.isFinite(raw)||!range||raw<range[0]||raw>range[1])throw Error('Current pose is outside the configured movement window.');
    target[j.key]=raw;
  }
  target[key]=radians(key,numeric);
  if(status.mode!=='simulator'&&Math.abs(target[key]-current[key])>0.08)throw Error('Choose a smaller step: at most 4.5° from the current angle.');
  return {kind:'joints',target,owner:status.owner};
}
