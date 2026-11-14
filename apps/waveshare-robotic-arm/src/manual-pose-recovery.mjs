import {readFileSync} from 'node:fs';
import {ABORT_REPAIR_REVISION,eligibleManualAbortRepair,validateManualAbortRepairPose,SHORTFALL_REPAIR_REVISION,eligibleManualShortfallRepair,validateManualShortfallRepairPose,CRASH_RECOVERY_REVISION,CRASH_RECOVERY_INSPECTIONS,CRASH_RECOVERY_INSTRUCTION,isCrashRecoveryAuthorization,crashRecoveryEnabled,eligibleCrashRecovery,validateCrashAuthorization} from './manual-crash-recovery.mjs';
import {recordedTabletopFloor} from './training-envelope.mjs';
import {historyDigest,historyPrefix,isImmutableHistoryValue} from './movement-history-snapshot.mjs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {calibrationDigest} from './factory-manual-calibration.mjs';
import {MANUAL_REVISION,validateStylusTrainingPlan,MANUAL_DIRECT_HELD_POLICY,MANUAL_NAMES,MANUAL_CONFIRMATIONS,MANUAL_TEST_CONFIRMATIONS,manualEndpointToleranceRad,validateManualFeedback,manualEnvelope,manualSources} from './manual-joints.mjs';
import {SERVO_STEP,observedTicks,assertLiftHealth} from './z-lift-actuators.mjs';
import {forwardKinematics,OFFSET_MODEL_REVISION} from './kinematics.mjs';
import {isManualRestartAuthorization,isManualTimeoutRestartAuthorization,validateManualRestartAuthorization,MANUAL_RESTART_INSPECTIONS,isManualSettledRestartAuthorization,MANUAL_SETTLED_RESTART_INSPECTIONS} from './manual-restart-qualification.mjs';

