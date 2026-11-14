import {tabletopGeometryPolicy,TABLETOP_CLEARANCE_REVISION} from './training-envelope.mjs';
import {DRAMATIC_WAVE_SCOPE,DRAMATIC_WAVE_MAX_WINDOW_MS} from './dramatic-wave.mjs';
import {FACTORY_CALIBRATION_SCOPE,factoryCalibrationSources,validateFactoryCalibrationReview} from './factory-manual-calibration.mjs';
import {ELBOW_REPEAT_SCOPE,ELBOW_REPEAT_DEADLINE} from './finite-elbow-repeat.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {SHARED_ENVELOPE_REVISION,SHARED_COMMAND_REVISION,GRIPPER_CALIBRATION_EXPERIMENT,BASE_WAVE_EXPERIMENTS,RESET_BASE_WAVE_EXPERIMENT,RESET_POSE,otherJointEnvelope,CLAW_CLOSE_EXPERIMENT} from './other-joint-plan.mjs';
import {Z_LIFT_MODEL_REVISION} from './z-lift-plan.mjs';
import {FEEDBACK_COMPLETION_REVISION,completionScope} from './feedback-completion.mjs';
import {SERVO_STEP} from './z-lift-actuators.mjs';
import {BASE_FEEDFORWARD_SCOPE,BASE_FEEDFORWARD_REQUIRED_SOURCE_HASHES} from './base-feedforward-hypothesis.mjs';
import {FINITE_BASE_WAVE_SCOPE,FINITE_BASE_WAVE_REQUIRED_SOURCE_HASHES} from './finite-base-wave.mjs';
import {VISIBLE_BASE_WAVE_SCOPE,VISIBLE_BASE_WAVE_REQUIRED_SOURCE_HASHES} from './visible-base-wave.mjs';
import {FINITE_ELBOW_GESTURE_SCOPE,FINITE_ELBOW_GESTURE_AUTHORIZATION_UNTIL,FINITE_ELBOW_GESTURE_REQUIRED_SOURCE_HASHES,elbowGestureSourceFiles} from './finite-elbow-gesture.mjs';
import {ELBOW_FEEDFORWARD_SCOPE,ELBOW_FEEDFORWARD_DEADLINE} from './elbow-feedforward-qualification.mjs';
export const MOTION_REVISION='supervised-movement-v5';
export const RESET_WAVE_AUTHORIZATION_UNTIL='2026-10-10T06:00:00.000Z';
export const COMPLETION_SOURCE_FILES=['movement.mjs','motion-config.mjs','feedback-completion.mjs','other-joint-plan.mjs','z-lift-actuators.mjs'];
export async function completionSourceHashes(){return Object.fromEntries(await Promise.all(COMPLETION_SOURCE_FILES.map(async f=>[f,digest(await fs.readFile(new URL(f,import.meta.url)))])));}
const RESET_ADMISSION_SOURCE_FILES=[...COMPLETION_SOURCE_FILES,'server.mjs','../tools/movement.mjs'];
export async function resetAdmissionSourceHashes(){return Object.fromEntries(await Promise.all(RESET_ADMISSION_SOURCE_FILES.map(async f=>[f,digest(await fs.readFile(new URL(f,import.meta.url)))])));}
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function completionContextDigest(profile){
 const {completionMode,reviewedBy,reviewedAt,evidence,...policy}=profile;
 const {feedbackCompletion,...hardwareEvidence}=evidence??{};
 const sorted=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])])):value;
 return digest(JSON.stringify(sorted({...policy,evidence:hardwareEvidence})));
}
export const motionFile=directory=>path.join(directory,'commissioning','motion.json');
export const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw Error('Unexpected movement fields');};
export function normalizeMove(value){
 exact(value,['joint','degrees']);
 if(!['base','elbow','gripper'].includes(value.joint))throw Error('Only base, elbow and gripper are available; shoulder must remain fixed');
 const maximum={base:15,gripper:30,elbow:45}[value.joint];
 if(typeof value.degrees!=='number'||!Number.isFinite(value.degrees)||Math.abs(value.degrees)<.09||Math.abs(value.degrees)>maximum)throw Error('Movement must be signed degrees between 0.09 and '+maximum);
 return {joint:value.joint,degrees:value.degrees};
}
// One lead-installed configuration. Requests cannot change it or manufacture review evidence.
export async function readMotionConfig(directory){
 const raw=await fs.readFile(motionFile(directory));const p=JSON.parse(raw);
 if(p.revision==='stock-tabletop-manual-v1')return (await import('./manual-joints-review.mjs')).readManualConfig(directory,p,raw);
 if(p.factoryManualCalibration!==undefined&&(p.factoryManualCalibration!==FACTORY_CALIBRATION_SCOPE||p.completionMode!=='shadow'||['calibration','wave','closing','baseFeedforward','finiteBaseWave','visibleBaseWave','finiteElbowGesture'].some(key=>p[key]!==undefined)))throw Error('Factory calibration requires its exclusive one-shot shadow scope');
 if(p.revision!==MOTION_REVISION||p.enabled!==true||p.variant!=='RoArm-M2-S'||p.modelRevision!==Z_LIFT_MODEL_REVISION||p.commandRevision!==SHARED_COMMAND_REVISION||p.envelopeRevision!==SHARED_ENVELOPE_REVISION||p.toolMode!=='EEMode 0')throw Error('Reviewed movement configuration is not enabled');
 if(p.completionMode!==undefined&&!['fixed','shadow','adaptive'].includes(p.completionMode))throw Error('Unsupported feedback completion mode');
 if(p.calibration!==undefined&&(p.calibration!==GRIPPER_CALIBRATION_EXPERIMENT||p.completionMode!=='shadow'))throw Error('Gripper calibration requires its exact scope and full shadow observation');
 if(p.visibleBaseWave!==undefined&&(p.visibleBaseWave!==VISIBLE_BASE_WAVE_SCOPE||p.finiteBaseWave!==undefined||p.finiteElbowGesture!==undefined||p.wave!==undefined||p.calibration!==undefined||p.closing!==undefined||p.baseFeedforward!==undefined||p.completionMode!=='shadow'))throw Error('Visible base wave requires its exclusive scope and full shadow observation');
 if(p.finiteElbowGesture!==undefined&&(![FINITE_ELBOW_GESTURE_SCOPE,ELBOW_FEEDFORWARD_SCOPE,ELBOW_REPEAT_SCOPE,DRAMATIC_WAVE_SCOPE].includes(p.finiteElbowGesture)||p.visibleBaseWave!==undefined||p.finiteBaseWave!==undefined||p.wave!==undefined||p.calibration!==undefined||p.closing!==undefined||p.baseFeedforward!==undefined||p.completionMode!=='shadow'))throw Error('Finite elbow gesture requires its exclusive scope and full shadow observation');
 if(p.finiteBaseWave!==undefined&&(p.finiteBaseWave!==FINITE_BASE_WAVE_SCOPE||p.visibleBaseWave!==undefined||p.wave!==undefined||p.calibration!==undefined||p.closing!==undefined||p.baseFeedforward!==undefined||p.completionMode!=='shadow'))throw Error('Finite base wave requires its exclusive scope and full shadow observation');
 if(p.baseFeedforward!==undefined&&(p.baseFeedforward!==BASE_FEEDFORWARD_SCOPE||p.finiteBaseWave!==undefined||p.wave!==undefined||p.calibration!==undefined||p.closing!==undefined||p.completionMode!=='shadow'))throw Error('Base feed-forward requires its exclusive one-shot scope and full shadow observation');
 if(p.wave!==undefined&&(!BASE_WAVE_EXPERIMENTS.includes(p.wave)||p.calibration!==undefined||!['shadow','adaptive'].includes(p.completionMode)))throw Error('Base wave requires its exact scope and shadow or qualified adaptive completion');
 if(p.wave===RESET_BASE_WAVE_EXPERIMENT&&p.completionMode!=='shadow')throw Error('Reset-pose wave requires full shadow observation');
 if(p.closing!==undefined&&(p.closing!==CLAW_CLOSE_EXPERIMENT||p.wave!==undefined||p.calibration!==undefined||p.completionMode!=='shadow'))throw Error('Claw closing requires its exclusive scope and full shadow observation');
 if(p.physicalDeadlineAt!==undefined&&(!Number.isFinite(Date.parse(p.physicalDeadlineAt))||Date.now()>=Date.parse(p.physicalDeadlineAt)))throw Error('Physical test deadline has expired or is invalid');
 if(p.wave===RESET_BASE_WAVE_EXPERIMENT&&(!Number.isFinite(Date.parse(p.physicalDeadlineAt??''))||Date.parse(p.physicalDeadlineAt)>Date.parse(RESET_WAVE_AUTHORIZATION_UNTIL)||Date.now()>=Date.parse(p.physicalDeadlineAt)))throw Error('Reset-pose wave requires a finite unexpired deadline within the user authorization window');
 if(typeof p.reviewedBy!=='string'||!p.reviewedBy.trim()||!Number.isFinite(Date.parse(p.reviewedAt))||Date.parse(p.reviewedAt)>Date.now()||Date.now()-Date.parse(p.reviewedAt)>7*86400000)throw Error('Movement configuration needs a current review');
 if(typeof p.installedFirmware!=='string'||!p.installedFirmware.trim())throw Error('Firmware evidence is missing');
 let completionScopes=[],closingReview=null,baseFeedforwardReview=null,baseFeedforwardSourceHashes=null,finiteBaseWaveReview=null,finiteBaseWaveSourceHashes=null,finiteBaseWaveAdmission=null,finiteElbowGestureReview=null,finiteElbowGestureSourceHashes=null,visibleBaseWaveReview=null,visibleBaseWaveSourceHashes=null;const contextDigest=completionContextDigest(p);
 for(const key of ['firmwareProtocol','geometryAndTool','servoHealth','powerAndMount','speedAndStop',...(p.factoryManualCalibration?['factoryCalibrationReview']:[]),...(p.calibration?['gripperCalibration']:[]),...(p.wave?['baseWave']:[]),...(p.closing?['clawClosing']:[]),...(p.baseFeedforward?['baseFeedforwardReview']:[]),...(p.finiteBaseWave?['finiteBaseWaveReview']:[]),...(p.visibleBaseWave?['visibleBaseWaveReview']:[]),...(p.finiteElbowGesture?['finiteElbowGestureReview']:[]),...(p.evidence?.elbowPoseRecovery?['elbowPoseRecovery']:[]),...(p.evidence?.poseRecovery?['poseRecovery']:[]),...(p.wave===RESET_BASE_WAVE_EXPERIMENT?['resetStateRecovery','resetWaveAdmission']:[]),...(p.completionMode==='adaptive'?['feedbackCompletion']:[])]){
  const e=p.evidence?.[key];if(e?.accepted!==true||!/^evidence\/[\w-]+\.(md|json)$/.test(e.file)||!/^\w{64}$/.test(e.sha256))throw Error('Reviewed movement evidence is missing');
  const root=await fs.realpath(path.join(directory,'commissioning')),file=await fs.realpath(path.join(root,e.file));
  if(!file.startsWith(root+path.sep)||digest(await fs.readFile(file))!==e.sha256)throw Error('Movement evidence changed');
  if(key==='clawClosing'){
   const review=JSON.parse(await fs.readFile(file,'utf8')),sources=await completionSourceHashes();
   if(review.revision!=='held-claw-closing-review-v1'||review.scope!==CLAW_CLOSE_EXPERIMENT||review.causeOfPriorDrift!=='unknown'||review.closedReferenceTicks!==2050||review.maximumTargetTicks!==2049||typeof review.reviewedBy!=='string'||!review.reviewedBy.trim()||!Number.isFinite(Date.parse(review.reviewedAt))||Date.parse(review.reviewedAt)>Date.now()||Date.now()-Date.parse(review.reviewedAt)>3600000||!/^[a-f0-9]{64}$/.test(review.historySHA256??'')||Object.entries(sources).some(([k,v])=>review.sourceHashes?.[k]!==v))throw Error('Current source-bound claw closing review required');
   exact(review.expectedObserved,['base','shoulder','elbow','gripper']);
   if(['base','shoulder','elbow','gripper'].some(k=>!Number.isFinite(review.expectedObserved?.[k])))throw Error('Reviewed starting pose required');
   closingReview=review;
  }
  if(key==='feedbackCompletion'){
   const proof=JSON.parse(await fs.readFile(file,'utf8')),sources=await completionSourceHashes();
   if(proof.revision!==FEEDBACK_COMPLETION_REVISION||proof.shadowPassed!==true||proof.lateDeparture!==false||!Array.isArray(proof.commands)||proof.commands.length<2||new Set(proof.commands.map(c=>c.id)).size!==proof.commands.length||Object.entries(sources).some(([k,v])=>proof.sourceHashes?.[k]!==v))throw Error('Current independent shadow validation evidence required');
   const history=JSON.parse(await fs.readFile(path.join(directory,'movement-history.json'),'utf8')),scopes=new Map();
   for(const reference of proof.commands){
    const row=history.commands.find(c=>c.id===reference.id),result=row?.result,c=result?.completion;
    if(!row||digest(JSON.stringify(row))!==reference.sha256||row.completionContextDigest!==contextDigest||row.mode!=='serial'||row.state!=='complete'||result.cleanupVerified!==true||result.requiresReconciliation||result.outcome!=='telemetry-reached'||c?.mode!=='shadow'||c.revision!==FEEDBACK_COMPLETION_REVISION||!c.candidate||c.lateDeparture!==false||c.observationDurationMs<row.plan.observationWindowMs||Object.entries(sources).some(([k,v])=>row.completionSourceHashes?.[k]!==v))throw Error('Shadow evidence does not match completed full-window commands and hardware context');
    const scope=completionScope(row.plan);scopes.set(scope,(scopes.get(scope)??0)+1);
   }
   completionScopes=[...scopes].filter(([,n])=>n>=2).map(([scope])=>scope);
   if(!completionScopes.length)throw Error('Two shadow validations of the same movement scope are required');
  }
 }
 let factoryCalibrationReview=null,factoryCalibrationSourceHashes=null;
 if(p.factoryManualCalibration){
  const evidence=p.evidence.factoryCalibrationReview;
  factoryCalibrationReview=JSON.parse(await fs.readFile(path.join(directory,'commissioning',evidence.file),'utf8'));
  factoryCalibrationSourceHashes=await factoryCalibrationSources();
  validateFactoryCalibrationReview(factoryCalibrationReview,p,factoryCalibrationSourceHashes);
 }
 let resetStateRecoveryReview=null,resetWaveAdmissionReview=null;
 if(p.baseFeedforward===BASE_FEEDFORWARD_SCOPE){
  if(!Number.isFinite(Date.parse(p.physicalDeadlineAt??''))||Date.parse(p.physicalDeadlineAt)>Date.parse('2026-10-10T06:00:00.000Z')||Date.now()>=Date.parse(p.physicalDeadlineAt))throw Error('Base feed-forward requires a finite unexpired one-shot authorization deadline');
  const evidence=p.evidence?.baseFeedforwardReview,root=await fs.realpath(directory),reviewFile=await fs.realpath(path.join(root,'commissioning',evidence.file));
  if(!reviewFile.startsWith(root+path.sep))throw Error('Base feed-forward review must remain inside commissioning evidence');
  baseFeedforwardReview=JSON.parse(await fs.readFile(reviewFile,'utf8'));
  const sourceRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  baseFeedforwardSourceHashes=Object.fromEntries(await Promise.all(BASE_FEEDFORWARD_REQUIRED_SOURCE_HASHES.map(async file=>[file,digest(await fs.readFile(path.join(sourceRoot,file)))])));
  if(Object.entries(baseFeedforwardSourceHashes).some(([file,sha])=>baseFeedforwardReview.sourceHashes?.[file]!==sha))throw Error('Current source-bound independent base feed-forward review required');
 }
 if(p.finiteBaseWave===FINITE_BASE_WAVE_SCOPE){
  const evidence=p.evidence?.finiteBaseWaveReview,root=await fs.realpath(directory),reviewFile=await fs.realpath(path.join(root,'commissioning',evidence.file));if(!reviewFile.startsWith(root+path.sep))throw Error('Finite-wave review must remain inside commissioning evidence');
  finiteBaseWaveReview=JSON.parse(await fs.readFile(reviewFile,'utf8'));const sourceRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const now=Date.now(),deadline=Date.parse(p.physicalDeadlineAt??'');
  if(finiteBaseWaveReview.revision==='independent-current-pose-base-demo-leg-v1'){
   const issued=Date.parse(finiteBaseWaveReview.authorizationIssuedAt),until=Date.parse(finiteBaseWaveReview.authorizationUntil);
   if(!Number.isFinite(issued)||!Number.isFinite(until)||issued>now||until<=now||until-issued>300000||until<=issued||deadline!==until||finiteBaseWaveReview.deadlineAt!==p.physicalDeadlineAt)throw Error('Current base demo requires a fresh finite five-minute authorization');
  }else if(!Number.isFinite(deadline)||deadline>Date.parse('2026-10-10T06:00:00.000Z')||now>=deadline)throw Error('Finite wave requires a finite unexpired deadline within the user authorization window');
  finiteBaseWaveSourceHashes=Object.fromEntries(await Promise.all(FINITE_BASE_WAVE_REQUIRED_SOURCE_HASHES.map(async file=>[file,digest(await fs.readFile(path.join(sourceRoot,file)))])));
  if(Object.entries(finiteBaseWaveSourceHashes).some(([file,sha])=>finiteBaseWaveReview.sourceHashes?.[file]!==sha))throw Error('Current source-bound independent finite-wave review required');
 }
 if([FINITE_ELBOW_GESTURE_SCOPE,ELBOW_FEEDFORWARD_SCOPE,ELBOW_REPEAT_SCOPE,DRAMATIC_WAVE_SCOPE].includes(p.finiteElbowGesture)){
  if(!Number.isFinite(Date.parse(p.physicalDeadlineAt??''))||(p.finiteElbowGesture!==DRAMATIC_WAVE_SCOPE&&Date.parse(p.physicalDeadlineAt)>Date.parse(p.finiteElbowGesture===ELBOW_REPEAT_SCOPE?ELBOW_REPEAT_DEADLINE:p.finiteElbowGesture===ELBOW_FEEDFORWARD_SCOPE?ELBOW_FEEDFORWARD_DEADLINE:FINITE_ELBOW_GESTURE_AUTHORIZATION_UNTIL))||Date.now()>=Date.parse(p.physicalDeadlineAt))throw Error('Finite elbow gesture requires a finite unexpired deadline within the renewed authorization window');
  const evidence=p.evidence?.finiteElbowGestureReview,root=await fs.realpath(directory),reviewFile=await fs.realpath(path.join(root,'commissioning',evidence.file));if(!reviewFile.startsWith(root+path.sep))throw Error('Finite elbow gesture review must remain inside commissioning evidence');
  finiteElbowGestureReview=JSON.parse(await fs.readFile(reviewFile,'utf8'));if(p.finiteElbowGesture===DRAMATIC_WAVE_SCOPE){const r=finiteElbowGestureReview,a=Date.parse(r.authorizationIssuedAt),b=Date.parse(r.authorizationUntil);if(!Number.isFinite(a)||!Number.isFinite(b)||a>Date.now()||b<=Date.now()||b-a>DRAMATIC_WAVE_MAX_WINDOW_MS||b<=a||r.deadlineAt!==p.physicalDeadlineAt||Date.parse(r.deadlineAt)>b)throw Error('Fresh five-minute dramatic wave authorization required');}const sourceRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  finiteElbowGestureSourceHashes=Object.fromEntries(await Promise.all(elbowGestureSourceFiles(p.finiteElbowGesture).map(async file=>[file,digest(await fs.readFile(path.join(sourceRoot,file)))])));
  if(Object.entries(finiteElbowGestureSourceHashes).some(([file,sha])=>finiteElbowGestureReview.sourceHashes?.[file]!==sha))throw Error('Current source-bound independent finite elbow gesture review required');
 }
 if(p.visibleBaseWave===VISIBLE_BASE_WAVE_SCOPE){
  if(!Number.isFinite(Date.parse(p.physicalDeadlineAt??''))||Date.parse(p.physicalDeadlineAt)>Date.parse('2026-10-10T06:00:00.000Z')||Date.now()>=Date.parse(p.physicalDeadlineAt))throw Error('Visible wave requires a finite unexpired deadline within the user authorization window');
  const evidence=p.evidence?.visibleBaseWaveReview,root=await fs.realpath(directory),reviewFile=await fs.realpath(path.join(root,'commissioning',evidence.file));if(!reviewFile.startsWith(root+path.sep))throw Error('Visible-wave review must remain inside commissioning evidence');
  visibleBaseWaveReview=JSON.parse(await fs.readFile(reviewFile,'utf8'));const sourceRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  visibleBaseWaveSourceHashes=Object.fromEntries(await Promise.all(VISIBLE_BASE_WAVE_REQUIRED_SOURCE_HASHES.map(async file=>[file,digest(await fs.readFile(path.join(sourceRoot,file)))])));
  if(Object.entries(visibleBaseWaveSourceHashes).some(([file,sha])=>visibleBaseWaveReview.sourceHashes?.[file]!==sha))throw Error('Current source-bound independent visible-wave review required');
 }
 if(p.wave===RESET_BASE_WAVE_EXPERIMENT){
  const sources=await resetAdmissionSourceHashes(),read=async key=>JSON.parse(await fs.readFile(path.join(directory,'commissioning',p.evidence[key].file),'utf8'));
  resetStateRecoveryReview=await read('resetStateRecovery');resetWaveAdmissionReview=await read('resetWaveAdmission');
  const currentReview=review=>typeof review.reviewedBy==='string'&&review.reviewedBy.trim()&&Number.isFinite(Date.parse(review.reviewedAt))&&Date.parse(review.reviewedAt)<=Date.now()&&Date.now()-Date.parse(review.reviewedAt)<=3600000&&Object.entries(sources).every(([k,v])=>review.sourceHashes?.[k]===v);
  const poseMatches=pose=>pose&&Object.keys(RESET_POSE).length===4&&Object.entries(RESET_POSE).every(([k,v])=>Number.isFinite(pose[k])&&Math.abs(pose[k]-v)<=1e-9);
  const recovery=resetStateRecoveryReview,scope=resetWaveAdmissionReview;
  if(recovery.revision!=='operator-asserted-reset-recovery-v1'||recovery.commandId!=='fa7b492e-2475-494f-a2a9-a406635d455c'||recovery.originalRowSHA256!=='c0a0f3acbd91602ecfd5ee14c63db9802dfdc28928eed107289cbc148db8892b'||recovery.cause!=='unknown'||recovery.operatorAssertionStatus!=='asserted-not-verified'||recovery.authorizationUntil!==RESET_WAVE_AUTHORIZATION_UNTIL||!poseMatches(recovery.expectedPose)||!currentReview(recovery))throw Error('Current source-bound operator-asserted reset recovery review required');
  const moves=[{joint:'base',degrees:-5},{joint:'base',degrees:10},{joint:'base',degrees:-5}],movesMatch=Array.isArray(scope.moves)&&scope.moves.length===moves.length&&moves.every((m,i)=>scope.moves[i]?.joint===m.joint&&scope.moves[i]?.degrees===m.degrees);
  if(scope.revision!=='independently-reviewed-reset-wave-v1'||scope.scope!==RESET_BASE_WAVE_EXPERIMENT||scope.commandId!==recovery.commandId||scope.originalRowSHA256!==recovery.originalRowSHA256||scope.authorizationUntil!==RESET_WAVE_AUTHORIZATION_UNTIL||!poseMatches(scope.expectedPose)||!movesMatch||typeof scope.independentlyReviewedBy!=='string'||!scope.independentlyReviewedBy.trim()||scope.independentlyReviewedBy===scope.reviewedBy||!currentReview(scope))throw Error('Current independent exact-pose reset-wave review required');
  const geometry=otherJointEnvelope(RESET_POSE,RESET_POSE,'base',RESET_BASE_WAVE_EXPERIMENT),matchesGeometry=g=>g&&g.gridConfigurations===geometry.gridConfigurations&&g.tabletopClearanceRevision===TABLETOP_CLEARANCE_REVISION&&g.requiredBodyHeightMm===0&&g.requiredSelfSeparationMm===24&&Math.abs(g.uncertaintyRad-(.0465+SERVO_STEP))<1e-9&&Object.entries(geometry.minimumBodyHeightMm).every(([k,v])=>Math.abs(g.minimumBodyHeightMm?.[k]-v)<.002)&&Math.abs(g.minimumSelfSeparationMm-geometry.minimumSelfSeparationMm)<.002;
  if(!matchesGeometry(scope.leadGeometry)||!matchesGeometry(scope.independentGeometry)||geometry.gridConfigurations!==17576||geometry.minimumBodyHeightMm.upperFree<0||geometry.minimumSelfSeparationMm<24)throw Error('Reset-pose wave geometry review differs from the conservative source calculation');
 }
 return {digest:digest(raw),profile:p,factoryCalibrationReview,factoryCalibrationSourceHashes,completionScopes,completionContextDigest:contextDigest,closingReview,baseFeedforwardReview,baseFeedforwardSourceHashes,finiteBaseWaveReview,finiteBaseWaveSourceHashes,finiteBaseWaveAdmission,finiteElbowGestureReview,finiteElbowGestureSourceHashes,visibleBaseWaveReview,visibleBaseWaveSourceHashes,resetStateRecoveryReview,resetWaveAdmissionReview};
}
