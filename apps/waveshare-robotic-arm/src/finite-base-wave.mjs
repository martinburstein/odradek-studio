import {tabletopGeometryPolicy,TABLETOP_CLEARANCE_REVISION} from './training-envelope.mjs';
import {createHash} from 'node:crypto';
import {SERVO_STEP,observedTicks,feedbackAtTicks} from './z-lift-actuators.mjs';
import {Z_LIFT_POLICY,Z_LIFT_MODEL_REVISION} from './z-lift-plan.mjs';
import {RESET_BASE_WAVE_EXPERIMENT,RESET_POSE,planOtherJoint} from './other-joint-plan.mjs';
import {forwardKinematics} from './kinematics.mjs';
import {assertFreshOneShotSample} from './base-feedforward-hypothesis.mjs';
import {DRAMATIC_WAVE_SCOPE,DRAMATIC_WAVE_GESTURE_COMPLETION,DRAMATIC_WAVE_GESTURE_COMPLETION_SHA256} from './dramatic-wave.mjs';
import {validatePilotCameraProof} from '../tools/pilot-camera-proof.mjs';

export const FINITE_BASE_WAVE_SCOPE='finite-inspected-alternating-base-wave-v1';
export const CURRENT_POSE_BASE_DEMO_REVIEW='independent-current-pose-base-demo-leg-v1';
export const FINITE_BASE_WAVE_AUTHORIZATION_UNTIL='2026-10-10T06:00:00.000Z';
export const FINITE_BASE_WAVE_FIRST_TRIAL_ID='aa91fed1-09d9-4dde-ba38-5bda86d4a165';
export const FINITE_BASE_WAVE_RESET_ANCHOR_ID='fa7b492e-2475-494f-a2a9-a406635d455c';
export const FINITE_BASE_WAVE_REQUIRED_SOURCE_HASHES=Object.freeze([
 'src/finite-base-wave.mjs','src/base-feedforward-hypothesis.mjs','src/movement.mjs','src/motion-config.mjs',
 'src/other-joint-plan.mjs','src/feedback-completion.mjs','src/z-lift-actuators.mjs','src/z-lift-plan.mjs',
 'src/kinematics.mjs','src/training-envelope.mjs','src/safety.mjs','src/controller.mjs','src/transport.mjs','src/server.mjs',
 'src/dramatic-wave.mjs','tools/movement.mjs','tools/prepare-wave-now.mjs','tools/pilot-camera-proof.mjs',
 'test/finite-base-wave.test.mjs','test/finite-base-wave-controller.test.mjs','test/current-base-demo.test.mjs','test/current-base-demo-controller.test.mjs','test/current-base-demo-preparation.test.mjs',
 'test/movement.test.mjs','test/wave-now-client.test.mjs','test/pilot-wave-action.test.mjs','test/pilot-camera-proof.test.mjs','test/dramatic-wave.test.mjs'
]);
export const FINITE_BASE_WAVE_POLICY=Object.freeze({
 maxLegs:4,conversationalDegrees:3,clockwiseRequestDegrees:-3,counterclockwiseRequestDegrees:3,
 clockwiseExtensionTicks:15,counterclockwiseExtensionTicks:-12,maxTotalCommandTicks:114,
 speedStepsPerSecond:20,acceleration:1,arrivalRad:.0024,trackingRad:.0065,heldJointTicks:1,
 observationWindowMs:12000,settlingDwellMs:1600,minimumSamples:9,maxSampleAgeMs:500,
 authorizationUntil:FINITE_BASE_WAVE_AUTHORIZATION_UNTIL
});
const digest=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const finiteDate=v=>Number.isFinite(Date.parse(v));
const isSha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const isUuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v);
const samePose=(a,b,ticks=1)=>!!a&&!!b&&['base','shoulder','elbow','gripper'].every(k=>Number.isFinite(a[k])&&Number.isFinite(b[k])&&Math.abs(a[k]-b[k])<=ticks*SERVO_STEP+1e-9);
const sameHeldPose=(a,b)=>!!a&&!!b&&['shoulder','elbow','gripper'].every(k=>Number.isFinite(a[k])&&Number.isFinite(b[k])&&Math.abs(a[k]-b[k])<=1e-9);
export const conversationForOrdinal=ordinal=>Number.isInteger(ordinal)&&ordinal>=1&&ordinal<=FINITE_BASE_WAVE_POLICY.maxLegs?(ordinal%2===1?-3:3):null;
export const requestForOrdinal=ordinal=>{const degrees=conversationForOrdinal(ordinal);return degrees===null?null:-degrees;};
export const extensionForOrdinal=ordinal=>{const degrees=conversationForOrdinal(ordinal);return degrees===null?null:degrees>0?FINITE_BASE_WAVE_POLICY.clockwiseExtensionTicks:FINITE_BASE_WAVE_POLICY.counterclockwiseExtensionTicks;};