export const MANUAL_RECOVERY_INSPECTIONS=[...MANUAL_CONFIRMATIONS,'stationary','noContact','noUnusualNoise','noTouchResetPowerChange'];
export const DIRECT_STYLUS_RESET_INSPECTIONS=['baseSecured','tabletop600mmClear','cablesSlack','powerSwitchReady','stationary','stylusHeldClear'];
export const CARDBOARD_RECOVERY_INSPECTIONS=['baseSecured','tabletop600mmClear','stylusHeldSecure','cablesSlack','powerSwitchReady','stationary','onlyCardboardContact','noUnusualNoise','noTouchResetPowerChange'];
const cardboardSettled=a=>a?.revision==='settled-manual-endpoint-qualification-v1'&&a.inspectionScope==='loaded-stylus-cardboard';
const loadedStylusSettled=a=>a?.revision==='settled-manual-endpoint-qualification-v1'&&['loaded-stylus-free-air','loaded-stylus-cardboard'].includes(a.inspectionScope);
const cardboardNoResponse=row=>row?.result?.error==='Each coordinated joint must produce a measured response'&&row.plan?.stylusTraining?.revision==='held-stylus-cardboard-rehearsal-v1'&&row.plan.stylusTraining.contactAllowed===true&&row.plan.movementJoint==='coordinated'&&JSON.stringify(row.plan.movementJoints)==='["shoulder","elbow"]';
// The observed upward shoulder miss is 31 ticks: a stationary baseline may
// use that exact bounded contact-lift class without accepting its failed target.
const cardboardShoulderLift=row=>row?.result?.error==='Manual command did not produce a sufficient settled response within the shoulder endpoint limit'&&row.plan?.movementJoint==='shoulder'&&!row.plan.movementJoints&&row.plan.stylusTraining?.revision==='held-stylus-cardboard-rehearsal-v1'&&row.plan.stylusTraining.contactAllowed===true&&row.plan.target.shoulder<row.plan.start.shoulder&&row.plan.commandTarget.shoulder<row.plan.start.shoulder&&row.plan.goal.z>row.plan.from.z&&Math.abs((row.result.observations?.at(-1)?.joints?.shoulder??NaN)-row.plan.target.shoulder)>28*SERVO_STEP+1e-9;
const cardboardRecoveryRow=row=>cardboardNoResponse(row)||cardboardShoulderLift(row);
const settledGrossTicks=row=>cardboardShoulderLift(row)?31:28;
const directStylusReset=a=>a?.revision==='direct-manual-stylus-pose-reset-v1';
export const manualOriginalDigest=row=>{const copy={...row};delete copy.manualRecovery;return calibrationDigest(copy);};
export const CANCELLED_GRIPPER_RECOVERY='cancelled-manual-gripper-pose-v1';
export const CANCELLED_GRIPPER_INSPECTIONS=[...DIRECT_STYLUS_RESET_INSPECTIONS,'noContact','noUnusualNoise','noTouchResetPowerChange'];
const cancelledGripperAuthorization=a=>a?.revision===CANCELLED_GRIPPER_RECOVERY;
// Only the recorded direct gripper cancellation. A partial/unknown dispatch,
// another fault or a different joint does not enter this stationary path.
export function eligibleManualCancelled(row){
 try{
  const p=row?.plan,r=row?.result,dispatch=Date.parse(row?.dispatchedAt),finished=Date.parse(row?.finishedAt);
  if(row?.mode!=='serial'||row.state!=='blocked'||row.manual?.phase!=='qualified'||p?.experiment!==MANUAL_REVISION||p.movementJoint!=='gripper'||p.heldTolerancePolicy!==MANUAL_DIRECT_HELD_POLICY||p.startPolicy!=='operator-current-pose-v1'||p.commands||p.command?.T!==101||p.command.joint!==4||p.command.rad!==p.commandTarget?.gripper||p.command.spd!==20||p.command.acc!==1||row.dispatchAttempt?.status!=='may-have-been-sent'||!Number.isFinite(dispatch)||!Number.isFinite(finished)||finished<dispatch||r?.error!=='Command cancelled; physical result unknown'||r.outcome!=='uncertain'||r.cleanupVerified!==true||r.requiresReconciliation!==true||row.manualRecovery||row.poseRecovery||row.resetRecovery||row.reconciliation||!Array.isArray(r.observations)||r.observations.length<10)return false;
  let previous=dispatch;for(const sample of r.observations){const at=Date.parse(sample.observedAt);if(sample.source!=='hardware'||!Number.isFinite(at)||at<=previous||at-previous>500||at>finished)return false;validateManualFeedback(sample.joints,p,p.endpointTolerancePolicy);assertLiftHealth(sample.health);previous=at;}
  return true;
 }catch{return false;}
}
function validateCancelledGripperPose(row,pose){
 validateManualFeedback(pose,row.plan,row.plan.endpointTolerancePolicy);
 const last=row.result.observations.at(-1).joints;
 // Retain the existing small 24-tick recovery window around last feedback,
 // inside the original command interval. Never require arrival at a canceled target.
 if(Math.abs(pose.gripper-last.gripper)>24*SERVO_STEP+1e-9)throw Error('Cancelled gripper left its recorded response window');
}
export const eligibleManualTimeout=row=>row?.mode==='serial'&&row.state==='blocked'&&row.manual?.phase==='qualified'&&row.plan?.experiment===MANUAL_REVISION&&(MANUAL_NAMES.includes(row.plan.movementJoint)&&row.result?.error==='Command timeout; physical result unknown'||fullyDeliveredStoppedPair(row)||eligibleManualCancelled(row))&&row.result?.outcome==='uncertain'&&row.result.requiresReconciliation===true&&typeof row.result.cleanupVerified==='boolean'&&Number.isFinite(Date.parse(row.finishedAt))&&!row.manualRecovery&&!row.poseRecovery&&!row.resetRecovery&&!row.reconciliation;
export function validateTimeoutRecoveryReview(row,a,now=Date.now()){
 if(!eligibleManualTimeout(row)||(eligibleManualCancelled(row)?!cancelledGripperAuthorization(a):(a?.revision!=='manual-timeout-recovery-v1'&&!isManualTimeoutRestartAuthorization(a)))||a.commandId!==row.id||a.originalRowSHA256!==manualOriginalDigest(row)||!/^[a-f0-9]{64}$/.test(a.historySHA256??'')||a.noMotionCommandIssued!==true)throw Error('Exact reviewed timeout recovery required');
 if(cancelledGripperAuthorization(a)){
  const issued=Date.parse(a.issuedAt),expires=Date.parse(a.expiresAt);
  if(a.inspectionScope!=='loaded-stylus-free-air'||a.noAutomaticRetry!==true||typeof a.sourceInstruction!=='string'||a.sourceInstruction.length<30||!Number.isFinite(issued)||!Number.isFinite(expires)||issued<Date.parse(row.finishedAt)||issued>now||expires<=now||expires-issued>900000||expires<=issued||!a.expectedObserved||Object.keys(a.expectedObserved).sort().join(',')!==MANUAL_NAMES.slice().sort().join(','))throw Error('Exact finite cancelled-gripper recovery required');
  validateCancelledGripperPose(row,a.expectedObserved);
 }
 if(isManualTimeoutRestartAuthorization(a)){
  const issued=Date.parse(a.issuedAt),expires=Date.parse(a.expiresAt);
  if(typeof a.sourceInstruction!=='string'||a.sourceInstruction.length<30||typeof a.inspectionAssertion!=='string'||a.inspectionAssertion.length<30||!Number.isFinite(issued)||!Number.isFinite(expires)||issued<Date.parse(row.finishedAt)||issued>now||expires<=now||expires-issued>900000||!a.expectedObserved||Object.keys(a.expectedObserved).sort().join(',')!==MANUAL_NAMES.slice().sort().join(','))throw Error('Exact finite restarted-timeout qualification required');
  validateManualRestartAuthorization(row,a,now);
 }
 return a;
}
export function eligibleManualRecovery(row){
 return row?.mode==='serial'&&row.state==='blocked'&&row.manual?.phase==='qualified'&&row.plan?.experiment===MANUAL_REVISION&&MANUAL_NAMES.includes(row.plan.movementJoint)&&row.result?.outcome==='uncertain'&&row.result.error==='Unexpected manual joint displacement'&&row.result.cleanupVerified===true&&row.result.requiresReconciliation===true&&!row.manualRecovery&&!row.poseRecovery&&!row.resetRecovery&&!row.reconciliation;
}
// This exact failure occurs before markDispatch/transport.send. Preserve its
// blocked result and durable attempt marker; never infer no-send from a timeout.
export const eligibleManualNotSent=row=>row?.mode==='serial'&&row.state==='blocked'&&row.manual?.phase==='qualified'&&row.plan?.experiment===MANUAL_REVISION&&MANUAL_NAMES.includes(row.plan.movementJoint)&&row.result?.outcome==='not-sent'&&row.result.error==='Fresh manual dispatch feedback required'&&row.result.requiresReconciliation===true&&row.result.cleanupVerified===true&&Array.isArray(row.result.observations)&&row.result.observations.length===0&&!row.dispatchedAt&&Number.isFinite(Date.parse(row.finishedAt))&&!row.manualRecovery&&!row.poseRecovery&&!row.resetRecovery&&!row.reconciliation;
export const eligibleManualIntent=row=>eligibleManualNotSent(row)||(row?.mode==='serial'&&row.state==='intent'&&row.manual?.phase==='qualified'&&row.plan?.experiment===MANUAL_REVISION&&MANUAL_NAMES.includes(row.plan.movementJoint)&&!row.result&&!row.finishedAt&&!row.manualRecovery&&!row.poseRecovery&&!row.resetRecovery&&!row.reconciliation);
export const eligibleManualCompleted=row=>row?.mode==='serial'&&row.state==='complete'&&row.manual?.phase==='qualified'&&row.plan?.experiment===MANUAL_REVISION&&(MANUAL_NAMES.includes(row.plan.movementJoint)||fullyDeliveredPair(row))&&row.result?.outcome==='manual-coarse-response'&&row.result.cleanupVerified===true&&row.result.requiresReconciliation===false&&row.result.observed&&Number.isFinite(Date.parse(row.finishedAt))&&!row.manualRecovery&&!row.poseRecovery&&!row.resetRecovery&&!row.reconciliation;
// Missing policy predates v2 and retains the pre-change canonical interpretation.
const recoveryEndpointPolicy=row=>row.plan.endpointTolerancePolicy===undefined?'canonical-per-joint-degrees-v1':row.plan.endpointTolerancePolicy;
const recoveryEndpointToleranceRad=(row,joint)=>manualEndpointToleranceRad(joint,recoveryEndpointPolicy(row));
const displacementAuthorization=a=>a?.revision==='manual-held-displacement-recovery-v1';
export function validateDisplacementRecoveryReview(row,a,now=Date.now()){
 if(!eligibleManualRecovery(row)||!displacementAuthorization(a)||a.commandId!==row.id||a.originalRowSHA256!==manualOriginalDigest(row)||!/^[a-f0-9]{64}$/.test(a.historySHA256??''))throw Error('Exact reviewed displacement recovery required');
 const issued=Date.parse(a.issuedAt),expires=Date.parse(a.expiresAt);
 if(!Number.isFinite(issued)||!Number.isFinite(expires)||issued<Date.parse(row.finishedAt)||issued>now||expires<=now||expires-issued>900000||typeof a.sourceInstruction!=='string'||a.sourceInstruction.length<30||!a.expectedObserved||Object.keys(a.expectedObserved).sort().join(',')!==MANUAL_NAMES.slice().sort().join(','))throw Error('Finite exact-pose displacement recovery required');
 validateCanonicalDisplacementPose(row,a.expectedObserved);return a;
}
function validateCanonicalDisplacementPose(row,pose){
 observedTicks(pose);
 for(const joint of MANUAL_NAMES){const reference=joint===row.plan.movementJoint?row.plan.target[joint]:(row.plan.heldReference?.[joint]??row.plan.start[joint]);
 if(!Number.isFinite(reference)||Math.abs(pose[joint]-reference)>recoveryEndpointToleranceRad(row,joint)+1e-9)throw Error('Displacement recovery exceeds an original canonical joint band');}
}
const currentPoseAuthorization=a=>a?.revision==='completed-manual-current-pose-v1';
const cardboardCompletedAuthorization=a=>currentPoseAuthorization(a)&&a.displacedJoint==='coordinated'&&a.inspectionScope==='loaded-stylus-cardboard';
const pairedCompletedAuthorization=a=>currentPoseAuthorization(a)&&a.displacedJoint==='coordinated'&&(a.inspectionScope==='normal-tabletop'||cardboardCompletedAuthorization(a));
// Only an already clean, responsive, opted-in cardboard glide. This does not
// admit a stopped/partial send or reinterpret any failed contact movement.
const completedCardboardGlide=row=>row?.state==='complete'&&row.result?.outcome==='manual-coarse-response'&&row.result.cleanupVerified===true&&row.result.requiresReconciliation===false&&row.plan?.stylusTraining?.revision==='held-stylus-cardboard-rehearsal-v1'&&row.plan.stylusTraining.contactAllowed===true&&row.plan.stylusTraining.coordinatedGlide===true&&JSON.stringify(row.plan.movementJoints)==='["shoulder","elbow"]'&&row.plan.movementJoints.every(j=>Number.isFinite(row.result.observed?.[j])&&Math.abs(row.result.observed[j]-row.plan.start[j])>SERVO_STEP+1e-9&&Math.abs(row.result.observed[j]-row.plan.target[j])<=recoveryEndpointToleranceRad(row,j)+1e-9);
const recoveryAxis=a=>currentPoseAuthorization(a)?a.displacedJoint:'base';
function assertPairedDeliveries(row){
 const plan=row?.plan;
 // A stopped pair uses the existing no-motion interrupted-result procedure
 // only after both deliveries. A partial send still cannot enter this path.
 const joints=plan?.movementJoints,legacy=JSON.stringify(joints)==='["base","elbow"]'&&plan.dispatchMode==='back-to-back-base-elbow-v1',stylus=plan?.dispatchMode==='back-to-back-stylus-arm-v1'&&plan.stylusTraining?.shoulderCoordination===true&&plan.stylusTraining.gripperLocked===true&&(plan.stylusTraining.contactAllowed===false||cardboardNoResponse(row)||completedCardboardGlide(row))&&Array.isArray(joints)&&['base,shoulder','shoulder,elbow','base,shoulder,elbow'].includes(joints.join(','));
 if(plan?.movementJoint!=='coordinated'||!legacy&&!stylus||!Array.isArray(plan.commands)||plan.commands.length!==joints.length||plan.commands.some((c,i)=>c.T!==101||c.joint!==MANUAL_NAMES.indexOf(joints[i])+1||stylus&&(c.spd!==(plan.stylusTraining.shoulderSpeed??20)||c.acc!==1))||!Array.isArray(row.componentDispatches)||row.componentDispatches.length!==joints.length)throw Error('Only a fully dispatched reviewed coordinated endpoint can use stationary inspection');
 let previous=Date.parse(row.dispatchedAt);if(!Number.isFinite(previous))throw Error('Coordinated dispatch time required');
 if(stylus)validateStylusTrainingPlan(plan,plan.stylusTraining,previous,false);
 for(const [i,d]of row.componentDispatches.entries()){
  const started=Date.parse(d.startedAt),confirmed=Date.parse(d.deliveryConfirmedAt);
  if(d.index!==i||d.joint!==plan.movementJoints[i]||d.deliveryConfirmed!==true||!Number.isFinite(started)||!Number.isFinite(confirmed)||started<previous||confirmed<started)throw Error('Coordinated component delivery evidence is incomplete');
  previous=confirmed;
 }
 if(!Number.isFinite(Date.parse(row.result?.observations?.[0]?.observedAt))||previous>Date.parse(row.result.observations[0].observedAt))throw Error('Coordinated observation must follow all deliveries');
}
function fullyDeliveredPair(row){try{assertPairedDeliveries(row);return true;}catch{return false;}}
function fullyDeliveredStoppedPair(row){return row?.result?.error==='The operation was aborted'&&fullyDeliveredPair(row);}
// A tiny stylus request can settle inside every endpoint band while one axis
// never responds. Preserve that failed motion result; only the existing exact
// stationary inspection may establish a baseline for a different request.
const stylusNoResponse=row=>row?.result?.error==='Each coordinated joint must produce a measured response'&&(row.plan?.stylusTraining?.revision==='held-stylus-free-air-v1'||cardboardNoResponse(row))&&row.plan.movementJoint==='coordinated';
function settledEndpointAxis(row){
 const plan=row?.plan;if(MANUAL_NAMES.includes(plan?.movementJoint))return plan.movementJoint;
 assertPairedDeliveries(row);
 if(stylusNoResponse(row)){validateStylusTrainingPlan(plan,plan.stylusTraining,Date.parse(row.dispatchedAt),false);const observed=row.result.observations?.at(-1)?.joints,axis=plan.movementJoints.find(j=>Number.isFinite(observed?.[j])&&Math.abs(observed[j]-plan.start[j])<=SERVO_STEP+1e-9);if(!axis)throw Error('A measured nonresponsive stylus axis is required');return axis;}
 const axis=plan.movementJoints.find(j=>row.result?.error==='Manual command did not produce a sufficient settled response within the '+j+' endpoint limit');
 if(!axis)throw Error('Only an exact coordinated endpoint shortfall is eligible');return axis;
}
function settledEndpoint(row){
 const axis=settledEndpointAxis(row),noResponse=stylusNoResponse(row);
 if(cardboardShoulderLift(row))validateStylusTrainingPlan(row.plan,row.plan.stylusTraining,Date.parse(row.dispatchedAt),false);
 if(row?.mode!=='serial'||row.state!=='blocked'||row.manual?.phase!=='qualified'||row.plan?.experiment!==MANUAL_REVISION||row.result?.outcome!=='uncertain'||row.result.cleanupVerified!==true||row.result.requiresReconciliation!==true||!noResponse&&row.result.error!=='Manual command did not produce a sufficient settled response within the '+axis+' endpoint limit'||row.manualRecovery||row.poseRecovery||row.resetRecovery||row.reconciliation)throw Error('Only an exact settled endpoint shortfall is eligible');
 const samples=row.result.observations,begin=Date.parse(row.dispatchedAt);if(!Array.isArray(samples)||samples.length<10||!Number.isFinite(begin))throw Error('Recorded full-window observations required');
 let previous=begin;for(const sample of samples){const at=Date.parse(sample.observedAt);if(sample.source!=='hardware'||!Number.isFinite(at)||at<=previous||at-previous>500)throw Error('Original endpoint feedback was interrupted');validateManualFeedback(sample.joints,row.plan,recoveryEndpointPolicy(row));assertLiftHealth(sample.health);previous=at;}
 const last=samples.at(-1),end=Date.parse(last.observedAt),i=samples.findIndex(s=>end-Date.parse(s.observedAt)<=1600),dwell=samples.slice(Math.max(0,i-1));
 if(end-begin<row.plan.observationWindowMs||dwell.length<9||end-Date.parse(dwell[0].observedAt)<1600||MANUAL_NAMES.some(k=>dwell.some(s=>Math.abs(s.joints[k]-last.joints[k])>SERVO_STEP+1e-9)))throw Error('Original endpoint did not record a complete settled window');
 if(noResponse){if(!cardboardNoResponse(row)&&!row.plan.movementJoints.some(j=>Math.abs(last.joints[j]-row.plan.start[j])>SERVO_STEP+1e-9)||row.plan.movementJoints.some(j=>Math.abs(last.joints[j]-row.plan.target[j])>recoveryEndpointToleranceRad(row,j)+1e-9))throw Error('Stylus no-response inspection requires another responding axis and every original endpoint band');return last.joints;}
 const error=Math.abs(last.joints[axis]-row.plan.target[axis]);if(error<=recoveryEndpointToleranceRad(row,axis)+1e-9||error>settledGrossTicks(row)*SERVO_STEP+1e-9)throw Error('Endpoint shortfall is outside the narrow qualification scope');
 if(row.plan.movementJoint==='coordinated')for(const joint of row.plan.movementJoints){if(Math.abs(last.joints[joint]-row.plan.start[joint])<=SERVO_STEP||joint!==axis&&Math.abs(last.joints[joint]-row.plan.target[joint])>recoveryEndpointToleranceRad(row,joint)+1e-9)throw Error('Both coordinated joints must respond and the other endpoint must already satisfy its canonical band');}
 return last.joints;
}
export function eligibleManualSettledEndpoint(row){try{settledEndpoint(row);return true;}catch{return false;}}
function validateLateSettledPose(row,pose,prior=settledEndpoint(row)){
 const axis=settledEndpointAxis(row);observedTicks(pose);
 for(const k of MANUAL_NAMES){const delta=pose[k]-prior[k];if(Math.abs(delta)>(k===axis?8:3)*SERVO_STEP+1e-9)throw Error('Late settled pose exceeds the bounded read-only qualification window');if(k===axis&&delta*Math.sign(row.plan.target[k]-prior[k])< -SERVO_STEP-1e-9)throw Error('Late settled pose departed away from the desired target');}
 if(Math.abs(pose[axis]-row.plan.target[axis])>settledGrossTicks(row)*SERVO_STEP+1e-9)throw Error('Late settled pose exceeds the gross response boundary');
 if(stylusNoResponse(row)&&row.plan.movementJoints.some(j=>Math.abs(pose[j]-row.plan.target[j])>recoveryEndpointToleranceRad(row,j)+1e-9))throw Error('Nonresponsive stylus pose must stay inside every original endpoint band');
}
const canonicalRestAuthorization=a=>a?.revision==='canonical-manual-rest-qualification-v1';
function validateCanonicalRestPose(row,pose,prior=settledEndpoint(row)){
 const axis=row.plan.movementJoint;observedTicks(pose);
 // Re-admit a newly measured stationary baseline only after the commanded
 // joint has reached its original canonical band. Never reclassify the miss.
 const toward=Math.sign(row.plan.target[axis]-prior[axis]),progress=(pose[axis]-prior[axis])*toward;
 if(Math.abs(pose[axis]-row.plan.target[axis])>recoveryEndpointToleranceRad(row,axis)+1e-9||progress< -SERVO_STEP-1e-9||progress>Math.abs(row.plan.target[axis]-prior[axis])+SERVO_STEP+1e-9)throw Error('Canonical rest requires arrival toward the original desired endpoint');
 for(const k of MANUAL_NAMES.filter(k=>k!==axis)){
  const anchored=row.plan.heldReference?.[k]??row.plan.start[k];
  if(Math.abs(pose[k]-prior[k])>recoveryEndpointToleranceRad(row,k)+1e-9||Math.abs(pose[k]-anchored)>recoveryEndpointToleranceRad(row,k)+1e-9)throw Error('Resting held joint exceeds its canonical error band');
 }
}
function validateDirectStylusResetPose(row,pose){
 if(row.plan.movementJoint!=='gripper'||row.plan.heldTolerancePolicy!==MANUAL_DIRECT_HELD_POLICY)throw Error('Stylus reset requires a direct manual gripper result');
 observedTicks(pose);
 if(Math.abs(pose.gripper-row.plan.target.gripper)>28*SERVO_STEP+1e-9)throw Error('Stylus reset exceeds the existing gross gripper response window');
 for(const joint of MANUAL_NAMES.filter(j=>j!=='gripper')){const anchor=row.plan.heldReference?.[joint]??row.plan.start[joint];if(Math.abs(pose[joint]-anchor)>recoveryEndpointToleranceRad(row,joint)+1e-9)throw Error('Stylus reset exceeds an original held-joint band');}
}
const normalSettledInspection=a=>a?.inspectionScope==='normal-tabletop';
export function validateSettledEndpointAuthorization(row,a,now=Date.now()){
 if(cardboardRecoveryRow(row)!==cardboardSettled(a))throw Error('Cardboard recovery requires its exact stationary contact inspection scope');
 if(cardboardSettled(a)&&(a.noAutomaticRetry!==true||a.noMotionCommandIssued!==true))throw Error('Cardboard recovery never replays a movement');
 if(stylusNoResponse(row)&&!loadedStylusSettled(a))throw Error('Nonresponsive stylus inspection requires the loaded free-air scope');
 if(a?.inspectionScope!==undefined&&!directStylusReset(a)&&!loadedStylusSettled(a)&&(!normalSettledInspection(a)||a.revision!=='settled-manual-endpoint-qualification-v1'))throw Error('Unknown settled-endpoint inspection scope');
 if(row?.plan?.movementJoint==='coordinated'&&(!(normalSettledInspection(a)||loadedStylusSettled(a))||a.revision!=='settled-manual-endpoint-qualification-v1'))throw Error('Coordinated endpoint requires the existing normal-tabletop stationary inspection');
 const observed=settledEndpoint(row),issued=Date.parse(a?.issuedAt),expires=Date.parse(a?.expiresAt);
 if(!['settled-manual-endpoint-qualification-v1','canonical-manual-rest-qualification-v1','direct-manual-stylus-pose-reset-v1'].includes(a?.revision)||a.commandId!==row.id||a.originalRowSHA256!==manualOriginalDigest(row)||!/^[a-f0-9]{64}$/.test(a.historySHA256??'')||typeof a.sourceInstruction!=='string'||a.sourceInstruction.length<30||!Number.isFinite(issued)||!Number.isFinite(expires)||issued<Date.parse(row.finishedAt)||issued>now||expires<=now||expires-issued>900000||!a.expectedObserved||Object.keys(a.expectedObserved).sort().join(',')!==MANUAL_NAMES.slice().sort().join(','))throw Error('Exact finite settled-endpoint qualification authorization required');
 if(loadedStylusSettled(a)){if(row.plan.movementJoint==='gripper'||a.operatorAssertedSetupChange!==undefined)throw Error('Loaded stylus recovery preserves the fixed gripper and unchanged pose');validateLateSettledPose(row,a.expectedObserved,observed);return a;}
 if(directStylusReset(a)){if(a.inspectionScope!=='direct-manual-loaded-stylus'||a.operatorResetRequested!==true||a.operatorAssertedSetupChange!==undefined)throw Error('Explicit direct manual stylus reset required');validateDirectStylusResetPose(row,a.expectedObserved);return a;}
 if(isManualSettledRestartAuthorization(a))return validateManualRestartAuthorization(row,a,now);
 if(a.operatorAssertedSetupChange!==undefined)throw Error('Explicit setup-change restart assertion required');
 if(canonicalRestAuthorization(a))validateCanonicalRestPose(row,a.expectedObserved,observed);else validateLateSettledPose(row,a.expectedObserved,observed);return a;
}
function validateCompletedPairShift(row,pose){
 if(!fullyDeliveredPair(row))throw Error('Completed paired recovery requires both original deliveries');
 const moving=row.plan.movementJoints;
 for(const k of MANUAL_NAMES){
  const shift=Math.abs(pose[k]-row.result.observed[k]);
  if(moving.includes(k)){if(shift>Math.min(8*SERVO_STEP,recoveryEndpointToleranceRad(row,k))+1e-9||Math.abs(pose[k]-row.plan.target[k])>recoveryEndpointToleranceRad(row,k)+1e-9)throw Error('Completed paired recovery exceeds an endpoint or shift limit');}
  else if(shift>3*SERVO_STEP+1e-9||Math.abs(pose[k]-(row.plan.heldReference?.[k]??row.plan.start[k]))>3*SERVO_STEP+1e-9)throw Error('Completed paired recovery exceeds a held-joint limit');
 }
}
// An exact, independently reviewed no-motion recovery; never a wider start gate.
export function validateCompletedRecoveryAuthorization(row,a,now=Date.now()){
 const issued=Date.parse(a?.issuedAt),expires=Date.parse(a?.expiresAt);
 if(!eligibleManualCompleted(row)||isManualTimeoutRestartAuthorization(a)||!(['completed-manual-base-shift-v1','completed-manual-current-pose-v1'].includes(a?.revision)||isManualRestartAuthorization(a))||a.commandId!==row.id||a.originalRowSHA256!==manualOriginalDigest(row)||!/^[a-f0-9]{64}$/.test(a.historySHA256??'')||typeof a.sourceInstruction!=='string'||a.sourceInstruction.length<30||typeof a.inspectionAssertion!=='string'||a.inspectionAssertion.length<30||!Number.isFinite(issued)||!Number.isFinite(expires)||issued<Date.parse(row.finishedAt)||issued>now||expires<=now||expires-issued>900000)throw Error('Exact current completed-pose recovery authorization required');
 const expected=a.expectedObserved;if(!expected||Object.keys(expected).sort().join(',')!==MANUAL_NAMES.slice().sort().join(','))throw Error('Exact reviewed recovery pose required');observedTicks(expected);observedTicks(row.result.observed);
 if(row.plan.movementJoint==='coordinated'){
  if(!pairedCompletedAuthorization(a))throw Error('Completed paired recovery requires the exact normal-tabletop current-pose review');
  if(completedCardboardGlide(row)!==cardboardCompletedAuthorization(a)||cardboardCompletedAuthorization(a)&&(a.noAutomaticRetry!==true||a.noMotionCommandIssued!==true))throw Error('Completed cardboard glide requires its exact no-motion contact inspection');
  validateCompletedPairShift(row,expected);
  if(!row.plan.movementJoints.some(k=>Math.abs(expected[k]-row.result.observed[k])>3*SERVO_STEP+1e-9))throw Error('Completed paired recovery requires an actual starting-pose shift');
  return a;
 }
 if(pairedCompletedAuthorization(a))throw Error('Paired current-pose review requires a completed pair');
 if(isManualRestartAuthorization(a))return validateManualRestartAuthorization(row,a,now);
 const axis=recoveryAxis(a);if(!MANUAL_NAMES.includes(axis))throw Error('Exact displaced joint required');
 const shift=Math.abs(expected[axis]-row.result.observed[axis]),maximum=currentPoseAuthorization(a)?Math.min(8*SERVO_STEP,recoveryEndpointToleranceRad(row,axis)):8*SERVO_STEP;
 if(shift<=3*SERVO_STEP+1e-9||shift>maximum+1e-9||MANUAL_NAMES.filter(k=>k!==axis).some(k=>Math.abs(expected[k]-row.result.observed[k])>3*SERVO_STEP+1e-9))throw Error('Completed recovery exceeds the narrow joint-shift window');
 return a;
}
function withinRecoveryWindow(row,pose,completedAuthorization,settledPrior){
 observedTicks(pose);
 if(isCrashRecoveryAuthorization(completedAuthorization)){
  if(eligibleManualAbortRepair(row))return validateManualAbortRepairPose(row,pose);
  if(eligibleManualShortfallRepair(row))return validateManualShortfallRepairPose(row,pose);
  if(!eligibleCrashRecovery(row))throw Error('Repair no longer matches the original move');
  for(const key of MANUAL_NAMES)if(Math.abs(pose[key]-(key===row.plan.movementJoint?row.plan.target[key]:row.plan.start[key]))>24*SERVO_STEP+1e-9)throw Error('Current position is outside the small manual recovery window');
  return;
 }
 if(cancelledGripperAuthorization(completedAuthorization)){validateCancelledGripperPose(row,pose);if(MANUAL_NAMES.some(k=>Math.abs(pose[k]-completedAuthorization.expectedObserved[k])>SERVO_STEP+1e-9))throw Error('Current position left the exact cancelled-gripper pose');return;}
 if(loadedStylusSettled(completedAuthorization)){validateLateSettledPose(row,pose,settledPrior);if(MANUAL_NAMES.some(k=>Math.abs(pose[k]-completedAuthorization.expectedObserved[k])>SERVO_STEP+1e-9))throw Error('Current position left the exact reviewed stylus pose');return;}
 if(directStylusReset(completedAuthorization)){validateDirectStylusResetPose(row,pose);if(MANUAL_NAMES.some(k=>Math.abs(pose[k]-completedAuthorization.expectedObserved[k])>SERVO_STEP+1e-9))throw Error('Current position left the exact reviewed stylus pose');return;}
 if(displacementAuthorization(completedAuthorization)){validateCanonicalDisplacementPose(row,pose);if(MANUAL_NAMES.some(k=>Math.abs(pose[k]-completedAuthorization.expectedObserved[k])>SERVO_STEP+1e-9))throw Error('Current position left the exact reviewed displacement pose');return;}
 if(eligibleManualNotSent(row)){observedTicks(row.plan.start);if(MANUAL_NAMES.some(k=>Math.abs(pose[k]-row.plan.start[k])>3*SERVO_STEP+1e-9))throw Error('Unsent command recovery must remain at its recorded starting pose');return;}
 if(isManualRestartAuthorization(completedAuthorization)){if(MANUAL_NAMES.some(k=>Math.abs(pose[k]-completedAuthorization.expectedObserved[k])>SERVO_STEP+1e-9))throw Error('Current position left the exact restarted-pose window');return;}
 if(eligibleManualTimeout(row)){
  for(const k of MANUAL_NAMES){const moving=(row.plan.movementJoints??[row.plan.movementJoint]).includes(k),expected=moving?row.plan.target[k]:(row.plan.heldReference?.[k]??row.plan.start[k]),limit=moving?Math.min(24*SERVO_STEP,recoveryEndpointToleranceRad(row,k)):3*SERVO_STEP;if(!Number.isFinite(expected)||Math.abs(pose[k]-expected)>limit+1e-9)throw Error('Current position is outside the timeout recovery window');}
  return;
 }
 if(completedAuthorization?.revision==='settled-manual-endpoint-qualification-v1'||canonicalRestAuthorization(completedAuthorization)){if(canonicalRestAuthorization(completedAuthorization))validateCanonicalRestPose(row,pose,settledPrior);else validateLateSettledPose(row,pose,settledPrior);if(MANUAL_NAMES.some(k=>Math.abs(pose[k]-completedAuthorization.expectedObserved[k])>SERVO_STEP+1e-9))throw Error('Current position left the exact reviewed settled-endpoint pose');return;}
 if(pairedCompletedAuthorization(completedAuthorization)){validateCompletedPairShift(row,pose);if(MANUAL_NAMES.some(k=>Math.abs(pose[k]-completedAuthorization.expectedObserved[k])>SERVO_STEP+1e-9))throw Error('Current position is outside the exact completed paired pose');return;}
 if(completedAuthorization){const axis=recoveryAxis(completedAuthorization),maximum=currentPoseAuthorization(completedAuthorization)?Math.min(8*SERVO_STEP,recoveryEndpointToleranceRad(row,axis)):8*SERVO_STEP;if(MANUAL_NAMES.some(k=>Math.abs(pose[k]-completedAuthorization.expectedObserved[k])>SERVO_STEP+1e-9)||Math.abs(pose[axis]-row.result.observed[axis])>maximum+1e-9||MANUAL_NAMES.filter(k=>k!==axis).some(k=>Math.abs(pose[k]-row.result.observed[k])>3*SERVO_STEP+1e-9))throw Error('Current position is outside the exact completed recovery window');return;}
 for(const key of MANUAL_NAMES){const moving=key===row.plan.movementJoint,expected=moving?row.plan.target[key]:row.plan.start[key],ticks=eligibleManualIntent(row)||moving?24:3;
  if(!Number.isFinite(expected)||Math.abs(pose[key]-expected)>ticks*SERVO_STEP+1e-9)throw Error('Current position is outside the small manual recovery window');
 }
}
function validateSamples(row,samples,completedAuthorization){
 if(!Array.isArray(samples)||samples.length<100)throw Error('Manual recovery needs 30 seconds of stationary feedback');
 // Private reuse only within this synchronous validation. A later call must
 // validate the original trajectory again, including any nested edits.
 const settledPrior=completedAuthorization?.revision==='settled-manual-endpoint-qualification-v1'||canonicalRestAuthorization(completedAuthorization)?settledEndpoint(row):undefined;
 const min={},max={};let first=null,last=null;
 for(const sample of samples){
  const at=Date.parse(sample.observedAt);if(!Number.isFinite(at)||at>Date.now()||(last!==null&&(at<=last||at-last>500)))throw Error('Manual recovery feedback was interrupted');
  first??=at;last=at;withinRecoveryWindow(row,sample.joints,completedAuthorization,settledPrior);assertLiftHealth(sample.health);
  for(const k of MANUAL_NAMES){min[k]=Math.min(min[k]??Infinity,sample.joints[k]);max[k]=Math.max(max[k]??-Infinity,sample.joints[k]);if(max[k]-min[k]>SERVO_STEP+1e-9)throw Error('Arm is not stationary');}
 }
 if(last-first<30000)throw Error('Manual recovery stationary window is incomplete');
 return {duration:last-first,observed:{...samples.at(-1).joints}};
}
const inspectedRecoveryCache=new WeakMap();
export function isInspectedManualRecovery(row){
 const immutable=isImmutableHistoryValue(row),now=Date.now(),checkedAt=immutable?inspectedRecoveryCache.get(row):undefined;
 if(checkedAt!==undefined&&now>=checkedAt&&Date.parse(row.manualRecovery.inspectedAt)<=now)return true;
 const valid=validateInspectedManualRecovery(row);
 // Only privately parsed, deeply frozen rows can reuse a successful result.
 // Mutable inputs and a backward clock still run the original validation.
 if(valid&&immutable)inspectedRecoveryCache.set(row,Date.now());
 return valid;
}
function validateInspectedManualRecovery(row){
 try{
  const r=row?.manualRecovery;if(!r||!Number.isFinite(Date.parse(r.inspectedAt))||Date.parse(r.inspectedAt)>Date.now())return false;const original={...row};delete original.manualRecovery;
  const cancelled=!isCrashRecoveryAuthorization(r.intentAuthorization)&&eligibleManualCancelled(original),intent=eligibleManualIntent(original)||(isCrashRecoveryAuthorization(r.intentAuthorization)&&(eligibleManualShortfallRepair(original)||eligibleManualAbortRepair(original))),completed=eligibleManualCompleted(original),settled=!isCrashRecoveryAuthorization(r.intentAuthorization)&&eligibleManualSettledEndpoint(original),restartedTimeout=eligibleManualTimeout(original)&&isManualTimeoutRestartAuthorization(r.timeoutAuthorization),inspectionKeys=cancelled?CANCELLED_GRIPPER_INSPECTIONS:(settled&&cardboardSettled(r.settledEndpointAuthorization)||completed&&cardboardCompletedAuthorization(r.completedAuthorization))?CARDBOARD_RECOVERY_INSPECTIONS:settled&&(directStylusReset(r.settledEndpointAuthorization)||loadedStylusSettled(r.settledEndpointAuthorization))?DIRECT_STYLUS_RESET_INSPECTIONS:settled&&isManualSettledRestartAuthorization(r.settledEndpointAuthorization)?MANUAL_SETTLED_RESTART_INSPECTIONS:restartedTimeout||completed&&isManualRestartAuthorization(r.completedAuthorization)?MANUAL_RESTART_INSPECTIONS:(settled&&normalSettledInspection(r.settledEndpointAuthorization)||completed&&pairedCompletedAuthorization(r.completedAuthorization))?MANUAL_RECOVERY_INSPECTIONS:settled||completed&&currentPoseAuthorization(r.completedAuthorization)?MANUAL_TEST_CONFIRMATIONS:intent?(isCrashRecoveryAuthorization(r.intentAuthorization)?CRASH_RECOVERY_INSPECTIONS:MANUAL_CONFIRMATIONS):MANUAL_RECOVERY_INSPECTIONS;
  if(intent){const a=r.intentAuthorization;if(r.revision!==(eligibleManualAbortRepair(original)?ABORT_REPAIR_REVISION:eligibleManualShortfallRepair(original)?SHORTFALL_REPAIR_REVISION:'observed-manual-intent-v1')||r.priorDispatch!=='unknown'||r.priorOutcome!=='unknown'||a?.commandId!==row.id||a.originalRowSHA256!==manualOriginalDigest(row)||typeof a.sourceInstruction!=='string'||a.sourceInstruction.length<30||!Number.isFinite(Date.parse(a.issuedAt))||!Number.isFinite(Date.parse(a.expiresAt))||Date.parse(a.expiresAt)<=Date.parse(a.issuedAt)||Date.parse(r.inspectedAt)>=Date.parse(a.expiresAt)||Date.parse(r.observations?.[0]?.observedAt)<Date.parse(a.issuedAt))return false;}
  if(intent&&isCrashRecoveryAuthorization(r.intentAuthorization)){validateCrashAuthorization(original,r.intentAuthorization,Date.parse(r.inspectedAt));if((eligibleManualShortfallRepair(original)||eligibleManualAbortRepair(original))&&r.originalEndpointAccepted!==false)return false;}
  else if(completed){if(r.revision!=='observed-manual-completed-v1')return false;validateCompletedRecoveryAuthorization(original,r.completedAuthorization,Date.parse(r.inspectedAt));if(Date.parse(r.observations?.[0]?.observedAt)<Date.parse(r.completedAuthorization.issuedAt))return false;}
  else if(settled){if(r.revision!=='observed-manual-settled-endpoint-v1')return false;validateSettledEndpointAuthorization(original,r.settledEndpointAuthorization,Date.parse(r.inspectedAt));if(Date.parse(r.observations?.[0]?.observedAt)<Date.parse(r.settledEndpointAuthorization.issuedAt))return false;}
  else if(eligibleManualTimeout(original)){
   validateTimeoutRecoveryReview(original,r.timeoutAuthorization,Date.parse(r.inspectedAt));
   if((restartedTimeout||cancelled)&&Date.parse(r.observations?.[0]?.observedAt)<Date.parse(r.timeoutAuthorization.issuedAt))return false;
   const c=r.currentCleanup,at=Date.parse(c?.checkedAt),first=Date.parse(r.observations?.[0]?.observedAt);
   if(r.revision!=='observed-manual-timeout-v1'||r.priorOutcome!=='unknown'||r.originalCleanupVerified!==row.result.cleanupVerified||!c||c.verified!==true||c.physicalStopVerified!==false||c.outstandingOperations!==0||!Number.isSafeInteger(c.generation)||!Number.isFinite(at)||at<Date.parse(row.finishedAt)||at>first||Date.parse(r.inspectedAt)<at)return false;
  }
  else if(!intent&&(!eligibleManualRecovery(original)||r.revision!=='inspected-manual-pose-v1'))return false;
  if(r.displacementAuthorization){validateDisplacementRecoveryReview(original,r.displacementAuthorization,Date.parse(r.inspectedAt));if(Date.parse(r.observations?.[0]?.observedAt)<Date.parse(r.displacementAuthorization.issuedAt))return false;}
  if(r.disposition!=='accept-current-pose-for-new-manual-request'||r.originalRowSHA256!==manualOriginalDigest(row)||r.reviewId!==row.manual.reviewId||r.cause!=='unknown'||r.noMotionCommandIssued!==true||r.preciseArrival!==false||Object.keys(r.inspection??{}).sort().join(',')!==[...inspectionKeys].sort().join(',')||!inspectionKeys.every(k=>r.inspection?.[k]===true)||!Number.isFinite(Date.parse(r.inspectedAt))||!r.owner||!/^[a-f0-9]{64}$/.test(r.configDigest??'')||!/^[a-f0-9]{64}$/.test(r.reviewSHA256??'')||!r.sourceHashes)return false;
  const proof=validateSamples(original,r.observations,restartedTimeout||cancelled?r.timeoutAuthorization:completed?r.completedAuthorization:settled?r.settledEndpointAuthorization:r.displacementAuthorization??(isCrashRecoveryAuthorization(r.intentAuthorization)?r.intentAuthorization:undefined));
  const floor=recordedTabletopFloor(r.geometry);
  return floor!==null&&r.observationDurationMs===proof.duration&&r.observationCount===r.observations.length&&Date.parse(r.inspectedAt)>=Date.parse(r.observations.at(-1).observedAt)&&MANUAL_NAMES.every(k=>r.observed?.[k]===proof.observed[k])&&r.geometry?.revision===MANUAL_REVISION&&r.geometry.requiredBodyHeightMm===floor&&r.geometry.requiredSelfSeparationMm===24&&Object.values(r.geometry.minimumBodyHeightMm??{}).length===4&&Object.values(r.geometry.minimumBodyHeightMm).every(h=>h>=floor)&&r.geometry.minimumSelfSeparationMm>=24&&r.modelAgreementMm<=1&&r.modelAgreementMm>=0;
 }catch{return false;}
}
export function completedRecoveryHistoryMatches(row,history){
 try{
  if(!(['observed-manual-completed-v1','observed-manual-settled-endpoint-v1','observed-manual-timeout-v1'].includes(row?.manualRecovery?.revision)||row?.manualRecovery?.displacementAuthorization||isCrashRecoveryAuthorization(row?.manualRecovery?.intentAuthorization))||!isInspectedManualRecovery(row)||!Array.isArray(history?.commands))return false;
  const i=history.commands.findIndex(r=>r.id===row.id);if(i<0||history.commands.filter(r=>r.id===row.id).length!==1)return false;
  const prefix=historyPrefix(history,i+1,{withoutLastRecovery:true});
  return historyDigest(prefix)===(row.manualRecovery.completedAuthorization??row.manualRecovery.settledEndpointAuthorization??row.manualRecovery.timeoutAuthorization??row.manualRecovery.displacementAuthorization??row.manualRecovery.intentAuthorization).historySHA256;
 }catch{return false;}
}
// The caller must also validate the receipt against its active source review.
export const acceptedManualPose=(row,history,reviewBound=false)=>row?.manualRecovery?((['observed-manual-completed-v1','observed-manual-settled-endpoint-v1','observed-manual-timeout-v1'].includes(row.manualRecovery.revision)||row.manualRecovery.displacementAuthorization||isCrashRecoveryAuthorization(row.manualRecovery.intentAuthorization))?(reviewBound&&completedRecoveryHistoryMatches(row,history)?row.manualRecovery.observed:null):isInspectedManualRecovery(row)?row.manualRecovery.observed:null):row?.result?.observed;

