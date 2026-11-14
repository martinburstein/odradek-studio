import {tabletopGeometryPolicy,TABLETOP_CLEARANCE_REVISION} from './training-envelope.mjs';
import {createHash} from 'node:crypto';
import {SERVO_STEP,observedTicks,feedbackAtTicks,commandForTicks,commandTicks} from './z-lift-actuators.mjs';
import {Z_LIFT_POLICY,Z_LIFT_MODEL_REVISION} from './z-lift-plan.mjs';
import {RESET_BASE_WAVE_EXPERIMENT,RESET_POSE,planOtherJoint} from './other-joint-plan.mjs';
import {forwardKinematics} from './kinematics.mjs';

export const BASE_FEEDFORWARD_SCOPE='one-shot-directional-base-undertravel-hypothesis-v1';
export const BASE_FEEDFORWARD_AUTHORIZATION_UNTIL='2026-10-10T06:00:00.000Z';
export const BASE_FEEDFORWARD_REQUIRED_SOURCE_HASHES=Object.freeze([
 'src/base-feedforward-hypothesis.mjs','src/movement.mjs','src/motion-config.mjs',
 'src/other-joint-plan.mjs','src/feedback-completion.mjs','src/z-lift-actuators.mjs',
 'src/server.mjs','tools/movement.mjs','test/base-feedforward-hypothesis.test.mjs'
]);
export const BASE_FEEDFORWARD_POLICY=Object.freeze({
 conversationalDegrees:3,rawJointDirection:'decreasing',servoFeedbackTickDirection:'increasing',hypothesisExtensionTicks:15,maxTotalCommandTicks:114,
 speedStepsPerSecond:20,acceleration:1,arrivalRad:.0024,trackingRad:.0065,heldJointTicks:1,
 observationWindowMs:12000,settlingDwellMs:1600,minimumSamples:9,authorizationUntil:BASE_FEEDFORWARD_AUTHORIZATION_UNTIL
});
const RESET_COMMAND_ID='fa7b492e-2475-494f-a2a9-a406635d455c';
const RESET_ORIGINAL_ROW_SHA256='c0a0f3acbd91602ecfd5ee14c63db9802dfdc28928eed107289cbc148db8892b';
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const finiteTime=value=>Number.isFinite(Date.parse(value));
const poseNear=(a,b,tol)=>!!a&&!!b&&['base','shoulder','elbow','gripper'].every(k=>Number.isFinite(a[k])&&Number.isFinite(b[k])&&Math.abs(a[k]-b[k])<=tol+1e-9);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

