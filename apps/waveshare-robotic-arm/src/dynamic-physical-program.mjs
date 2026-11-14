import {tabletopGeometryPolicy,TABLETOP_CLEARANCE_REVISION} from './training-envelope.mjs';
import {dynamicMove} from './dynamic-moves.mjs';
import {SERVO_STEP,commandForTicks,feedbackAtTicks} from './z-lift-actuators.mjs';
import {trainingBodyBounds} from './training-envelope.mjs';

export const DYNAMIC_PHYSICAL_PROGRAM_REVISION='dynamic-named-held-shoulder-t101-v1';
export const DYNAMIC_REFERENCE_TICKS=Object.freeze({base:2038,shoulder:2054,elbow:2052,gripper:2047});
export const DYNAMIC_PROGRAM_POLICY=Object.freeze({
  maxStartDriftTicks:1,
  maxAxisOffsetDegrees:10,
  maxSteps:10,
  maxPauseMs:1500,
  sessionSeconds:300,
  speedStepsPerSecond:20,
  acceleration:1,
  freshFeedbackMaxAgeMs:500,
  uncertaintyRad:0.0465+SERVO_STEP,
  maximumGridStepRad:0.004,
  requiredBodyHeightMm:0,
  requiredSelfSeparationMm:24
});

const JOINTS=Object.freeze(['base','shoulder','elbow','gripper']);
const MOVABLE=Object.freeze(['base','elbow','gripper']);
const JOINT_ID=Object.freeze({base:1,elbow:3,gripper:4});
const EXACT_INPUT=['name','start','sourceHashes','now'];
const EXACT_START=['ticks','observedAt','source','commandId','historyRowSHA256'];
const MINIMUM_SOURCES=Object.freeze([
  'src/dynamic-moves.mjs','src/motion-config.mjs','src/simulator.mjs','src/z-lift-actuators.mjs','src/training-envelope.mjs',
  'src/safety.mjs','src/dynamic-physical-program.mjs'
]);
const hashPattern=/^[a-f0-9]{64}$/;
const exactKeys=(obj,keys,label)=>{
  if(!obj||typeof obj!=='object'||Array.isArray(obj))throw Error(`${label} must be an object`);
  const names=Object.keys(obj);
  if(names.length!==keys.length||keys.some(key=>!Object.hasOwn(obj,key))||names.some(key=>!keys.includes(key)))throw Error(`${label} has an invalid field set`);
};
const roundServo=x=>Math.sign(x)*Math.floor(Math.abs(x)+0.5);
const axisGap=(a,b)=>Math.max(...[0,1,2].map(k=>Math.max(a.min[k]-b.max[k],b.min[k]-a.max[k])));
const range=(lo,hi,step)=>{
  const count=Math.max(1,Math.ceil((hi-lo)/step));
  return Array.from({length:count+1},(_,index)=>lo+(hi-lo)*index/count);
};
const freezeDeep=value=>{
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const child of Object.values(value))freezeDeep(child);
    Object.freeze(value);
  }
  return value;
};

function validateStart(start,now){
  exactKeys(start,EXACT_START,'start');
  exactKeys(start.ticks,JOINTS,'start.ticks');
  for(const joint of JOINTS){
    const tick=start.ticks[joint],reference=DYNAMIC_REFERENCE_TICKS[joint];
    if(!Number.isInteger(tick)||Math.abs(tick-reference)>DYNAMIC_PROGRAM_POLICY.maxStartDriftTicks)throw Error(`Fresh start ${joint} tick is outside the fixed reference plus one tick`);
  }
  if(start.source!=='T:1051'||!Number.isInteger(start.observedAt)||start.observedAt>now||now-start.observedAt>DYNAMIC_PROGRAM_POLICY.freshFeedbackMaxAgeMs)throw Error('Fresh T:1051 baseline feedback within 500 ms is required');
  if(typeof start.commandId!=='string'||!start.commandId.trim()||!hashPattern.test(start.historyRowSHA256??''))throw Error('Start must bind a history command and SHA-256 row');
  return {ticks:Object.fromEntries(JOINTS.map(k=>[k,start.ticks[k]])),observedAt:start.observedAt,source:start.source,commandId:start.commandId,historyRowSHA256:start.historyRowSHA256};
}