export async function recoverManualPose(m,input,admission,validatePrefix,{selfServiceCrash=false}={}){
 if(!input||Object.keys(input).sort().join(',')!=='commandId,inspection,note,originalRowSHA256,owner'||!input.inspection||typeof input.note!=='string'||input.note.length<20||input.note.length>500)throw Error('Current stationary inspection for the selected recovery is required');
 return m.c.withForeground(async()=>{
  m.setup(input.owner);const c=m.c,generation=c.generation;
  if(m.session||m.active||c.mode!=='serial')throw Error('Idle serial setup required for manual position recovery');
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),45000),samples=[];c.abort=abort;c.busy=true;c.taskActive=true;c.lifecycle='manual-pose-recovery';
  const gate=()=>{admission();c.assertOwner(input.owner);if(abort.signal.aborted||c.generation!==generation||!c.connected||c.armed||c.commissioned||m.session||c.recoveryFault||c.pendingConnectionClose||c.stopping)throw Error('Manual recovery cancelled');};
  try{
   const config=await m.physicalConfig(),history=await m.history(),historySHA256=calibrationDigest(history),row=history.commands.at(-1);
   if(selfServiceCrash&&(!crashRecoveryEnabled(config)||!(eligibleCrashRecovery(row)||eligibleManualShortfallRepair(row)||eligibleManualAbortRepair(row))))throw Error('This hold is outside local crash recovery; no records were cleared');
   const crashIssued=Date.now();
   const crashAuthorization=selfServiceCrash?{revision:CRASH_RECOVERY_REVISION,commandId:row.id,originalRowSHA256:manualOriginalDigest(row),historySHA256,sourceInstruction:CRASH_RECOVERY_INSTRUCTION,issuedAt:new Date(crashIssued).toISOString(),expiresAt:new Date(crashIssued+120000).toISOString()}:null;
   const cancelled=!selfServiceCrash&&eligibleManualCancelled(row),timeout=!selfServiceCrash&&eligibleManualTimeout(row),intent=eligibleManualIntent(row)||(selfServiceCrash&&(eligibleManualShortfallRepair(row)||eligibleManualAbortRepair(row))),completed=eligibleManualCompleted(row),settled=!selfServiceCrash&&eligibleManualSettledEndpoint(row),displaced=eligibleManualRecovery(row)&&Boolean(config.manualReview?.displacementRecovery),authorization=displaced?config.manualReview.displacementRecovery:timeout?config.manualReview?.timeoutRecovery:intent?(crashAuthorization??config.manualReview?.intentRecovery):completed?config.manualReview?.completedPoseRecovery:settled?config.manualReview?.settledEndpointRecovery:null,restartedTimeout=timeout&&isManualTimeoutRestartAuthorization(authorization),inspectionKeys=cancelled?CANCELLED_GRIPPER_INSPECTIONS:(settled&&cardboardSettled(authorization)||completed&&cardboardCompletedAuthorization(authorization))?CARDBOARD_RECOVERY_INSPECTIONS:settled&&(directStylusReset(authorization)||loadedStylusSettled(authorization))?DIRECT_STYLUS_RESET_INSPECTIONS:settled&&isManualSettledRestartAuthorization(authorization)?MANUAL_SETTLED_RESTART_INSPECTIONS:restartedTimeout||completed&&isManualRestartAuthorization(authorization)?MANUAL_RESTART_INSPECTIONS:(settled&&normalSettledInspection(authorization)||completed&&pairedCompletedAuthorization(authorization))?MANUAL_RECOVERY_INSPECTIONS:settled||completed&&currentPoseAuthorization(authorization)?MANUAL_TEST_CONFIRMATIONS:intent?(isCrashRecoveryAuthorization(authorization)?CRASH_RECOVERY_INSPECTIONS:MANUAL_CONFIRMATIONS):MANUAL_RECOVERY_INSPECTIONS;
   const intentGate=()=>{if(intent&&(!authorization||authorization.commandId!==row.id||authorization.originalRowSHA256!==manualOriginalDigest(row)||typeof authorization.sourceInstruction!=='string'||authorization.sourceInstruction.length<30||!Number.isFinite(Date.parse(authorization.issuedAt))||Date.parse(authorization.issuedAt)>Date.now()||!Number.isFinite(Date.parse(authorization.expiresAt))||Date.now()>=Date.parse(authorization.expiresAt)))throw Error('Exact current intent recovery authorization required');};
   const completedGate=()=>{
    if(displaced){validateDisplacementRecoveryReview(row,authorization);if(authorization.historySHA256!==historySHA256)throw Error('Displacement recovery history changed');}
    if(timeout){validateTimeoutRecoveryReview(row,authorization);if(authorization.historySHA256!==historySHA256)throw Error('Timeout recovery history changed');}
    if(completed||settled){if(settled){if(!normalSettledInspection(authorization)&&!directStylusReset(authorization)&&!loadedStylusSettled(authorization)&&!config.manualTestWindow)throw Error('Settled endpoint qualification requires a current finite test window');if((normalSettledInspection(authorization)||directStylusReset(authorization)||loadedStylusSettled(authorization))&&config.manualTestWindow)throw Error('Normal tabletop recovery cannot use a legacy sector window');validateSettledEndpointAuthorization(row,authorization);}else validateCompletedRecoveryAuthorization(row,authorization);if(authorization.historySHA256!==historySHA256)throw Error('Completed recovery history changed');}
   };
   if(!config.manualReview||config.profile.phase!=='qualified'||(!eligibleManualRecovery(row)&&!timeout&&!intent&&!completed&&!settled)||row.id!==input.commandId||row.manual.reviewId!==config.manualReview.id||manualOriginalDigest(row)!==input.originalRowSHA256)throw Error('Only the latest qualified manual position-change hold is eligible');
   if(Object.keys(input.inspection).sort().join(',')!==[...inspectionKeys].sort().join(',')||!inspectionKeys.every(k=>input.inspection[k]===true))throw Error('Current inspection confirmations required');
   if(isCrashRecoveryAuthorization(authorization)){validateCrashAuthorization(row,authorization,Date.now());if(authorization.historySHA256!==historySHA256)throw Error('Crash recovery history changed');}
   intentGate();completedGate();
   validatePrefix(config,completed?history:{...history,commands:history.commands.slice(0,-1)});
   let currentCleanup;
   if(timeout){
    gate();await c.bounded(()=>c.transport.stop(),abort.signal);gate();
    if(c.outstanding.size||c.recoveryFault||c.pendingConnectionClose||c.stopping)throw Error('Timeout recovery requires verified current transport cleanup');
    currentCleanup={verified:true,physicalStopVerified:false,checkedAt:new Date().toISOString(),outstandingOperations:0,generation:c.generation};
   }
   const expected=await m.fresh(abort.signal);withinRecoveryWindow(row,expected,restartedTimeout||cancelled||completed||settled||displaced||selfServiceCrash?authorization:undefined);
   const geometry=manualEnvelope(completed&&!isManualRestartAuthorization(authorization)?row.result.observed:expected,expected),cart=forwardKinematics(expected,OFFSET_MODEL_REVISION),modelAgreementMm=c.firmwareCartesian?Math.hypot(...['x','y','z'].map(k=>cart[k]-c.firmwareCartesian[k])):Infinity;
   if(!Number.isFinite(modelAgreementMm)||modelAgreementMm>1)throw Error('Current geometry disagrees with firmware');
   let first=null,last=null;
   do{
    gate();intentGate();completedGate();const pose=await m.fresh(abort.signal),at=Date.parse(c.telemetryUpdatedAt),now=Date.now();
    if(!Number.isFinite(at)||at>now||now-at>500||(last!==null&&(at<=last||at-last>500)))throw Error('Manual recovery feedback is stale or interrupted');
    withinRecoveryWindow(row,pose,restartedTimeout||cancelled||completed||settled||displaced||selfServiceCrash?authorization:undefined);
    if(MANUAL_NAMES.some(k=>Math.abs(expected[k]-pose[k])>SERVO_STEP+1e-9)||samples.some(s=>MANUAL_NAMES.some(k=>Math.abs(s.joints[k]-pose[k])>SERVO_STEP+1e-9)))throw Error('Arm is not stationary');
    first??=at;last=at;samples.push({observedAt:c.telemetryUpdatedAt,joints:pose,health:{...c.liftHealth}});
    if(last-first<30000||samples.length<100)await delay(150,undefined,{signal:abort.signal});
   }while(last-first<30000||samples.length<100);
   if((await m.physicalConfig()).digest!==config.digest||calibrationDigest(await m.history())!==historySHA256)throw Error('Manual recovery configuration or history changed');
   gate();intentGate();completedGate();row.manualRecovery={revision:timeout?'observed-manual-timeout-v1':intent?(eligibleManualAbortRepair(row)?ABORT_REPAIR_REVISION:eligibleManualShortfallRepair(row)?SHORTFALL_REPAIR_REVISION:'observed-manual-intent-v1'):completed?'observed-manual-completed-v1':settled?'observed-manual-settled-endpoint-v1':'inspected-manual-pose-v1',...(displaced?{displacementAuthorization:structuredClone(authorization)}:{}),...(timeout?{timeoutAuthorization:structuredClone(authorization),currentCleanup,priorOutcome:'unknown',originalCleanupVerified:row.result.cleanupVerified}:{}),...(selfServiceCrash&&(eligibleManualShortfallRepair(row)||eligibleManualAbortRepair(row))?{originalEndpointAccepted:false}:{}),...(intent?{intentAuthorization:structuredClone(authorization),priorDispatch:'unknown',priorOutcome:'unknown'}:{}),...(completed?{completedAuthorization:structuredClone(authorization)}:{}),...(settled?{settledEndpointAuthorization:structuredClone(authorization),originalEndpointAccepted:false}:{}),disposition:'accept-current-pose-for-new-manual-request',originalRowSHA256:input.originalRowSHA256,reviewId:config.manualReview.id,reviewSHA256:config.profile.review.sha256,configDigest:config.digest,sourceHashes:config.manualReview.sourceHashes,owner:input.owner,inspectedAt:new Date().toISOString(),inspection:{...input.inspection},note:input.note,cause:'unknown',observations:samples,observed:{...samples.at(-1).joints},observationDurationMs:last-first,observationCount:samples.length,geometry,modelAgreementMm,preciseArrival:false,noMotionCommandIssued:true};
   if(!isInspectedManualRecovery(row))throw Error('Manual recovery proof failed validation');
   const sources=await manualSources();if(calibrationDigest(sources)!==calibrationDigest(config.manualReview.sourceHashes))throw Error('Manual recovery source changed');
   await m.save(history,()=>{
    gate();if((intent||completed||settled||restartedTimeout||cancelled||displaced)&&Date.now()>=Date.parse(authorization.expiresAt))throw Error('Manual recovery authority expired');if(calibrationDigest(readFileSync(path.join(c.directory,'commissioning/motion.json')))!==config.digest||calibrationDigest(readFileSync(path.join(c.directory,'commissioning',config.profile.review.file)))!==config.profile.review.sha256||calibrationDigest(JSON.parse(readFileSync(m.file,'utf8')))!==historySHA256||Object.entries(sources).some(([f,h])=>calibrationDigest(readFileSync(new URL('../'+f,import.meta.url)))!==h))throw Error('Manual recovery evidence changed before commit');
   });
   m.result=structuredClone(row);return {id:row.id,recovered:true,observed:row.manualRecovery.observed,noMotionCommandIssued:true};
  }finally{clearTimeout(timer);if(c.abort===abort)c.abort=null;c.busy=false;c.taskActive=false;c.lifecycle=null;}
 });
}
