import {isCrashRecoveryAuthorization} from './manual-crash-recovery.mjs';
import {assertFactoryCalibrationHistory,assertFactoryCalibrationMoves,planFactoryCalibration} from './factory-manual-calibration.mjs';
import {MovementHistorySnapshot,historyDigest,historyJSON,historyFileDigest,appendHistory,prepareHistoryCommit} from './movement-history-snapshot.mjs';
import {MANUAL_REVISION,stylusConfirmationKeys,validateStylusTrainingPlan,MANUAL_CONFIRMATIONS,MANUAL_TEST_CONFIRMATIONS,MANUAL_NAMES,MANUAL_TOLERANCE,MANUAL_DIRECT_HELD_POLICY,markSayAhClosing,isSayAhClosingPlan,directManualStartWithinAcceptedEndpoint,manualEndpointToleranceRad,manualMoveJoints,manualPlanJoints,validateManualTestPlan,normalizeManualMove,planManual,validateManualFeedback,classifyManualSettling} from './manual-joints.mjs';
import {createManualSettledExit} from './manual-settled-exit.mjs';
import {assertManualHistory,assertManualMoves,manualRecoveryBoundToReview,manualStartupAccess,manualStartupPoseAllowed} from './manual-joints-review.mjs';
import {isInspectedManualRecovery,acceptedManualPose,recoverManualPose,completedRecoveryHistoryMatches} from './manual-pose-recovery.mjs';
import {DRAMATIC_WAVE_SCOPE,DRAMATIC_WAVE_MAX_WINDOW_MS} from './dramatic-wave.mjs';
import {executeGuardedTrajectory} from './guarded-trajectory-executor.mjs';
import {validateRoutineMotionConsent} from './routine-motion-consent.mjs';
import {readRoutineMotionConsent} from './routine-motion-consent.mjs';
import {ELBOW_REPEAT_SCOPE} from './finite-elbow-repeat.mjs';
import fs from 'node:fs/promises';
import {ELBOW_FEEDFORWARD_SCOPE} from './elbow-feedforward-qualification.mjs';
import {isReviewedElbowBaseShift,recoverElbowCurrentPose} from './elbow-stationary-recovery.mjs';
import {readFileSync,renameSync} from 'node:fs';
import path from 'node:path';
import {assertManualRestartStart,assertManualRestartSession,isManualRestartAuthorization,manualRestartAuthorization} from './manual-restart-qualification.mjs';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {exact,normalizeMove,readMotionConfig,completionSourceHashes,resetAdmissionSourceHashes,digest} from './motion-config.mjs';
import {observedTicks,SERVO_STEP,assertLiftHealth} from './z-lift-actuators.mjs';
import {planOtherJoint,SHARED_EXPERIMENTS,GRIPPER_CALIBRATION_EXPERIMENT,BASE_WAVE_EXPERIMENT,BASE_WAVE_EXPERIMENTS,RESET_BASE_WAVE_EXPERIMENT,RESET_POSE,CLOSED_BASE_WAVE_EXPERIMENT,CLAW_CLOSE_EXPERIMENT,FINITE_ELBOW_GESTURE_EXPERIMENT,otherJointEnvelope,validateOtherFeedback,classifyOtherSettling} from './other-joint-plan.mjs';
import {assertPoseNear} from './z-lift-plan.mjs';
import {validateJoints} from './safety.mjs';
import {encodeJoints} from './transport.mjs';
import {createFeedbackCompletion,completionScope} from './feedback-completion.mjs';
import {BASE_FEEDFORWARD_SCOPE,BASE_FEEDFORWARD_POLICY,BASE_FEEDFORWARD_REQUIRED_SOURCE_HASHES,validateBaseFeedforwardAdmission,planBaseFeedforwardLeg,validateOneShotExecution,assertFreshOneShotSample,assertDesiredFeedbackArrival} from './base-feedforward-hypothesis.mjs';
import {fileURLToPath} from 'node:url';
import {FINITE_ELBOW_GESTURE_SCOPE,FINITE_ELBOW_GESTURE_REQUIRED_SOURCE_HASHES,elbowGestureSourceFiles,validateFiniteElbowGestureAdmission,assertFiniteElbowGestureExecution,planFiniteElbowGesture,assertFreshElbowGestureSample,validateFiniteElbowGestureObservation} from './finite-elbow-gesture.mjs';
import {FINITE_BASE_WAVE_SCOPE,FINITE_BASE_WAVE_POLICY,FINITE_BASE_WAVE_REQUIRED_SOURCE_HASHES,validateFiniteBaseWaveAdmission,assertFiniteWaveExecution,planFiniteBaseWaveLeg,validateFiniteWaveObservation} from './finite-base-wave.mjs';
import {VISIBLE_BASE_WAVE_SCOPE,VISIBLE_BASE_WAVE_POLICY,VISIBLE_BASE_WAVE_REQUIRED_SOURCE_HASHES,validateVisibleBaseWaveAdmission,assertVisibleWaveExecution,planVisibleBaseWaveLeg,validateVisibleWaveObservation} from './visible-base-wave.mjs';

const confirmations=['baseSecured','sweep300mmClear','cablesSlack','jawsClear','powerSwitchReady'];
const inspectionKeys=['stationary','noContact','cablesSlack','noUnusualNoise'];
const assertCurrentBaseDemoPose=(pose,session)=>{
 if(!session.currentBaseDemoBaseline)return;
 const sample=session.currentBaseDemoBaseline.observations.at(-1),at=Date.parse(sample?.observedAt),cameraAt=Date.parse(session.finiteBaseWaveReview.cameraObservation?.observedAt);
 if(!Number.isFinite(at)||Date.now()-at>60000||!Number.isFinite(cameraAt)||Date.now()-cameraAt>60000||['base','shoulder','elbow','gripper'].some(k=>Math.abs(pose[k]-sample.joints[k])>SERVO_STEP+1e-9))throw Error('Base demo pose or camera changed after stationary qualification');
};
const RESET_COMMAND_ID='fa7b492e-2475-494f-a2a9-a406635d455c';
const RESET_COMMAND_SHA256='c0a0f3acbd91602ecfd5ee14c63db9802dfdc28928eed107289cbc148db8892b';
export const originalMovementDigest=row=>{const original={...row};delete original.reconciliation;delete original.poseRecovery;delete original.resetRecovery;return digest(JSON.stringify(original));};
const resetRecoverySourceHistoryDigest=history=>{const original=structuredClone(history),anchor=original.commands?.find(row=>row.id===RESET_COMMAND_ID);if(anchor)delete anchor.resetRecovery;return digest(JSON.stringify(original));};
const inspectedShortfall=row=>{
 const r=row.reconciliation;
 return row.state==='blocked'&&row.result?.outcome==='telemetry-settled-off-target'&&row.result.cleanupVerified===true&&
  r?.revision==='inspected-shortfall-v1'&&r.disposition==='accept-observed-pose-for-new-plan'&&
  r.originalRowSHA256===originalMovementDigest(row)&&inspectionKeys.every(k=>r.inspection?.[k]===true)&&
  Number.isFinite(Date.parse(r.inspectedAt))&&r.observationDurationMs>=3000&&r.observationCount>=16&&
  /^[a-f0-9]{64}$/.test(r.configDigest??'')&&typeof r.owner==='string'&&r.owner.length>0;
};
const inspectedCurrentPose=row=>{
 const r=row.poseRecovery;
 return row.state==='blocked'&&row.result?.outcome==='telemetry-settled-off-target'&&row.result.cleanupVerified===true&&
  r?.revision==='reviewed-current-pose-v1'&&r.disposition==='accept-current-pose-for-base-wave-only'&&r.noMotionCommandIssued===true&&
  r.originalRowSHA256===originalMovementDigest(row)&&inspectionKeys.every(k=>r.inspection?.[k]===true)&&r.inspection.noTouchResetPowerChange===true&&
  Number.isFinite(Date.parse(r.inspectedAt))&&r.observationDurationMs>=30000&&r.observationCount>=100&&
  /^[a-f0-9]{64}$/.test(r.reviewSHA256??'')&&/^[a-f0-9]{64}$/.test(r.configDigest??'')&&typeof r.owner==='string'&&r.owner.length>0;
};
const inspectedResetPose=row=>{
 const r=row.resetRecovery;
 return row.id===RESET_COMMAND_ID&&row.state==='blocked'&&row.result?.outcome==='telemetry-settled-off-target'&&row.result.cleanupVerified===true&&
  row.plan?.experiment===CLOSED_BASE_WAVE_EXPERIMENT&&r?.revision==='operator-asserted-reset-v1'&&r.disposition==='accept-reset-pose-for-reviewed-wave-only'&&
  r.originalRowSHA256===RESET_COMMAND_SHA256&&r.originalRowSHA256===originalMovementDigest(row)&&r.cause==='unknown'&&
  r.operatorAssertion?.status==='operator-asserted-not-verified'&&typeof r.operatorAssertion.assertion==='string'&&r.operatorAssertion.assertion.length>=20&&
  inspectionKeys.every(k=>r.postResetInspection?.[k]===true)&&r.noMotionCommandIssued===true&&r.observationDurationMs>=30000&&r.observationCount>=100&&
  r.reviewSHA256&&/^[a-f0-9]{64}$/.test(r.reviewSHA256)&&r.admissionSHA256&&/^[a-f0-9]{64}$/.test(r.admissionSHA256)&&
  r.configDigest&&/^[a-f0-9]{64}$/.test(r.configDigest)&&r.observations?.length>=100&&r.expectedPose&&
  Object.keys(RESET_POSE).every(k=>Math.abs(r.expectedPose[k]-RESET_POSE[k])<=1e-9)&&Number.isFinite(Date.parse(r.inspectedAt));
};
export const acceptedFactoryRecovery=(row,kind)=>kind==='poseRecovery'?(inspectedCurrentPose(row)||isReviewedElbowBaseShift(row)):kind==='resetRecovery'?inspectedResetPose(row):false;
const done=(row,history)=>row?.manualRecovery?((['observed-manual-completed-v1','observed-manual-timeout-v1'].includes(row.manualRecovery.revision)||isCrashRecoveryAuthorization(row.manualRecovery.intentAuthorization))?completedRecoveryHistoryMatches(row,history):isInspectedManualRecovery(row)):(row.state==='complete'&&row.result?.cleanupVerified===true&&row.result.requiresReconciliation!==true)||inspectedShortfall(row)||inspectedCurrentPose(row)||inspectedResetPose(row)||isReviewedElbowBaseShift(row)||isInspectedManualRecovery(row);
export const assertWaveBaseline=(history,pose,config,session=null)=>{
 if(!config.profile?.wave)return;
 const last=history.commands.filter(r=>r.mode==='serial').at(-1);
 if(config.profile.wave===RESET_BASE_WAVE_EXPERIMENT){
  const anchor=history.commands.find(r=>r.id===RESET_COMMAND_ID),recovery=anchor?.resetRecovery,review=config.resetWaveAdmissionReview;
  if(!inspectedResetPose(anchor)||!review||recovery.admissionSHA256!==config.profile.evidence.resetWaveAdmission.sha256||recovery.configDigest!==config.digest||recovery.originalRowSHA256!==review.originalRowSHA256)throw Error('Exact reviewed reset-pose recovery is required for this wave scope');
  if(!session){
   if(last!==anchor||recovery.sourceHistorySHA256!==resetRecoverySourceHistoryDigest(history))throw Error('Reset-pose wave requires the unchanged recovered history anchor');
   if(['base','shoulder','elbow','gripper'].some(k=>Math.abs(pose[k]-RESET_POSE[k])>SERVO_STEP+1e-9))throw Error('Reset-pose wave start changed beyond the one-tick bound');
  }else{
   const priorRows=history.commands.filter(r=>r.sessionId===session.id),anchorContract=session.resetRecoveryAnchor,admission=session.resetWaveAdmission;
   if(!anchorContract||anchorContract.commandId!==anchor.id||anchorContract.originalRowSHA256!==recovery.originalRowSHA256||anchorContract.admissionSHA256!==recovery.admissionSHA256||!admission||admission.anchorCommandId!==anchor.id||admission.anchorSHA256!==recovery.originalRowSHA256||admission.reviewSHA256!==config.profile.evidence.resetWaveAdmission.sha256||priorRows.length!==session.next||priorRows.some((row,index)=>row.index!==index||row.state!=='complete'||row.result?.cleanupVerified!==true||row.result?.requiresReconciliation||row.plan?.experiment!==RESET_BASE_WAVE_EXPERIMENT||row.configDigest!==session.digest||row.move?.joint!=='base'||row.move?.degrees!==review.moves[index]?.degrees||row.resetWaveAdmission?.baselineSHA256!==admission.baselineSHA256))throw Error('Reset-pose wave session history is not a complete reviewed prefix');
   const expectedPrior=session.next?priorRows.at(-1).result?.observed:session.start;
   if(last!==(session.next?priorRows.at(-1):anchor)||!expectedPrior||['base','shoulder','elbow','gripper'].some(k=>Math.abs(pose[k]-expectedPrior[k])>SERVO_STEP+1e-9))throw Error('Reset-pose wave pose changed since its last observed endpoint');
  }
 }
 const prior=last?.resetRecovery?.observations?.at(-1)?.joints??last?.poseRecovery?.observations?.at(-1)?.joints??last?.reconciliation?.observations?.at(-1)?.joints??last?.result?.observed;
 if(prior&&['base','shoulder','elbow','gripper'].some(k=>Math.abs(pose[k]-prior[k])>SERVO_STEP+1e-9))throw Error('Wave pose changed since the last observed endpoint; inspect before continuing');
};
// Retry only atomic journal IO, never a motor command. Keep the candidate on failure.
export async function commitMovementHistory(file,history,beforeCommit=null,io={fs,renameSync,wait:ms=>delay(ms),log:message=>console.error(message)}){
 const temporary=file+'.tmp',prepared=prepareHistoryCommit(history),bytes=prepared.bytes;let stage='prepare';
 await io.fs.mkdir(path.dirname(file),{recursive:true});
 for(let attempt=0;attempt<4;attempt++){
  try{
   stage='write';const handle=await io.fs.open(temporary,'w');try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
   stage='rename';if(beforeCommit){beforeCommit();io.renameSync(temporary,file);}else await io.fs.rename(temporary,file);
   return prepared.token;
  }catch(error){
   if(attempt<3&&['EPERM','EBUSY'].includes(error.code)){await io.wait(25);continue;}
   const pending=file+'.pending-'+randomUUID()+'.json';
   try{await io.fs.writeFile(pending,bytes,{flag:'wx'});}catch{}
   io.log('Movement journal commit failed: stage='+stage+' code='+(error.code??'admission')+'; original intent remains authoritative; candidate preserved when possible.');
   throw error;
  }
 }
}

