import {GUARDED_ELBOW_POLICY} from './guarded-elbow-trajectory.mjs';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createWaveAuthorization,createWaveReview} from '../tools/prepare-wave-now.mjs';
import {DRAMATIC_WAVE_SCOPE,DRAMATIC_WAVE_REQUIRED_SOURCE_HASHES,validateDramaticWaveAdmission} from './dramatic-wave.mjs';
import {readMotionConfig} from './motion-config.mjs';
import {SERVO_STEP} from './z-lift-actuators.mjs';
import {collectWaveStationaryStart,collectWaveResetStart} from './wave-stationary-start.mjs';
import {collectCurrentWaveStart} from './current-wave-start.mjs';
import {assertReferencePhysicalAdmission} from './reference-pose-return-control.mjs';

const OWNER='melchior-pilot';
const INSPECTION_KEYS=Object.freeze(['stationary','noContact','cablesSlack','noUnusualNoise']);
const CAMERA_MAX_AGE_MS=60000;
const digest=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const isoMs=value=>Number.isFinite(Date.parse(value))?Date.parse(value):NaN;
const cleanRecord=(row)=>row?.mode==='serial'&&row.state==='complete'&&row.result?.outcome==='telemetry-reached'&&row.result?.cleanupVerified===true&&row.result?.requiresReconciliation===false&&row.result?.completion?.mode==='shadow'&&row.result.completion?.candidate&&row.result.completion.lateDeparture===false;
function currentInspection(value){return !!value&&Object.keys(value).length===INSPECTION_KEYS.length&&INSPECTION_KEYS.every(key=>value[key]===true);}
function currentCamera(value,commandId,now){const at=isoMs(value?.observedAt);if(!value||value.inspectedBy!=='root'||value.confirmedShowsArm!==true||value.fullSweepVisible!==true||value.visibleObstacles!==false||value.frameSaved!==false||!Number.isInteger(value.sequence)||value.sequence<1||typeof value.cameraSessionId!=='string'||!value.cameraSessionId.trim()||!Number.isFinite(at)||at>now||now-at>CAMERA_MAX_AGE_MS||typeof commandId!=='string'||!commandId||value.commandId!==commandId)throw Error('Fresh root-inspected camera proof of the unobstructed full sweep, bound to the current predecessor, is required');}
async function atomicWrite(file,bytes){const temporary=`${file}.${randomUUID()}.tmp`;try{await fs.writeFile(temporary,bytes,{flag:'wx'});await fs.rename(temporary,file);}finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}}
function sourceSnapshot(sourceRoot){const root=path.resolve(sourceRoot),hashes={};for(const relative of DRAMATIC_WAVE_REQUIRED_SOURCE_HASHES){const file=path.resolve(root,relative);if(!file.startsWith(root+path.sep))throw Error('Wave source path escaped its source root');hashes[relative]=digest(readFileSync(file));}return Object.freeze(hashes);}

