import {tabletopGeometryPolicy,TABLETOP_CLEARANCE_REVISION} from './training-envelope.mjs';
import {createHash} from 'node:crypto';
import {SERVO_STEP, observedTicks, feedbackAtTicks, commandForTicks, commandTicks, assertLiftHealth} from './z-lift-actuators.mjs';
import {Z_LIFT_MODEL_REVISION} from './z-lift-plan.mjs';
import {trainingBodyBounds} from './training-envelope.mjs';
import {adjacentLinkSeparationMm} from './other-joint-plan.mjs';
import {validateReferenceStart} from './reference-pose-start.mjs';

export const REFERENCE_RETURN_SCOPE = 'finite-reference-pose-return-v1';
export const REFERENCE_TARGET_TICKS = Object.freeze({base:2038, shoulder:2054, elbow:2052, gripper:2047});
export const REFERENCE_JOINT_ORDER = Object.freeze(['base','shoulder','elbow','gripper']);
export const REFERENCE_RETURN_POLICY = Object.freeze({
  maximumPerJointTicks:16,
  startAndTargetTicks:Object.freeze({base:Object.freeze([2022,2054]),shoulder:Object.freeze([2052,2060]),elbow:Object.freeze([2048,2056]),gripper:Object.freeze([2045,2049])}),
  uncertaintyRad:0.0465, maximumGridStepRad:0.004, interpolationRemainderMm:2,
  requiredBodyHeightMm:0, requiredSelfSeparationMm:24,
  speedStepsPerSecond:20, acceleration:1, trackingRad:0.0065, heldJointTicks:1,
  observationWindowMs:12000, settlingDwellMs:1600, minimumSamples:9, maxSampleAgeMs:500
});
const JOINT_COMMAND = Object.freeze({base:1,shoulder:2,elbow:3,gripper:4});
const JOINTS = REFERENCE_JOINT_ORDER;
const fullPose = v => !!v && typeof v === 'object' && !Array.isArray(v) && JOINTS.every(k => Number.isFinite(v[k]));
const sep = (a,b) => Math.max(...[0,1,2].map(k => Math.max(a.min[k]-b.max[k],b.min[k]-a.max[k])));
const range = (lo,hi) => {const n=Math.max(1,Math.ceil((hi-lo)/REFERENCE_RETURN_POLICY.maximumGridStepRad));return Array.from({length:n+1},(_,i)=>lo+(hi-lo)*i/n);};