export class Movement {
 #historySnapshot=new MovementHistorySnapshot();
 constructor(controller){this.c=controller;this.session=null;this.active=false;this.result=null;this.file=path.join(controller.directory,'movement-history.json');}
 invalidate(){this.session=null;this.verifiedHistory=null;}
 snapshot(){const s=this.session;return {active:this.active,session:s?{id:s.id,expiresAt:new Date(s.until).toISOString(),remaining:s.moves.length-s.next,next:s.next,mode:s.mode}:null,result:this.result};}
 async status(){
  const state=this.snapshot();
  try{const history=await this.history({readOnly:true});await this.validateCompletedRecoveryReadiness(history);state.unresolved=this.unresolvedHistory(history);state.historyReady=state.unresolved.length===0;}
  catch{state.historyReady=false;state.historyError='Movement history or recovery proof is invalid';}
  return state;
 }
 async history({readOnly=false}={}){
  try{const value=await this.#historySnapshot.read(this.file);return readOnly?value:structuredClone(value);}
  catch(e){if(e.code==='ENOENT')return {version:1,commands:[]};throw Error('Movement history is unreadable; reconcile before continuing');}
 }
 async save(history,beforeCommit=null){const token=await commitMovementHistory(this.file,history,beforeCommit);this.#historySnapshot.acceptCommitted(token);}
 async validateCompletedRecoveryReadiness(h){if(h.commands.some(r=>r.manualRecovery&&(r.state==='complete'||r.manualRecovery.revision==='observed-manual-timeout-v1'||isCrashRecoveryAuthorization(r.manualRecovery.intentAuthorization)))){const config=await readMotionConfig(this.c.directory);if(!config.manualReview)throw Error('Completed manual recovery requires its reviewed profile');assertManualHistory(config,h,acceptedFactoryRecovery);}}
 unresolvedHistory(history){
  const hash=historyDigest(history),now=Date.now(),cached=this.verifiedHistory;
  if(cached?.hash===hash&&now>=cached.checkedAt)return [];
  const unresolved=history.commands.filter(r=>!done(r,history)).map(r=>({id:r.id,state:r.state,outcome:r.result?.outcome??'unknown'}));
  // Never turn an unresolved result into a cached success. Profile/source checks
  // still run before this lookup; snapshot reuse requires a fresh byte comparison.
  this.verifiedHistory=unresolved.length?null:{hash,checkedAt:Date.now()};return unresolved;
 }
 async readyHistory({readOnly=false}={}){const h=await this.history({readOnly:true});await this.validateCompletedRecoveryReadiness(h);if(this.unresolvedHistory(h).length)throw Error('An unresolved movement requires reconciliation');return readOnly?h:structuredClone(h);}
 // Explicit new-pose admission, not a wider arrival/reconciliation tolerance.
 // The reviewed expected pose is independently observed for 30 seconds; the
 // historical failed command and the unexplained displacement remain intact.
 async recoverCrash(input,admission=()=>{}){
  return recoverManualPose(this,input,admission,(config,history)=>assertManualHistory(config,history,acceptedFactoryRecovery),{selfServiceCrash:true});
 }
 async rebaseline(input,admission=()=>{}){
  if((await this.physicalConfig()).manualReview)return recoverManualPose(this,input,admission,(config,history)=>assertManualHistory(config,history,acceptedFactoryRecovery));
  if((await this.physicalConfig()).profile?.finiteElbowGesture===ELBOW_FEEDFORWARD_SCOPE)return recoverElbowCurrentPose(this,input,admission);
  exact(input,['owner','commandId','originalRowSHA256','inspection','note']);exact(input.inspection,[...inspectionKeys,'noTouchResetPowerChange']);
  if([...inspectionKeys,'noTouchResetPowerChange'].some(k=>input.inspection[k]!==true)||typeof input.note!=='string'||input.note.trim().length<20||input.note.length>500)throw Error('Current physical inspection and unexplained-displacement acknowledgment required');
  return this.c.withForeground(async()=>{
   this.setup(input.owner);const c=this.c,generation=c.generation;
   if(this.session||this.active||c.mode!=='serial')throw Error('Pose recovery requires idle serial setup with no session');
   const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),45000),samples=[];c.abort=abort;c.busy=true;c.taskActive=true;c.lifecycle='pose-recovery';
   const gate=()=>{admission();c.assertOwner(input.owner);if(abort.signal.aborted||c.generation!==generation||!c.connected||c.armed||c.commissioned||this.session)throw Error('Pose recovery cancelled');};
   try{
    const config=await this.physicalConfig(),history=await this.history(),historyDigest=digest(JSON.stringify(history)),row=history.commands.find(r=>r.id===input.commandId);
    if(!row||originalMovementDigest(row)!==input.originalRowSHA256)throw Error('Original movement record changed');
    if(row.reconciliation||row.poseRecovery||history.commands.at(-1)!==row||history.commands.some(r=>r!==row&&!done(r,history)))throw Error('Only the latest unresolved movement can receive current-pose recovery');
    if(row.mode!=='serial'||row.state!=='blocked'||row.plan?.experiment!==GRIPPER_CALIBRATION_EXPERIMENT||row.result?.outcome!=='telemetry-settled-off-target'||row.result.settled!==true||row.result.cleanupVerified!==true||row.result.completion?.lateDeparture!==false||row.result.completion?.candidate||!Number.isFinite(row.result.signedEndpointErrorRad)||Math.abs(row.result.signedEndpointErrorRad)>24*SERVO_STEP)throw Error('Only an inspected gripper calibration shortfall is eligible');
    if(config.profile.wave!==BASE_WAVE_EXPERIMENT||config.profile.completionMode!=='shadow'||!config.profile.evidence.poseRecovery)throw Error('Reviewed base-wave-only pose recovery configuration required');
    const evidence=config.profile.evidence.poseRecovery,review=JSON.parse(await fs.readFile(path.join(c.directory,'commissioning',evidence.file),'utf8')),sources=await completionSourceHashes();
    if(review.revision!=='stationary-base-shift-review-v1'||review.commandId!==row.id||review.originalRowSHA256!==input.originalRowSHA256||review.disposition!=='base-wave-only'||review.cause!=='unknown'||typeof review.reviewedBy!=='string'||!review.reviewedBy.trim()||!Number.isFinite(Date.parse(review.reviewedAt))||Date.parse(review.reviewedAt)>Date.now()||Date.now()-Date.parse(review.reviewedAt)>3600000||Object.entries(sources).some(([k,v])=>review.sourceHashes?.[k]!==v))throw Error('A current source-bound review of this exact failed command is required');
    const expected=review.expectedObserved;exact(expected,['base','shoulder','elbow','gripper']);observedTicks(expected);
    if(['shoulder','elbow','gripper'].some(k=>Math.abs(expected[k]-row.result.observed[k])>SERVO_STEP+1e-9)||Math.abs(expected.base-row.result.observed.base)<=SERVO_STEP+1e-9)throw Error('Review must describe only a changed stationary base, with other joints unchanged');
    // Both endpoints must independently satisfy the existing body uncertainty
    // margins in the newly reviewed, narrower held-pose wave region.
    const geometry=otherJointEnvelope(expected,expected,'base',BASE_WAVE_EXPERIMENT);
    otherJointEnvelope(row.result.observed,row.result.observed,'base',BASE_WAVE_EXPERIMENT);
    let firstAt=null,lastAt=null;
    do{
     gate();const pose=await this.fresh(abort.signal),at=Date.parse(c.telemetryUpdatedAt),now=Date.now();
     if(!Number.isFinite(at)||at>now||now-at>500||(lastAt!==null&&(at<=lastAt||at-lastAt>500)))throw Error('Pose recovery feedback is stale or interrupted');
     for(const key of ['base','shoulder','elbow','gripper'])if(Math.abs(pose[key]-expected[key])>SERVO_STEP+1e-9||samples.some(s=>Math.abs(pose[key]-s.joints[key])>SERVO_STEP+1e-9))throw Error('Current pose differs from review or is still moving');
     firstAt??=at;lastAt=at;samples.push({observedAt:c.telemetryUpdatedAt,joints:pose,health:{...c.liftHealth}});
     if(lastAt-firstAt<30000||samples.length<100)await delay(150,undefined,{signal:abort.signal});
    }while(lastAt-firstAt<30000||samples.length<100);
    if((await this.physicalConfig()).digest!==config.digest)throw Error('Configuration changed during pose recovery');
    gate();row.poseRecovery={revision:'reviewed-current-pose-v1',disposition:'accept-current-pose-for-base-wave-only',originalRowSHA256:input.originalRowSHA256,
     owner:input.owner,inspectedAt:new Date().toISOString(),inspection:{...input.inspection},note:input.note.trim(),configDigest:config.digest,reviewSHA256:evidence.sha256,
     completionSourceHashes:sources,expectedObserved:expected,changedBaseRad:expected.base-row.result.observed.base,cause:'unknown',geometry,
     observationDurationMs:lastAt-firstAt,observationCount:samples.length,observations:samples,preciseArrival:false,physicalStopVerified:false,noMotionCommandIssued:true};
    await this.save(history,()=>{gate();if(Date.now()>=Date.parse(config.profile.physicalDeadlineAt??'9999-01-01')||Date.now()-Date.parse(review.reviewedAt)>3600000)throw Error('Pose recovery review or configuration expired');if(digest(readFileSync(path.join(c.directory,'commissioning/motion.json')))!==config.digest||digest(readFileSync(path.join(c.directory,'commissioning',evidence.file)))!==evidence.sha256)throw Error('Recovery configuration or evidence changed before commit');if(digest(JSON.stringify(JSON.parse(readFileSync(this.file,'utf8'))))!==historyDigest)throw Error('Movement history changed before recovery commit');});
    this.result=structuredClone(row);return {id:row.id,state:row.state,outcome:row.result.outcome,recovered:true,disposition:row.poseRecovery.disposition,observed:samples.at(-1).joints,cause:'unknown',noMotionCommandIssued:true};
   }finally{clearTimeout(timer);if(c.abort===abort)c.abort=null;c.busy=false;c.taskActive=false;c.lifecycle=null;}
  });
 }
 // Reset is recorded as a supervisor assertion, while the new pose is accepted
 // only after source-bound review and fresh, healthy, stationary telemetry.
 async resetRecover(input,admission=()=>{}){
  exact(input,['owner','commandId','originalRowSHA256','inspection','operatorAssertedReset','note']);
  exact(input.inspection,inspectionKeys);exact(input.operatorAssertedReset,['asserted','assertedBy','assertion']);
  if(inspectionKeys.some(k=>input.inspection[k]!==true)||input.operatorAssertedReset.asserted!==true||typeof input.operatorAssertedReset.assertedBy!=='string'||!input.operatorAssertedReset.assertedBy.trim()||typeof input.operatorAssertedReset.assertion!=='string'||input.operatorAssertedReset.assertion.trim().length<20||input.operatorAssertedReset.assertion.length>500||typeof input.note!=='string'||input.note.trim().length<20||input.note.length>500)throw Error('Current post-reset inspection and separate operator assertion are required');
  if(input.commandId!==RESET_COMMAND_ID||input.originalRowSHA256!==RESET_COMMAND_SHA256)throw Error('Only the pinned failed movement row is eligible for reset-state recovery');
  return this.c.withForeground(async()=>{
   this.setup(input.owner);const c=this.c,generation=c.generation;
   if(this.session||this.active||c.mode!=='serial')throw Error('Reset-state recovery requires idle serial setup with no session');
   const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),45000),samples=[];c.abort=abort;c.busy=true;c.taskActive=true;c.lifecycle='reset-state-recovery';
   const gate=()=>{admission();c.assertOwner(input.owner);if(abort.signal.aborted||c.generation!==generation||!c.connected||c.armed||c.commissioned||this.session)throw Error('Reset-state recovery cancelled');};
   try{
    const config=await this.physicalConfig(),history=await this.history(),historyDigest=digest(JSON.stringify(history)),row=history.commands.find(r=>r.id===input.commandId);
    if(!row||originalMovementDigest(row)!==input.originalRowSHA256)throw Error('Original movement record changed');
    if(row.reconciliation||row.poseRecovery||row.resetRecovery||history.commands.at(-1)!==row||history.commands.some(r=>r!==row&&!done(r,history)))throw Error('Only the latest unresolved movement can receive reset-state recovery');
    if(row.mode!=='serial'||row.state!=='blocked'||row.plan?.experiment!==CLOSED_BASE_WAVE_EXPERIMENT||row.result?.outcome!=='telemetry-settled-off-target'||row.result.settled!==true||row.result.cleanupVerified!==true||row.result.completion?.lateDeparture!==false||!Number.isFinite(row.result.signedEndpointErrorRad)||Math.abs(row.result.signedEndpointErrorRad/SERVO_STEP)<10||Math.abs(row.result.signedEndpointErrorRad/SERVO_STEP)>12)throw Error('Pinned settled closed-base-wave shortfall is not eligible');
    if(config.profile.wave!==RESET_BASE_WAVE_EXPERIMENT||config.profile.completionMode!=='shadow'||!config.resetStateRecoveryReview||!config.resetWaveAdmissionReview)throw Error('Separately reviewed reset recovery and exact-pose wave scope required');
    const recoveryEvidence=config.profile.evidence.resetStateRecovery,admissionEvidence=config.profile.evidence.resetWaveAdmission,recovery=config.resetStateRecoveryReview,wave=config.resetWaveAdmissionReview,sources=await resetAdmissionSourceHashes();
    if(recovery.commandId!==row.id||recovery.originalRowSHA256!==input.originalRowSHA256||wave.commandId!==row.id||wave.originalRowSHA256!==input.originalRowSHA256||
      Object.entries(RESET_POSE).some(([k,v])=>Math.abs(recovery.expectedPose[k]-v)>1e-9||Math.abs(wave.expectedPose[k]-v)>1e-9)||
      Object.entries(sources).some(([k,v])=>recovery.sourceHashes?.[k]!==v||wave.sourceHashes?.[k]!==v))throw Error('Reset review evidence does not match the pinned failure, pose, or sources');
    const geometry=otherJointEnvelope(RESET_POSE,RESET_POSE,'base',RESET_BASE_WAVE_EXPERIMENT);
    let firstAt=null,lastAt=null;
    do{
     gate();const pose=await this.fresh(abort.signal),at=Date.parse(c.telemetryUpdatedAt),now=Date.now();
     if(!Number.isFinite(at)||at>now||now-at>500||(lastAt!==null&&(at<=lastAt||at-lastAt>500)))throw Error('Post-reset feedback is stale or interrupted');
     for(const key of ['base','shoulder','elbow','gripper'])if(Math.abs(pose[key]-RESET_POSE[key])>SERVO_STEP+1e-9||samples.some(s=>Math.abs(pose[key]-s.joints[key])>SERVO_STEP+1e-9))throw Error('Post-reset pose differs from reviewed pose or is still moving');
     firstAt??=at;lastAt=at;samples.push({observedAt:c.telemetryUpdatedAt,joints:pose,health:{...c.liftHealth}});
     if(lastAt-firstAt<30000||samples.length<100)await delay(150,undefined,{signal:abort.signal});
    }while(lastAt-firstAt<30000||samples.length<100);
    if((await this.physicalConfig()).digest!==config.digest)throw Error('Configuration changed during reset-state recovery');
    gate();row.resetRecovery={revision:'operator-asserted-reset-v1',disposition:'accept-reset-pose-for-reviewed-wave-only',originalRowSHA256:input.originalRowSHA256,
     owner:input.owner,inspectedAt:new Date().toISOString(),postResetInspection:{...input.inspection},operatorAssertion:{status:'operator-asserted-not-verified',assertedBy:input.operatorAssertedReset.assertedBy.trim(),assertion:input.operatorAssertedReset.assertion.trim()},
     note:input.note.trim(),configDigest:config.digest,reviewSHA256:recoveryEvidence.sha256,admissionSHA256:admissionEvidence.sha256,sourceHistorySHA256:historyDigest,
     expectedPose:{...RESET_POSE},geometry,cause:'unknown',observationDurationMs:lastAt-firstAt,observationCount:samples.length,observations:samples,
     preciseArrival:false,physicalStopVerified:false,noMotionCommandIssued:true};
    await this.save(history,()=>{gate();if(Date.now()>=Date.parse(config.profile.physicalDeadlineAt??'9999-01-01')||Date.now()-Date.parse(wave.reviewedAt)>3600000||Date.now()-Date.parse(recovery.reviewedAt)>3600000)throw Error('Reset recovery review or configuration expired');
     if(digest(readFileSync(path.join(c.directory,'commissioning/motion.json')))!==config.digest||digest(readFileSync(path.join(c.directory,'commissioning',recoveryEvidence.file)))!==recoveryEvidence.sha256||digest(readFileSync(path.join(c.directory,'commissioning',admissionEvidence.file)))!==admissionEvidence.sha256)throw Error('Reset review evidence or configuration changed before commit');
     if(digest(JSON.stringify(JSON.parse(readFileSync(this.file,'utf8'))))!==historyDigest)throw Error('Movement history changed before reset recovery commit');});
    this.result=structuredClone(row);return {id:row.id,state:row.state,outcome:row.result.outcome,recovered:true,disposition:row.resetRecovery.disposition,cause:'unknown',operatorAssertionStatus:'asserted-not-verified',observed:samples.at(-1).joints,noMotionCommandIssued:true};
   }finally{clearTimeout(timer);if(c.abort===abort)c.abort=null;c.busy=false;c.taskActive=false;c.lifecycle=null;}
  });
 }
 async reconcile(input,admission=()=>{}){
  exact(input,['owner','commandId','originalRowSHA256','inspection','note']);exact(input.inspection,inspectionKeys);
  if(inspectionKeys.some(k=>input.inspection[k]!==true)||typeof input.note!=='string'||input.note.trim().length<5||input.note.length>500||!/^\w{64}$/.test(input.originalRowSHA256??''))throw Error('Specific physical inspection, original row hash and note required');
  return this.c.withForeground(async()=>{
   this.setup(input.owner);const c=this.c,generation=c.generation;
   if(this.session||this.active||c.mode!=='serial')throw Error('Reconciliation requires idle serial setup with no session');
   const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),8000),samples=[];c.abort=abort;c.busy=true;c.lifecycle='reconciliation';
   const gate=()=>{admission();c.assertOwner(input.owner);if(abort.signal.aborted||c.generation!==generation||!c.connected||c.armed||c.commissioned||this.session)throw Error('Reconciliation cancelled');};
   try{
    const config=await this.physicalConfig(),history=await this.history(),historyDigest=digest(JSON.stringify(history)),row=history.commands.find(r=>r.id===input.commandId);
    if(!row||originalMovementDigest(row)!==input.originalRowSHA256)throw Error('Original movement record changed');
    if(row.reconciliation||row.poseRecovery)throw Error('Movement already has a reconciliation or recovery record');
    if(row.mode!=='serial'||row.state!=='blocked'||row.result?.outcome!=='telemetry-settled-off-target'||row.result.settled!==true||row.result.cleanupVerified!==true||row.result.completion?.lateDeparture!==false||row.result.completion?.candidate||!Number.isFinite(row.result.signedEndpointErrorRad)||Math.abs(row.result.signedEndpointErrorRad)>24*SERVO_STEP)throw Error('Only a known settled shortfall with verified cleanup can be reconciled');
    if(history.commands.some(r=>r.id!==row.id&&!done(r,history)))throw Error('Other unresolved movements require separate inspection');
    let firstAt=null,lastAt=null;
    do{
     gate();const pose=await this.fresh(abort.signal),at=Date.parse(c.telemetryUpdatedAt),now=Date.now();
     if(!Number.isFinite(at)||at>now||now-at>500||(lastAt!==null&&(at<=lastAt||at-lastAt>500)))throw Error('Reconciliation feedback is stale or interrupted');
     validateOtherFeedback(pose,row.plan);
     for(const key of ['base','shoulder','elbow','gripper'])if(Math.abs(pose[key]-row.result.observed[key])>SERVO_STEP+1e-9||samples.some(s=>Math.abs(pose[key]-s.joints[key])>SERVO_STEP+1e-9))throw Error('Arm moved since the recorded endpoint or during inspection');
     firstAt??=at;lastAt=at;samples.push({observedAt:c.telemetryUpdatedAt,joints:pose,health:{...c.liftHealth}});
     if(lastAt-firstAt<3000||samples.length<16)await delay(150,undefined,{signal:abort.signal});
    }while(lastAt-firstAt<3000||samples.length<16);
    const finalConfig=await this.physicalConfig();if(finalConfig.digest!==config.digest)throw Error('Configuration changed during reconciliation');
    const latest=await this.history();if(digest(JSON.stringify(latest))!==digest(JSON.stringify(history)))throw Error('Movement history changed during reconciliation');
    gate();row.reconciliation={revision:'inspected-shortfall-v1',disposition:'accept-observed-pose-for-new-plan',originalRowSHA256:input.originalRowSHA256,
     owner:input.owner,inspectedAt:new Date().toISOString(),inspection:{...input.inspection},note:input.note.trim(),configDigest:config.digest,
     completionSourceHashes:await completionSourceHashes(),observationDurationMs:lastAt-firstAt,observationCount:samples.length,observations:samples,
     preciseArrival:false,physicalStopVerified:false,noMotionCommandIssued:true};
    gate();await this.save(history,()=>{
     gate();
     if(Date.now()>=Date.parse(config.profile.physicalDeadlineAt??'9999-01-01')||digest(readFileSync(path.join(c.directory,'commissioning/motion.json')))!==config.digest)throw Error('Configuration expired or changed before reconciliation commit');
     if(digest(JSON.stringify(JSON.parse(readFileSync(this.file,'utf8'))))!==historyDigest)throw Error('Movement history changed before reconciliation commit');
    });this.result=structuredClone(row);
    return {id:row.id,state:row.state,outcome:row.result.outcome,reconciled:true,disposition:row.reconciliation.disposition,observed:samples.at(-1).joints,noMotionCommandIssued:true};
   }finally{clearTimeout(timer);if(c.abort===abort)c.abort=null;c.busy=false;c.lifecycle=null;}
  });
 }
 setup(owner){const c=this.c;c.assertOwner(owner);c.assertIdle();if(!c.connected||!['serial','simulator'].includes(c.mode)||c.armed||c.commissioned)throw Error('Movement requires a connected, idle setup with ordinary controls disarmed and uncommissioned');}
 async physicalConfig(){if(this.c.mode==='simulator')return {digest:'simulator'};const config=await readMotionConfig(this.c.directory);if(config.manualReview){const expected=config.manualReview.connection;if(this.c.mode!=='serial'||this.c.connectionPort!==expected.port)throw Error('Manual review is for a different USB connection');const ports=this.c.factory?await this.c.transport.identity():await (await import('serialport')).SerialPort.list();if(!ports.some(p=>p.path===expected.port&&p.serialNumber===expected.serialNumber&&p.vendorId?.toLowerCase()===expected.vendorId&&p.productId?.toLowerCase()===expected.productId))throw Error('Reviewed arm USB identity is missing or changed');}return config;}
 async standingConsent(review){
  if(review?.scope!==DRAMATIC_WAVE_SCOPE)return;
  let consent;try{consent=await readRoutineMotionConsent(this.c.directory);}catch(error){if(error.code==='ENOENT'&&!review.routineConsentId)return;throw error;}
  if(review.routineConsentId!==consent.id||Date.parse(review.authorizationUntil)>Date.parse(consent.until))throw Error('Current standing consent must bind this wave review');
  if(review.guardedTrajectory&&consent.guardedElbowTrajectory!==review.guardedTrajectory.revision)throw Error('Current explicit guarded trajectory consent required');
  if(review.resetOnly&&JSON.stringify(review.resetAssertion)!==JSON.stringify(consent.resetAssertion))throw Error('Reset review must retain its current explicit power-reset assertion');
 }
 async fresh(signal){const c=this.c;await c.refresh(signal);c.requireCurrentFeedback();if(c.mode!=='simulator')assertLiftHealth(c.liftHealth);return {...(c.mode==='simulator'?c.simulated:c.measured)};}
 async closingBaseline(config,history,inspection,owner,admission,generation){
  exact(inspection,[...inspectionKeys,'noTouchResetPowerChange']);
  if([...inspectionKeys,'noTouchResetPowerChange'].some(k=>inspection[k]!==true))throw Error('Current stationary, contact-free and unchanged-setup inspection required');
  const review=config.closingReview,c=this.c,historySHA256=digest(JSON.stringify(history));
  if(!review||review.historySHA256!==historySHA256)throw Error('Claw closing review does not match the complete movement history');
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),45000),samples=[];c.abort=abort;c.taskActive=true;c.lifecycle='claw-baseline';
  const gate=()=>{admission();c.assertOwner(owner);if(abort.signal.aborted||c.generation!==generation||!c.connected||c.armed||c.commissioned||this.session)throw Error('Claw baseline cancelled');};
  try{
   let firstAt=null,lastAt=null;
   do{
    gate();const pose=await this.fresh(abort.signal),at=Date.parse(c.telemetryUpdatedAt),now=Date.now();
    if(!Number.isFinite(at)||at>now||now-at>500||(lastAt!==null&&(at<=lastAt||at-lastAt>500)))throw Error('Claw baseline feedback is stale or interrupted');
    for(const key of ['base','shoulder','elbow','gripper'])if(Math.abs(pose[key]-review.expectedObserved[key])>SERVO_STEP+1e-9||samples.some(s=>Math.abs(pose[key]-s.joints[key])>SERVO_STEP+1e-9))throw Error('Claw starting pose differs from review or is still moving');
    firstAt??=at;lastAt=at;samples.push({observedAt:c.telemetryUpdatedAt,joints:pose,health:{...c.liftHealth}});
    if(lastAt-firstAt<30000||samples.length<100)await delay(150,undefined,{signal:abort.signal});
   }while(lastAt-firstAt<30000||samples.length<100);
   if((await this.physicalConfig()).digest!==config.digest||digest(JSON.stringify(await this.history()))!==historySHA256)throw Error('Claw configuration or history changed during observation');
   gate();return {revision:'held-claw-baseline-v1',scope:CLAW_CLOSE_EXPERIMENT,historySHA256,reviewSHA256:config.profile.evidence.clawClosing.sha256,inspection:{...inspection},observedAt:c.telemetryUpdatedAt,observations:samples,observationDurationMs:lastAt-firstAt,observationCount:samples.length,causeOfPriorDrift:'unknown',noMotionCommandIssued:true};
  }finally{clearTimeout(timer);if(c.abort===abort)c.abort=null;c.taskActive=false;c.lifecycle=null;}
 }
 async resetWaveBaseline(config,history,inspection,owner,admission,generation){
  exact(inspection,inspectionKeys);if(inspectionKeys.some(k=>inspection[k]!==true))throw Error('Current post-reset physical inspection is required');
  const c=this.c,historySHA256=digest(JSON.stringify(history)),row=history.commands.at(-1),review=config.resetWaveAdmissionReview;
  if(!inspectedResetPose(row)||!review||row.resetRecovery.sourceHistorySHA256!==resetRecoverySourceHistoryDigest(history)||row.resetRecovery.admissionSHA256!==config.profile.evidence.resetWaveAdmission.sha256)throw Error('Latest history lacks the source-bound reset recovery required for this exact-pose wave');
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),45000),samples=[];c.abort=abort;c.taskActive=true;c.lifecycle='reset-wave-baseline';
  const gate=()=>{admission();c.assertOwner(owner);if(abort.signal.aborted||c.generation!==generation||!c.connected||c.armed||c.commissioned||this.session)throw Error('Reset-wave baseline cancelled');};
  try{
   let firstAt=null,lastAt=null;
   do{
    gate();const pose=await this.fresh(abort.signal),at=Date.parse(c.telemetryUpdatedAt),now=Date.now();
    if(!Number.isFinite(at)||at>now||now-at>500||(lastAt!==null&&(at<=lastAt||at-lastAt>500)))throw Error('Reset-wave baseline feedback is stale or interrupted');
    for(const key of ['base','shoulder','elbow','gripper'])if(Math.abs(pose[key]-review.expectedPose[key])>SERVO_STEP+1e-9||samples.some(s=>Math.abs(pose[key]-s.joints[key])>SERVO_STEP+1e-9))throw Error('Reset-wave starting pose differs from the reviewed pose or is still moving');
    firstAt??=at;lastAt=at;samples.push({observedAt:c.telemetryUpdatedAt,joints:pose,health:{...c.liftHealth}});
    if(lastAt-firstAt<30000||samples.length<100)await delay(150,undefined,{signal:abort.signal});
   }while(lastAt-firstAt<30000||samples.length<100);
   if((await this.physicalConfig()).digest!==config.digest||digest(JSON.stringify(await this.history()))!==historySHA256)throw Error('Reset-wave configuration or history changed during baseline observation');
   gate();return {revision:'exact-reset-wave-baseline-v1',scope:RESET_BASE_WAVE_EXPERIMENT,historySHA256,reviewSHA256:config.profile.evidence.resetWaveAdmission.sha256,observedAt:c.telemetryUpdatedAt,observations:samples,observationDurationMs:lastAt-firstAt,observationCount:samples.length,causeOfPriorMovement:'unknown',noMotionCommandIssued:true};
  }finally{clearTimeout(timer);if(c.abort===abort)c.abort=null;c.taskActive=false;c.lifecycle=null;}
 }
 async currentBaseDemoBaseline(config,history,owner,admission,generation){
  const c=this.c,review=config.finiteBaseWaveReview,historySHA256=digest(JSON.stringify(history));
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),40000),samples=[];
  c.abort=abort;c.taskActive=true;c.lifecycle='current-base-demo-baseline';
  const gate=()=>{admission();c.assertOwner(owner);if(abort.signal.aborted||c.generation!==generation||!c.connected||c.mode!=='serial'||c.armed||c.commissioned||this.session)throw Error('Current base demo baseline cancelled');};
  try{
   let firstAt=null,lastAt=null;
   do{
    gate();const pose=await this.fresh(abort.signal),at=Date.parse(c.telemetryUpdatedAt),now=Date.now();
    if(!Number.isFinite(at)||at>now||now-at>500||(lastAt!==null&&(at<=lastAt||at-lastAt>500)))throw Error('Base demo baseline feedback is stale or interrupted');
    for(const key of ['base','shoulder','elbow','gripper'])if(Math.abs(pose[key]-review.expectedStart[key])>SERVO_STEP+1e-9||samples.some(s=>Math.abs(pose[key]-s.joints[key])>SERVO_STEP+1e-9))throw Error('Base demo pose changed or is not stationary');
    firstAt??=at;lastAt=at;samples.push({source:'hardware',observedAt:c.telemetryUpdatedAt,joints:pose,health:{...c.liftHealth}});
    if(lastAt-firstAt<30000||samples.length<100)await delay(150,undefined,{signal:abort.signal});
   }while(lastAt-firstAt<30000||samples.length<100);
   const finalConfig=await this.physicalConfig(),latest=await this.history();
   if(finalConfig.digest!==config.digest||digest(JSON.stringify(latest))!==historySHA256)throw Error('Base demo configuration or history changed during baseline');
   validateFiniteBaseWaveAdmission({review:finalConfig.finiteBaseWaveReview,sourceHashes:finalConfig.finiteBaseWaveSourceHashes,history:latest,deadlineAt:finalConfig.profile.physicalDeadlineAt,ordinal:review.ordinal,seriesId:review.seriesId});
   gate();return {revision:'current-base-demo-stationary-baseline-v1',historySHA256,observationCount:samples.length,observationDurationMs:lastAt-firstAt,observations:samples,noMotionCommandIssued:true};
  }finally{clearTimeout(timer);if(c.abort===abort)c.abort=null;c.taskActive=false;c.lifecycle=null;}
 }
 plan(request,start,config={},controlMode,previous){
  if(config.manualReview){const plan=planManual(request,start,this.c.firmwareCartesian,config.manualTestWindow?.baseFeedForwardTicks??config.manualReview.stylusTraining?.baseFeedForwardTicks??0,config.manualTestWindow?.jointFeedForwardTicks??config.manualReview.jointFeedForwardTicks,request.targets?(Object.hasOwn(request.targets,'shoulder')?(config.manualReview.stylusTraining?.shoulderSpeed??20):(config.manualReview.coordinatedSpeed??20)):20,request.targets&&!Object.hasOwn(request.targets,'shoulder')?(config.manualReview.coordinatedAcceleration??1):1,config.manualReview.stylusTraining?.shoulderCoordination===true);validateManualTestPlan(plan,config.manualTestWindow);validateStylusTrainingPlan(plan,config.manualReview.stylusTraining);if(controlMode==='direct-manual'){if(config.profile.phase!=='qualified'||request.targets||config.manualTestWindow)throw Error('Direct held-joint tolerance requires one qualified manual joint');plan.heldTolerancePolicy=MANUAL_DIRECT_HELD_POLICY;if(manualStartupAccess(config))plan.startPolicy='operator-current-pose-v1';if(request.joint==='gripper'&&request.targetDegrees===155)markSayAhClosing(plan,previous);}if(config.manualReview.guardedExit==='base-shoulder-elbow-v1')plan.manualGuardedExit=config.manualReview.guardedExit;return plan;}
  if(config.factoryCalibrationReview)return planFactoryCalibration(config.factoryCalibrationReview,request,start,this.c.firmwareCartesian);
  if(this.c.mode==='simulator'){const target=validateJoints({...start,[request.joint]:start[request.joint]+request.degrees*Math.PI/180});return {start,target,command:encodeJoints(target),movementJoint:request.joint,simulated:true,observationWindowMs:0,durationMs:20000};}
  const ticks=observedTicks(start),delta=Math.round(request.degrees*Math.PI/180/SERVO_STEP)*(request.joint==='base'?-1:1);
  if(config.profile?.calibration&&(request.joint!=='gripper'||request.degrees>=0))throw Error('Calibration permits gripper opening only');
  if(config.profile?.wave&&(request.joint!=='base'||Math.abs(request.degrees)>10))throw Error('Wave scope permits base movement up to 10 degrees only');
  if(config.profile?.closing&&(request.joint!=='gripper'||request.degrees<=0))throw Error('Claw closing permits positive gripper movement only');
  return planOtherJoint(start,this.c.firmwareCartesian,config.profile?.closing?CLAW_CLOSE_EXPERIMENT:config.profile?.wave??(config.profile?.calibration?GRIPPER_CALIBRATION_EXPERIMENT:SHARED_EXPERIMENTS[request.joint]),ticks[request.joint]+delta);
 }
 async preview(input,admission=()=>{}){
  exact(input,['owner','move']);return this.c.withForeground(async()=>{
   this.setup(input.owner);const c=this.c,generation=c.generation;c.busy=true;
   try{const config=await this.physicalConfig(),move=(config.manualReview?v=>normalizeManualMove(v,{allowShoulder:config.manualReview.stylusTraining?.shoulderCoordination===true}):normalizeMove)(input.move),start=await this.fresh(),plan=this.plan(move,start,config);admission();if(c.generation!==generation)throw Error('Preview cancelled');return {move,plan,physicalMovementVerified:false};}finally{c.busy=false;}
  });
 }
 async begin(input,admission=()=>{}){
  exact(input,['owner','moves','seconds','confirmations','inspection','controlMode']);
  if(!Array.isArray(input.moves)||input.moves.length<1)throw Error('A session requires an explicit nonempty move list');
  const seconds=input.seconds??300;
  if(!Number.isInteger(seconds)||seconds<30||seconds>300)throw Error('Session duration must be 30 to 300 seconds');
  return this.c.withForeground(async()=>{
   this.setup(input.owner);const c=this.c,generation=c.generation;c.busy=true;
   try{
    const config=await this.physicalConfig();
    const moves=input.moves.map(config.manualReview?v=>normalizeManualMove(v,{allowShoulder:config.manualReview.stylusTraining?.shoulderCoordination===true}):normalizeMove);
    if(!config.manualReview&&moves.length>10)throw Error('Legacy sessions allow at most 10 moves');
    const directManual=input.controlMode==='direct-manual';
    if(input.controlMode!==undefined&&!directManual)throw Error('Unknown movement control mode');
    if(directManual){
     if(c.mode!=='serial'||!config.manualReview||config.profile.phase!=='qualified'||config.manualTestWindow||moves.length!==1||moves[0].targets||input.confirmations!==undefined||input.inspection!==undefined)throw Error('Direct manual control requires one qualified joint target without automatic setup assertions');
    }else if(c.mode!=='simulator'){const keys=config.manualTestWindow?MANUAL_TEST_CONFIRMATIONS:config.manualReview?(config.manualReview.stylusTraining?stylusConfirmationKeys(config.manualReview.stylusTraining):MANUAL_CONFIRMATIONS):confirmations;exact(input.confirmations,keys);if(keys.some(k=>input.confirmations[k]!==true))throw Error('Current supervision and physical setup confirmations required');}
    if(config.profile?.calibration&&moves.some(m=>m.joint!=='gripper'||m.degrees>=0))throw Error('Calibration permits gripper opening only');
    if(config.profile?.wave&&moves.some(m=>m.joint!=='base'||Math.abs(m.degrees)>10))throw Error('Wave scope permits base movement up to 10 degrees only');
    if(config.profile?.closing&&moves.some(m=>m.joint!=='gripper'||m.degrees<=0))throw Error('Claw closing permits positive gripper movement only');
    const history=await this.readyHistory({readOnly:true});
    if(!config.manualReview&&history.commands.some(r=>r.manualRecovery))throw Error('Manual pose recovery is restricted to reviewed manual controls');
    if(config.manualReview)assertManualMoves(config,moves,history,acceptedFactoryRecovery,seconds);
    if(config.factoryCalibrationReview){assertFactoryCalibrationMoves(config.factoryCalibrationReview,moves);assertFactoryCalibrationHistory(config.factoryCalibrationReview,history,acceptedFactoryRecovery);}
    if(!config.manualReview&&!config.factoryCalibrationReview&&history.commands.some(r=>r.poseRecovery)&&!BASE_WAVE_EXPERIMENTS.includes(config.profile?.wave)&&config.profile?.closing!==CLAW_CLOSE_EXPERIMENT&&config.profile?.baseFeedforward!==BASE_FEEDFORWARD_SCOPE&&config.profile?.finiteBaseWave!==FINITE_BASE_WAVE_SCOPE&&config.profile?.visibleBaseWave!==VISIBLE_BASE_WAVE_SCOPE&&![FINITE_ELBOW_GESTURE_SCOPE,ELBOW_FEEDFORWARD_SCOPE,ELBOW_REPEAT_SCOPE,DRAMATIC_WAVE_SCOPE].includes(config.profile?.finiteElbowGesture))throw Error('Current-pose recovery is restricted to the reviewed base wave scope');
    if(!config.manualReview&&!config.factoryCalibrationReview&&history.commands.some(r=>r.resetRecovery)&&config.profile?.wave!==RESET_BASE_WAVE_EXPERIMENT&&config.profile?.baseFeedforward!==BASE_FEEDFORWARD_SCOPE&&config.profile?.finiteBaseWave!==FINITE_BASE_WAVE_SCOPE&&config.profile?.visibleBaseWave!==VISIBLE_BASE_WAVE_SCOPE&&![FINITE_ELBOW_GESTURE_SCOPE,ELBOW_FEEDFORWARD_SCOPE,ELBOW_REPEAT_SCOPE,DRAMATIC_WAVE_SCOPE].includes(config.profile?.finiteElbowGesture))throw Error('Reset-state recovery is restricted to its separately reviewed one-shot scope');
    if(config.profile?.wave===RESET_BASE_WAVE_EXPERIMENT){
     const expected=config.resetWaveAdmissionReview?.moves;
     const sameMoves=Array.isArray(expected)&&moves.length===expected.length&&moves.every((move,index)=>move.joint===expected[index]?.joint&&move.degrees===expected[index]?.degrees);
     if(seconds>120||!sameMoves||history.commands.at(-1)?.id!==RESET_COMMAND_ID)throw Error('Reset-pose wave permits only its exact reviewed sequence in one finite session');
    }
    let baseFeedforwardAdmission=null,finiteBaseWaveAdmission=null,visibleBaseWaveAdmission=null,finiteElbowGestureAdmission=null;
    if(config.profile?.baseFeedforward===BASE_FEEDFORWARD_SCOPE){
     exact(input.inspection,inspectionKeys);if(inspectionKeys.some(key=>input.inspection[key]!==true))throw Error('Fresh camera and physical inspection is required immediately before the one-shot leg');
     if(c.mode!=='serial'||moves.length!==1||moves[0].joint!=='base'||moves[0].degrees!==-3||seconds>60||history.commands.at(-1)?.id!==RESET_COMMAND_ID)throw Error('Feed-forward permits exactly one -3-degree base request within 60 seconds after the pinned reset recovery');
     baseFeedforwardAdmission=validateBaseFeedforwardAdmission({review:config.baseFeedforwardReview,sourceHashes:config.baseFeedforwardSourceHashes,history,deadlineAt:config.profile.physicalDeadlineAt});
    }
    if(config.profile?.finiteBaseWave===FINITE_BASE_WAVE_SCOPE){exact(input.inspection,inspectionKeys);if(inspectionKeys.some(key=>input.inspection[key]!==true))throw Error('Fresh physical inspection is required before each finite-wave leg');finiteBaseWaveAdmission=validateFiniteBaseWaveAdmission({review:config.finiteBaseWaveReview,sourceHashes:config.finiteBaseWaveSourceHashes,history,deadlineAt:config.profile.physicalDeadlineAt,ordinal:config.finiteBaseWaveReview.ordinal,seriesId:config.finiteBaseWaveReview.seriesId});if(c.mode!=='serial'||moves.length!==1||seconds!==60||moves[0].joint!=='base'||moves[0].degrees!==finiteBaseWaveAdmission.requestDegrees)throw Error('Finite wave permits exactly its reviewed single base leg in a 60-second session');}
    if([FINITE_ELBOW_GESTURE_SCOPE,ELBOW_FEEDFORWARD_SCOPE,ELBOW_REPEAT_SCOPE,DRAMATIC_WAVE_SCOPE].includes(config.profile?.finiteElbowGesture)){exact(input.inspection,inspectionKeys);if(inspectionKeys.some(key=>input.inspection[key]!==true))throw Error('Fresh physical inspection is required before each finite elbow gesture');await this.standingConsent(config.finiteElbowGestureReview);finiteElbowGestureAdmission=validateFiniteElbowGestureAdmission({review:config.finiteElbowGestureReview,sourceHashes:config.finiteElbowGestureSourceHashes,history,deadlineAt:config.profile.physicalDeadlineAt,now:Date.now(),ordinal:config.finiteElbowGestureReview.ordinal,seriesId:config.finiteElbowGestureReview.seriesId});if(c.mode!=='serial'||moves.length!==1||seconds!==90||moves[0].joint!=='elbow'||moves[0].degrees!==finiteElbowGestureAdmission.requestDegrees)throw Error('Finite elbow gesture permits exactly its reviewed single elbow leg in a 90-second session');}
    if(config.profile?.visibleBaseWave===VISIBLE_BASE_WAVE_SCOPE){exact(input.inspection,inspectionKeys);if(inspectionKeys.some(key=>input.inspection[key]!==true))throw Error('Fresh physical inspection is required before each visible-wave leg');visibleBaseWaveAdmission=validateVisibleBaseWaveAdmission({review:config.visibleBaseWaveReview,sourceHashes:config.visibleBaseWaveSourceHashes,history,deadlineAt:config.profile.physicalDeadlineAt,ordinal:config.visibleBaseWaveReview.ordinal,seriesId:config.visibleBaseWaveReview.seriesId});if(c.mode!=='serial'||moves.length!==1||seconds!==60||moves[0].joint!=='base'||moves[0].degrees!==visibleBaseWaveAdmission.requestDegrees)throw Error('Visible wave permits exactly its reviewed single base leg in a 60-second session');}
    const closingAdmission=config.profile?.closing?await this.closingBaseline(config,history,input.inspection,input.owner,admission,generation):null;
    const resetAdmission=config.profile?.wave===RESET_BASE_WAVE_EXPERIMENT?await this.resetWaveBaseline(config,history,input.inspection,input.owner,admission,generation):null;
    const currentBaseDemoBaseline=finiteBaseWaveAdmission&&config.finiteBaseWaveReview.revision==='independent-current-pose-base-demo-leg-v1'?await this.currentBaseDemoBaseline(config,history,input.owner,admission,generation):null;
    const start=await this.fresh();assertManualRestartStart(config,history,start);if(config.manualReview){const prior=config.profile.phase==='qualification'?config.manualReview.start:acceptedManualPose(history.commands.at(-1),history,manualRecoveryBoundToReview(history.commands.at(-1),config));if((!prior||MANUAL_NAMES.some(k=>Math.abs(start[k]-prior[k])>MANUAL_TOLERANCE.heldTicks*SERVO_STEP+1e-9))&&!(directManual&&(manualStartupPoseAllowed(config,history.commands.at(-1))||directManualStartWithinAcceptedEndpoint(history.commands.at(-1),start))))throw Error('Manual starting pose changed since review or accepted endpoint');}assertWaveBaseline(history,start,config);if(finiteElbowGestureAdmission){planFiniteElbowGesture({start,cartesian:c.firmwareCartesian,admission:finiteElbowGestureAdmission,review:config.finiteElbowGestureReview});}else if(visibleBaseWaveAdmission){planVisibleBaseWaveLeg({start,cartesian:c.firmwareCartesian,admission:visibleBaseWaveAdmission,review:config.visibleBaseWaveReview});}else if(finiteBaseWaveAdmission){planFiniteBaseWaveLeg({start,cartesian:c.firmwareCartesian,admission:finiteBaseWaveAdmission,review:config.finiteBaseWaveReview});}else if(baseFeedforwardAdmission){const proof=history.commands.at(-1)?.resetRecovery;if(!proof||['base','shoulder','elbow','gripper'].some(k=>Math.abs(start[k]-RESET_POSE[k])>SERVO_STEP+1e-9))throw Error('Fresh one-shot start must remain within one tick of accepted reset recovery');planBaseFeedforwardLeg({degrees:3,start,cartesian:c.firmwareCartesian,admission:baseFeedforwardAdmission,review:config.baseFeedforwardReview});}else this.plan(moves[0],start,config,input.controlMode,history.commands.at(-1));
    if(closingAdmission){const baseline=closingAdmission.observations.at(-1).joints;for(const key of ['base','shoulder','elbow','gripper'])if(Math.abs(start[key]-baseline[key])>SERVO_STEP+1e-9)throw Error('Claw pose changed after baseline observation');}
    admission();if(c.generation!==generation)throw Error('Session cancelled');
    const resetRecoveryAnchor=resetAdmission?{commandId:history.commands.at(-1).id,originalRowSHA256:history.commands.at(-1).resetRecovery.originalRowSHA256,admissionSHA256:history.commands.at(-1).resetRecovery.admissionSHA256}:null;
    const resetWaveAdmission=resetAdmission?{...resetAdmission,moves:structuredClone(config.resetWaveAdmissionReview.moves),anchorCommandId:resetRecoveryAnchor.commandId,anchorSHA256:resetRecoveryAnchor.originalRowSHA256,baselineSHA256:digest(JSON.stringify(resetAdmission))}:null;
    this.session={id:randomUUID(),owner:input.owner,moves,seconds,controlMode:directManual?'direct-manual':'supervised-session',next:0,until:Math.min(Date.now()+seconds*1000,config.profile?.physicalDeadlineAt?Date.parse(config.profile.physicalDeadlineAt):Infinity),stopEpoch:c.stopEpoch,mode:c.mode,digest:config.digest,start,completionMode:config.profile?.completionMode??'fixed',closingAdmission,resetRecoveryAnchor,resetWaveAdmission,baseFeedforwardAdmission,baseFeedforwardReview:config.baseFeedforwardReview,baseFeedforwardInspection:baseFeedforwardAdmission?structuredClone(input.inspection):null,finiteBaseWaveAdmission,finiteBaseWaveReview:config.finiteBaseWaveReview,finiteBaseWaveInspection:finiteBaseWaveAdmission?structuredClone(input.inspection):null,finiteElbowGestureAdmission,finiteElbowGestureReview:config.finiteElbowGestureReview,finiteElbowGestureInspection:finiteElbowGestureAdmission?structuredClone(input.inspection):null,visibleBaseWaveAdmission,visibleBaseWaveReview:config.visibleBaseWaveReview,visibleBaseWaveInspection:visibleBaseWaveAdmission?structuredClone(input.inspection):null};
    if(config.manualReview){if(config.manualReview.stylusTraining)this.session.until=Math.min(this.session.until,Date.parse(config.manualReview.stylusTraining.expiresAt));const restart=manualRestartAuthorization(config);if(isManualRestartAuthorization(restart))this.session.until=Math.min(this.session.until,Date.parse(restart.expiresAt));if(config.manualTestWindow)this.session.until=Math.min(this.session.until,Date.parse(config.manualTestWindow.expiresAt));this.session.manual={reviewId:config.manualReview.id,phase:config.profile.phase,heldReference:{...start},deadlineMonotonic:performance.now()+Math.max(0,this.session.until-Date.now())};}
    if(config.factoryCalibrationReview)this.session.factoryCalibration={reviewId:config.factoryCalibrationReview.id,reviewSHA256:config.profile.evidence.factoryCalibrationReview.sha256,deadlineMonotonic:performance.now()+Math.max(0,this.session.until-Date.now())};
    if(currentBaseDemoBaseline)this.session.currentBaseDemoBaseline=currentBaseDemoBaseline;
    return this.snapshot();
   }finally{c.busy=false;}
  });
 }
 async execute(input,admission=()=>{}){
  exact(input,['owner','sessionId','index','commandId']);if(typeof input.commandId!=='string'||!/^[a-f0-9-]{36}$/.test(input.commandId))throw Error('A unique command UUID is required');
  return this.c.withForeground(()=>this.executeIdle(input,admission));
 }
 async executeIdle(input,admission){
  const executionStartedAt=new Date().toISOString();
  this.setup(input.owner);const c=this.c,s=this.session;
  const gate=(reserveMs=0)=>{admission();c.assertOwner(input.owner);if(!s||this.session!==s||s.owner!==input.owner||s.id!==input.sessionId||s.mode!==c.mode||s.stopEpoch!==c.stopEpoch||Date.now()+reserveMs>s.until||(s.factoryCalibration&&performance.now()+reserveMs>s.factoryCalibration.deadlineMonotonic))throw Error('Supervised session expired or cancelled');};
  gate(21000);if(input.index!==s.next||s.next>=s.moves.length)throw Error('Only the next authorized movement can run');
  // Hold the Controller slot across every await, including journal persistence.
  c.busy=true;c.taskActive=true;c.lifecycle='movement';this.active=true;
  const abort=new AbortController();c.abort=abort;const generation=c.generation;
  let timer=setTimeout(()=>abort.abort(),s.manual?30000:8000),attempted=false,row,history,manualPrefix,plan,failure,cleanup,monitor,manualExit,classified,feedbackAgeAtDispatchMs=null;
  const observations=[];let previousSampleAt=null,trajectoryCommittedHistorySHA256=null,coordinatedCommittedHistorySHA256=null,manualDispatchPins=null;
  try{
   manualPrefix=await this.readyHistory({readOnly:true});history={...manualPrefix,commands:[...manualPrefix.commands]};if(history.commands.some(r=>r.id===input.commandId))throw Error('Command ID was already consumed');
   const config=await this.physicalConfig();if(config.digest!==s.digest)throw Error('Movement configuration changed; start a new session');
   if(config.factoryCalibrationReview){assertFactoryCalibrationHistory(config.factoryCalibrationReview,history,acceptedFactoryRecovery);assertFactoryCalibrationMoves(config.factoryCalibrationReview,s.moves);if(!s.factoryCalibration||s.factoryCalibration.reviewId!==config.factoryCalibrationReview.id||s.factoryCalibration.reviewSHA256!==config.profile.evidence.factoryCalibrationReview.sha256)throw Error('Factory calibration session/review changed');}
   if(config.manualReview){const n=assertManualHistory(config,manualPrefix,acceptedFactoryRecovery);if(!s.manual||s.manual.reviewId!==config.manualReview.id||s.manual.phase!==config.profile.phase||(s.manual.phase==='qualification'&&n!==s.next))throw Error('Manual session or program prefix changed');}
   if(s.manual&&s.next===0)assertManualRestartSession(config,s.moves,history,s.seconds);const start=await this.fresh(abort.signal);if(s.manual&&s.next===0)assertManualRestartStart(config,history,start);if(s.manual){const prior=s.next?history.commands.at(-1)?.result?.observed:s.start;if(MANUAL_NAMES.some(k=>Math.abs(start[k]-prior[k])>MANUAL_TOLERANCE.heldTicks*SERVO_STEP+1e-9))throw Error('Manual pose changed since the accepted endpoint');}assertWaveBaseline(history,start,config,s);assertCurrentBaseDemoPose(start,s);
   if(s.finiteElbowGestureAdmission){await this.standingConsent(s.finiteElbowGestureReview);assertFiniteElbowGestureExecution({admission:s.finiteElbowGestureAdmission,review:s.finiteElbowGestureReview,history,sourceHashes:config.finiteElbowGestureSourceHashes,now:Date.now(),owner:input.owner,expectedOwner:s.owner,sessionId:s.id,expectedSessionId:s.id,stopped:abort.signal.aborted,expiresAt:new Date(s.until).toISOString(),configDigest:config.digest,expectedConfigDigest:s.digest});plan=planFiniteElbowGesture({start,cartesian:c.firmwareCartesian,admission:s.finiteElbowGestureAdmission,review:s.finiteElbowGestureReview});}else if(s.visibleBaseWaveAdmission){assertVisibleWaveExecution({admission:s.visibleBaseWaveAdmission,review:s.visibleBaseWaveReview,history,sourceHashes:config.visibleBaseWaveSourceHashes,now:Date.now(),owner:input.owner,expectedOwner:s.owner,sessionId:s.id,expectedSessionId:s.id,stopped:abort.signal.aborted,expiresAt:new Date(s.until).toISOString(),configDigest:config.digest,expectedConfigDigest:s.digest});plan=planVisibleBaseWaveLeg({start,cartesian:c.firmwareCartesian,admission:s.visibleBaseWaveAdmission,review:s.visibleBaseWaveReview});}else if(s.finiteBaseWaveAdmission){assertFiniteWaveExecution({admission:s.finiteBaseWaveAdmission,review:s.finiteBaseWaveReview,history,sourceHashes:config.finiteBaseWaveSourceHashes,now:Date.now(),owner:input.owner,expectedOwner:s.owner,sessionId:s.id,expectedSessionId:s.id,stopped:abort.signal.aborted,expiresAt:new Date(s.until).toISOString(),configDigest:config.digest,expectedConfigDigest:s.digest});plan=planFiniteBaseWaveLeg({start,cartesian:c.firmwareCartesian,admission:s.finiteBaseWaveAdmission,review:s.finiteBaseWaveReview});}else if(s.baseFeedforwardAdmission){validateOneShotExecution({admission:s.baseFeedforwardAdmission,history,sourceHashes:config.baseFeedforwardSourceHashes,now:Date.now(),owner:input.owner,expectedOwner:s.owner,sessionId:s.id,expectedSessionId:s.id,stopped:abort.signal.aborted,expiresAt:new Date(s.until).toISOString(),configDigest:config.digest,expectedConfigDigest:s.digest,consumed:history.commands.some(r=>r.baseFeedforward?.oneShotId===s.baseFeedforwardAdmission.oneShotId)});plan=planBaseFeedforwardLeg({degrees:3,start,cartesian:c.firmwareCartesian,admission:s.baseFeedforwardAdmission,review:s.baseFeedforwardReview});}
   else plan=this.plan(s.moves[s.next],start,config,s.controlMode,history.commands.at(-1));
   if(s.manual)plan.heldReference={...s.manual.heldReference};

   if(config.profile?.closing){
    if(!s.closingAdmission||s.closingAdmission.reviewSHA256!==config.profile.evidence.clawClosing.sha256)throw Error('Reviewed stationary claw admission required');
    const prior=s.next===0?s.start:history.commands.at(-1)?.result?.observed;
    if(!prior||['base','shoulder','elbow','gripper'].some(k=>Math.abs(start[k]-prior[k])>SERVO_STEP+1e-9))throw Error('Claw pose changed since the last observed endpoint');
    if(s.next===0&&digest(JSON.stringify(history))!==s.closingAdmission.historySHA256)throw Error('Movement history changed after claw admission');
   }
   if(s.completionMode==='adaptive'&&!config.completionScopes.includes(completionScope(plan)))throw Error('Movement scope has not passed two full-window shadow validations');
   if(s.manual){for(const key of MANUAL_NAMES.filter(k=>!manualMoveJoints(s.moves[s.next]).includes(k)))if(Math.abs(start[key]-s.manual.heldReference[key])>MANUAL_TOLERANCE.heldTicks*SERVO_STEP+1e-9)throw Error('Held joint drifted from the chain baseline');}
   else if(c.mode!=='simulator')for(const key of ['base','shoulder','elbow','gripper'].filter(k=>!s.moves.some(m=>m.joint===k)))if(Math.abs(start[key]-s.start[key])>SERVO_STEP+1e-9)throw Error('Held joint drifted from the session baseline');
   row={id:input.commandId,sessionId:s.id,index:s.next,mode:c.mode,move:s.moves[s.next],executionStartedAt,createdAt:new Date().toISOString(),state:'intent',plan,configDigest:s.digest};
   if(s.manual)row.manual={reviewId:s.manual.reviewId,phase:s.manual.phase,programIndex:s.next};
   if(s.factoryCalibration)row.factoryCalibration={...plan.factoryCalibration,reviewSHA256:s.factoryCalibration.reviewSHA256};
   if(s.finiteElbowGestureAdmission)row.finiteElbowGesture={...plan.finiteElbowGesture,reviewSHA256:s.finiteElbowGestureAdmission.reviewSHA256,historySHA256:s.finiteElbowGestureAdmission.historySHA256,inspection:structuredClone(s.finiteElbowGestureInspection)};
   if(s.visibleBaseWaveAdmission)row.visibleBaseWave={...plan.visibleBaseWave,reviewSHA256:s.visibleBaseWaveAdmission.reviewSHA256,historySHA256:s.visibleBaseWaveAdmission.historySHA256,inspection:structuredClone(s.visibleBaseWaveInspection)};
   if(s.finiteBaseWaveAdmission)row.finiteBaseWave={...plan.finiteBaseWave,reviewSHA256:s.finiteBaseWaveAdmission.reviewSHA256,historySHA256:s.finiteBaseWaveAdmission.historySHA256,inspection:structuredClone(s.finiteBaseWaveInspection),...(s.currentBaseDemoBaseline?{stationaryBaseline:structuredClone(s.currentBaseDemoBaseline)}:{})};
   if(s.baseFeedforwardAdmission)row.baseFeedforward={...plan.baseFeedforward,reviewSHA256:s.baseFeedforwardAdmission.reviewSHA256,historySHA256:s.baseFeedforwardAdmission.historySHA256};
   if(s.baseFeedforwardAdmission)row.baseFeedforward.inspection=structuredClone(s.baseFeedforwardInspection);
   if(s.closingAdmission)row.closingAdmission=structuredClone(s.closingAdmission);
   if(s.resetWaveAdmission)row.resetWaveAdmission=structuredClone(s.resetWaveAdmission);
   if(c.mode!=='simulator'&&s.completionMode!=='fixed'){row.completionSourceHashes=await completionSourceHashes();row.completionContextDigest=config.completionContextDigest;}
   if(s.manual)history=appendHistory(manualPrefix,row);else history.commands.push(row);
   if(s.finiteElbowGestureAdmission)await this.save(history,()=>{gate();const onDisk=JSON.parse(readFileSync(this.file,'utf8')),sourceRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url))),current=Object.fromEntries(elbowGestureSourceFiles(s.finiteElbowGestureAdmission.scope).map(file=>[file,digest(readFileSync(path.join(sourceRoot,file)))])),ev=config.profile.evidence.finiteElbowGestureReview;if(Date.now()>=Date.parse(s.finiteElbowGestureAdmission.deadlineAt)||digest(readFileSync(path.join(c.directory,'commissioning/motion.json')))!==s.digest||digest(JSON.stringify(onDisk))!==s.finiteElbowGestureAdmission.historySHA256||Object.entries(current).some(([file,sha])=>s.finiteElbowGestureAdmission.sourceHashes[file]!==sha)||digest(readFileSync(path.join(c.directory,'commissioning',ev.file)))!==ev.sha256)throw Error('Finite elbow gesture source, history, review, configuration or deadline changed before intent commit');});else if(s.visibleBaseWaveAdmission)await this.save(history,()=>{gate();const onDisk=JSON.parse(readFileSync(this.file,'utf8')),sourceRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url))),currentSources=Object.fromEntries(VISIBLE_BASE_WAVE_REQUIRED_SOURCE_HASHES.map(file=>[file,digest(readFileSync(path.join(sourceRoot,file)))])),reviewEvidence=config.profile.evidence.visibleBaseWaveReview;if(Date.now()>=Date.parse(s.visibleBaseWaveAdmission.deadlineAt)||digest(readFileSync(path.join(c.directory,'commissioning/motion.json')))!==s.digest||digest(JSON.stringify(onDisk))!==s.visibleBaseWaveAdmission.historySHA256||Object.entries(currentSources).some(([file,sha])=>s.visibleBaseWaveAdmission.sourceHashes[file]!==sha)||digest(readFileSync(path.join(c.directory,'commissioning',reviewEvidence.file)))!==reviewEvidence.sha256)throw Error('Visible-wave source, history, review, configuration or deadline changed before intent commit');});else if(s.finiteBaseWaveAdmission)await this.save(history,()=>{gate();const onDisk=JSON.parse(readFileSync(this.file,'utf8')),sourceRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url))),currentSources=Object.fromEntries(FINITE_BASE_WAVE_REQUIRED_SOURCE_HASHES.map(file=>[file,digest(readFileSync(path.join(sourceRoot,file)))])),reviewEvidence=config.profile.evidence.finiteBaseWaveReview;if(Date.now()>=Date.parse(s.finiteBaseWaveAdmission.deadlineAt)||digest(readFileSync(path.join(c.directory,'commissioning/motion.json')))!==s.digest||digest(JSON.stringify(onDisk))!==s.finiteBaseWaveAdmission.historySHA256||Object.entries(currentSources).some(([file,sha])=>s.finiteBaseWaveAdmission.sourceHashes[file]!==sha)||digest(readFileSync(path.join(c.directory,'commissioning',reviewEvidence.file)))!==reviewEvidence.sha256)throw Error('Finite-wave source, history, review, configuration or deadline changed before intent commit');});else if(s.baseFeedforwardAdmission)await this.save(history,()=>{
    gate();const onDisk=JSON.parse(readFileSync(this.file,'utf8'));
    const sourceRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const currentSources=Object.fromEntries(BASE_FEEDFORWARD_REQUIRED_SOURCE_HASHES.map(file=>[file,digest(readFileSync(path.join(sourceRoot,file)))]));
    const reviewEvidence=config.profile.evidence.baseFeedforwardReview;
    if(Date.now()>=Date.parse(s.baseFeedforwardAdmission.deadlineAt)||digest(readFileSync(path.join(c.directory,'commissioning/motion.json')))!==s.digest||digest(JSON.stringify(onDisk))!==s.baseFeedforwardAdmission.historySHA256||
      Object.entries(currentSources).some(([file,sha])=>s.baseFeedforwardAdmission.sourceHashes[file]!==sha)||digest(readFileSync(path.join(c.directory,'commissioning',reviewEvidence.file)))!==reviewEvidence.sha256)throw Error('One-shot source, history, review, configuration or deadline changed before intent commit');
   });else await this.save(history);
   const preflight=async()=>{
    if(s.manual){
     // Expensive validation precedes telemetry. Exact file/source pins are
     // rechecked after the awaited feedback read so that it cannot open a gap.
     assertManualHistory(config,manualPrefix,acceptedFactoryRecovery);
     const finalConfig=await this.physicalConfig();
     if(finalConfig.digest!==s.digest)throw Error('Movement configuration changed before dispatch');
     if(!finalConfig.manualReview||finalConfig.manualReview.id!==s.manual.reviewId||historyDigest(await this.history({readOnly:true}))!==historyDigest(history))throw Error('Manual review or committed history changed');
     if(s.next===0)assertManualRestartSession(finalConfig,s.moves,manualPrefix,s.seconds);
     const committedFileSHA256=historyFileDigest(history);
     const fresh=await this.fresh(abort.signal);
     if(digest(readFileSync(path.join(c.directory,'commissioning/motion.json')))!==s.digest||digest(readFileSync(path.join(c.directory,'commissioning',finalConfig.profile.review.file)))!==finalConfig.profile.review.sha256||digest(readFileSync(this.file))!==committedFileSHA256||Object.entries(finalConfig.manualReview.sourceHashes).some(([file,sha])=>digest(readFileSync(new URL('../'+file,import.meta.url)))!==sha))throw Error('Manual evidence changed during final feedback');
     if(plan.commands)manualDispatchPins={historySHA256:committedFileSHA256,reviewFile:finalConfig.profile.review.file,reviewSHA256:finalConfig.profile.review.sha256,sourceHashes:finalConfig.manualReview.sourceHashes};
     assertPoseNear(fresh,plan.start,MANUAL_TOLERANCE.heldTicks*SERVO_STEP+1e-9);validateManualFeedback(fresh,plan);
     if(s.next===0){assertManualRestartSession(finalConfig,s.moves,manualPrefix,s.seconds);assertManualRestartStart(finalConfig,manualPrefix,fresh);}
     const age=Date.now()-Date.parse(c.telemetryUpdatedAt);if(!Number.isFinite(age)||age<0||age>500)throw Error('Fresh manual preflight feedback required');
     if(MANUAL_NAMES.some(k=>Math.abs(fresh[k]-plan.start[k])>MANUAL_TOLERANCE.heldTicks*SERVO_STEP+1e-9))throw Error('Manual pose changed before dispatch');
     if(performance.now()+plan.durationMs+1000>s.manual.deadlineMonotonic)throw Error('Manual finite session expired');
     c.requireCurrentFeedback();gate(plan.durationMs+1000);
     if(abort.signal.aborted||c.generation!==generation||!c.connected||c.armed||c.commissioned)throw Error('Movement cancelled before dispatch');
     return;
    }
    // Replay immutable proofs before reading the dispatch pose. The profile and
    // on-disk history are still checked below against this exact validated copy.
    const fresh=await this.fresh(abort.signal);assertPoseNear(fresh,plan.start,s.manual?MANUAL_TOLERANCE.heldTicks*SERVO_STEP+1e-9:undefined);if(s.manual)validateManualFeedback(fresh,plan);assertCurrentBaseDemoPose(fresh,s);
    const finalConfig=await this.physicalConfig();if(finalConfig.digest!==s.digest)throw Error('Movement configuration changed before dispatch');if(s.finiteElbowGestureAdmission){const src=path.dirname(path.dirname(fileURLToPath(import.meta.url))),h=Object.fromEntries(elbowGestureSourceFiles(s.finiteElbowGestureAdmission.scope).map(file=>[file,digest(readFileSync(path.join(src,file)))])),ev=finalConfig.profile.evidence.finiteElbowGestureReview;if(digest(JSON.stringify(JSON.parse(readFileSync(this.file,'utf8'))))!==digest(JSON.stringify(history))||Date.now()>=Date.parse(s.finiteElbowGestureAdmission.deadlineAt)||Object.entries(h).some(([file,sha])=>s.finiteElbowGestureAdmission.sourceHashes[file]!==sha)||digest(readFileSync(path.join(c.directory,'commissioning',ev.file)))!==ev.sha256)throw Error('Finite elbow gesture review, source or deadline changed before dispatch');}if(s.visibleBaseWaveAdmission){const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),hashes=Object.fromEntries(VISIBLE_BASE_WAVE_REQUIRED_SOURCE_HASHES.map(file=>[file,digest(readFileSync(path.join(root,file)))])),ev=finalConfig.profile.evidence.visibleBaseWaveReview;if(Date.now()>=Date.parse(s.visibleBaseWaveAdmission.deadlineAt)||Object.entries(hashes).some(([file,sha])=>s.visibleBaseWaveAdmission.sourceHashes[file]!==sha)||digest(readFileSync(path.join(c.directory,'commissioning',ev.file)))!==ev.sha256)throw Error('Visible-wave source, review, or deadline changed before dispatch');}
    if(s.factoryCalibration){
     if(!finalConfig.factoryCalibrationReview||finalConfig.factoryCalibrationReview.id!==s.factoryCalibration.reviewId||finalConfig.profile.evidence.factoryCalibrationReview.sha256!==s.factoryCalibration.reviewSHA256||historyDigest(await this.history({readOnly:true}))!==historyDigest(history))throw Error('Factory calibration review or committed history changed before dispatch');
     const prior={...history,commands:history.commands.slice(0,-1)};
     assertFactoryCalibrationHistory(finalConfig.factoryCalibrationReview,prior,acceptedFactoryRecovery);
     if(history.commands.at(-1)?.id!==row.id||row.factoryCalibration.reviewId!==s.factoryCalibration.reviewId)throw Error('Factory calibration intent identity changed');
     planFactoryCalibration(finalConfig.factoryCalibrationReview,s.moves[0],fresh,c.firmwareCartesian);
    }
    c.requireCurrentFeedback();gate(plan.durationMs+1000);
    if(abort.signal.aborted||c.generation!==generation||!c.connected||c.armed||c.commissioned)throw Error('Movement cancelled before dispatch');
   };
   const markDispatch=()=>{feedbackAgeAtDispatchMs=Date.now()-Date.parse(c.telemetryUpdatedAt);attempted=true;row.dispatchedAt=new Date().toISOString();clearTimeout(timer);timer=setTimeout(()=>abort.abort(),plan.durationMs);if(c.mode!=='simulator'&&s.completionMode!=='fixed')monitor=createFeedbackCompletion(plan,Date.parse(row.dispatchedAt));if(s.manual){const allowBase=plan.manualGuardedExit==='base-shoulder-elbow-v1';if(allowBase&&manualPlanJoints(plan).every(j=>['base','shoulder','elbow'].includes(j))||plan.manualTestWindow?.guardedExit==='shoulder-elbow-v1'&&manualPlanJoints(plan).every(j=>['shoulder','elbow'].includes(j)))manualExit=createManualSettledExit(plan,row.dispatchedAt,{allowBase});}};
   let receipt;
   if(plan.guardedTrajectory){
    if(c.mode!=='serial')throw Error('Guarded trajectory requires serial Controller ownership');
    await c.bounded(preflight,abort.signal);
    trajectoryCommittedHistorySHA256=digest(JSON.stringify(history)+String.fromCharCode(10));
    row.trajectoryDispatches=[];
    const streamGate=()=>{
     gate();if(abort.signal.aborted||c.generation!==generation||!c.connected||c.armed||c.commissioned)throw Error('Trajectory controller admission cancelled');
     const consent=JSON.parse(readFileSync(path.join(c.directory,'routine-motion-consent.json'),'utf8'));validateRoutineMotionConsent(consent);
     if(consent.id!==s.finiteElbowGestureReview.routineConsentId||consent.guardedElbowTrajectory!==plan.guardedTrajectory.policy.revision||Date.parse(consent.until)<Date.parse(s.finiteElbowGestureReview.authorizationUntil))throw Error('Trajectory consent changed');
     const ev=config.profile.evidence.finiteElbowGestureReview;
     if(Date.now()>=Date.parse(s.finiteElbowGestureAdmission.deadlineAt)||digest(readFileSync(path.join(c.directory,'commissioning/motion.json')))!==s.digest||digest(readFileSync(path.join(c.directory,'commissioning',ev.file)))!==ev.sha256||digest(readFileSync(this.file))!==trajectoryCommittedHistorySHA256)throw Error('Trajectory config, review or movement history changed');
    };
    await executeGuardedTrajectory({trajectory:plan.guardedTrajectory,signal:abort.signal,clock:Date.now,wait:(ms,signal)=>delay(ms,undefined,{signal}),guard:streamGate,records:row.trajectoryDispatches,
     read:async signal=>{const joints=await this.fresh(signal);const sample={source:'hardware',observedAt:c.telemetryUpdatedAt,joints,health:{...c.liftHealth}};if(row.dispatchedAt){previousSampleAt=assertFreshElbowGestureSample({sample,previousAt:previousSampleAt,now:Date.now()});observations.push(sample);monitor.observe(sample,Date.now());}return {...sample,elbowTick:observedTicks(joints).elbow,admission:{stopEpoch:c.stopEpoch,generation,consentId:s.finiteElbowGestureReview.routineConsentId,configDigest:s.digest}};},
     validateSample:sample=>validateOtherFeedback(sample.joints,plan),
     persist:async()=>{await this.save(history,streamGate);trajectoryCommittedHistorySHA256=digest(JSON.stringify(history)+String.fromCharCode(10));},
     send:(command,signal,{origin,point})=>c.bounded(()=>{streamGate();c.requireCurrentFeedback();if(Date.now()-Date.parse(c.telemetryUpdatedAt)>500||Date.now()-origin-point.atMs>plan.guardedTrajectory.policy.maxLatenessMs)throw Error('Trajectory feedback or slot stale at transport dispatch');if(!row.dispatchedAt)markDispatch();return c.transport.send(command,{signal});},signal)
    });
    receipt={sent:true};
   }else receipt=await c.preparedSend(async()=>{await preflight();if(s.manual){row.dispatchAttempt={at:new Date().toISOString(),status:'may-have-been-sent'};await this.save(history);await preflight();}},async()=>{
    const dispatchGate=()=>{gate(plan.durationMs+1000);if(s.manual&&performance.now()+plan.durationMs+1000>s.manual.deadlineMonotonic)throw Error('Manual finite session expired');if(abort.signal.aborted||c.generation!==generation||!c.connected||c.armed||c.commissioned)throw Error('Movement cancelled before dispatch');if(s.manual){const age=Date.now()-Date.parse(c.telemetryUpdatedAt);if(!Number.isFinite(age)||age<0||age>500)throw Error('Fresh manual dispatch feedback required');}};
    dispatchGate();
    if(!plan.commands){markDispatch();return c.transport.send(plan.command,{signal:abort.signal});}
    // One durable intent covers all components before any can begin. A partial
    // send is uncertain and cannot resume. Serial write/drain is awaited, not
    // physical completion, allowing the selected motions to overlap.
    coordinatedCommittedHistorySHA256=manualDispatchPins?.historySHA256;
    row.componentDispatches=[];
    for(const [index,command] of plan.commands.entries()){
     dispatchGate();
     if(index){const pins=manualDispatchPins;if(!pins||digest(readFileSync(path.join(c.directory,'commissioning/motion.json')))!==s.digest||digest(readFileSync(path.join(c.directory,'commissioning',pins.reviewFile)))!==pins.reviewSHA256||digest(readFileSync(this.file))!==pins.historySHA256||Object.entries(pins.sourceHashes).some(([file,sha])=>digest(readFileSync(new URL('../'+file,import.meta.url)))!==sha))throw Error('Coordinated evidence changed between component sends');dispatchGate();}
     if(index===0)markDispatch();
     const entry={index,joint:plan.movementJoints[index],startedAt:new Date().toISOString(),deliveryConfirmed:false};row.componentDispatches.push(entry);
     const delivered=await c.transport.send(command,{signal:abort.signal});
     if(delivered?.sent!==true&&delivered?.acknowledged!==true)throw Error('Coordinated local delivery unconfirmed');
     entry.deliveryConfirmed=true;entry.deliveryConfirmedAt=new Date().toISOString();
    }
    return {sent:true,componentCount:row.componentDispatches.length};
   },abort.signal,{preparationMs:s.manual?30000:8000});
   if(receipt?.sent!==true&&receipt?.acknowledged!==true)throw Error('Local delivery unconfirmed');
   let result;
   if(c.mode==='simulator'){
    const observed=await this.fresh(abort.signal);gate();if(c.generation!==generation)throw Error('Simulation cancelled');
    if(Object.keys(plan.target).some(k=>Math.abs(observed[k]-plan.target[k])>1e-6))throw Error('Simulator did not reach the target');
    result={outcome:'simulated',observed,simulated:true,requiresReconciliation:false};
   }else{
    const started=plan.guardedTrajectory?Date.parse(row.dispatchedAt):Date.now();while(Date.now()-started<plan.observationWindowMs){
     await delay(150,undefined,{signal:abort.signal});gate();if(c.generation!==generation)throw Error('Movement cancelled during observation');
     const joints=await this.fresh(abort.signal);if(!s.manual)validateOtherFeedback(joints,plan);const sample={source:c.mode==='serial'?'hardware':'simulator',observedAt:c.telemetryUpdatedAt,joints,health:{...c.liftHealth}};if(s.finiteElbowGestureAdmission)previousSampleAt=assertFreshElbowGestureSample({sample,previousAt:previousSampleAt,now:Date.now()});else if(s.manual||s.visibleBaseWaveAdmission||s.finiteBaseWaveAdmission||s.baseFeedforwardAdmission)previousSampleAt=assertFreshOneShotSample({sample,previousAt:previousSampleAt,now:Date.now()});observations.push(sample);if(s.manual)validateManualFeedback(joints,plan);
     const completion=monitor?.observe(sample,Date.now());
     if(plan.gestureCompletion&&completion?.ready&&Date.parse(sample.observedAt)-Date.parse(row.dispatchedAt)>=plan.gestureCompletion.minimumObservationMs&&Date.parse(sample.observedAt)-Date.parse(row.dispatchedAt)>=completion.candidate.elapsedMs+plan.gestureCompletion.postCandidateGuardMs)break;
     if(s.completionMode==='adaptive'&&completion?.ready)break;
     if(manualExit?.observe(observations).ready)break;
    }
    result=s.manual?classifyManualSettling(observations,plan):classifyOtherSettling(observations,plan);
    classified=result;
    if(s.visibleBaseWaveAdmission)validateVisibleWaveObservation({observations,plan,completion:monitor?.snapshot(),dispatchedAt:row.dispatchedAt,now:Date.now()});
    if(s.finiteElbowGestureAdmission)validateFiniteElbowGestureObservation({observations,plan,completion:monitor?.snapshot(),dispatchedAt:row.dispatchedAt,now:Date.now()});
    if(s.finiteBaseWaveAdmission)validateFiniteWaveObservation({observations,plan,completion:monitor?.snapshot(),dispatchedAt:row.dispatchedAt,now:Date.now()});
    if(s.baseFeedforwardAdmission){const last=observations.at(-1),end=Date.parse(last?.observedAt),boundary=observations.findIndex(sample=>end-Date.parse(sample.observedAt)<=BASE_FEEDFORWARD_POLICY.settlingDwellMs),firstDwell=Math.max(0,boundary-1),dwell=observations.slice(firstDwell),dwellMs=end-Date.parse(dwell[0]?.observedAt),completion=monitor?.snapshot();if(!last||end-Date.parse(row.dispatchedAt)<BASE_FEEDFORWARD_POLICY.observationWindowMs||dwell.length<BASE_FEEDFORWARD_POLICY.minimumSamples||dwellMs<BASE_FEEDFORWARD_POLICY.settlingDwellMs||!completion?.candidate||completion.lateDeparture)throw Error('Feed-forward requires the full 12-second observation, 1600ms/9-sample desired-target dwell, and clean shadow completion');for(const sample of dwell)assertDesiredFeedbackArrival(sample.joints,plan);}
    if(result.requiresReconciliation||(!(s.manual&&isSayAhClosingPlan(plan)&&result.acceptedEndpoint?.gripper===result.observed?.gripper)&&Math.abs(result.signedEndpointErrorRad)>(s.manual?manualEndpointToleranceRad(result.residualJoint??plan.movementJoint):24*SERVO_STEP)+(s.manual?1e-9:0)))throw Error('Movement did not settle close enough to the target');
    if(monitor&&(result.outcome!=='telemetry-reached'||monitor.snapshot().lateDeparture))throw Error('Feedback completion could not verify target arrival; inspect the settled shortfall or late movement before continuing');
   }
   row.result={...result,observations,completion:monitor?{mode:s.completionMode,...monitor.snapshot(),observationDurationMs:Date.parse(observations.at(-1).observedAt)-Date.parse(row.dispatchedAt)}:manualExit?{...manualExit.snapshot(),observationDurationMs:Date.parse(observations.at(-1).observedAt)-Date.parse(row.dispatchedAt),exitReason:manualExit.snapshot().ready?'guarded-settled':'full-window'}:null,physicalMovementVerified:false,physicalStopVerified:false};
  }catch(e){failure=e;if(row)row.result={...classified,outcome:classified?.outcome??(attempted?'uncertain':'not-sent'),error:e.message,requiresReconciliation:true,observations,completion:monitor?{mode:s.completionMode,...monitor.snapshot()}:manualExit?.snapshot()??null,physicalMovementVerified:false,physicalStopVerified:false};}
  finally{
   clearTimeout(timer);c.busy=false;c.taskActive=false;this.active=false;
   try{cleanup=await c.stop('Movement finished; no automatic return',false,{trialCleanup:true});}catch{cleanup={cleanupVerified:false};}
   if(c.abort===abort)c.abort=null;
  }
  try{
   if(row){row.result.cleanupVerified=cleanup?.cleanupVerified===true;row.state=!failure&&row.result.cleanupVerified?'complete':'blocked';row.finishedAt=new Date().toISOString();
    row.result.timing={...(s.manual?{feedbackAgeAtDispatchMs}:{}),preparationMs:row.dispatchedAt?Date.parse(row.dispatchedAt)-Date.parse(executionStartedAt):null,dispatchToLastFeedbackMs:observations.length?Date.parse(observations.at(-1).observedAt)-Date.parse(row.dispatchedAt):null,totalMs:Date.parse(row.finishedAt)-Date.parse(executionStartedAt)};
    const committedHistorySHA256=trajectoryCommittedHistorySHA256??coordinatedCommittedHistorySHA256;await this.save(history,committedHistorySHA256?()=>{if(digest(readFileSync(this.file))!==committedHistorySHA256)throw Error('Movement history changed; preserve unresolved intent without overwriting external records');}:null);this.result=structuredClone(row);}
   if(failure||cleanup?.cleanupVerified!==true){this.invalidate();throw failure??Error('Transport cleanup is unverified');}
   if(s.manual)for(const joint of manualPlanJoints(plan))s.manual.heldReference[joint]=row.result.observed[joint];
   s.next++;if(s.next===s.moves.length)this.invalidate();return structuredClone(row);
  }catch(e){this.invalidate();throw e;}finally{c.lifecycle=null;}
 }
}