export function createPilotControl({controller,directory=controller?.directory,sourceRoot,claim,release,beginTask=()=>{},endTask=()=>{},now=Date.now,readConsent,prepare,execute,lifecycleObserver}={}){
 if(!controller||!directory||!sourceRoot||typeof claim!=='function'||typeof release!=='function')throw Error('Pilot control requires Controller, runtime/source roots and owner claim/release callbacks');
 if(lifecycleObserver!==undefined&&typeof lifecycleObserver?.wrap!=='function')throw Error('Pilot lifecycle observer requires a wrap function');
 const prepareOperation=lifecycleObserver?lifecycleObserver.wrap('prepare',prepare??defaultPrepare):prepare??defaultPrepare;
 const executeOperation=lifecycleObserver?lifecycleObserver.wrap('dispatch',execute??defaultExecute):execute??defaultExecute;
 const frozenSources=sourceSnapshot(sourceRoot),usedIds=new Set();let current=null,pendingDown=null,stationaryQualification=null,resetQualification=null,currentQualification=null,epoch=0;
 const view=()=>{const measured=controller.measured?{...controller.measured}:null,measuredAt=controller.telemetryUpdatedAt??null,age=measuredAt?Math.max(0,now()-Date.parse(measuredAt)):null,elbowTick=Number.isFinite(measured?.elbow)?Math.round((Math.PI/2+measured.elbow)/SERVO_STEP):null;return {job:current?structuredClone(current):null,measured,measuredAt,measuredAgeMs:Number.isFinite(age)?age:null,source:controller.mode==='serial'&&measured?'controller-telemetry':null,rawDegrees:Number.isFinite(measured?.elbow)?measured.elbow*180/Math.PI:null,elbowTick,elbowErrorTicks:elbowTick!==null&&Number.isInteger(current?.target?.desiredTick)?elbowTick-current.target.desiredTick:null,connected:controller.connected===true,armed:controller.armed===true,busy:controller.busy===true,stopEpoch:controller.stopEpoch,sourceHashes:{...frozenSources}};};
 const assertSources=()=>{for(const [relative,expected] of Object.entries(frozenSources)){if(digest(readFileSync(path.resolve(sourceRoot,relative)))!==expected)throw Error(`Frozen wave source changed: ${relative}`);}};
 const setPhase=(job,phase,extra={})=>{if(current?.id===job.id)current={...current,phase,...extra,updatedAt:new Date(now()).toISOString()};};
 async function currentSourceReview(){
  const review=JSON.parse(await fs.readFile(path.join(directory,'current-wave-start-independent-review.json'),'utf8'));
  if(review.revision!=='current-wave-start-source-review-v1'||review.verdict!=='pass'||typeof review.reviewedBy!=='string'||!review.reviewedBy.startsWith('Independent ')||!Number.isFinite(Date.parse(review.reviewedAt))||Date.parse(review.reviewedAt)>now()||now()-Date.parse(review.reviewedAt)>3600000||digest(review.sourceHashes)!==review.sourceCapsuleSHA256||JSON.stringify(review.sourceHashes)!==JSON.stringify(frozenSources))throw Error('Exact fresh independent current-start source review required');
  assertSources();return review;
 }
 async function defaultPrepare(input){
  const {command,ordinal,authorization,authorizationOverride,cameraObservation,inspection,context}=input;
  context.admit();assertSources();if(!readConsent)throw Error('Standing wave consent reader is required');const consent=await readConsent();
  const history=await controller.movement.readyHistory(),predecessor=history.commands.at(-1);currentCamera(cameraObservation,predecessor?.id,now());
  const sourceHashes={...frozenSources};
  const stationaryStart=input.currentStart??input.resetStart??(input.resumeOnly?stationaryQualification:null);
  if(stationaryStart&&Date.parse(cameraObservation.observedAt)<Date.parse(stationaryStart.observations.at(-1).observedAt))throw Error('New root camera inspection after stationary qualification required');
  if(input.resetStart&&JSON.stringify(input.resetStart.resetAssertion)!==JSON.stringify(consent.resetAssertion))throw Error('Reset proof no longer binds current consent');
  if(command.trajectory&&consent.guardedElbowTrajectory!==GUARDED_ELBOW_POLICY.revision)throw Error('Explicit supervised trajectory consent required');
  const independent=command.trajectory||input.currentStart||ordinal===2&&predecessor.finiteElbowGesture?.currentPoseQualified?await currentSourceReview():null;
  const review=createWaveReview({...(command.trajectory?{guardedTrajectory:{...GUARDED_ELBOW_POLICY}}:{}),history,sourceHashes,authorization:authorizationOverride??authorization,ordinal,cameraObservation,resumeOnly:input.resumeOnly===true,stationaryStart,currentStart:!!input.currentStart,...(independent?{independentlyReviewedBy:independent.reviewedBy}:{}),resetOnly:!!input.resetStart,resetAssertion:input.resetStart?consent.resetAssertion:undefined,now:now()});
  const admission=validateDramaticWaveAdmission({review,sourceHashes,history,deadlineAt:review.deadlineAt,now:now(),ordinal:review.ordinal,seriesId:review.seriesId});
  const configFile=path.join(directory,'commissioning','motion.json'),oldConfig=await fs.readFile(configFile),profile=JSON.parse(oldConfig);
  if(stationaryStart&&digest(oldConfig)!==stationaryStart.configDigest)throw Error('Configuration changed after stationary qualification');
  profile.finiteElbowGesture=DRAMATIC_WAVE_SCOPE;profile.completionMode='shadow';profile.physicalDeadlineAt=review.deadlineAt;profile.reviewedAt=new Date(now()).toISOString();
  profile.evidence??={};
  const reviewBytes=JSON.stringify(review,null,2),reviewHash=digest(reviewBytes),evidenceFile=`evidence/dramatic-wave-${reviewHash.slice(0,16)}.json`,evidencePath=path.join(directory,'commissioning',evidenceFile);
  for(const key of ['geometryAndTool','powerAndMount','speedAndStop','finiteElbowGestureReview'])profile.evidence[key]={accepted:true,file:evidenceFile,sha256:reviewHash};
  const configBytes=JSON.stringify(profile,null,2);
  let evidenceInstalled=false,configInstalled=false;
  try{
   await fs.writeFile(evidencePath,reviewBytes,{flag:'wx'});evidenceInstalled=true;await atomicWrite(configFile,configBytes);configInstalled=true;
   const loaded=await readMotionConfig(directory);if(loaded.profile?.finiteElbowGesture!==DRAMATIC_WAVE_SCOPE||loaded.finiteElbowGestureReview?.oneShotId!==review.oneShotId)throw Error('Installed wave review did not reload exactly');
   return {review,admission,history,configDigest:loaded.digest,sourceHashes,consent,currentStart:input.currentStart,resetStart:input.resetStart,ordinal,authorization:authorizationOverride??authorization,sessionRequest:{owner:OWNER,seconds:90,moves:[{joint:'elbow',degrees:(admission.requestDegrees)}],inspection,confirmations:consent.confirmations},rollback:async()=>{if(configInstalled)await atomicWrite(configFile,oldConfig);if(evidenceInstalled)await fs.unlink(evidencePath).catch(()=>{});}};
  }catch(error){if(configInstalled)await atomicWrite(configFile,oldConfig).catch(()=>{});if(evidenceInstalled)await fs.unlink(evidencePath).catch(()=>{});throw error;}
 }
 async function defaultExecute(prepared,input){
  const gate=()=>{assertSources();input.context.admit();if(input.epoch!==epoch||controller.stopEpoch!==input.stopEpoch)throw Error('Pilot command was stopped or superseded');};
  return controller.withForeground(async()=>{
   if(prepared.resetStart||prepared.currentStart){
    const consent=await readConsent();
    if(consent.id!==prepared.consent.id||prepared.resetStart&&JSON.stringify(consent.resetAssertion)!==JSON.stringify(prepared.resetStart.resetAssertion))throw Error('Reset consent changed before dispatch');
    if((await readMotionConfig(directory)).digest!==prepared.configDigest)throw Error('Reset configuration changed before dispatch');
   }
   gate();const begun=await controller.movement.begin(prepared.sessionRequest,gate);input.markExecuting();
   gate();const row=await controller.movement.execute({owner:OWNER,sessionId:begun.session.id,index:0,commandId:input.commandId},gate);
   if(row.state!=='complete'||row.result?.outcome!=='telemetry-reached'||row.result?.cleanupVerified!==true||row.result?.requiresReconciliation!==false)throw Error('Pilot movement did not complete cleanly; stop and reconcile before continuing');
   return row;
  });
 }
 function schedule(job,input,command){setImmediate(()=>run(job,input,command).catch(()=>{}));}
 async function run(job,input,command){
  const myEpoch=input.pilotEpoch,stopEpoch=input.stopEpoch;let claimed=false,taskStarted=false,executionEntered=false,prepared=null,finalPhase='failed',finalDetails={error:'Pilot job did not finish'};
  const assertTicket=()=>{if(myEpoch!==epoch||controller.stopEpoch!==stopEpoch)throw Error('Pilot command was stopped or superseded');};
  const gate=()=>{assertTicket();assertSources();input.context.admit();};
  try{
   assertTicket();setPhase(job,'preparing');input.context.checkLive();assertSources();
   await claim(input.context);claimed=true;assertTicket();input.context.checkLive();await beginTask(command.trajectory?60000:55000);taskStarted=true;
   gate();
   const history=await controller.movement.readyHistory();currentCamera(input.cameraObservation,history.commands.at(-1)?.id,now());
   if(command.kind==='qualify'){
    if(pendingDown)throw Error('Stationary qualification cannot interrupt a pending wave');
    stationaryQualification=null;resetQualification=null;currentQualification=null;
    const consent=command.reset||command.current?await readConsent():null;
    if(command.current)await currentSourceReview();
    if(command.reset&&!consent.resetAssertion)throw Error('An explicit current user power-reset assertion is required');
    const proof=command.current?await collectCurrentWaveStart({controller,history,sourceHashes:frozenSources,inspection:input.inspection,consentId:consent.id,gate,now}):command.reset?await collectWaveResetStart({controller,history,sourceHashes:frozenSources,inspection:input.inspection,resetAssertion:consent.resetAssertion,gate,now}):await collectWaveStationaryStart({controller,history,sourceHashes:frozenSources,inspection:input.inspection,gate,now});
    gate();if(command.current){if((await readConsent()).id!==consent.id)throw Error('Consent changed during qualification');currentQualification=proof;}else if(command.reset){const currentConsent=await readConsent();if(JSON.stringify(currentConsent.resetAssertion)!==JSON.stringify(consent.resetAssertion))throw Error('Reset consent changed during qualification');resetQualification=proof;}else stationaryQualification=proof;
    finalPhase='complete';finalDetails={result:{qualificationId:proof.id,observationCount:proof.observationCount,observationDurationMs:proof.observationDurationMs,expectedStart:proof.expectedStart,noMotionCommandIssued:true,physicalMovementVerified:false}};return;
   }
   let ordinal=command.direction==='down'?1:pendingDown?2:1;
   let authorization,authorizationOverride,resumeOnly=false;
   if(command.direction==='down'){
    if(pendingDown)throw Error('Complete the pending up command before starting another wave');
    if(!readConsent)throw Error('Standing wave consent is unavailable');const consent=await readConsent();authorization=createWaveAuthorization({speedStepsPerSecond:command.speed,gesture:true,consent,now:Date.parse(input.cameraObservation.observedAt)});
   }else if(pendingDown){
    if(command.speed!==pendingDown.authorization.speedStepsPerSecond)throw Error('Up command speed must match its reviewed down command');ordinal=2;authorizationOverride=pendingDown.authorization;authorization=authorizationOverride;
   }else{
    const prior=history.commands.at(-1),meta=prior?.finiteElbowGesture;
    if(!cleanRecord(prior)||meta?.scope!==DRAMATIC_WAVE_SCOPE||meta.ordinal!==1||meta.desiredTick!==2389||!Number.isFinite(isoMs(meta.authorizationUntil))||isoMs(meta.authorizationUntil)>=now())throw Error('Pilot up command requires an in-process down phase, or an expired clean outward phase for resume-only review');
    if(!readConsent)throw Error('Standing wave consent is unavailable');const consent=await readConsent();authorization=createWaveAuthorization({speedStepsPerSecond:command.speed,gesture:true,consent,now:Date.parse(input.cameraObservation.observedAt)});resumeOnly=true;
   }
   gate();
   const prepInput={controller,directory,sourceRoot,command,ordinal,authorization,authorizationOverride,cameraObservation:input.cameraObservation,inspection:input.inspection,context:input.context,sourceHashes:frozenSources,now,resumeOnly};
   if(command.direction==='down'&&currentQualification){prepInput.currentStart=currentQualification;currentQualification=null;}
   if(command.direction==='down'&&resetQualification){prepInput.resetStart=resetQualification;resetQualification=null;}
   prepInput.history=history;gate();
   prepared=await prepareOperation(prepInput);
   if(resumeOnly)stationaryQualification=null;
   gate();
   const perform=executeOperation;
   const result=await perform(prepared,{controller,directory,commandId:job.id,command,cameraObservation:input.cameraObservation,inspection:input.inspection,context:input.context,job,epoch:myEpoch,stopEpoch,markExecuting:()=>{executionEntered=true;const desiredTick=prepared.admission?.desiredTick??prepared.review?.desiredTick??null,commandTick=prepared.admission?.commandTick??prepared.review?.commandTick??null;setPhase(job,'executing',{target:{desiredTick,commandTick,targetDesiredDegrees:Number.isInteger(desiredTick)?(desiredTick-1024)*360/4096:null,commandedDegrees:Number.isInteger(commandTick)?(commandTick-1024)*360/4096:null}});},assertLive:gate});
   if(result?.state!=='complete'||result.result?.outcome!=='telemetry-reached'||result.result?.cleanupVerified!==true||result.result?.requiresReconciliation!==false)throw Error('Pilot movement did not complete cleanly; stop and reconcile before continuing');
   if(myEpoch!==epoch)throw Error('Pilot command was stopped during movement');
   if(command.direction==='down')pendingDown={authorization:prepared.authorization??authorization,review:prepared.review??null,row:result};else pendingDown=null;
   finalPhase='complete';finalDetails={result:{id:result.id,outcome:result.result.outcome,physicalMovementVerified:false}};
  }catch(error){if(!executionEntered&&prepared?.rollback)await prepared.rollback().catch(()=>{});finalPhase=myEpoch!==epoch?'cancelled':'failed';finalDetails={error:error?.message??String(error)};}
  finally{
   if(current?.id===job.id&&!['complete','failed','cancelled'].includes(current.phase))setPhase(job,'releasing',{...(finalDetails.error?{error:finalDetails.error}:{})});
   let releaseError=null;
   if(claimed)try{await release(input.context);}catch(error){releaseError=error;}
   if(taskStarted)try{await endTask();}catch(error){releaseError??=error;}
   if(current?.id===job.id){if(releaseError){finalPhase='failed';finalDetails={error:`Owner/task release failed: ${releaseError.message}`};}setPhase(job,finalPhase,finalDetails);}
  }
 }
 function submit({commandId,command,cameraObservation,inspection},context){
  if(!uuid(commandId)||usedIds.has(commandId))throw Error('A unique, non-replayed command UUID is required');
  if(command?.kind==='reference'){
   if(Object.keys(command).length!==2||!(command.qualify===true||['base','shoulder','elbow','gripper'].includes(command.joint)))throw Error('Only fixed reference commands are supported');
   if(typeof context?.checkLive!=='function'||typeof context?.admit!=='function')throw Error('Authenticated live request context required');
   context.checkLive();
   // No claim, task, query, intent, or first-joint dispatch can precede this
   // uncommissioned whole-series gate. User consent cannot supply servo13 data.
   assertReferencePhysicalAdmission();
  }
  if(!command||!(command.kind==='qualify'&&(Object.keys(command).length===1||Object.keys(command).length===2&&(command.reset===true||command.current===true)))&&!(Object.keys(command).length===3&&command.kind==='move'&&['down','up'].includes(command.direction)&&[20,40].includes(command.speed))&&!(Object.keys(command).length===4&&command.kind==='move'&&command.direction==='down'&&command.speed===20&&command.trajectory===true))throw Error('Pilot accepts only QUALIFY [RESET|CURRENT] or move down|up at20|40 commands');
  if(current&&!['complete','failed','cancelled'].includes(current.phase))throw Error('Pilot already has one outstanding command; the queue is disabled');
  if(typeof context?.checkLive!=='function'||typeof context?.admit!=='function')throw Error('Authenticated live request context required');
  assertSources();
  currentCamera(cameraObservation,cameraObservation?.commandId,now());if(!currentInspection(inspection))throw Error('All four current physical inspection assertions are required');
  current={id:commandId,phase:'accepted',command:{...command},acceptedAt:new Date(now()).toISOString(),updatedAt:new Date(now()).toISOString(),target:null};usedIds.add(commandId);
  schedule(current,{context,cameraObservation:structuredClone(cameraObservation),inspection:structuredClone(inspection),stopEpoch:controller.stopEpoch,pilotEpoch:epoch},command);
  return {accepted:true,job:{...structuredClone(current),phase:'accepted'}};
 }
 function cancel(){epoch++;if(current&&!['complete','failed','cancelled'].includes(current.phase))setPhase(current,'releasing',{error:'Pilot command cancelled by software stop'});pendingDown=null;stationaryQualification=null;resetQualification=null;currentQualification=null;}
 return Object.freeze({submit,state:view,cancel,owner:OWNER});
}