function checkedTicks(start) {
  if(!fullPose(start)) throw new TypeError('A four-joint observed feedback pose is required');
  const ticks=observedTicks(start);
  for(const k of JOINTS){const [lo,hi]=REFERENCE_RETURN_POLICY.startAndTargetTicks[k];if(ticks[k]<lo||ticks[k]>hi)throw new RangeError(`${k} start is outside the reviewed reference-return envelope`);}
  return ticks;
}
function geometryForLeg(start,target,joint,historical=false) {
  const p=REFERENCE_RETURN_POLICY,u=p.uncertaintyRad;
  const ss=range(Math.min(start.shoulder,target.shoulder)-u,Math.max(start.shoulder,target.shoulder)+u);
  const es=range(Math.min(start.elbow,target.elbow)-u,Math.max(start.elbow,target.elbow)+u);
  const gs=range(Math.min(start.gripper,target.gripper)-u,Math.max(start.gripper,target.gripper)+u);
  const minima={upperFree:Infinity,distal:Infinity,finger:Infinity};let separation=Infinity,count=0;
  // Base yaw is evaluated in its co-rotating shoulder plane; yaw preserves
  // rigid-body heights and pair distances. External swept workspace is out of model.
  for(const shoulder of ss)for(const elbow of es)for(const gripper of gs){
    const b=trainingBodyBounds({...start,shoulder,elbow,gripper});count++;
    for(const k of Object.keys(minima))minima[k]=Math.min(minima[k],b[k].min[2]);
    separation=Math.min(separation,adjacentLinkSeparationMm(elbow),
      ...(joint==='shoulder'?[sep(b.mount,b.upperFree)]:[]),sep(b.upper,b.finger),
      sep(b.mount,b.distal),sep(b.mount,b.finger));
  }
  const floorPolicy=tabletopGeometryPolicy({historical});
  for(const k of Object.keys(minima))minima[k]+=floorPolicy.modelHeightOffsetMm;
  const requiredHeight=floorPolicy.requiredBodyHeightMm,requiredSeparation=p.requiredSelfSeparationMm;
  if(Object.values(minima).some(x=>!Number.isFinite(x)||x<requiredHeight))throw new Error(`BLOCKED: complete ${joint} path fails the unchanged ${requiredHeight} mm body-height margin`);
  if(!Number.isFinite(separation)||separation<requiredSeparation)throw new Error(`BLOCKED: complete ${joint} path fails the unchanged ${requiredSeparation} mm self-separation margin`);
  return Object.freeze({revision:'reference-pose-four-joint-swept-geometry-v1',...floorPolicy.fields,...(historical?{}:{plane:floorPolicy.plane}),modelRevision:Z_LIFT_MODEL_REVISION,
    wholeMovingIntervalChecked:true,activeJoint:joint,uncertaintyRad:u,maximumGridStepRad:p.maximumGridStepRad,
    interpolationRemainderMm:p.interpolationRemainderMm,gridConfigurations:count,
    minimumBodyHeightMm:Object.freeze(minima),requiredBodyHeightMm:requiredHeight,minimumSelfSeparationMm:separation,
    requiredSelfSeparationMm:requiredSeparation,shoulderPathFullySampled:true,designedShoulderPivotExemptionMm:20,
    exceptions:Object.freeze(['Only the documented first 20 mm shoulder attachment is excluded from mount-versus-free-upper-link collision; all remaining free-link, distal, finger and mount pairs are checked.','Base yaw is evaluated in its co-rotating plane; fixed-base housing, cables, external workspace and physical clearance are not modeled.']),physicalGeometryVerified:false});
}

/** Pure single-joint leg toward the fixed four-joint return reference. */
export function planReferenceLeg({start,joint,historical=false}={}) {
  if(!JOINTS.includes(joint))throw new RangeError('joint must be one of the four ordered reference joints');
  const startTicks=checkedTicks(start),targetTicks={...startTicks,[joint]:REFERENCE_TARGET_TICKS[joint]};
  const [lo,hi]=REFERENCE_RETURN_POLICY.startAndTargetTicks[joint],targetTick=targetTicks[joint],startTick=startTicks[joint];
  if(targetTick<lo||targetTick>hi||Math.abs(targetTick-startTick)>REFERENCE_RETURN_POLICY.maximumPerJointTicks)throw new RangeError(`${joint} reference leg exceeds its reviewed tick bounds`);
  if(joint==='gripper'&&targetTick>2049)throw new RangeError('gripper reference command exceeds its reviewed cap');
  const startPose={...start},target=feedbackAtTicks(targetTicks),commandSnapshot=commandForTicks(targetTicks),encoded=commandTicks(commandSnapshot);
  if(encoded[joint]!==targetTicks[joint])throw new Error('Active reference command failed source tick round-trip');
  const skip=Math.abs(targetTick-startTick)<=1;
  let geometry,blockedReason=null;
  if(skip) geometry=Object.freeze({revision:'reference-pose-four-joint-swept-geometry-v1',wholeMovingIntervalChecked:false,activeJoint:joint,notNeeded:'No command is sent for a target within one feedback tick',physicalGeometryVerified:false});
  else try{geometry=geometryForLeg(startPose,target,joint,historical);}catch(error){blockedReason=String(error?.message??error);geometry=Object.freeze({revision:'reference-pose-four-joint-swept-geometry-v1',wholeMovingIntervalChecked:false,blocked:true,activeJoint:joint,reason:blockedReason,physicalGeometryVerified:false});}
  const blocked=blockedReason!==null,command=skip||blocked?null:Object.freeze({T:101,joint:JOINT_COMMAND[joint],rad:commandSnapshot[joint],spd:20,acc:1});
  return Object.freeze({scope:REFERENCE_RETURN_SCOPE,joint,movementJoint:joint,start:Object.freeze(startPose),target:Object.freeze(target),
    targetTicks:Object.freeze(targetTicks),startTicks:Object.freeze({...startTicks}),targetTick,startTick,commandTick:targetTick,
    commandSnapshot:Object.freeze({...commandSnapshot}),command,skip,noSend:skip||blocked,status:blocked?'BLOCKED':skip?'skip':'planned',...(blocked?{blockedReason}:{}),
    sourceRoundTrip:Object.freeze({feedbackTicks:targetTicks,commandTicks:encoded,shoulderCenterFeedbackTick:2048,shoulderCenterCommandTick:2047}),
    geometry,speedStepsPerSecond:20,acceleration:1,physicalGeometryVerified:false,noAutomaticRetry:true,noAutomaticReturn:true});
}