function validateSources(sourceHashes){
  if(!sourceHashes||typeof sourceHashes!=='object'||Array.isArray(sourceHashes))throw Error('sourceHashes must be an object');
  for(const path of MINIMUM_SOURCES)if(!hashPattern.test(sourceHashes[path]??''))throw Error(`Missing source hash: ${path}`);
  for(const [path,hash] of Object.entries(sourceHashes))if(!path||!hashPattern.test(hash))throw Error('Every sourceHashes entry must contain a SHA-256 digest');
  return Object.fromEntries(Object.entries(sourceHashes).sort(([a],[b])=>a.localeCompare(b)));
}

function checkWholePath(startTicks,allTargetTicks){
  const poses=[startTicks,...allTargetTicks].map(ticks=>feedbackAtTicks(ticks));
  const u=DYNAMIC_PROGRAM_POLICY.uncertaintyRad,step=DYNAMIC_PROGRAM_POLICY.maximumGridStepRad;
  const bounds={
    shoulder:[Math.min(...poses.map(p=>p.shoulder))-u,Math.max(...poses.map(p=>p.shoulder))+u],
    elbow:[Math.min(...poses.map(p=>p.elbow))-u,Math.max(...poses.map(p=>p.elbow))+u],
    gripper:[Math.min(...poses.map(p=>p.gripper))-u,Math.max(...poses.map(p=>p.gripper))+u]
  };
  const grid={shoulder:range(...bounds.shoulder,step),elbow:range(...bounds.elbow,step),gripper:range(...bounds.gripper,step)};
  const minima={upperFree:Infinity,distal:Infinity,finger:Infinity};let selfSeparation=Infinity,gridConfigurations=0;
  const base=poses[0].base;
  for(const shoulder of grid.shoulder)for(const elbow of grid.elbow)for(const gripper of grid.gripper){
    const body=trainingBodyBounds({base,shoulder,elbow,gripper});gridConfigurations++;
    for(const key of Object.keys(minima))minima[key]=Math.min(minima[key],body[key].min[2]);
    selfSeparation=Math.min(selfSeparation,
      axisGap(body.upper,body.distalBeyondJoint),axisGap(body.upper,body.finger),
      axisGap(body.mount,body.distal),axisGap(body.mount,body.finger));
  }
  const interpolationRemainderMm=2,floorPolicy=tabletopGeometryPolicy();
  for(const k of Object.keys(minima))minima[k]+=floorPolicy.modelHeightOffsetMm;
  if(Object.values(minima).some(height=>height<DYNAMIC_PROGRAM_POLICY.requiredBodyHeightMm)||selfSeparation<DYNAMIC_PROGRAM_POLICY.requiredSelfSeparationMm)throw Error('Whole-path dynamic geometry fails the actual tabletop plane / 24 mm separation checks');
  return Object.freeze({
    revision:'dynamic-whole-path-training-bounds-v1',...floorPolicy.fields,plane:floorPolicy.plane,wholePathChecked:true,
    uncertaintyRad:u,maximumGridStepRad:step,interpolationRemainderMm,gridConfigurations,
    minimumBodyHeightMm:Object.freeze(minima),requiredBodyHeightMm:DYNAMIC_PROGRAM_POLICY.requiredBodyHeightMm,
    minimumSelfSeparationMm:selfSeparation,requiredSelfSeparationMm:DYNAMIC_PROGRAM_POLICY.requiredSelfSeparationMm,
    physicalGeometryVerified:false,
    limitations:Object.freeze(['Stock training body bounds and conservative uncertainty model; external workspace, cabling and installed hardware are not measured','Independent physical clearance inspection remains required'])
  });
}

