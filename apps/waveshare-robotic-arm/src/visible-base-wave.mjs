import {tabletopGeometryPolicy,TABLETOP_CLEARANCE_REVISION} from './training-envelope.mjs';
import {createHash} from 'node:crypto';
import {SERVO_STEP,observedTicks,feedbackAtTicks} from './z-lift-actuators.mjs';
import {Z_LIFT_POLICY,Z_LIFT_MODEL_REVISION} from './z-lift-plan.mjs';
import {RESET_BASE_WAVE_EXPERIMENT,RESET_POSE,planOtherJoint} from './other-joint-plan.mjs';
import {forwardKinematics} from './kinematics.mjs';
import {assertFreshOneShotSample} from './base-feedforward-hypothesis.mjs';

export const VISIBLE_BASE_WAVE_SCOPE='finite-inspected-visible-base-wave-v1';
export const VISIBLE_BASE_WAVE_AUTHORIZATION_UNTIL='2026-10-10T06:00:00.000Z';
export const VISIBLE_BASE_WAVE_FIRST_TRIAL_ID='ae1e95bb-ad3f-47d2-917c-74453786b1eb';
export const VISIBLE_BASE_WAVE_RESET_ANCHOR_ID='fa7b492e-2475-494f-a2a9-a406635d455c';
export const VISIBLE_BASE_WAVE_REQUIRED_SOURCE_HASHES=Object.freeze([
 'src/visible-base-wave.mjs','src/base-feedforward-hypothesis.mjs','src/movement.mjs','src/motion-config.mjs',
 'src/other-joint-plan.mjs','src/feedback-completion.mjs','src/z-lift-actuators.mjs','src/server.mjs',
 'tools/movement.mjs','test/visible-base-wave.test.mjs'
]);
export const VISIBLE_BASE_WAVE_POLICY=Object.freeze({
 maxLegs:4,conversationalDegrees:8,clockwiseRequestDegrees:-8,counterclockwiseRequestDegrees:8,
 clockwiseExtensionTicks:15,counterclockwiseExtensionTicks:-12,maxTotalCommandTicks:114,
 speedStepsPerSecond:20,acceleration:1,arrivalRad:.0024,trackingRad:.0065,heldJointTicks:1,
 observationWindowMs:12000,settlingDwellMs:1600,minimumSamples:9,maxSampleAgeMs:500,
 authorizationUntil:VISIBLE_BASE_WAVE_AUTHORIZATION_UNTIL
});
const digest=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const finiteDate=v=>Number.isFinite(Date.parse(v));
const isSha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const isUuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v);
const samePose=(a,b,ticks=1)=>!!a&&!!b&&['base','shoulder','elbow','gripper'].every(k=>Number.isFinite(a[k])&&Number.isFinite(b[k])&&Math.abs(a[k]-b[k])<=ticks*SERVO_STEP+1e-9);
export const conversationForOrdinal=ordinal=>Number.isInteger(ordinal)&&ordinal>=1&&ordinal<=VISIBLE_BASE_WAVE_POLICY.maxLegs?(ordinal%2===1?-8:8):null;
export const requestForOrdinal=ordinal=>{const degrees=conversationForOrdinal(ordinal);return degrees===null?null:-degrees;};
export const desiredDeltaTicksForOrdinal=ordinal=>{const degrees=conversationForOrdinal(ordinal);return degrees===null?null:Math.round(degrees*Math.PI/180/SERVO_STEP);};
export const targetTicksForOrdinal=(startTick,ordinal)=>Number.isInteger(startTick)&&desiredDeltaTicksForOrdinal(ordinal)!==null?startTick+desiredDeltaTicksForOrdinal(ordinal):null;
export const extensionForOrdinal=ordinal=>{const degrees=conversationForOrdinal(ordinal);return degrees===null?null:degrees>0?VISIBLE_BASE_WAVE_POLICY.clockwiseExtensionTicks:VISIBLE_BASE_WAVE_POLICY.counterclockwiseExtensionTicks;};

