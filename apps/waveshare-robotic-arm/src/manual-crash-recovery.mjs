// A local, explicitly inspected recovery of an interrupted direct Manual click.
// It accepts a stationary start; it never claims that the interrupted move finished.
import {MANUAL_NAMES,validateManualFeedback,manualEndpointToleranceRad} from './manual-joints.mjs';
import {SERVO_STEP,assertLiftHealth,observedTicks} from './z-lift-actuators.mjs';
export const SHORTFALL_REPAIR_REVISION='observed-manual-shortfall-v1';
export const ABORT_REPAIR_REVISION='observed-manual-abort-v1';
export const CRASH_RECOVERY_REVISION='local-inspected-crash-v1';
export const CRASH_RECOVERY_INSPECTIONS=['baseSecured','tabletop600mmClear','toolSecuredOrEmpty','cablesSlack','powerSwitchReady','stationary','noContact','noUnusualNoise','noTouchResetPowerChange'];
export const CRASH_RECOVERY_INSTRUCTION='Operator requested Repair Controller and confirmed the current stationary, contact-free setup; accept the observed pose without retrying the interrupted move.';
export const isCrashRecoveryAuthorization=a=>a?.revision===CRASH_RECOVERY_REVISION;
export const crashRecoveryEnabled=c=>c?.profile?.phase==='qualified'&&c.profile.manualAccess==='local-direct-on-startup-v1'&&c.manualReview?.manualAccess==='local-direct-on-startup-v1'&&c.manualReview.crashRecovery===CRASH_RECOVERY_REVISION&&!c.manualReview.stylusTraining&&!c.manualTestWindow;
export const eligibleCrashRecovery=row=>row?.mode==='serial'&&row.state==='intent'&&row.manual?.phase==='qualified'&&row.plan?.experiment==='stock-tabletop-manual-v1'&&['base','shoulder','elbow','gripper'].includes(row.plan.movementJoint)&&row.plan.heldTolerancePolicy==='direct-manual-canonical-v2'&&row.plan.startPolicy==='operator-current-pose-v1'&&!row.plan.commands&&!row.result&&!row.finishedAt&&!row.manualRecovery&&!row.poseRecovery&&!row.resetRecovery&&!row.reconciliation;
export function eligibleManualAbortRepair(row){
 try{
  const p=row?.plan,r=row?.result,j=p?.movementJoint,s=r?.observations,dispatch=Date.parse(row?.dispatchedAt),finished=Date.parse(row?.finishedAt);
  if(row?.mode!=='serial'||row.state!=='blocked'||row.manual?.phase!=='qualified'||p?.experiment!=='stock-tabletop-manual-v1'||!MANUAL_NAMES.includes(j)||p.commands||p.heldTolerancePolicy!=='direct-manual-canonical-v2'||p.startPolicy!=='operator-current-pose-v1'||p.command?.T!==101||p.command.joint!==MANUAL_NAMES.indexOf(j)+1||(!Number.isFinite(p.command.rad)||p.command.spd!==20||p.command.acc!==1||j==='gripper'&&p.command.rad!==p.commandTarget?.[j])||row.dispatchAttempt?.status!=='may-have-been-sent'||r?.outcome!=='uncertain'||!['The operation was aborted','Command cancelled; physical result unknown'].includes(r.error)||r.cleanupVerified!==true||r.requiresReconciliation!==true||row.manualRecovery||row.poseRecovery||row.resetRecovery||row.reconciliation||!Array.isArray(s)||!Number.isFinite(dispatch)||!Number.isFinite(finished)||finished<dispatch)return false;
  let previous=dispatch;
  for(const sample of s){const at=Date.parse(sample.observedAt);if(sample.source!=='hardware'||!Number.isFinite(at)||at<=previous||at-previous>500||at>finished)return false;validateManualFeedback(sample.joints,p,p.endpointTolerancePolicy);assertLiftHealth(sample.health);previous=at;}
  // With no post-dispatch samples, only the recorded start is a usable anchor.
  // Fresh stationary observation must still pass; no delivery is inferred.
  validateManualAbortRepairPose(row,s.at(-1)?.joints??p.start);return true;
 }catch{return false;}
}
export function validateManualAbortRepairPose(row,pose){
 observedTicks(pose);validateManualFeedback(pose,row.plan,row.plan.endpointTolerancePolicy);
 const j=row.plan.movementJoint,anchor=row.result.observations.at(-1)?.joints??row.plan.start;
 for(const k of MANUAL_NAMES)if(Math.abs(pose[k]-anchor[k])>(k===j?24:3)*SERVO_STEP+1e-9)throw Error('Current pose left the recorded aborted-move window');
}
// Preserve the original failed result and require its complete, healthy recorded
// observation window. A later stationary baseline does not accept the missed target.
export function eligibleManualShortfallRepair(row){
 try{
  const p=row?.plan,r=row?.result,j=p?.movementJoint,s=r?.observations;
  if(row?.mode!=='serial'||row.state!=='blocked'||row.manual?.phase!=='qualified'||p?.experiment!=='stock-tabletop-manual-v1'||!MANUAL_NAMES.includes(j)||p.commands||p.heldTolerancePolicy!=='direct-manual-canonical-v2'||p.startPolicy!=='operator-current-pose-v1'||r?.outcome!=='uncertain'||r.error!==`Manual command did not produce a sufficient settled response within the ${j} endpoint limit`||r.cleanupVerified!==true||r.requiresReconciliation!==true||row.manualRecovery||row.poseRecovery||row.resetRecovery||row.reconciliation||!Array.isArray(s)||s.length<10||!Number.isFinite(Date.parse(row.dispatchedAt))||!Number.isFinite(Date.parse(row.finishedAt)))return false;
  let previous=Date.parse(row.dispatchedAt);
  for(const sample of s){const at=Date.parse(sample.observedAt);if(sample.source!=='hardware'||!Number.isFinite(at)||at<=Date.parse(row.dispatchedAt)||at>Date.parse(row.finishedAt)||previous!==null&&(at<=previous||at-previous>500))return false;validateManualFeedback(sample.joints,p,p.endpointTolerancePolicy);assertLiftHealth(sample.health);previous=at;}
  const last=s.at(-1),end=Date.parse(last.observedAt),dwell=s.filter(x=>end-Date.parse(x.observedAt)<=1800),error=Math.abs(last.joints[j]-p.target[j]);
  if(end-Date.parse(row.dispatchedAt)<p.observationWindowMs||dwell.length<9||end-Date.parse(dwell[0].observedAt)<1600||error<=manualEndpointToleranceRad(j,p.endpointTolerancePolicy)||error>28*SERVO_STEP+1e-9||MANUAL_NAMES.some(k=>dwell.some(x=>Math.abs(x.joints[k]-last.joints[k])>SERVO_STEP+1e-9)))return false;
  validateManualShortfallRepairPose(row,last.joints);return true;
 }catch{return false;}
}
export function validateManualShortfallRepairPose(row,pose){
 observedTicks(pose);const p=row.plan,j=p.movementJoint,last=row.result.observations.at(-1).joints;
 for(const k of MANUAL_NAMES){
  if(Math.abs(pose[k]-last[k])>(k===j?8:3)*SERVO_STEP+1e-9)throw Error('Current pose left the recorded shortfall window');
  const reference=k===j?p.target[k]:(p.heldReference?.[k]??p.start[k]),limit=k===j?28*SERVO_STEP:manualEndpointToleranceRad(k,p.endpointTolerancePolicy);
  if(Math.abs(pose[k]-reference)>limit+1e-9)throw Error('Current pose exceeds the shortfall recovery bounds');
 }
}
export function validateCrashAuthorization(row,a,now){
 const issued=Date.parse(a?.issuedAt),expires=Date.parse(a?.expiresAt);
 if(!(eligibleCrashRecovery(row)||eligibleManualShortfallRepair(row)||eligibleManualAbortRepair(row))||!isCrashRecoveryAuthorization(a)||a.commandId!==row.id||a.sourceInstruction!==CRASH_RECOVERY_INSTRUCTION||!/^[a-f0-9]{64}$/.test(a.historySHA256??'')||!Number.isFinite(issued)||!Number.isFinite(expires)||issued>now||expires<=now||expires-issued!==120000)throw Error('Current local crash recovery authorization required');
}