export function validateBaseFeedforwardAdmission({review,sourceHashes,history,deadlineAt,now=Date.now()}){
 if(!Number.isFinite(now)||!finiteTime(deadlineAt)||Date.parse(deadlineAt)<=now||Date.parse(deadlineAt)>Date.parse(BASE_FEEDFORWARD_AUTHORIZATION_UNTIL))throw Error('Feed-forward authorization deadline is missing, expired or outside the user window');
 if(!review||review.revision!=='independent-base-feedforward-one-shot-v1'||review.scope!==BASE_FEEDFORWARD_SCOPE||review.authorizationUntil!==BASE_FEEDFORWARD_AUTHORIZATION_UNTIL||review.deadlineAt!==deadlineAt||review.conversationalDegrees!==BASE_FEEDFORWARD_POLICY.conversationalDegrees||review.rawJointDirection!==BASE_FEEDFORWARD_POLICY.rawJointDirection||review.servoFeedbackTickDirection!==BASE_FEEDFORWARD_POLICY.servoFeedbackTickDirection||review.extensionTicks!==BASE_FEEDFORWARD_POLICY.hypothesisExtensionTicks||review.maxTotalCommandTicks!==BASE_FEEDFORWARD_POLICY.maxTotalCommandTicks||review.speedStepsPerSecond!==BASE_FEEDFORWARD_POLICY.speedStepsPerSecond||review.acceleration!==BASE_FEEDFORWARD_POLICY.acceleration||review.arrivalRad!==BASE_FEEDFORWARD_POLICY.arrivalRad||review.trackingRad!==BASE_FEEDFORWARD_POLICY.trackingRad||review.heldJointTicks!==BASE_FEEDFORWARD_POLICY.heldJointTicks||review.observationWindowMs!==BASE_FEEDFORWARD_POLICY.observationWindowMs||review.settlingDwellMs!==BASE_FEEDFORWARD_POLICY.settlingDwellMs||review.minimumSamples!==BASE_FEEDFORWARD_POLICY.minimumSamples)throw Error('Independent review does not bind the exact one-shot movement policy');
 if(typeof review.reviewedBy!=='string'||!review.reviewedBy.trim()||typeof review.independentlyReviewedBy!=='string'||!review.independentlyReviewedBy.trim()||review.reviewedBy===review.independentlyReviewedBy||!finiteTime(review.reviewedAt)||Date.parse(review.reviewedAt)>now||now-Date.parse(review.reviewedAt)>3600000||typeof review.oneShotId!=='string'||!/^[a-f0-9-]{36}$/i.test(review.oneShotId))throw Error('A current independent one-shot review is required');
 const anchor=history?.commands?.at(-1),r=anchor?.resetRecovery,sourceHistory=structuredClone(history);
 if(sourceHistory?.commands?.length)delete sourceHistory.commands.at(-1).resetRecovery;
 if(!anchor||anchor.id!==RESET_COMMAND_ID||anchor.mode!=='serial'||anchor.state!=='blocked'||anchor.result?.outcome!=='telemetry-settled-off-target'||anchor.result?.cleanupVerified!==true||anchor.result?.completion?.lateDeparture!==false||r?.revision!=='operator-asserted-reset-v1'||r.disposition!=='accept-reset-pose-for-reviewed-wave-only'||r.originalRowSHA256!==RESET_ORIGINAL_ROW_SHA256||r.cause!=='unknown'||r.operatorAssertion?.status!=='operator-asserted-not-verified'||r.noMotionCommandIssued!==true||r.observationDurationMs<30000||r.observationCount<100||!poseNear(r.expectedPose,RESET_POSE,1e-9))throw Error('Latest history must contain the accepted no-motion reset recovery anchor');
 if(r.sourceHistorySHA256!==digest(sourceHistory))throw Error('Reset recovery does not bind its actual pre-recovery history');
 if(history.commands.slice(0,-1).some(row=>!(row.state==='complete'&&row.result?.cleanupVerified===true&&!row.result?.requiresReconciliation)&&!row.reconciliation&&!row.poseRecovery&&!row.resetRecovery))throw Error('Earlier unresolved movement blocks the one-shot feed-forward trial');
 const rowHash=digest(anchor),historyHash=digest(history);
 if(review.resetRecoveryRowSHA256!==rowHash||review.resetRecoveryCommandId!==anchor.id||review.resetRecoveryOriginalRowSHA256!==RESET_ORIGINAL_ROW_SHA256||review.historySHA256!==historyHash)throw Error('Independent review does not bind the accepted reset-recovery history');
 if(BASE_FEEDFORWARD_REQUIRED_SOURCE_HASHES.some(file=>!hash(sourceHashes?.[file])||review.sourceHashes?.[file]!==sourceHashes[file]))throw Error('Independent review source hashes are stale or incomplete');
 if(history.commands.some(row=>row.baseFeedforward?.oneShotId===review.oneShotId))throw Error('This one-shot review identifier was already consumed');
 return Object.freeze({scope:BASE_FEEDFORWARD_SCOPE,oneShotId:review.oneShotId,reviewSHA256:digest(review),historySHA256:historyHash,
  resetRecoveryCommandId:anchor.id,resetRecoveryRowSHA256:rowHash,resetRecoveryOriginalRowSHA256:RESET_ORIGINAL_ROW_SHA256,
  sourceHashes:Object.freeze({...sourceHashes}),deadlineAt,authorizationUntil:BASE_FEEDFORWARD_AUTHORIZATION_UNTIL,noMotionAnchorAccepted:true});
}