function validateSuccessfulRow(row){
 const c=row?.result?.completion,r=row?.result;
 if(!row||row.mode!=='serial'||row.state!=='complete'||r?.cleanupVerified!==true||r?.requiresReconciliation===true||r?.outcome!=='telemetry-reached'||
  c?.mode!=='shadow'||!c.candidate||c.lateDeparture!==false||!Number.isFinite(c.maxLaterDriftTicks)||c.maxLaterDriftTicks>1+1e-6||c.observationDurationMs<VISIBLE_BASE_WAVE_POLICY.observationWindowMs||
  !Array.isArray(r.observations)||r.observations.length<VISIBLE_BASE_WAVE_POLICY.minimumSamples||!r.observed||!isSha(row.configDigest))
  throw Error('Finite base wave requires a latest complete clean-shadow hardware endpoint with the full observation window and no later drift');
 return row;
}
function geometryCovered(reviewed,actual){
 if(!reviewed||reviewed.wholeIntervalChecked!==true||reviewed.tabletopClearanceRevision!==TABLETOP_CLEARANCE_REVISION||reviewed.requiredBodyHeightMm!==0||reviewed.requiredSelfSeparationMm!==24||
  !Number.isFinite(reviewed.uncertaintyRad)||reviewed.uncertaintyRad<actual.uncertaintyRad||!Number.isFinite(reviewed.maximumGridStepRad)||reviewed.maximumGridStepRad>actual.maximumGridStepRad||
  !Number.isInteger(reviewed.gridConfigurations)||reviewed.gridConfigurations<actual.gridConfigurations||!Number.isFinite(reviewed.minimumSelfSeparationMm)||
  reviewed.minimumSelfSeparationMm<24||reviewed.minimumSelfSeparationMm>actual.minimumSelfSeparationMm+1e-6)return false;
 return ['upperFree','distal','finger'].every(k=>Number.isFinite(reviewed.minimumBodyHeightMm?.[k])&&reviewed.minimumBodyHeightMm[k]>=0&&reviewed.minimumBodyHeightMm[k]<=actual.minimumBodyHeightMm[k]+1e-6);
}
export function validateVisibleBaseWaveAdmission({review,sourceHashes,history,deadlineAt,now=Date.now(),ordinal,seriesId}){
 if(!Number.isFinite(now)||!finiteDate(deadlineAt)||Date.parse(deadlineAt)<=now||Date.parse(deadlineAt)>Date.parse(VISIBLE_BASE_WAVE_AUTHORIZATION_UNTIL))throw Error('Visible wave authorization deadline is missing, expired or outside the user window');
 if(!Number.isInteger(ordinal)||ordinal<1||ordinal>VISIBLE_BASE_WAVE_POLICY.maxLegs||!isUuid(seriesId))throw Error('Visible wave ordinal or series identifier is invalid');
 const degrees=conversationForOrdinal(ordinal),extensionTicks=extensionForOrdinal(ordinal),requestDegrees=requestForOrdinal(ordinal);
 if(!review||review.revision!=='independent-visible-base-wave-leg-v1'||review.scope!==VISIBLE_BASE_WAVE_SCOPE||review.seriesId!==seriesId||review.ordinal!==ordinal||
  review.authorizationUntil!==VISIBLE_BASE_WAVE_AUTHORIZATION_UNTIL||review.deadlineAt!==deadlineAt||review.conversationalDegrees!==degrees||review.requestDegrees!==requestDegrees||
  review.rawJointDirection!==(degrees>0?'decreasing':'increasing')||review.servoFeedbackTickDirection!==(degrees>0?'increasing':'decreasing')||review.extensionTicks!==extensionTicks||
  review.maxTotalCommandTicks!==VISIBLE_BASE_WAVE_POLICY.maxTotalCommandTicks||review.speedStepsPerSecond!==VISIBLE_BASE_WAVE_POLICY.speedStepsPerSecond||review.acceleration!==VISIBLE_BASE_WAVE_POLICY.acceleration||
  review.arrivalRad!==VISIBLE_BASE_WAVE_POLICY.arrivalRad||review.trackingRad!==VISIBLE_BASE_WAVE_POLICY.trackingRad||review.heldJointTicks!==VISIBLE_BASE_WAVE_POLICY.heldJointTicks||
  review.observationWindowMs!==VISIBLE_BASE_WAVE_POLICY.observationWindowMs||review.settlingDwellMs!==VISIBLE_BASE_WAVE_POLICY.settlingDwellMs||review.minimumSamples!==VISIBLE_BASE_WAVE_POLICY.minimumSamples||
  review.maxSampleAgeMs!==VISIBLE_BASE_WAVE_POLICY.maxSampleAgeMs)throw Error('Independent review does not bind the exact visible-wave leg policy, ordinal and alternating direction');
 if(typeof review.reviewedBy!=='string'||!review.reviewedBy.trim()||typeof review.independentlyReviewedBy!=='string'||!review.independentlyReviewedBy.trim()||review.reviewedBy===review.independentlyReviewedBy||
  !finiteDate(review.reviewedAt)||Date.parse(review.reviewedAt)>now||now-Date.parse(review.reviewedAt)>3600000||!isUuid(review.oneShotId))throw Error('A current independent one-leg review is required');
 if(!history||!Array.isArray(history.commands)||!history.commands.length)throw Error('Current validated full movement history is required');
 const previous=validateSuccessfulRow(history.commands.at(-1));
 let resetAnchorRowHash;
 if(ordinal===1){
  if(previous.id!==VISIBLE_BASE_WAVE_FIRST_TRIAL_ID||previous.finiteBaseWave?.scope!=='finite-inspected-alternating-base-wave-v1'||previous.finiteBaseWave?.ordinal!==4||previous.move?.joint!=='base'||previous.move?.degrees!==-3)
   throw Error('First visible-wave leg must immediately follow accepted visible-wave ordinal four');
  if(review.priorCommandId!==VISIBLE_BASE_WAVE_FIRST_TRIAL_ID||review.priorSeriesOrdinal!==4)throw Error('First visible-wave review must bind its accepted predecessor');
  resetAnchorRowHash=previous.finiteBaseWave.resetAnchorRowSHA256;
 }else{
  const prior=previous.visibleBaseWave;
  if(!prior||prior.scope!==VISIBLE_BASE_WAVE_SCOPE||prior.seriesId!==seriesId||prior.ordinal!==ordinal-1||!isUuid(prior.oneShotId)||previous.move?.joint!=='base'||previous.move?.degrees!==requestForOrdinal(ordinal-1))
   throw Error('Visible-wave leg must follow the immediately preceding accepted leg in the same series');
  if(review.priorCommandId!==previous.id||review.priorSeriesOrdinal!==ordinal-1)throw Error('Review does not bind the immediately preceding series leg');
  resetAnchorRowHash=prior.resetAnchorRowSHA256;
 }
 const resetAnchor=history.commands.find(row=>row.id===VISIBLE_BASE_WAVE_RESET_ANCHOR_ID);
 if(review.priorCommandId!==previous.id||review.priorRowSHA256!==digest(previous)||review.historySHA256!==digest(history))throw Error('Independent review does not bind the exact current predecessor and full history');
 if(!samePose(review.expectedStart,previous.result.observed,0)||!isSha(review.resetAnchorRowSHA256)||review.resetAnchorRowSHA256!==resetAnchorRowHash||!resetAnchor||digest(resetAnchor)!==resetAnchorRowHash)throw Error('Review does not bind the exact observed start and preserved reset-recovery anchor');
 if(VISIBLE_BASE_WAVE_REQUIRED_SOURCE_HASHES.some(file=>!isSha(sourceHashes?.[file])||review.sourceHashes?.[file]!==sourceHashes[file]))throw Error('Independent visible-wave source hashes are stale or incomplete');
 const used=history.commands.flatMap(row=>row.visibleBaseWave?[row.visibleBaseWave]:[]);
 if(used.some(item=>item.oneShotId===review.oneShotId)||used.some(item=>item.seriesId===seriesId&&item.ordinal===ordinal))throw Error('This one-shot id or visible-wave ordinal was already consumed');
 return Object.freeze({scope:VISIBLE_BASE_WAVE_SCOPE,seriesId,ordinal,oneShotId:review.oneShotId,reviewSHA256:digest(review),historySHA256:digest(history),
  priorCommandId:previous.id,priorRowSHA256:digest(previous),resetAnchorRowSHA256:review.resetAnchorRowSHA256,sourceHashes:Object.freeze({...sourceHashes}),deadlineAt,
  authorizationUntil:VISIBLE_BASE_WAVE_AUTHORIZATION_UNTIL,conversationalDegrees:degrees,requestDegrees,extensionTicks,expectedStart:Object.freeze({...previous.result.observed})});
}
export function assertVisibleWaveExecution({admission,review,history,sourceHashes,now=Date.now(),owner,expectedOwner,sessionId,expectedSessionId,expiresAt,configDigest,expectedConfigDigest,stopped=false}){
 if(!admission||admission.scope!==VISIBLE_BASE_WAVE_SCOPE||!Number.isFinite(now)||!finiteDate(expiresAt)||!finiteDate(admission.deadlineAt)||Date.parse(admission.deadlineAt)<=now||Date.parse(admission.deadlineAt)>Date.parse(VISIBLE_BASE_WAVE_AUTHORIZATION_UNTIL)||digest(review)!==admission.reviewSHA256||digest(history)!==admission.historySHA256||
  VISIBLE_BASE_WAVE_REQUIRED_SOURCE_HASHES.some(file=>sourceHashes?.[file]!==admission.sourceHashes[file])||
  !Number.isFinite(now)||Date.parse(expiresAt)<=now||Date.parse(expiresAt)>Math.min(Date.parse(admission.deadlineAt),now+60000)||
  owner!==expectedOwner||!owner||sessionId!==expectedSessionId||!sessionId||configDigest!==expectedConfigDigest||stopped||
  history.commands.some(row=>row.visibleBaseWave?.oneShotId===admission.oneShotId))throw Error('Visible-wave authorization is stale, changed, cancelled, non-exclusive or consumed');
 return true;
}
export function planVisibleBaseWaveLeg({start,cartesian,admission,review}){
 if(!admission||admission.scope!==VISIBLE_BASE_WAVE_SCOPE||digest(review)!==admission.reviewSHA256)throw Error('Validated source-bound visible-wave leg review required');
 if(!samePose(start,admission.expectedStart,1))throw Error('Fresh hardware start differs from the accepted predecessor by more than one tick');
 const ticks=observedTicks(start);
 const desiredTick=targetTicksForOrdinal(ticks.base,admission.ordinal),commandTick=desiredTick+admission.extensionTicks,totalTicks=Math.abs(commandTick-ticks.base);
 if(totalTicks<1||totalTicks>VISIBLE_BASE_WAVE_POLICY.maxTotalCommandTicks)throw Error('Visible-wave compensated command exceeds 114 encoder ticks');
 const desired=feedbackAtTicks({...ticks,base:desiredTick}),commandTarget=feedbackAtTicks({...ticks,base:commandTick});
 const p=planOtherJoint(start,cartesian,RESET_BASE_WAVE_EXPERIMENT,commandTick);
 if(!geometryCovered(review.geometry,p.envelope))throw Error('Independent geometry review does not conservatively cover the full extended command path');
 p.target=desired;p.commandTarget=commandTarget;p.goal=forwardKinematics(desired,Z_LIFT_MODEL_REVISION);p.commandGoal=forwardKinematics(commandTarget,Z_LIFT_MODEL_REVISION);
 p.servoTargets={base:commandTick};p.desiredEndpointServoTicks={base:desiredTick};p.delta=Object.fromEntries(Object.keys(start).map(k=>[k,desired[k]-start[k]]));
 p.visibleBaseWave={scope:VISIBLE_BASE_WAVE_SCOPE,seriesId:admission.seriesId,ordinal:admission.ordinal,oneShotId:admission.oneShotId,
  reviewSHA256:admission.reviewSHA256,historySHA256:admission.historySHA256,priorCommandId:admission.priorCommandId,priorRowSHA256:admission.priorRowSHA256,
  resetAnchorRowSHA256:admission.resetAnchorRowSHA256,desiredConversationalDegrees:admission.conversationalDegrees,requestDegrees:admission.requestDegrees,
  extensionTicks:admission.extensionTicks,desiredEndpointTick:desiredTick,extendedCommandTargetTick:commandTick,totalCommandTicks:totalTicks,
  rawJointDirection:admission.conversationalDegrees>0?'decreasing':'increasing',servoFeedbackTickDirection:admission.conversationalDegrees>0?'increasing':'decreasing',
  speedStepsPerSecond:20,acceleration:1,arrivalRad:.0024,trackingRad:.0065,heldJointTicks:1,observationWindowMs:12000,settlingDwellMs:1600,minimumSamples:9,noRetry:true,noAutoReturn:true};
 p.durationMs=Math.max(p.durationMs,20000);p.observationWindowMs=12000;p.speedStepsPerSecond=20;p.acceleration=1;p.physicalPathVerified=false;
 return p;
}
export function validateVisibleWaveObservation({observations,plan,completion,dispatchedAt,now=Date.now()}){
 if(!Array.isArray(observations)||!observations.length||!completion?.candidate||completion.lateDeparture!==false)throw Error('Visible-wave leg requires a clean target-arrival shadow candidate');
 // Live age is enforced at capture time by the movement loop. At finalization,
 // the same samples are naturally older than 500ms, so validate their source,
 // shape, chronology and inter-sample freshness without pretending they are new.
 let previousAt=null;for(const sample of observations){const at=Date.parse(sample?.observedAt);if(sample?.source!=='hardware'||!Number.isFinite(at)||at>now||!sample.joints||['base','shoulder','elbow','gripper'].some(k=>!Number.isFinite(sample.joints[k]))||(previousAt!==null&&(at<=previousAt||at-previousAt>VISIBLE_BASE_WAVE_POLICY.maxSampleAgeMs)))throw Error('Visible-wave observation is malformed, out of order or has a stale gap');previousAt=at;}
 const end=Date.parse(observations.at(-1).observedAt),boundary=observations.findIndex(s=>end-Date.parse(s.observedAt)<=VISIBLE_BASE_WAVE_POLICY.settlingDwellMs),dwell=observations.slice(Math.max(0,boundary-1));
 if(end-Date.parse(dispatchedAt)<VISIBLE_BASE_WAVE_POLICY.observationWindowMs||dwell.length<VISIBLE_BASE_WAVE_POLICY.minimumSamples||
  end-Date.parse(dwell[0]?.observedAt)<VISIBLE_BASE_WAVE_POLICY.settlingDwellMs)throw Error('Visible-wave leg lacks the full 12-second window and 1600ms/9-sample final dwell');
 for(const s of dwell){if(Math.abs(s.joints.base-plan.target.base)>VISIBLE_BASE_WAVE_POLICY.arrivalRad||['shoulder','elbow','gripper'].some(k=>Math.abs(s.joints[k]-plan.start[k])>SERVO_STEP+1e-9))throw Error('Visible-wave leg missed its desired endpoint or moved a held joint');}
 return true;
}


