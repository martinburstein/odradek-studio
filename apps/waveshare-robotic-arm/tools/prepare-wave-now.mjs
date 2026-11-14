import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';import {randomUUID} from 'node:crypto';
import {digest,readMotionConfig} from '../src/motion-config.mjs';import {DRAMATIC_WAVE_SCOPE,DRAMATIC_WAVE_REQUIRED_SOURCE_HASHES,DRAMATIC_GESTURE_POLICY,DRAMATIC_WAVE_GESTURE_COMPLETION_SHA256,DRAMATIC_WAVE_RECOVERY_ORIGINAL_ROW_SHA256} from '../src/dramatic-wave.mjs';import {SERVO_STEP,observedTicks} from '../src/z-lift-actuators.mjs';import {elbowFeedforwardGeometry} from '../src/elbow-feedforward-geometry.mjs';
import {createRoutineMotionConsent,readRoutineMotionConsent,ROUTINE_MOTION_CONSENT_FILENAME} from '../src/routine-motion-consent.mjs';
import {stagePilotCameraProof,validatePilotCameraProof} from './pilot-camera-proof.mjs';
import {validateDramaticWaveAdmission,DRAMATIC_WAVE_RECOVERY_ROW_ID} from '../src/dramatic-wave.mjs';
import {setTimeout as proofDelay} from 'node:timers/promises';
import {FINITE_BASE_WAVE_SCOPE,CURRENT_POSE_BASE_DEMO_REVIEW,FINITE_BASE_WAVE_POLICY,FINITE_BASE_WAVE_REQUIRED_SOURCE_HASHES,validateFiniteBaseWaveAdmission} from '../src/finite-base-wave.mjs';
import {RESET_BASE_WAVE_EXPERIMENT,planOtherJoint} from '../src/other-joint-plan.mjs';
import {forwardKinematics} from '../src/kinematics.mjs';
import {Z_LIFT_MODEL_REVISION} from '../src/z-lift-plan.mjs';
import {feedbackAtTicks} from '../src/z-lift-actuators.mjs';

// Offline proposal: no clock-bound authority, installation, connection or motion.
export function createCurrentBaseDemoCandidate({history,sourceHashes}){
 const prior=history?.commands?.at(-1),start=prior?.result?.observed;
 if(prior?.mode!=='serial'||prior.state!=='complete'||prior.result?.outcome!=='telemetry-reached'||prior.result.cleanupVerified!==true||prior.result.requiresReconciliation!==false||prior.finiteElbowGesture?.scope!==DRAMATIC_WAVE_SCOPE||prior.finiteElbowGesture.desiredTick!==2052)throw Error('Latest clean horizontal elbow receipt required for this base candidate');
 const ticks=observedTicks(start),outTick=ticks.base+Math.round(3*Math.PI/180/SERVO_STEP),outStart={...start,base:feedbackAtTicks({...ticks,base:outTick}).base};
 const make=(pose,desiredTick,extensionTicks)=>{const commandTick=desiredTick+extensionTicks,p=planOtherJoint(pose,forwardKinematics(pose,Z_LIFT_MODEL_REVISION),RESET_BASE_WAVE_EXPERIMENT,commandTick);return {expectedStart:pose,desiredTargetTick:desiredTick,extendedCommandTargetTick:commandTick,extensionTicks,totalCommandTicks:Math.abs(commandTick-observedTicks(pose).base),geometry:p.envelope};};
 return {revision:'current-base-demo-candidate-v1',controllerReviewRevision:CURRENT_POSE_BASE_DEMO_REVIEW,preparedOnly:true,executionAuthorized:false,installed:false,physicalMovementVerified:false,sourceHashes,historySHA256:digest(JSON.stringify(history)),predecessorId:prior.id,predecessorRowSHA256:digest(JSON.stringify(prior)),seriesAnchorBaseTick:ticks.base,policy:{maxLegs:2,conversationalDegrees:[3,-3],speedStepsPerSecond:20,acceleration:1,maxTotalCommandTicks:114,arrivalRad:.0024,trackingRad:.0065,heldJointTicks:1,observationWindowMs:12000,stationaryBaselineMs:30000,minimumBaselineSamples:100},legs:[make(start,outTick,15),make(outStart,ticks.base,-12)],limitations:['Each leg needs fresh source-bound review, current operator supervision and camera inspection.','Return is conditional on a clean first leg and its actual observed pose.','Directional feed-forward is a finite hypothesis, not general base calibration.','The original expired and consumed reviews remain unchanged.']};
}