function validateSuccessfulRow(row){
 const c=row?.result?.completion,r=row?.result;
 if(!row||row.mode!=='serial'||row.state!=='complete'||r?.cleanupVerified!==true||r?.requiresReconciliation===true||r?.outcome!=='telemetry-reached'||
  c?.mode!=='shadow'||!c.candidate||c.lateDeparture!==false||!Number.isFinite(c.maxLaterDriftTicks)||c.maxLaterDriftTicks>1+1e-6||c.observationDurationMs<FINITE_BASE_WAVE_POLICY.observationWindowMs||
  !Array.isArray(r.observations)||r.observations.length<FINITE_BASE_WAVE_POLICY.minimumSamples||!r.observed||!isSha(row.configDigest))
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
function cleanElbowUp(row){
 const r=row?.result,c=r?.completion,m=row?.finiteElbowGesture,ms=c?.observationDurationMs??r?.observationDurationMs,drift=c?.maxLaterDriftTicks;
 return row?.mode==='serial'&&row.state==='complete'&&r?.cleanupVerified===true&&r?.requiresReconciliation===false&&r?.outcome==='telemetry-reached'&&c?.mode==='shadow'&&!!c.candidate&&c.lateDeparture===false&&Number.isFinite(drift)&&drift<=1+1e-6&&Number.isFinite(ms)&&ms>=DRAMATIC_WAVE_GESTURE_COMPLETION.minimumObservationMs&&Array.isArray(r.observations)&&r.observations.length>=DRAMATIC_WAVE_GESTURE_COMPLETION.minimumSamples&&r.gestureArrival===true&&row.plan?.movementJoint==='elbow'&&m?.scope===DRAMATIC_WAVE_SCOPE&&m.ordinal===2&&m.desiredTick===2052&&JSON.stringify(m.gestureCompletion)===JSON.stringify(DRAMATIC_WAVE_GESTURE_COMPLETION)&&m.gestureCompletionSHA256===DRAMATIC_WAVE_GESTURE_COMPLETION_SHA256&&r.observed&&['base','shoulder','elbow','gripper'].every(k=>Number.isFinite(r.observed[k]));
}
function currentDemoCamera({camera,inspection,predecessor,previousCamera,now}){
 const cameraKeys=['inspectedBy','cameraSessionId','sequence','observedAt','commandId','confirmedShowsArm','fullSweepVisible','visibleObstacles','frameSaved'],inspectionKeys=['stationary','noContact','cablesSlack','noUnusualNoise'],at=Date.parse(camera?.observedAt);
 if(!camera||Object.keys(camera).length!==cameraKeys.length||cameraKeys.some(k=>!Object.hasOwn(camera,k))||!inspection||Object.keys(inspection).length!==inspectionKeys.length||inspectionKeys.some(k=>inspection[k]!==true)||camera.inspectedBy!=='root'||camera.commandId!==predecessor?.id||camera.confirmedShowsArm!==true||camera.fullSweepVisible!==true||camera.visibleObstacles!==false||camera.frameSaved!==false||typeof camera.cameraSessionId!=='string'||!camera.cameraSessionId.trim()||!Number.isSafeInteger(camera.sequence)||camera.sequence<1||!Number.isFinite(at)||at<Date.parse(predecessor.finishedAt)||at>now||now-at>60000||(previousCamera?.cameraSessionId===camera.cameraSessionId&&(!Number.isSafeInteger(previousCamera.sequence)||camera.sequence<=previousCamera.sequence)))throw Error('Current base demo requires a fresh root-verified, unrecorded, full-sweep camera observation of its exact predecessor');
 return digest({...Object.fromEntries(cameraKeys.map(k=>[k,camera[k]])),inspection:Object.fromEntries(inspectionKeys.map(k=>[k,inspection[k]]))});
}
function validateCurrentPoseBaseDemoAdmission({review,sourceHashes,history,deadlineAt,now,ordinal,seriesId}){
 const issued=Date.parse(review?.authorizationIssuedAt),until=Date.parse(review?.authorizationUntil),duration=until-issued;
 if(!Number.isFinite(now)||!Number.isFinite(issued)||!Number.isFinite(until)||new Date(issued).toISOString()!==review.authorizationIssuedAt||new Date(until).toISOString()!==review.authorizationUntil||issued>now||duration<=0||duration>300000||until-now<30000||deadlineAt!==review.authorizationUntil||!isUuid(review.authorizationId)||!isUuid(seriesId)||typeof review.sourceInstruction!=='string'||review.sourceInstruction.length<12||review.sourceInstruction.length>2000||review.executeAuthorized!==true||!review.confirmations||['baseSecured','sweep300mmClear','cablesSlack','jawsClear','powerSwitchReady'].some(k=>review.confirmations[k]!==true))throw Error('Fresh five-minute-or-shorter user source instruction, explicit execution consent and five current confirmations required');
 if(!Number.isInteger(ordinal)||ordinal<1||ordinal>2||review.revision!==CURRENT_POSE_BASE_DEMO_REVIEW||review.scope!==FINITE_BASE_WAVE_SCOPE||review.ordinal!==ordinal||review.seriesId!==seriesId||review.maxLegs!==2||!isUuid(seriesId))throw Error('Current-pose base demo permits only its exact two-leg series and ordinal');
 const degrees=ordinal===1?3:-3,requestDegrees=-degrees,extensionTicks=ordinal===1?15:-12;
 if(review.conversationalDegrees!==degrees||review.requestDegrees!==requestDegrees||review.rawJointDirection!==(degrees>0?'decreasing':'increasing')||review.servoFeedbackTickDirection!==(degrees>0?'increasing':'decreasing')||review.extensionTicks!==extensionTicks||review.maxTotalCommandTicks!==114||review.speedStepsPerSecond!==20||review.acceleration!==1||review.arrivalRad!==.0024||review.trackingRad!==.0065||review.heldJointTicks!==1||review.observationWindowMs!==12000||review.settlingDwellMs!==1600||review.minimumSamples!==9||review.maxSampleAgeMs!==500)throw Error('Independent review does not bind the fixed current-pose base demo bounds');
 if(typeof review.reviewedBy!=='string'||!review.reviewedBy.trim()||typeof review.independentlyReviewedBy!=='string'||!review.independentlyReviewedBy.trim()||review.reviewedBy===review.independentlyReviewedBy||!finiteDate(review.reviewedAt)||Date.parse(review.reviewedAt)>now||now-Date.parse(review.reviewedAt)>3600000||!isUuid(review.oneShotId))throw Error('A current independent one-leg review is required');
 if(!Array.isArray(history?.commands)||!history.commands.length)throw Error('Complete current movement history is required');
 // Movement.readyHistory is the authority that validates every prior blocked
 // row against its complete reconciliation or recovery contract before this admission.
 const rows=history.commands,previous=rows.at(-1);
 let seriesAnchorBaseTick,resetAnchorRowHash;
 if(ordinal===1){
  if(!cleanElbowUp(previous))throw Error('First demo leg must follow the latest clean expressive elbow UP receipt at tick 2052');
  const cameraHash=currentDemoCamera({camera:review.cameraObservation,inspection:review.inspection,predecessor:previous,previousCamera:previous.finiteElbowGesture?.cameraObservation,now});
  if(review.cameraProofSHA256!==cameraHash||review.priorCommandId!==previous.id||review.priorRowSHA256!==digest(previous)||review.historySHA256!==digest(history)||review.priorSeriesOrdinal!==0)throw Error('First leg camera and predecessor must bind the exact latest elbow receipt and history');
  const start=previous.result.observed,ticks=observedTicks(start);seriesAnchorBaseTick=ticks.base;resetAnchorRowHash=review.resetAnchorRowSHA256;
  if(review.seriesAnchorBaseTick!==seriesAnchorBaseTick||!isSha(resetAnchorRowHash)||!rows.some(row=>row.resetRecovery&&digest(row)===resetAnchorRowHash))throw Error('First leg must bind its absolute series return tick and preserved reset anchor');
  const canonicalProof=validatePilotCameraProof({proof:{cameraObservation:review.cameraObservation,inspection:review.inspection},predecessor:previous,now});
  if(canonicalProof.metadataSha256!==cameraHash)throw Error('First leg camera metadata hash does not match the shared Pilot camera-proof validator');
  const used=rows.flatMap(row=>row.finiteBaseWave?[row.finiteBaseWave]:[]);
  if(used.some(item=>item.authorizationId===review.authorizationId||item.seriesId===seriesId||item.oneShotId===review.oneShotId))throw Error('Authorization, series or one-shot identifier was already used');
 }else{
  const meta=previous.finiteBaseWave;
  if(!validateSuccessfulRow(previous)||!meta||meta.revision!==CURRENT_POSE_BASE_DEMO_REVIEW||meta.scope!==FINITE_BASE_WAVE_SCOPE||meta.authorizationId!==review.authorizationId||meta.seriesId!==seriesId||meta.ordinal!==1||!isUuid(meta.oneShotId)||previous.move?.joint!=='base'||previous.move?.degrees!==-3)throw Error('Second leg must immediately follow ordinal one under the same authorization and series');
  const first=rows.find(row=>row.finiteBaseWave?.revision===CURRENT_POSE_BASE_DEMO_REVIEW&&row.finiteBaseWave.authorizationId===review.authorizationId&&row.finiteBaseWave.ordinal===1),firstMeta=first?.finiteBaseWave,origin=rows.find(row=>row.id===firstMeta?.priorCommandId);
  if(!first||rows.filter(row=>row.finiteBaseWave?.revision===CURRENT_POSE_BASE_DEMO_REVIEW&&row.finiteBaseWave.authorizationId===review.authorizationId).length!==1||rows.some(row=>row.finiteBaseWave?.seriesId===seriesId&&row!==first))throw Error('Exactly one first leg must anchor a fresh authorization and series');
  if(firstMeta.authorizationIssuedAt!==review.authorizationIssuedAt||firstMeta.authorizationUntil!==review.authorizationUntil||firstMeta.sourceInstruction!==review.sourceInstruction||firstMeta.seriesId!==seriesId||!origin||digest(origin)!==firstMeta.priorRowSHA256||!cleanElbowUp(origin))throw Error('Return authorization must retain its original user instruction and exact expressive series start');
  seriesAnchorBaseTick=firstMeta.seriesAnchorBaseTick;resetAnchorRowHash=firstMeta.resetAnchorRowSHA256;
  if(review.seriesAnchorBaseTick!==seriesAnchorBaseTick||seriesAnchorBaseTick!==observedTicks(origin.result.observed).base||review.priorCommandId!==previous.id||review.priorRowSHA256!==digest(previous)||review.historySHA256!==digest(history)||review.priorSeriesOrdinal!==1||!sameHeldPose(previous.result.observed,origin.result.observed)||!samePose(review.expectedStart,previous.result.observed,0))throw Error('Return leg must bind the original absolute base heading, held joints, predecessor and full history');
  const cameraHash=currentDemoCamera({camera:review.cameraObservation,inspection:review.inspection,predecessor:previous,previousCamera:meta.cameraObservation,now});
  if(review.cameraProofSHA256!==cameraHash||meta.oneShotId===review.oneShotId)throw Error('Return camera proof or one-shot identity is stale or replayed');
 }
 const currentTicks=observedTicks(previous.result.observed),desiredTargetTick=ordinal===1?currentTicks.base+Math.round(3*Math.PI/180/SERVO_STEP):seriesAnchorBaseTick,commandTick=desiredTargetTick+extensionTicks,totalTicks=Math.abs(commandTick-currentTicks.base);
 if(review.desiredTargetTick!==desiredTargetTick||review.extendedCommandTargetTick!==commandTick||totalTicks<1||totalTicks>114||!samePose(review.expectedStart,previous.result.observed,0))throw Error('Reviewed absolute target or existing 114-tick command envelope changed');
 if(review.priorCommandId!==previous.id||review.priorRowSHA256!==digest(previous)||review.historySHA256!==digest(history)||review.resetAnchorRowSHA256!==resetAnchorRowHash)throw Error('Review does not bind exact predecessor, full history and reset anchor');
 if(rows.some(row=>row.finiteBaseWave?.oneShotId===review.oneShotId))throw Error('Current-pose demo one-shot identifier was already used');
 if(FINITE_BASE_WAVE_REQUIRED_SOURCE_HASHES.some(file=>!isSha(sourceHashes?.[file])||review.sourceHashes?.[file]!==sourceHashes[file]))throw Error('Current-pose demo source hashes are stale or incomplete');
 const actual=geometryForDemo(previous.result.observed,commandTick);
 if(!geometryCovered(review.geometry,actual))throw Error('Independent geometry review does not cover the unchanged reset-pose sweep');
 return Object.freeze({scope:FINITE_BASE_WAVE_SCOPE,reviewRevision:CURRENT_POSE_BASE_DEMO_REVIEW,authorizationId:review.authorizationId,authorizationIssuedAt:review.authorizationIssuedAt,authorizationUntil:review.authorizationUntil,sourceInstruction:review.sourceInstruction,seriesId,ordinal,oneShotId:review.oneShotId,reviewSHA256:digest(review),historySHA256:digest(history),priorCommandId:previous.id,priorRowSHA256:digest(previous),resetAnchorRowSHA256:resetAnchorRowHash,sourceHashes:Object.freeze({...sourceHashes}),deadlineAt:review.authorizationUntil,conversationalDegrees:degrees,requestDegrees,extensionTicks,expectedStart:Object.freeze({...previous.result.observed}),seriesAnchorBaseTick,desiredTargetTick,extendedCommandTargetTick:commandTick,cameraObservation:Object.freeze({...review.cameraObservation}),inspection:Object.freeze({...review.inspection}),cameraProofSHA256:review.cameraProofSHA256});
}
function geometryForDemo(start,commandTick){return planOtherJoint(start,forwardKinematics(start,Z_LIFT_MODEL_REVISION),RESET_BASE_WAVE_EXPERIMENT,commandTick).envelope;}
export function validateFiniteBaseWaveAdmission({review,sourceHashes,history,deadlineAt,now=Date.now(),ordinal,seriesId}){
 if(review?.revision===CURRENT_POSE_BASE_DEMO_REVIEW)return validateCurrentPoseBaseDemoAdmission({review,sourceHashes,history,deadlineAt,now,ordinal,seriesId});
 if(!Number.isFinite(now)||!finiteDate(deadlineAt)||Date.parse(deadlineAt)<=now||Date.parse(deadlineAt)>Date.parse(FINITE_BASE_WAVE_AUTHORIZATION_UNTIL))throw Error('Finite wave authorization deadline is missing, expired or outside the user window');
 if(!Number.isInteger(ordinal)||ordinal<1||ordinal>FINITE_BASE_WAVE_POLICY.maxLegs||!isUuid(seriesId))throw Error('Finite wave ordinal or series identifier is invalid');
 const degrees=conversationForOrdinal(ordinal),extensionTicks=extensionForOrdinal(ordinal),requestDegrees=requestForOrdinal(ordinal);
 if(!review||review.revision!=='independent-finite-base-wave-leg-v1'||review.scope!==FINITE_BASE_WAVE_SCOPE||review.seriesId!==seriesId||review.ordinal!==ordinal||
  review.authorizationUntil!==FINITE_BASE_WAVE_AUTHORIZATION_UNTIL||review.deadlineAt!==deadlineAt||review.conversationalDegrees!==degrees||review.requestDegrees!==requestDegrees||
  review.rawJointDirection!==(degrees>0?'decreasing':'increasing')||review.servoFeedbackTickDirection!==(degrees>0?'increasing':'decreasing')||review.extensionTicks!==extensionTicks||
  review.maxTotalCommandTicks!==FINITE_BASE_WAVE_POLICY.maxTotalCommandTicks||review.speedStepsPerSecond!==FINITE_BASE_WAVE_POLICY.speedStepsPerSecond||review.acceleration!==FINITE_BASE_WAVE_POLICY.acceleration||
  review.arrivalRad!==FINITE_BASE_WAVE_POLICY.arrivalRad||review.trackingRad!==FINITE_BASE_WAVE_POLICY.trackingRad||review.heldJointTicks!==FINITE_BASE_WAVE_POLICY.heldJointTicks||
  review.observationWindowMs!==FINITE_BASE_WAVE_POLICY.observationWindowMs||review.settlingDwellMs!==FINITE_BASE_WAVE_POLICY.settlingDwellMs||review.minimumSamples!==FINITE_BASE_WAVE_POLICY.minimumSamples||
  review.maxSampleAgeMs!==FINITE_BASE_WAVE_POLICY.maxSampleAgeMs)throw Error('Independent review does not bind the exact finite-wave leg policy, ordinal and alternating direction');
 if(typeof review.reviewedBy!=='string'||!review.reviewedBy.trim()||typeof review.independentlyReviewedBy!=='string'||!review.independentlyReviewedBy.trim()||review.reviewedBy===review.independentlyReviewedBy||
  !finiteDate(review.reviewedAt)||Date.parse(review.reviewedAt)>now||now-Date.parse(review.reviewedAt)>3600000||!isUuid(review.oneShotId))throw Error('A current independent one-leg review is required');
 if(!history||!Array.isArray(history.commands)||!history.commands.length)throw Error('Current validated full movement history is required');
 const previous=validateSuccessfulRow(history.commands.at(-1));
 let resetAnchorRowHash;
 if(ordinal===1){
  if(previous.id!==FINITE_BASE_WAVE_FIRST_TRIAL_ID||previous.baseFeedforward?.scope!=='one-shot-directional-base-undertravel-hypothesis-v1'||previous.baseFeedforward?.oneShotId===undefined||previous.move?.joint!=='base'||previous.move?.degrees!==-3)
   throw Error('First finite-wave leg must immediately follow the accepted +3-degree trial');
  if(review.priorCommandId!==FINITE_BASE_WAVE_FIRST_TRIAL_ID||review.priorSeriesOrdinal!==0)throw Error('First finite-wave review must bind its accepted predecessor');
  resetAnchorRowHash=previous.baseFeedforward.resetRecoveryRowSHA256;
 }else{
  const prior=previous.finiteBaseWave;
  if(!prior||prior.scope!==FINITE_BASE_WAVE_SCOPE||prior.seriesId!==seriesId||prior.ordinal!==ordinal-1||!isUuid(prior.oneShotId)||previous.move?.joint!=='base'||previous.move?.degrees!==requestForOrdinal(ordinal-1))
   throw Error('Finite-wave leg must follow the immediately preceding accepted leg in the same series');
  if(review.priorCommandId!==previous.id||review.priorSeriesOrdinal!==ordinal-1)throw Error('Review does not bind the immediately preceding series leg');
  resetAnchorRowHash=prior.resetAnchorRowSHA256;
 }
 const resetAnchor=history.commands.find(row=>row.id===FINITE_BASE_WAVE_RESET_ANCHOR_ID);
 if(review.priorCommandId!==previous.id||review.priorRowSHA256!==digest(previous)||review.historySHA256!==digest(history))throw Error('Independent review does not bind the exact current predecessor and full history');
 if(!samePose(review.expectedStart,previous.result.observed,0)||!isSha(review.resetAnchorRowSHA256)||review.resetAnchorRowSHA256!==resetAnchorRowHash||!resetAnchor||digest(resetAnchor)!==resetAnchorRowHash)throw Error('Review does not bind the exact observed start and preserved reset-recovery anchor');
 if(FINITE_BASE_WAVE_REQUIRED_SOURCE_HASHES.some(file=>!isSha(sourceHashes?.[file])||review.sourceHashes?.[file]!==sourceHashes[file]))throw Error('Independent finite-wave source hashes are stale or incomplete');
 const used=history.commands.flatMap(row=>row.finiteBaseWave?[row.finiteBaseWave]:[]);
 if(used.some(item=>item.oneShotId===review.oneShotId)||used.some(item=>item.seriesId===seriesId&&item.ordinal===ordinal))throw Error('This one-shot id or finite-wave ordinal was already consumed');
 return Object.freeze({scope:FINITE_BASE_WAVE_SCOPE,seriesId,ordinal,oneShotId:review.oneShotId,reviewSHA256:digest(review),historySHA256:digest(history),
  priorCommandId:previous.id,priorRowSHA256:digest(previous),resetAnchorRowSHA256:review.resetAnchorRowSHA256,sourceHashes:Object.freeze({...sourceHashes}),deadlineAt,
  authorizationUntil:FINITE_BASE_WAVE_AUTHORIZATION_UNTIL,conversationalDegrees:degrees,requestDegrees,extensionTicks,expectedStart:Object.freeze({...previous.result.observed})});
}
export function assertFiniteWaveExecution({admission,review,history,sourceHashes,now=Date.now(),owner,expectedOwner,sessionId,expectedSessionId,expiresAt,configDigest,expectedConfigDigest,stopped=false}){
 if(admission?.reviewRevision===CURRENT_POSE_BASE_DEMO_REVIEW){
  if(admission.scope!==FINITE_BASE_WAVE_SCOPE||!Number.isFinite(now)||!finiteDate(expiresAt)||Date.parse(expiresAt)<=now||Date.parse(expiresAt)>Math.min(Date.parse(admission.deadlineAt),now+60000)||Date.parse(admission.deadlineAt)<=now||Date.parse(admission.deadlineAt)!==Date.parse(admission.authorizationUntil)||digest(review)!==admission.reviewSHA256||digest(history)!==admission.historySHA256||FINITE_BASE_WAVE_REQUIRED_SOURCE_HASHES.some(file=>sourceHashes?.[file]!==admission.sourceHashes[file])||owner!==expectedOwner||!owner||sessionId!==expectedSessionId||!sessionId||configDigest!==expectedConfigDigest||stopped||history.commands.some(row=>row.finiteBaseWave?.oneShotId===admission.oneShotId||row.finiteBaseWave?.authorizationId===admission.authorizationId&&row.finiteBaseWave?.ordinal===admission.ordinal))throw Error('Current-pose demo authorization is stale, changed, cancelled, non-exclusive or consumed');
  return true;
 }
 if(!admission||admission.scope!==FINITE_BASE_WAVE_SCOPE||!Number.isFinite(now)||!finiteDate(expiresAt)||!finiteDate(admission.deadlineAt)||Date.parse(admission.deadlineAt)<=now||Date.parse(admission.deadlineAt)>Date.parse(FINITE_BASE_WAVE_AUTHORIZATION_UNTIL)||digest(review)!==admission.reviewSHA256||digest(history)!==admission.historySHA256||
  FINITE_BASE_WAVE_REQUIRED_SOURCE_HASHES.some(file=>sourceHashes?.[file]!==admission.sourceHashes[file])||
  !Number.isFinite(now)||Date.parse(expiresAt)<=now||Date.parse(expiresAt)>Math.min(Date.parse(admission.deadlineAt),now+60000)||
  owner!==expectedOwner||!owner||sessionId!==expectedSessionId||!sessionId||configDigest!==expectedConfigDigest||stopped||
  history.commands.some(row=>row.finiteBaseWave?.oneShotId===admission.oneShotId))throw Error('Finite-wave authorization is stale, changed, cancelled, non-exclusive or consumed');
 return true;
}
export function planFiniteBaseWaveLeg({start,cartesian,admission,review}){
 if(!admission||admission.scope!==FINITE_BASE_WAVE_SCOPE||digest(review)!==admission.reviewSHA256)throw Error('Validated source-bound finite-wave leg review required');
 if(!samePose(start,admission.expectedStart,1))throw Error('Fresh hardware start differs from the accepted predecessor by more than one tick');
 const ticks=observedTicks(start),currentPoseDemo=admission.reviewRevision===CURRENT_POSE_BASE_DEMO_REVIEW,desiredDelta=Math.round(admission.conversationalDegrees*Math.PI/180/SERVO_STEP);
 const desiredTick=currentPoseDemo?admission.desiredTargetTick:ticks.base+desiredDelta,commandTick=currentPoseDemo?admission.extendedCommandTargetTick:desiredTick+admission.extensionTicks,totalTicks=Math.abs(commandTick-ticks.base);
 if(currentPoseDemo&&desiredTick!==(admission.ordinal===2?admission.seriesAnchorBaseTick:ticks.base+desiredDelta))throw Error('Current-pose demo must use its reviewed absolute encoder endpoint');
 if(totalTicks<1||totalTicks>FINITE_BASE_WAVE_POLICY.maxTotalCommandTicks)throw Error('Finite-wave compensated command exceeds 114 encoder ticks');
 const desired=feedbackAtTicks({...ticks,base:desiredTick}),commandTarget=feedbackAtTicks({...ticks,base:commandTick});
 const p=planOtherJoint(start,cartesian,RESET_BASE_WAVE_EXPERIMENT,commandTick);
 if(!geometryCovered(review.geometry,p.envelope))throw Error('Independent geometry review does not conservatively cover the full extended command path');
 p.target=desired;p.commandTarget=commandTarget;p.goal=forwardKinematics(desired,Z_LIFT_MODEL_REVISION);p.commandGoal=forwardKinematics(commandTarget,Z_LIFT_MODEL_REVISION);
 p.servoTargets={base:commandTick};p.desiredEndpointServoTicks={base:desiredTick};p.delta=Object.fromEntries(Object.keys(start).map(k=>[k,desired[k]-start[k]]));
 p.finiteBaseWave={...(currentPoseDemo?{revision:CURRENT_POSE_BASE_DEMO_REVIEW,authorizationId:admission.authorizationId,authorizationIssuedAt:admission.authorizationIssuedAt,authorizationUntil:admission.authorizationUntil,sourceInstruction:admission.sourceInstruction,seriesAnchorBaseTick:admission.seriesAnchorBaseTick,cameraObservation:{...admission.cameraObservation},cameraProofSHA256:admission.cameraProofSHA256}:{}),scope:FINITE_BASE_WAVE_SCOPE,seriesId:admission.seriesId,ordinal:admission.ordinal,oneShotId:admission.oneShotId,
  reviewSHA256:admission.reviewSHA256,historySHA256:admission.historySHA256,priorCommandId:admission.priorCommandId,priorRowSHA256:admission.priorRowSHA256,
  resetAnchorRowSHA256:admission.resetAnchorRowSHA256,desiredConversationalDegrees:admission.conversationalDegrees,requestDegrees:admission.requestDegrees,
  extensionTicks:admission.extensionTicks,desiredEndpointTick:desiredTick,extendedCommandTargetTick:commandTick,totalCommandTicks:totalTicks,
  rawJointDirection:admission.conversationalDegrees>0?'decreasing':'increasing',servoFeedbackTickDirection:admission.conversationalDegrees>0?'increasing':'decreasing',
  speedStepsPerSecond:20,acceleration:1,arrivalRad:.0024,trackingRad:.0065,heldJointTicks:1,observationWindowMs:12000,settlingDwellMs:1600,minimumSamples:9,noRetry:true,noAutoReturn:true};
 p.durationMs=Math.max(p.durationMs,20000);p.observationWindowMs=12000;p.speedStepsPerSecond=20;p.acceleration=1;p.physicalPathVerified=false;
 return p;
}
export function validateFiniteWaveObservation({observations,plan,completion,dispatchedAt,now=Date.now()}){
 if(!Array.isArray(observations)||!observations.length||!completion?.candidate||completion.lateDeparture!==false)throw Error('Finite-wave leg requires a clean target-arrival shadow candidate');
 // Live age is enforced at capture time by the movement loop. At finalization,
 // the same samples are naturally older than 500ms, so validate their source,
 // shape, chronology and inter-sample freshness without pretending they are new.
 let previousAt=null;for(const sample of observations){const at=Date.parse(sample?.observedAt);if(sample?.source!=='hardware'||!Number.isFinite(at)||at>now||!sample.joints||['base','shoulder','elbow','gripper'].some(k=>!Number.isFinite(sample.joints[k]))||(previousAt!==null&&(at<=previousAt||at-previousAt>FINITE_BASE_WAVE_POLICY.maxSampleAgeMs)))throw Error('Finite-wave observation is malformed, out of order or has a stale gap');previousAt=at;}
 const end=Date.parse(observations.at(-1).observedAt),boundary=observations.findIndex(s=>end-Date.parse(s.observedAt)<=FINITE_BASE_WAVE_POLICY.settlingDwellMs),dwell=observations.slice(Math.max(0,boundary-1));
 if(end-Date.parse(dispatchedAt)<FINITE_BASE_WAVE_POLICY.observationWindowMs||dwell.length<FINITE_BASE_WAVE_POLICY.minimumSamples||
  end-Date.parse(dwell[0]?.observedAt)<FINITE_BASE_WAVE_POLICY.settlingDwellMs)throw Error('Finite-wave leg lacks the full 12-second window and 1600ms/9-sample final dwell');
 for(const s of dwell){if(Math.abs(s.joints.base-plan.target.base)>FINITE_BASE_WAVE_POLICY.arrivalRad||['shoulder','elbow','gripper'].some(k=>Math.abs(s.joints[k]-plan.start[k])>SERVO_STEP+1e-9))throw Error('Finite-wave leg missed its desired endpoint or moved a held joint');}
 return true;
}