export function assertTotalCommandTicks(totalTicks){
 if(!Number.isInteger(totalTicks)||totalTicks<1||totalTicks>BASE_FEEDFORWARD_POLICY.maxTotalCommandTicks)throw Error('Feed-forward total command travel exceeds 114 encoder ticks');
 return totalTicks;
}

function geometryCovered(reviewed,actual){
 if(!reviewed||reviewed.wholeIntervalChecked!==true||reviewed.tabletopClearanceRevision!==TABLETOP_CLEARANCE_REVISION||reviewed.requiredBodyHeightMm!==0||reviewed.requiredSelfSeparationMm!==24||
  !Number.isFinite(reviewed.uncertaintyRad)||reviewed.uncertaintyRad<actual.uncertaintyRad||!Number.isFinite(reviewed.maximumGridStepRad)||reviewed.maximumGridStepRad>actual.maximumGridStepRad||
  !Number.isInteger(reviewed.gridConfigurations)||reviewed.gridConfigurations<actual.gridConfigurations||
  !Number.isFinite(reviewed.minimumSelfSeparationMm)||reviewed.minimumSelfSeparationMm<24||reviewed.minimumSelfSeparationMm>actual.minimumSelfSeparationMm+1e-6)return false;
 return ['upperFree','distal','finger'].every(k=>Number.isFinite(reviewed.minimumBodyHeightMm?.[k])&&reviewed.minimumBodyHeightMm[k]>=0&&reviewed.minimumBodyHeightMm[k]<=actual.minimumBodyHeightMm[k]+1e-6);
}

export function planBaseFeedforwardLeg({degrees,start,cartesian,admission,review}){
 if(!admission||admission.scope!==BASE_FEEDFORWARD_SCOPE||admission.noMotionAnchorAccepted!==true||!hash(admission.reviewSHA256)||!hash(admission.historySHA256)||digest(review)!==admission.reviewSHA256)throw Error('Validated one-shot feed-forward admission and exact reviewed artifact required');
 if(degrees!==BASE_FEEDFORWARD_POLICY.conversationalDegrees)throw Error('The admitted one-shot leg is exactly +3 conversational base degrees');
 const ticks=observedTicks(start);
 if(!poseNear(start,RESET_POSE,SERVO_STEP))throw Error('Starting pose is outside the one-tick reset recovery bound');
 const desiredDeltaTicks=Math.round(degrees*Math.PI/180/SERVO_STEP);
 if(desiredDeltaTicks<=0)throw Error('Conversational-positive base leg must map to increasing raw ticks');
 const desiredTick=ticks.base+desiredDeltaTicks,commandTick=desiredTick+BASE_FEEDFORWARD_POLICY.hypothesisExtensionTicks;
 const totalTicks=assertTotalCommandTicks(Math.abs(commandTick-ticks.base));
 const encodedTicks={...ticks,base:commandTick},desiredTicks={...ticks,base:desiredTick};
 const commandTarget=feedbackAtTicks(encodedTicks),target=feedbackAtTicks(desiredTicks);
 const hardwarePlan=planOtherJoint(start,cartesian,RESET_BASE_WAVE_EXPERIMENT,commandTick),actualGeometry=hardwarePlan.envelope;
 if(!geometryCovered(review.geometry,actualGeometry))throw Error('Independent geometry review does not conservatively cover the complete extended command path');
 const commandGoal=hardwarePlan.goal,goal=forwardKinematics(target,Z_LIFT_MODEL_REVISION);
 // Keep feedback arrival at the intended endpoint. The extended servo target
 // exists only for command planning and full-path geometry.
 hardwarePlan.target=target;hardwarePlan.commandTarget=commandTarget;hardwarePlan.goal=goal;hardwarePlan.commandGoal=commandGoal;
 hardwarePlan.servoTargets={base:commandTick};hardwarePlan.desiredEndpointServoTicks={base:desiredTick};
 hardwarePlan.delta=Object.fromEntries(Object.keys(start).map(k=>[k,target[k]-start[k]]));
 hardwarePlan.baseFeedforward={scope:BASE_FEEDFORWARD_SCOPE,oneShotId:admission.oneShotId,reviewSHA256:admission.reviewSHA256,historySHA256:admission.historySHA256,
  resetRecoveryCommandId:admission.resetRecoveryCommandId,resetRecoveryRowSHA256:admission.resetRecoveryRowSHA256,sourceHashes:{...admission.sourceHashes},
  desiredConversationalDegrees:degrees,rawJointDirection:'decreasing',servoFeedbackTickDirection:'increasing',desiredRawDeltaTicks:desiredDeltaTicks,desiredEndpointTick:desiredTick,
  extendedCommandTargetTick:commandTick,hypothesisExtensionTicks:BASE_FEEDFORWARD_POLICY.hypothesisExtensionTicks,totalCommandTicks:totalTicks,
  feedbackArrivalRad:Z_LIFT_POLICY.arrivalRad,trackingRad:Z_LIFT_POLICY.trackingRad,heldJointTicks:1,fullObservationWindowMs:12000,noRetry:true,noAutoReturn:true,
  hypothesis:'direction-dependent base undertravel; cause unknown; +15 servo-feedback ticks while raw joint angle decreases is unverified'};
 hardwarePlan.durationMs=Math.max(hardwarePlan.durationMs,20000);hardwarePlan.observationWindowMs=12000;
 hardwarePlan.speedStepsPerSecond=20;hardwarePlan.acceleration=1;hardwarePlan.physicalPathVerified=false;
 return hardwarePlan;
}