export function validateReferenceFeedback(joints,plan) {
  if(!fullPose(joints)||plan?.scope!==REFERENCE_RETURN_SCOPE||!JOINTS.includes(plan.joint)||plan.status==='BLOCKED')throw new TypeError('Reference feedback and a valid unblocked planned leg are required');
  const observed=observedTicks(joints),start=plan.startTicks,target=plan.targetTicks,active=plan.joint;
  for(const k of JOINTS){if(k!==active&&Math.abs(observed[k]-start[k])>REFERENCE_RETURN_POLICY.heldJointTicks)throw new Error(`BLOCKED: held ${k} drift exceeds one tick`);}
  const direction=Math.sign(target[active]-start[active]);
  if(direction!==0&&(observed[active]-start[active])*direction < -REFERENCE_RETURN_POLICY.heldJointTicks)throw new Error(`BLOCKED: ${active} feedback moved in the wrong direction`);
  const segmentLo=Math.min(plan.start[active],plan.target[active])-REFERENCE_RETURN_POLICY.trackingRad,segmentHi=Math.max(plan.start[active],plan.target[active])+REFERENCE_RETURN_POLICY.trackingRad;
  if(joints[active]<segmentLo-1e-9||joints[active]>segmentHi+1e-9)throw new Error(`BLOCKED: ${active} feedback exceeds the reviewed tracking corridor`);
  return Object.freeze({valid:true,activeJoint:active,observedTicks:Object.freeze(observed),heldJointTicks:1,trackingRad:REFERENCE_RETURN_POLICY.trackingRad,healthChecked:false,physicalMovementVerified:false});
}