/** Compile one exact catalog routine into a finite, proposal-only T:101 tick program. */
export function compileDynamicPhysicalProgram(input){
  exactKeys(input,EXACT_INPUT,'input');
  const now=input.now;
  if(!Number.isInteger(now)||now<0)throw Error('now must be an integer epoch-millisecond timestamp');
  const start=validateStart(input.start,now),sourceHashes=validateSources(input.sourceHashes),routine=dynamicMove(input.name);
  if(routine.moves.length<3||routine.moves.length>DYNAMIC_PROGRAM_POLICY.maxSteps||routine.pausesMs.length!==routine.moves.length||routine.pausesMs.some(x=>!Number.isInteger(x)||x<0||x>DYNAMIC_PROGRAM_POLICY.maxPauseMs))throw Error('Named routine violates the finite physical-program shape');
  const cumulative={base:0,elbow:0,gripper:0},axisTotals={base:0,elbow:0,gripper:0};
  const targets=[];
  for(const [index,move] of routine.moves.entries()){
    if(!MOVABLE.includes(move.joint)||!Number.isFinite(move.degrees)||!Number.isInteger(move.degrees))throw Error(`Unsupported dynamic move at step ${index}`);
    cumulative[move.joint]+=move.degrees;axisTotals[move.joint]+=move.degrees;
    if(Math.abs(cumulative[move.joint])>DYNAMIC_PROGRAM_POLICY.maxAxisOffsetDegrees+1e-9)throw Error(`Cumulative ${move.joint} offset exceeds ten degrees`);
    const tickOffset=roundServo(cumulative[move.joint]*Math.PI/180/SERVO_STEP);
    const priorTicks=targets.length?targets.at(-1).targetTicks:start.ticks;
    const targetTicks={...priorTicks,[move.joint]:start.ticks[move.joint]+(move.joint==='base'?-tickOffset:tickOffset)};
    const bridgeRanges={base:[1920,2160],shoulder:[2052,2060],elbow:[2000,2389],gripper:[1900,2049]};
    if(JOINTS.some(j=>targetTicks[j]<bridgeRanges[j][0]||targetTicks[j]>bridgeRanges[j][1]))throw Error('Compiled target exceeds the fixed hardware bridge envelope');
    const targetJoints=feedbackAtTicks(targetTicks);
    commandForTicks(targetTicks); // Enforce source integer ranges and exact round trip.
    const logicalCommand=commandForTicks(targetTicks);
    const command={T:101,joint:JOINT_ID[move.joint],rad:logicalCommand[move.joint],spd:DYNAMIC_PROGRAM_POLICY.speedStepsPerSecond,acc:DYNAMIC_PROGRAM_POLICY.acceleration};
    targets.push({index,move:{...move},pauseAfterMs:routine.pausesMs[index],fromTicks:{...priorTicks},targetTicks,targetJoints,command});
  }
  if(MOVABLE.some(joint=>Math.abs(axisTotals[joint])>1e-9)||MOVABLE.some(joint=>targets.at(-1).targetTicks[joint]!==start.ticks[joint]))throw Error('Requested named routine must return exactly to its baseline ticks');
  const geometry=checkWholePath(start.ticks,targets.map(leg=>leg.targetTicks));
  const program={
    schema:'roarm-dynamic-physical-program-v1',revision:DYNAMIC_PHYSICAL_PROGRAM_REVISION,
    name:routine.name,title:routine.title,description:routine.description,
    status:'proposal-only',dispatchAuthorized:false,physicalMovementVerified:false,
    baseline:{...start.ticks},start,sourceHashes,
    finiteSession:{seconds:DYNAMIC_PROGRAM_POLICY.sessionSeconds,legCount:targets.length,maximumLegCount:DYNAMIC_PROGRAM_POLICY.maxSteps,automaticReturn:false,retry:false},
    policy:{...DYNAMIC_PROGRAM_POLICY},requestedOffsetTotals:axisTotals,
    heldJoints:{shoulder:start.ticks.shoulder},legs:targets,geometry,
    requiredProofs:Object.freeze([
      'fresh source-bound Controller/Pilot admission for this exact routine, baseline, target ticks and current source hashes',
      'fresh in-memory camera clearance inspection bound to the exact start history row',
      'current human supervision, power, stop reachability and cable/jaw clearance confirmation',
      'fresh paired-shoulder ID12/ID13 feedback proof; T:1051 alone does not establish both motor samples',
      'installed geometry and external swept-workspace review; this software body-bound check is not physical verification',
      'current guarded shared Controller execution path; this compiler sends no command'
    ]),
    limitations:Object.freeze(['No feedforward compensation: each leg commands the requested absolute cumulative offset from the exact start ticks','Base degree offsets map to the opposite raw command-tick direction; elbow and gripper offsets map directly','All offsets are quantized independently from the fixed start baseline to avoid cumulative rounding drift','No existing qualified elbow-return scope is reused for these arbitrary multi-axis routines'])
  };
  return freezeDeep(program);
}