// Called only after a later actual execution instruction. Issuance is separate
// from preparing the inert candidate and each leg still uses the fixed client.
export function createCurrentBaseDemoReview({history,sourceHashes,authority,cameraObservation,inspection,independentlyReviewedBy,now=Date.now(),ordinal=1}){
 const confirmations=['baseSecured','sweep300mmClear','cablesSlack','jawsClear','powerSwitchReady'];
 if(authority?.executeAuthorized!==true||typeof authority.sourceInstruction!=='string'||authority.sourceInstruction.trim().length<12||authority.sourceInstruction.length>2000||!authority.confirmations||Object.keys(authority.confirmations).length!==5||confirmations.some(k=>authority.confirmations[k]!==true))throw Error('Actual explicit execution instruction and all current physical confirmations required');
 if(![1,2].includes(ordinal)||typeof independentlyReviewedBy!=='string'||!independentlyReviewedBy.trim())throw Error('Two-leg ordinal and distinct source reviewer required');
 const issued=Date.parse(authority.authorizationIssuedAt),until=Date.parse(authority.authorizationUntil),uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
 if(!uuid(authority.authorizationId)||!uuid(authority.seriesId)||!Number.isFinite(issued)||!Number.isFinite(until)||issued>now||until-now<60000||until-issued<=0||until-issued>300000||new Date(issued).toISOString()!==authority.authorizationIssuedAt||new Date(until).toISOString()!==authority.authorizationUntil)throw Error('Immutable current execution instruction ID, issuance time and bounded original deadline required');
 const prior=history.commands.at(-1),start=prior.result.observed,ticks=observedTicks(start),a=ordinal===1?{authorizationId:authority.authorizationId,seriesId:authority.seriesId,authorizationIssuedAt:authority.authorizationIssuedAt,authorizationUntil:authority.authorizationUntil,sourceInstruction:authority.sourceInstruction.trim(),seriesAnchorBaseTick:ticks.base}:prior.finiteBaseWave;
 if(ordinal===2&&['authorizationId','seriesId','authorizationIssuedAt','authorizationUntil'].some(k=>a?.[k]!==authority[k]))throw Error('Return must retain the exact original execution authority');
 if(ordinal===2&&a?.sourceInstruction!==authority.sourceInstruction.trim())throw Error('Return must preserve the original explicit execution instruction');
 const degrees=ordinal===1?3:-3,extensionTicks=ordinal===1?15:-12,desiredTargetTick=ordinal===1?ticks.base+Math.round(3*Math.PI/180/SERVO_STEP):a.seriesAnchorBaseTick,extendedCommandTargetTick=desiredTargetTick+extensionTicks;
 const p=FINITE_BASE_WAVE_POLICY,review={revision:CURRENT_POSE_BASE_DEMO_REVIEW,scope:FINITE_BASE_WAVE_SCOPE,seriesId:a.seriesId,ordinal,maxLegs:2,executeAuthorized:true,confirmations:{...authority.confirmations},authorizationId:a.authorizationId,authorizationIssuedAt:a.authorizationIssuedAt,authorizationUntil:a.authorizationUntil,sourceInstruction:a.sourceInstruction,deadlineAt:a.authorizationUntil,oneShotId:randomUUID(),reviewedBy:'Sol lead',independentlyReviewedBy,reviewedAt:new Date(now).toISOString(),conversationalDegrees:degrees,requestDegrees:-degrees,rawJointDirection:degrees>0?'decreasing':'increasing',servoFeedbackTickDirection:degrees>0?'increasing':'decreasing',extensionTicks,maxTotalCommandTicks:p.maxTotalCommandTicks,speedStepsPerSecond:p.speedStepsPerSecond,acceleration:p.acceleration,arrivalRad:p.arrivalRad,trackingRad:p.trackingRad,heldJointTicks:p.heldJointTicks,observationWindowMs:p.observationWindowMs,settlingDwellMs:p.settlingDwellMs,minimumSamples:p.minimumSamples,maxSampleAgeMs:p.maxSampleAgeMs,priorCommandId:prior.id,priorRowSHA256:digest(JSON.stringify(prior)),priorSeriesOrdinal:ordinal-1,historySHA256:digest(JSON.stringify(history)),expectedStart:{...start},seriesAnchorBaseTick:a.seriesAnchorBaseTick,desiredTargetTick,extendedCommandTargetTick,resetAnchorRowSHA256:digest(JSON.stringify(history.commands.find(r=>r.id==='fa7b492e-2475-494f-a2a9-a406635d455c'))),sourceHashes,cameraObservation,inspection,cameraProofSHA256:digest(JSON.stringify({...cameraObservation,inspection})),geometry:planOtherJoint(start,forwardKinematics(start,Z_LIFT_MODEL_REVISION),RESET_BASE_WAVE_EXPERIMENT,extendedCommandTargetTick).envelope};
 validateFiniteBaseWaveAdmission({review,sourceHashes,history,deadlineAt:review.deadlineAt,now,ordinal,seriesId:review.seriesId});return review;
}
function cameraProof(value){const {inspection,...cameraObservation}=value;return {cameraObservation,inspection};}
export async function readPilotCameraProof({runtime,phase='initial',clock=Date.now,io=fs}={}){
 if(!['initial','return'].includes(phase))throw Error('Unknown Pilot proof phase');
 const proof=cameraProof(JSON.parse(await io.readFile(path.join(runtime,'wave-now-camera-metadata.json'),'utf8')));
 if(phase==='initial'){
  const history=JSON.parse(await io.readFile(path.join(runtime,'movement-history.json'),'utf8'));
  validatePilotCameraProof({proof,predecessor:history.commands.at(-1),now:clock()});
 }
 // During an admitted wave, the old initial proof is expected until root inspects
 // the completed DOWN. The console owns waiting, freshness and its finite timeout.
 return proof;
}
export async function stageWaveCameraProof({runtime,proof,history,submit,clock=Date.now,signal,io=fs,platform=process.platform,sleep=proofDelay,retryRename=io===fs}={}){
 if(typeof submit!=='function')throw Error('One preparation callback required');
 const historyPath=path.join(runtime,'movement-history.json');
 const current=history??JSON.parse(await io.readFile(historyPath,'utf8'));
 const historySHA256=digest(JSON.stringify(current));
 const predecessor=current.commands.at(-1),targetPath=path.resolve(runtime,'wave-now-camera-metadata.json');
 const stagingIO=retryRename?{
  readFile:(...args)=>io.readFile(...args),writeFile:(...args)=>io.writeFile(...args),unlink:(...args)=>io.unlink(...args),
  rename:async(from,to)=>{
   const isStaging=path.resolve(to)===targetPath&&path.dirname(path.resolve(from))===path.dirname(targetPath)&&path.basename(from).startsWith('.wave-now-camera-metadata.json.')&&path.extname(from)==='.tmp';
   if(!isStaging)return io.rename(from,to); // Rollback is never delayed or gated by stale proof.
   const check=()=>{if(signal?.aborted)throw Error('Proof preparation cancelled');validatePilotCameraProof({proof,predecessor,now:clock()});};
   check();
   try{return await io.rename(from,to);}catch(error){
    if(platform!=='win32'||error?.code!=='EPERM')throw error;
    check();await sleep(25,undefined,{signal});check();
    return io.rename(from,to); // Exactly one rename retry, before any preparation callback.
   }
  }
 }:io;
 return stagePilotCameraProof({proof,predecessor,targetPath,clock,signal,io:stagingIO,
  submit:async staged=>{
   const latest=JSON.parse(await io.readFile(historyPath,'utf8'));
   if(digest(JSON.stringify(latest))!==historySHA256)throw Error('Movement history changed during proof staging; no preparation submitted');
   validatePilotCameraProof({proof:{cameraObservation:staged.cameraObservation,inspection:staged.inspection},predecessor:latest.commands.at(-1),now:clock()});
   if(signal?.aborted)throw Error('Proof preparation cancelled');
   return submit(staged);
  }});
}
export function createWaveAuthorization({speedStepsPerSecond=20,gesture=false,consent,now=Date.now()}={}){
 if(![20,40].includes(speedStepsPerSecond))throw Error('Only reviewed 20 or 40 speed is available');
 const until=Math.min(now+300000,consent?Date.parse(consent.until):Infinity);
 if(!Number.isFinite(until)||until-now<45000)throw Error('Full execution reserve within standing consent required');
 return {speedStepsPerSecond,authorizationId:randomUUID(),seriesId:randomUUID(),actionWindowId:randomUUID(),issuedAt:new Date(now).toISOString(),until:new Date(until).toISOString(),...(consent?{routineConsentId:consent.id}:{}),...(gesture?{gestureCompletion:{...DRAMATIC_GESTURE_POLICY},gestureCompletionSHA256:DRAMATIC_WAVE_GESTURE_COMPLETION_SHA256}:{})};
}
async function atomicWrite(file,bytes){const temporary=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temporary,bytes,{flag:'wx'});await fs.rename(temporary,file);}finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}}
async function existingConsent(runtime){try{return await readRoutineMotionConsent(runtime);}catch(error){if(error.code==='ENOENT')return undefined;throw error;}}
export function createWaveReview({guardedTrajectory,history,sourceHashes,authorization,ordinal,cameraObservation,recoveryOnly=false,resumeOnly=false,stationaryStart,resetOnly=false,resetAssertion,currentStart=false,independentlyReviewedBy='Independent GPT-6 Luna Medium frozen-source and deterministic preparation review; caller lead binds current evidence',now=Date.now()}){
 if(cameraObservation?.fullSweepVisible!==true||cameraObservation.visibleObstacles!==false||cameraObservation.confirmedShowsArm!==true)throw Error('Explicit unobstructed full-sweep camera inspection required');
 const prior=history.commands.at(-1),start=stationaryStart?.expectedStart??prior.result.observed,desiredTick=recoveryOnly||resumeOnly?2052:ordinal===1?2389:2052,commandTick=recoveryOnly||resumeOnly?2034:ordinal===1?2389:2034,currentPoseQualified=currentStart||ordinal===2&&prior.finiteElbowGesture?.currentPoseQualified===true,geometry=elbowFeedforwardGeometry({start,desiredTick,commandTick,currentPoseQualified});
 return {revision:'independent-dramatic-wave-review-v1',scope:DRAMATIC_WAVE_SCOPE,...(guardedTrajectory?{guardedTrajectory}:{}),...(currentPoseQualified?{currentPoseQualified:true,currentQualificationId:currentStart?stationaryStart.id:prior.finiteElbowGesture.currentQualificationId}:{}),...(currentStart?{currentStart:true}:{}),...(resetOnly?{resetOnly:true,resetAssertion}:{}),...(authorization.routineConsentId?{routineConsentId:authorization.routineConsentId}:{}),seriesId:authorization.seriesId,actionWindowId:authorization.actionWindowId,authorizationId:authorization.authorizationId,authorizationIssuedAt:authorization.issuedAt,authorizationUntil:authorization.until,deadlineAt:authorization.until,ordinal,maxLegs:recoveryOnly||resumeOnly?1:2,recoveryOnly,resumeOnly,...(stationaryStart?{stationaryStart,stationaryStartSHA256:digest(JSON.stringify(stationaryStart))}:{}),...(recoveryOnly?{recoveryAnchorSHA256:DRAMATIC_WAVE_RECOVERY_ORIGINAL_ROW_SHA256,originalShortfallSHA256:DRAMATIC_WAVE_RECOVERY_ORIGINAL_ROW_SHA256}:{}),...(authorization.gestureCompletion?{gestureCompletion:authorization.gestureCompletion,gestureCompletionSHA256:authorization.gestureCompletionSHA256}:{}),sessionSeconds:90,oneShotId:randomUUID(),reviewedBy:'Sol lead',independentlyReviewedBy,reviewedAt:new Date(now).toISOString(),predecessorId:prior.id,predecessorRowSHA256:digest(JSON.stringify(prior)),historySHA256:digest(JSON.stringify(history)),startPoseSHA256:digest(JSON.stringify(start)),startTick:observedTicks(start).elbow,desiredTick,commandTick,extensionTicks:desiredTick-commandTick,maxLegTicks:360,anchorProof:currentStart?'qualified-current-horizontal-start':resetOnly?'operator-reset-stationary-start':resumeOnly?'completed-wave-outward-resume':recoveryOnly?'reconciled-wave-shortfall':ordinal===1?'completed-wave-anchor':'completed-wave-outward',qualificationOutwardSHA256:'8a5bba580e68546179a6353ad95f1731cddc1fbe788dd0e4f576744c215113e6',qualificationReturnSHA256:'727e7888f8a19b9dea286a9c96e5ec4f294b2aa503d5a72cca4901bb4f718a7a',speedStepsPerSecond:authorization.speedStepsPerSecond??20,acceleration:1,arrivalRad:authorization.gestureCompletion?4*SERVO_STEP:.0024,trackingRad:.0065,heldJointTicks:1,observationWindowMs:36000,settlingDwellMs:1600,minimumSamples:9,maxSampleAgeMs:500,sourceHashes,geometry,geometrySHA256:digest(JSON.stringify(geometry)),cameraObservation,cameraObservationSHA256:digest(JSON.stringify(cameraObservation))};
}
export function createRecoveryWaveReview({history,sourceHashes,authorization,proof,now=Date.now()}={}){
 const camera=proof?.cameraObservation,inspection=proof?.inspection,prior=history?.commands?.at(-1);
 const cameraKeys=['inspectedBy','cameraSessionId','sequence','observedAt','commandId','confirmedShowsArm','fullSweepVisible','visibleObstacles','frameSaved'];
 const inspectionKeys=['stationary','noContact','cablesSlack','noUnusualNoise'];
 const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
 const at=Date.parse(camera?.observedAt),reconciledAt=Date.parse(prior?.reconciliation?.observations?.at(-1)?.observedAt);
 if(!exact(proof,['cameraObservation','inspection'])||!exact(camera,cameraKeys)||!exact(inspection,inspectionKeys)||inspectionKeys.some(k=>inspection[k]!==true)||prior?.id!==DRAMATIC_WAVE_RECOVERY_ROW_ID||camera.commandId!==prior.id||camera.inspectedBy!=='root'||camera.confirmedShowsArm!==true||camera.fullSweepVisible!==true||camera.visibleObstacles!==false||camera.frameSaved!==false||typeof camera.cameraSessionId!=='string'||!camera.cameraSessionId.trim()||!Number.isSafeInteger(camera.sequence)||camera.sequence<1||!Number.isFinite(now)||!Number.isFinite(at)||at>now||now-at>60000||!Number.isFinite(reconciledAt)||at<reconciledAt||!Number.isFinite(Date.parse(prior.finishedAt))||at<Date.parse(prior.finishedAt))throw Error('Fresh exact root proof after recovery reconciliation required');
 const review=createWaveReview({history,sourceHashes,authorization,ordinal:1,recoveryOnly:true,cameraObservation:camera,now});
 // Keep the exact preserved failed-row/reconciliation contract. This is candidate
 // preparation only; it neither stages ordinary Pilot proof nor issues motion.
 validateDramaticWaveAdmission({review,sourceHashes,history,deadlineAt:review.deadlineAt,ordinal:1,seriesId:review.seriesId,now});
 return review;
}
// Evidence preparation only: never opens hardware or grants motion by itself.
// Lead installs only after the distinct reviewer has checked the frozen hash.
async function main(){const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),runtime=path.join(root,'runtime'),[action,phase,input]=process.argv.slice(2),authFile=path.join(runtime,'wave-now-authorization.json');
 if(action==='base-candidate'){
  if(phase||input)throw Error('base-candidate takes no arguments and grants no authority');
  const history=JSON.parse(await fs.readFile(path.join(runtime,'movement-history.json'),'utf8')),sourceHashes=Object.fromEntries(await Promise.all([...new Set(FINITE_BASE_WAVE_REQUIRED_SOURCE_HASHES)].map(async f=>[f,digest(await fs.readFile(path.join(root,f)))]))),candidate=createCurrentBaseDemoCandidate({history,sourceHashes});
  await atomicWrite(path.join(runtime,'current-base-demo-candidate.json'),JSON.stringify(candidate,null,2));console.log(JSON.stringify({candidateFile:'runtime/current-base-demo-candidate.json',preparedOnly:true,executionAuthorized:false,installed:false,physicalMovementVerified:false,desiredTicks:candidate.legs.map(l=>l.desiredTargetTick)}));
 }else if(action==='base-stage'){
  if(!['first','return'].includes(phase)||!input)throw Error('base-stage first|return actual-execution-instruction-and-camera.json');
  const request=JSON.parse(await fs.readFile(path.resolve(input),'utf8')),history=JSON.parse(await fs.readFile(path.join(runtime,'movement-history.json'),'utf8'));
  const sourceHashes=Object.fromEntries(await Promise.all([...new Set(FINITE_BASE_WAVE_REQUIRED_SOURCE_HASHES)].map(async f=>[f,digest(await fs.readFile(path.join(root,f)))])));
  const accepted=JSON.parse(await fs.readFile(path.join(runtime,'current-base-demo-independent-review.json'),'utf8'));
  if(accepted.verdict!=='pass'||!accepted.reviewedBy||Object.keys(sourceHashes).some(f=>accepted.sourceHashes?.[f]!==sourceHashes[f]))throw Error('Exact independently accepted current base-demo source capsule required');
  const review=createCurrentBaseDemoReview({history,sourceHashes,authority:request,cameraObservation:request.cameraObservation,inspection:request.inspection,independentlyReviewedBy:accepted.reviewedBy,ordinal:phase==='first'?1:2}),bytes=JSON.stringify(review,null,2),hash=digest(bytes),file='evidence/current-base-demo-'+review.authorizationId+'-leg'+review.ordinal+'.json';
  const p=JSON.parse(await fs.readFile(path.join(runtime,'commissioning/motion.json'),'utf8'));
  for(const k of ['finiteElbowGesture','visibleBaseWave','wave','calibration','closing','baseFeedforward'])delete p[k];
  for(const k of ['finiteElbowGestureReview','visibleBaseWaveReview','baseWave','gripperCalibration','clawClosing','baseFeedforwardReview','resetStateRecovery','resetWaveAdmission','elbowPoseRecovery','poseRecovery','feedbackCompletion'])delete p.evidence[k];
  p.finiteBaseWave=FINITE_BASE_WAVE_SCOPE;p.completionMode='shadow';p.physicalDeadlineAt=review.deadlineAt;p.reviewedAt=review.reviewedAt;p.reviewedBy=review.reviewedBy;
  for(const k of ['geometryAndTool','powerAndMount','speedAndStop','finiteBaseWaveReview'])p.evidence[k]={accepted:true,file,sha256:hash};
  await fs.writeFile(path.join(runtime,'commissioning',file),bytes,{flag:'wx'});
  await atomicWrite(path.join(runtime,'wave-now-candidate.json'),JSON.stringify({reviewFile:file,reviewSHA256:hash,profile:p},null,2));
  await atomicWrite(path.join(runtime,'base-demo-request.json'),JSON.stringify({seconds:60,moves:[{joint:'base',degrees:review.requestDegrees}],inspection:request.inspection,confirmations:request.confirmations},null,2));
  console.log(JSON.stringify({reviewFile:file,reviewSHA256:hash,ordinal:review.ordinal,installed:false,commandSubmitted:false,physicalMovementVerified:false}));
 }else if(action==='consent'){
  if(!phase||input)throw Error('consent explicit-user-instruction.json');
  const request=JSON.parse(await fs.readFile(path.resolve(phase),'utf8'));if(Object.keys(request).some(k=>!['sourceInstruction','confirmations','operatorAssertedReset','guardedElbowTrajectory'].includes(k)))throw Error('Unexpected consent request fields');
  const consent=createRoutineMotionConsent(request);await atomicWrite(path.join(runtime,ROUTINE_MOTION_CONSENT_FILENAME),JSON.stringify(consent,null,2));console.log(JSON.stringify({id:consent.id,until:consent.until,scope:consent.scope}));
 }else if(action==='inspect'){
  if(!phase||input)throw Error('inspect camera-metadata.json');
  const value=JSON.parse(await fs.readFile(path.resolve(phase),'utf8'));
  const staged=await stageWaveCameraProof({runtime,proof:cameraProof(value),submit:async()=>({accepted:true})});
  console.log(JSON.stringify({metadataStagedAndVerified:staged.staged,metadataSHA256:staged.metadataSha256,commandSubmitted:false,physicalMovementVerified:false}));
 }else if(action==='stage'){
  if(!['first','return','recovery','resume'].includes(phase)||!input)throw Error('stage first|return|recovery|resume camera-metadata.json');
  const authorization=JSON.parse(await fs.readFile(authFile)),consent=await existingConsent(runtime);
  if((consent||authorization.routineConsentId)&&(!consent||authorization.routineConsentId!==consent.id||Date.parse(authorization.until)>Date.parse(consent.until)))throw Error('Action window does not bind current standing consent');
   const history=JSON.parse(await fs.readFile(path.join(runtime,'movement-history.json'))),proof=cameraProof(JSON.parse(await fs.readFile(path.resolve(input))));
  const prepare=async({cameraObservation})=>{
  // Issuance precedes this inspection; no image is persisted by this helper.
  const sourceHashes=Object.fromEntries(await Promise.all(DRAMATIC_WAVE_REQUIRED_SOURCE_HASHES.map(async f=>[f,digest(await fs.readFile(path.join(root,f)))]))),review=phase==='recovery'?createRecoveryWaveReview({history,sourceHashes,authorization,proof}):createWaveReview({history,sourceHashes,authorization,ordinal:phase==='return'?2:1,resumeOnly:phase==='resume',cameraObservation}),bytes=JSON.stringify(review,null,2),hash=digest(bytes),file='evidence/dramatic-wave-'+hash.slice(0,16)+'.json',p=JSON.parse(await fs.readFile(path.join(runtime,'commissioning/motion.json')));
  p.finiteElbowGesture=DRAMATIC_WAVE_SCOPE;p.completionMode='shadow';p.physicalDeadlineAt=authorization.until;p.reviewedAt=review.reviewedAt;delete p.evidence.elbowPoseRecovery;
  for(const k of ['geometryAndTool','powerAndMount','speedAndStop','finiteElbowGestureReview'])p.evidence[k]={accepted:true,file,sha256:hash};
  const candidate={reviewFile:file,reviewSHA256:hash,profile:p};await fs.writeFile(path.join(runtime,'commissioning',file),bytes);await fs.writeFile(path.join(runtime,'wave-now-candidate.json'),JSON.stringify(candidate,null,2));if(phase==='recovery'||phase==='resume')await fs.writeFile(path.join(runtime,'wave-now-return-recovery-request.json'),JSON.stringify({seconds:90,moves:[{joint:'elbow',degrees:(review.desiredTick-review.startTick)*SERVO_STEP*180/Math.PI}],inspection:{stationary:true,noContact:true,cablesSlack:true,noUnusualNoise:true},confirmations:{baseSecured:true,sweep300mmClear:true,cablesSlack:true,jawsClear:true,powerSwitchReady:true}},null,2));console.log(JSON.stringify({reviewFile:file,reviewSHA256:hash,ordinal:review.ordinal,recoveryOnly:review.recoveryOnly,deadlineAt:authorization.until,sourceFiles:Object.keys(sourceHashes).length}));return {accepted:true};};
  if(phase==='recovery')await prepare({cameraObservation:proof.cameraObservation});
  else await stageWaveCameraProof({runtime,proof,history,submit:prepare});
 }else if(action==='install'){
  const c=JSON.parse(await fs.readFile(path.join(runtime,'wave-now-candidate.json')));if(phase!==c.reviewSHA256)throw Error('Exact independently reviewed candidate hash required');
  const target=path.join(runtime,'commissioning/motion.json'),old=await fs.readFile(target);await fs.writeFile(path.join(runtime,'wave-now-prior-'+c.reviewSHA256.slice(0,16)+'.json'),old,{flag:'wx'});
  await atomicWrite(target,JSON.stringify(c.profile,null,2));try{await readMotionConfig(runtime);}catch(e){await atomicWrite(target,old);throw e;}console.log(JSON.stringify({installed:true,reviewSHA256:c.reviewSHA256}));
 }else if(action==='authorize'){
  const speedStepsPerSecond=Number(phase??20);if(![20,40].includes(speedStepsPerSecond)||input&&input!=='gesture')throw Error('Only reviewed 20 or 40 speed and optional gesture policy are available');const a=createWaveAuthorization({speedStepsPerSecond,gesture:input==='gesture',consent:await existingConsent(runtime)});await fs.writeFile(authFile,JSON.stringify(a,null,2));console.log(JSON.stringify(a));
 }else throw Error('Use consent instruction.json, authorize, inspect metadata.json, stage first|return metadata.json, or install reviewed-hash');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