export function referenceArrived(samples,plan,now=Date.now()) {
  const p=REFERENCE_RETURN_POLICY;
  const dispatchedAt=Date.parse(plan?.dispatchedAt);
  if(!Array.isArray(samples)||samples.length<p.minimumSamples||plan?.scope!==REFERENCE_RETURN_SCOPE||!Number.isFinite(now)||!Number.isFinite(dispatchedAt)||dispatchedAt>now)throw new Error('BLOCKED: full reference arrival sample set with dispatch timestamp is required');
  const valid=samples.map((s,i)=>{
    const at=Date.parse(s?.observedAt);
    if(s?.source!=='hardware'||!Number.isFinite(at)||at>now||!fullPose(s.joints))throw new Error('BLOCKED: malformed or non-hardware reference observation');
    try{assertLiftHealth(s.health);}catch{throw new Error('BLOCKED: reference observation health is missing or unhealthy');}
    if(at<dispatchedAt)throw new Error('BLOCKED: reference observation predates command dispatch');
    if(i&&at<=Date.parse(samples[i-1].observedAt))throw new Error('BLOCKED: reference observations are not strictly chronological');
    if(i&&at-Date.parse(samples[i-1].observedAt)>p.maxSampleAgeMs)throw new Error('BLOCKED: reference observations contain a stale gap');
    validateReferenceFeedback(s.joints,plan);
    return {at,joints:s.joints,ticks:observedTicks(s.joints)};
  });
  const first=valid[0],last=valid.at(-1);
  if(last.at-dispatchedAt<p.observationWindowMs||now-last.at>p.maxSampleAgeMs)throw new Error('BLOCKED: full 12-second observation window or fresh final sample is missing');
  if(Math.abs(last.ticks[plan.joint]-plan.targetTicks[plan.joint])>1)throw new Error('BLOCKED: reference target left its one-tick arrival band at the final observation');
  const anchor=last.ticks,dwell=[];
  for(let i=valid.length-1;i>=0;i--){const s=valid[i];if(Math.abs(s.ticks[plan.joint]-plan.targetTicks[plan.joint])>1||JOINTS.some(k=>Math.abs(s.ticks[k]-anchor[k])>1))break;dwell.unshift(s);}
  if(dwell.length<p.minimumSamples||last.at-dwell[0].at<p.settlingDwellMs)throw new Error('BLOCKED: full 1600ms/9-sample reference dwell is missing');
  for(const k of JOINTS)if(Math.max(...dwell.map(s=>s.ticks[k]))-Math.min(...dwell.map(s=>s.ticks[k]))>1)throw new Error(`BLOCKED: ${k} departed by more than one tick during final dwell`);
  const maxResidualTicks=Math.max(...valid.map(s=>Math.abs(s.ticks[plan.joint]-plan.targetTicks[plan.joint])));
  // Endpoint residual during travel is expected; tracking applies to the
  // swept start/target corridor. The final continuous dwell enforces arrival.
  return Object.freeze({arrived:true,scope:REFERENCE_RETURN_SCOPE,activeJoint:plan.joint,maxResidualTicks,observationDurationMs:last.at-first.at,sampleCount:valid.length,dwellMs:last.at-dwell[0].at,dwellSamples:dwell.length,arrivalBandTicks:1,maxDwellSpanTicks:1,physicalMovementVerified:false});
}

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export function validateReferenceCompleted(history,{now=Date.now()}={}) {
  if(!history||!Array.isArray(history.commands)||!Number.isFinite(now))throw new Error('BLOCKED: full validated movement history and current time are required');
  const rows=history.commands;if(rows.length<4)throw new Error('BLOCKED: four completed reference-return rows are required');
  const selected=rows.slice(-4),first=selected[0],base=first?.referencePoseReturn,series=base?.seriesId;
  if(typeof series!=='string'||!series)throw new Error('BLOCKED: reference-return series identity is missing');
  const validHash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),validId=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/i.test(x);
  const anchorId=base.referenceCommandId,anchorHash=base.referenceRowSHA256,sourceHashesSHA256=base.sourceHashesSHA256,configDigest=base.configDigest,authorizationUntil=base.authorizationUntil;
  const authorizationMs=Date.parse(authorizationUntil);
  if(!validId(anchorId)||!validHash(anchorHash)||!validHash(sourceHashesSHA256)||!validHash(configDigest)||!validId(base.consentId)||!Number.isFinite(authorizationMs))throw new Error('BLOCKED: reference series identifiers, source hash or authorization deadline are invalid');
  const anchorIndex=rows.findIndex(row=>row?.id===anchorId),anchor=rows[anchorIndex];
  if(anchorIndex<0||anchorIndex+5!==rows.length||selected.some((row,i)=>row!==rows[anchorIndex+i+1]))throw new Error('BLOCKED: reference-return corrections are not the four contiguous rows immediately after the anchor');
  const anchorGesture=anchor?.finiteElbowGesture,anchorExpiry=Date.parse(anchorGesture?.authorizationUntil),firstDispatch=Date.parse(first?.dispatchedAt);
  if(!Number.isFinite(anchorExpiry)||!Number.isFinite(firstDispatch)||anchorExpiry>=firstDispatch||Date.parse(anchor?.finishedAt)>firstDispatch)throw new Error('BLOCKED: original anchor authorization must expire before the first correction dispatch');
  const prefix={...history,commands:rows.slice(0,anchorIndex+1)};
  if(!base.stationaryStart)throw Error('BLOCKED: fresh displaced first-start qualification required');
  const qualifiedStart=validateReferenceStart({proof:base.stationaryStart,history:prefix,sourceHashes:base.sourceHashes,consentId:base.consentId,configDigest,now:firstDispatch});
  const firstStart=first.plan.start,qualifiedTicks=observedTicks(qualifiedStart),firstStartTicks=observedTicks(firstStart);
  if(JOINTS.some(k=>Math.abs(firstStartTicks[k]-qualifiedTicks[k])>1))throw Error('BLOCKED: first correction pose changed after qualification');
  let previous=anchor;
  for(let i=0;i<selected.length;i++){
    const row=selected[i],meta=row?.referencePoseReturn,expectedJoint=REFERENCE_JOINT_ORDER[i];
    if(row?.mode!=='serial'||row?.state!=='complete'||row?.result?.cleanupVerified!==true||row?.result?.requiresReconciliation!==false||row?.result?.outcome!=='telemetry-reached'||row?.result?.completion?.mode!=='shadow'||!row.result.completion.candidate||row.result.completion.lateDeparture!==false||!Number.isFinite(row.result.completion.maxLaterDriftTicks)||row.result.completion.maxLaterDriftTicks>1||!Array.isArray(row.result.observations)||!row?.result?.observed||row?.plan?.experiment!==REFERENCE_RETURN_SCOPE||row?.plan?.movementJoint!==expectedJoint||meta?.scope!==REFERENCE_RETURN_SCOPE||meta?.seriesId!==series||meta?.ordinal!==i+1||meta?.maxLegs!==4||meta?.referenceCommandId!==anchorId||meta?.referenceRowSHA256!==anchorHash||meta?.sourceHashesSHA256!==sourceHashesSHA256||!meta.sourceHashes||digest(meta.sourceHashes)!==sourceHashesSHA256||meta?.configDigest!==configDigest||meta?.authorizationUntil!==authorizationUntil||meta?.consentId!==base.consentId||!validId(meta.consentId)||meta.referenceTargetTicks?.base!==REFERENCE_TARGET_TICKS.base||meta.referenceTargetTicks?.shoulder!==REFERENCE_TARGET_TICKS.shoulder||meta.referenceTargetTicks?.elbow!==REFERENCE_TARGET_TICKS.elbow||meta.referenceTargetTicks?.gripper!==REFERENCE_TARGET_TICKS.gripper||!validId(meta.predecessorId)||!validHash(meta.predecessorRowSHA256)||!JOINTS.every(k=>Number.isFinite(row.result.observed[k])))throw new Error(`BLOCKED: reference-return history leg ${i+1} is incomplete or contradictory`);
    const dispatched=Date.parse(row.dispatchedAt),finished=Date.parse(row.finishedAt);
    if(row.configDigest!==configDigest||!Number.isFinite(dispatched)||!Number.isFinite(finished)||dispatched>finished||finished>now||finished>authorizationMs||dispatched>=authorizationMs)throw new Error(`BLOCKED: reference-return leg ${i+1} lacks source/configuration binding or completed inside its shared authorization window`);
    if(i===3?meta.complete!==true:meta.complete===true)throw new Error('BLOCKED: only the fourth clean reference leg may mark the series complete');
    if(meta.predecessorId!==previous.id||meta.predecessorRowSHA256!==digest(previous))throw new Error(`BLOCKED: reference-return leg ${i+1} is not bound to its immediate predecessor`);
    const startPose=i===0?firstStart:previous.result.observed;
    if(previous){const startTicks=observedTicks(startPose),endTicks=observedTicks(row.result.observed);for(const k of JOINTS)if(k!==expectedJoint&&Math.abs(endTicks[k]-startTicks[k])>1)throw new Error(`BLOCKED: reference-return leg ${i+1} displaced held ${k}`);}
    const expectedPlan=planReferenceLeg({start:startPose,joint:expectedJoint,historical:row.plan?.geometry?.requiredBodyHeightMm===17&&row.plan.geometry.tabletopClearanceRevision===undefined});
    const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b)),planFields=['scope','joint','start','target','targetTicks','startTicks','targetTick','startTick','commandTick','commandSnapshot','command','skip','noSend','status','blockedReason','sourceRoundTrip','geometry','speedStepsPerSecond','acceleration','physicalGeometryVerified','noAutomaticRetry','noAutomaticReturn'];
    if(expectedPlan.status==='BLOCKED'||planFields.some(key=>!same(row.plan[key],expectedPlan[key])))throw new Error(`BLOCKED: reference-return leg ${i+1} plan does not match the pure replanned predecessor pose`);
    if(expectedPlan.skip){if(row.noMotionCommandIssued!==true||row.delivery!==null)throw new Error(`BLOCKED: reference-return leg ${i+1} one-tick no-op must record no motion command and no delivery`);}
    else if(row.noMotionCommandIssued===true)throw new Error(`BLOCKED: reference-return leg ${i+1} claims no-op despite a required correction`);
    const ticks=observedTicks(row.result.observed);if(Math.abs(ticks[expectedJoint]-REFERENCE_TARGET_TICKS[expectedJoint])>1)throw new Error(`BLOCKED: reference-return leg ${i+1} did not reach its active reference tick`);
    if(i===3&&JOINTS.some(k=>Math.abs(ticks[k]-REFERENCE_TARGET_TICKS[k])>1))throw new Error('BLOCKED: final reference leg did not complete the full four-joint pose');
    const arrivalPlan={...row.plan,scope:REFERENCE_RETURN_SCOPE,dispatchedAt:row.dispatchedAt};
    referenceArrived(row.result.observations,arrivalPlan,Date.parse(row.finishedAt));
    if(previous!==anchor&&dispatched<Date.parse(previous.finishedAt))throw new Error(`BLOCKED: reference-return leg ${i+1} predates its predecessor completion`);
    previous=row;
  }
  const gesture=anchorGesture,completion=anchor?.result?.completion;
  if(!anchor||digest(anchor)!==anchorHash||anchor.state!=='complete'||anchor.mode!=='serial'||anchor.result?.cleanupVerified!==true||anchor.result?.requiresReconciliation!==false||anchor.result?.outcome!=='telemetry-reached'||anchor.plan?.movementJoint!=='elbow'||gesture?.scope!=='camera-inspected-dramatic-wave-v1'||gesture.ordinal!==2||gesture.desiredTick!==2052||completion?.mode!=='shadow'||!completion.candidate||completion.lateDeparture!==false||!Number.isFinite(completion.maxLaterDriftTicks)||completion.maxLaterDriftTicks>1||!fullPose(anchor.result?.observed))throw new Error('BLOCKED: original clean horizontal anchor is missing, dirty or misidentified');
  const completedAt=Date.parse(anchor.finishedAt),anchorAuthorizationUntil=Date.parse(gesture.authorizationUntil);
  if(!Number.isFinite(completedAt)||!Number.isFinite(anchorAuthorizationUntil)||completedAt>firstDispatch||anchorAuthorizationUntil>=firstDispatch||authorizationMs>=now)throw new Error('BLOCKED: baseline or correction authorization expiry is not strictly ordered before the handoff');
  const anchorTicks=observedTicks(anchor.result.observed);if(JOINTS.some(k=>Math.abs(anchorTicks[k]-REFERENCE_TARGET_TICKS[k])>1))throw new Error('BLOCKED: original horizontal anchor is not at the fixed four-joint reference');
  if(!validHash(anchor.configDigest)||!validHash(configDigest))throw new Error('BLOCKED: original anchor or reference configuration identifiers are missing');
  return Object.freeze({valid:true,scope:REFERENCE_RETURN_SCOPE,seriesId:series,rows:Object.freeze(selected.map(r=>r.id)),anchorId:anchor.id,anchorRowSHA256:digest(anchor),sourceHashesSHA256,configDigest,physicalMovementVerified:false});
}