export function assertDesiredFeedbackArrival(joints,plan){
 if(!plan?.baseFeedforward||!joints||Math.abs(joints.base-plan.target.base)>BASE_FEEDFORWARD_POLICY.arrivalRad||
  ['shoulder','elbow','gripper'].some(k=>Math.abs(joints[k]-plan.start[k])>BASE_FEEDFORWARD_POLICY.heldJointTicks*SERVO_STEP+1e-9))throw Error('Observed endpoint did not reach the intended feedback target with held joints inside one tick');
 return true;
}

export function validateOneShotExecution({admission,history,sourceHashes,now=Date.now(),owner,expectedOwner,sessionId,expectedSessionId,
 stopped=false,expiresAt,configDigest,expectedConfigDigest,consumed=false}){
 if(!admission||admission.scope!==BASE_FEEDFORWARD_SCOPE||admission.noMotionAnchorAccepted!==true||consumed||stopped||
  typeof owner!=='string'||!owner||owner!==expectedOwner||!sessionId||sessionId!==expectedSessionId||
  !Number.isFinite(now)||!finiteTime(expiresAt)||Date.parse(expiresAt)<=now||Date.parse(expiresAt)>Math.min(Date.parse(admission.deadlineAt),now+60000)||
  configDigest!==expectedConfigDigest||digest(history)!==admission.historySHA256||BASE_FEEDFORWARD_REQUIRED_SOURCE_HASHES.some(file=>sourceHashes?.[file]!==admission.sourceHashes?.[file]))
  throw Error('One-shot feed-forward execution is stale, cancelled, non-exclusive, consumed or source/history/config changed');
 return true;
}

export function assertFreshOneShotSample({sample,previousAt=null,now=Date.now()}){
 const at=Date.parse(sample?.observedAt);
 if(sample?.source!=='hardware'||!Number.isFinite(now)||!Number.isFinite(at)||at>now||now-at>500||
  (previousAt!==null&&(!Number.isFinite(previousAt)||at<=previousAt||at-previousAt>500))||
  !sample.joints||['base','shoulder','elbow','gripper'].some(k=>!Number.isFinite(sample.joints[k])))throw Error('One-shot feedback is stale, future dated, out of order or malformed');
 return at;
}

export function assertOneTickHeldJoints(joints,start){
 if(!joints||!start||['shoulder','elbow','gripper'].some(k=>!Number.isFinite(joints[k])||Math.abs(joints[k]-start[k])>SERVO_STEP+1e-9))throw Error('One-shot feed-forward requires all non-base joints held within one tick');
 return true;
}
