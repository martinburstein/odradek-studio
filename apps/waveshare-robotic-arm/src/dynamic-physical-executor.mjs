import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {compileHardwarePhysicalProgram} from './hardware-physical-program.mjs';
import {assertHealthyBridgeSample} from './hardware-bridge-feedback.mjs';
import {readDynamicHardwareAdmission,hardwareBridgeSourceFiles} from './hardware-bridge-admission.mjs';
import {dynamicMove} from './dynamic-moves.mjs';

const OWNER='melchior-pilot',TICKET=new WeakMap(),JOINTS=['base','shoulder','elbow','gripper'],MAX_COLLECT_MS=60000,MIN_COLLECT_MS=30000,MIN_COLLECT_SAMPLES=100,MAX_GAP_MS=500,MAX_TICKET_MS=300000;
const COMPILER_SOURCES=['src/dynamic-moves.mjs','src/motion-config.mjs','src/simulator.mjs','src/z-lift-actuators.mjs','src/training-envelope.mjs','src/safety.mjs','src/dynamic-physical-program.mjs','src/hardware-physical-program.mjs','src/reference-pose-return.mjs','src/shoulder-clearance.mjs'];
const ALL_SOURCE_FILES=()=>[...new Set([...hardwareBridgeSourceFiles(),...COMPILER_SOURCES])];
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash=value=>createHash('sha256').update(value).digest('hex');
const delayWithSignal=(ms,signal)=>delay(ms,undefined,{signal});
const ticksClose=(a,b,n=1)=>JOINTS.every(k=>Math.abs(a[k]-b[k])<=n);
const freshAdmission=async(readAdmission,controller,name,now)=>{
 const value=await readAdmission({controller,name,now});
 if(!value||typeof value!=='object'||typeof value.buildId!=='string'||typeof value.reviewId!=='string'||typeof value.consentId!=='string'||!Number.isFinite(value.until)||value.until<=now||!value.sourceHashes||typeof value.sourceHashes!=='object'||typeof value.configDigest!=='string'||typeof value.admissionDigest!=='string')throw Error('Current installed hardware bridge admission required');
 return structuredClone(value);
};
function assertControllerReady(c){
 if(!c||c.mode!=='serial'||c.connected!==true||c.armed!==false||c.commissioned!==false||![null,OWNER].includes(c.owner)||c.busy||c.taskActive||c.lifecycle||c.stopping||c.outstanding?.size||c.recoveryFault||c.movement?.active||c.movement?.session||c.runner?.status?.().active)throw Error('A connected, disarmed, uncommissioned, idle private serial Controller is required');
 if(typeof c.transport?.bridgeRequest!=='function')throw Error('Typed hardware bridge transport is unavailable');
}
async function reserve(c,label){
 assertControllerReady(c);if(!c.claim)throw Error('Controller owner claim is unavailable');
 const ownedInternally=c.owner===null;
 if(ownedInternally){await c.claim(OWNER);if(c.owner!==OWNER)throw Error('Controller owner claim did not settle');}
 c.busy=true;c.taskActive=true;c.lifecycle=label;const abort=new AbortController();c.abort=abort;
 return {generation:c.generation,stopEpoch:c.stopEpoch,abort,ownedInternally};
}
async function releaseReservation(c,token,{disconnect=false}={}){
 if(c.abort===token.abort)c.abort=null;c.busy=false;c.taskActive=false;c.lifecycle=null;
 if(token.ownedInternally&&c.owner===OWNER)c.owner=null;
 if(disconnect&&token.ownedInternally&&c.connected){try{await c.disconnect();}catch{}}
}
async function currentHistory(c){
 const h=await c.movement.readyHistory();
 const prior=h.commands.at(-1);if(!prior||prior.state!=='complete'||prior.mode!=='serial'||prior.result?.outcome!=='telemetry-reached'||prior.result?.cleanupVerified!==true||prior.result?.requiresReconciliation===true||prior.result?.physicalMovementVerified===true)throw Error('Latest clean serial movement-history row required');
 return {history:h,row:structuredClone(prior),sha256:hash(JSON.stringify(prior))};
}
function normalizedSample(raw,buildId,now,previous,stationary=false){return assertHealthyBridgeSample(raw,{expectedBuildId:buildId,now,previous,stationary});}
function hashSources(files){return Object.fromEntries(files.map(file=>[file,hash(readFileSync(path.join(ROOT,file)))]));}
function sameHashes(left,right){return Object.entries(left??{}).every(([key,value])=>right?.[key]===value);}
function validateCameraProof(proof,predecessor,now,previous){
 const at=Date.parse(proof?.observedAt);
 if(!proof||typeof proof.sessionId!=='string'||!proof.sessionId.trim()||!Number.isInteger(proof.sequence)||proof.sequence<1||proof.fullSweepClear!==true||proof.frameSaved!==false||!Number.isFinite(at)||at>now||now-at>60000||proof.predecessorId!==predecessor.id||at<Date.parse(predecessor.finishedAt))throw Error('Fresh in-memory inspected camera proof bound to the immediate predecessor is required');
 if(previous&&previous.sessionId===proof.sessionId&&proof.sequence<=previous.sequence)throw Error('Camera sequence must increase within a session');
 return structuredClone(proof);
}
function assertLive(c,token,ticket,now=Date.now){
 if(c.generation!==token.generation||c.stopEpoch!==token.stopEpoch||token.abort.signal.aborted||c.mode!=='serial'||!c.connected||c.armed||c.commissioned||c.owner!==OWNER||!c.busy||!c.taskActive||c.lifecycle!=='dynamic-physical-execution'||ticket.expiresAt<=now())throw Error('Dynamic physical Controller admission changed');
}
async function verifyAdmission(readAdmission,c,name,ticket,now){
 const fresh=await freshAdmission(readAdmission,c,name,now());
 if(fresh.admissionDigest!==ticket.admission.admissionDigest||fresh.configDigest!==ticket.admission.configDigest||fresh.consentId!==ticket.admission.consentId||fresh.reviewId!==ticket.admission.reviewId||fresh.buildId!==ticket.admission.buildId||!sameHashes(fresh.sourceHashes,ticket.sourcePins))throw Error('Dynamic physical admission, consent, configuration or source changed');
 const actual=hashSources(ALL_SOURCE_FILES());if(!sameHashes(actual,ticket.sourcePins))throw Error('Dynamic physical source changed after qualification');
 return fresh;
}
function intentRow(program,leg,predecessor,now,ticket,camera){
 return {id:randomUUID(),mode:'serial',state:'intent',createdAt:new Date(now).toISOString(),plan:{experiment:'dynamic-named-hardware-bridge-v1',name:program.name,index:leg.index,joint:leg.move.joint,fromTicks:structuredClone(leg.fromTicks),targetTicks:structuredClone(leg.targetTicks),command:structuredClone(leg.command),predecessorId:predecessor.id,predecessorSHA256:hash(JSON.stringify(predecessor)),originalHistorySHA256:ticket.historyPin.sha256,programId:program.id,authorization:{sourceHashes:structuredClone(ticket.sourcePins),configDigest:ticket.admission.configDigest,admissionDigest:ticket.admission.admissionDigest,consentId:ticket.admission.consentId,reviewId:ticket.admission.reviewId,buildId:ticket.admission.buildId,bootId:ticket.bootId,authorizationUntil:ticket.admission.until},cameraProof:{observedAt:camera.observedAt,sequence:camera.sequence,sessionId:camera.sessionId,predecessorId:camera.predecessorId,fullSweepClear:camera.fullSweepClear,frameSaved:camera.frameSaved},dispatchAuthorized:true,physicalMovementVerified:false}};
}
function activePathCheck(sample,leg){
 const target=leg.targetTicks[leg.move.joint],from=leg.fromTicks[leg.move.joint],actual=sample.ticks[leg.move.joint],tol=0.0065/((Math.PI*2)/4096);
 if(actual<Math.min(from,target)-tol||actual>Math.max(from,target)+tol)throw Error('Active servo feedback left the compiled command path corridor');
}
function validateStepDispatch(reply,{command,leg,programId,buildId,bootId,previousSequence,previousAt,now}){
 const at=Date.parse(reply?.observedAt);
 if(reply?.T!==1011||reply?.buildId!==buildId||reply?.requestId!==command.requestId||reply?.programId!==programId||reply?.index!==leg.index||reply?.status!=='dispatched'||reply?.bootId!==bootId||!Number.isInteger(reply?.sequence)||reply.sequence<=previousSequence||!Number.isFinite(at)||at>now()||now()-at>500||at<previousAt)throw Error('Bridge T1011 did not confirm this exact fresh finite program step');
 return reply;
}
async function observeLeg(c,token,ticket,leg,now,wait,previousSample,gate){
 const sentAt=now(),observations=[];let previous=previousSample,arrived=false,dwellStart=null,dwellCount=0,dwellMinTicks=null,dwellMaxTicks=null,dwellMinServo13=0,dwellMaxServo13=0,qualifiedDwell=null;
 await wait(200,token.abort.signal);
 for(let index=0;index<100;index++){
  gate();if(index%2===0)await verifyAdmission(ticket.readAdmission,c,ticket.name,ticket,now);
  const sample=await query(c,token,ticket.admission.buildId,now,previous,false);previous=sample;
  const held=['base','shoulder','elbow','gripper'].filter(j=>j!==leg.move.joint);
  if(held.some(j=>Math.abs(sample.ticks[j]-leg.targetTicks[j])>1))throw Error(`Held ${held.find(j=>Math.abs(sample.ticks[j]-leg.targetTicks[j])>1)} axis drifted`);
  activePathCheck(sample,leg);
  if(Math.abs(sample.ticks[leg.move.joint]-leg.targetTicks[leg.move.joint])<=1)arrived=true;
  else if(arrived)throw Error('Active servo departed the target after one-tick arrival');
  const stationary=sample.servos.every(s=>s.moving===0);
  const servo13=sample.servos[2].encoderCount;
  if(qualifiedDwell){
   if(!stationary||JOINTS.some(j=>Math.abs(sample.ticks[j]-qualifiedDwell.ticks[j])>1)||Math.abs(servo13-qualifiedDwell.servo13)>1)throw Error('Qualified full-pose stationary dwell departed by more than one encoder tick');
   dwellCount++;
  }else if(stationary){
   if(!dwellStart){dwellStart=Date.parse(sample.observedAt);dwellCount=1;dwellMinTicks={...sample.ticks};dwellMaxTicks={...sample.ticks};dwellMinServo13=servo13;dwellMaxServo13=servo13;}
   else {
    const nextMin={...dwellMinTicks},nextMax={...dwellMaxTicks};
    for(const joint of JOINTS){nextMin[joint]=Math.min(nextMin[joint],sample.ticks[joint]);nextMax[joint]=Math.max(nextMax[joint],sample.ticks[joint]);}
    const nextMin13=Math.min(dwellMinServo13,servo13),nextMax13=Math.max(dwellMaxServo13,servo13);
    if(JOINTS.some(j=>nextMax[j]-nextMin[j]>1)||nextMax13-nextMin13>1){dwellStart=Date.parse(sample.observedAt);dwellCount=1;dwellMinTicks={...sample.ticks};dwellMaxTicks={...sample.ticks};dwellMinServo13=servo13;dwellMaxServo13=servo13;}
    else {dwellCount++;dwellMinTicks=nextMin;dwellMaxTicks=nextMax;dwellMinServo13=nextMin13;dwellMaxServo13=nextMax13;}
   }
   if(dwellCount>=9&&Date.parse(sample.observedAt)-dwellStart>=1600)qualifiedDwell={ticks:{...dwellMinTicks},servo13:dwellMinServo13};
  }else {dwellStart=null;dwellCount=0;dwellMinTicks=null;dwellMaxTicks=null;dwellMinServo13=0;dwellMaxServo13=0;}
  observations.push(structuredClone(sample));
  const elapsed=now()-sentAt,dwellMs=dwellStart?Date.parse(sample.observedAt)-dwellStart:0;
  if(elapsed>=12000&&arrived&&stationary&&qualifiedDwell&&dwellCount>=9&&dwellMs>=1600){
   return {observations,observed:structuredClone(sample.joints),observedTicks:structuredClone(sample.ticks),lastSample:structuredClone(sample),durationMs:Date.parse(sample.observedAt)-Date.parse(observations[0].observedAt),dwellMs,dwellSamples:dwellCount};
  }
  await wait(200,token.abort.signal);gate();if(index%2===1)await verifyAdmission(ticket.readAdmission,c,ticket.name,ticket,now);
 }
 throw Error('Named physical leg did not complete its bounded 12-second observation and stable dwell');
}
async function pauseBetween(c,token,ticket,milliseconds,now,wait,previousSample,gate){
 let remaining=milliseconds,previous=previousSample;
 while(remaining>0){
  gate();await verifyAdmission(ticket.readAdmission,c,ticket.name,ticket,now);
  const slice=Math.min(250,remaining),before=now();await wait(slice,token.abort.signal);remaining-=Math.max(slice,now()-before);
  gate();await verifyAdmission(ticket.readAdmission,c,ticket.name,ticket,now);
  const sample=await query(c,token,ticket.admission.buildId,now,previous,true);
  if(!ticksClose(previous.ticks,sample.ticks,1)||sample.servos.some(s=>s.moving!==0))throw Error('Servo drift or motion occurred during the reviewed between-leg pause');
  previous=sample;
 }
 return previous;
}
async function query(c,token,buildId,now,previous=null,stationary=true){
 if(c.generation!==token.generation||c.stopEpoch!==token.stopEpoch||token.abort.signal.aborted)throw Error('Dynamic hardware collection cancelled');
 const raw=await c.bounded(()=>c.transport.bridgeRequest({T:105,requestId:randomUUID()},{expectedBuildId:buildId,signal:token.abort.signal}),token.abort.signal);
 try{return normalizedSample(raw,buildId,now(),previous,stationary);}catch(error){if(previous)throw Error(`${error.message} (prior=${previous.sequence}/${previous.observedAt}, sample=${raw?.sequence}/${raw?.observedAt}, boot=${raw?.bootId===previous.bootId})`);throw error;}
}

/** Qualify a stable, source-bound five-servo baseline and return an opaque one-use ticket. */
export async function collectDynamicPhysicalStart({controller,name,now=Date.now,wait=delayWithSignal,readAdmission=readDynamicHardwareAdmission}={}){
 let known=name==='reference-return';if(!known)try{known=Boolean(dynamicMove(name));}catch{known=false;}
 if(typeof now!=='function'||typeof wait!=='function'||!known)throw Error('Known named routine and monotone time/wait functions required');
 assertControllerReady(controller);
 const start=await reserve(controller,'dynamic-physical-qualification');let token=start,started=now(),samples=[],historyPin,sourcePins;
 try{
  const admission=await freshAdmission(readAdmission,controller,name,now());
  historyPin=await currentHistory(controller);
  sourcePins=hashSources(ALL_SOURCE_FILES());
  if(!sameHashes(admission.sourceHashes,sourcePins))throw Error('Hardware bridge source changed during admission');
  let previous=null,previousClock=started,sampleCount=0;
  while(now()-started<MAX_COLLECT_MS){
   if(sampleCount++>=201)throw Error('Five-servo start collector reached its finite sample cap');
   const sample=await query(controller,token,admission.buildId,now,previous,true);
   if(sample.servos.some(servo=>servo.moving!==0))throw Error('Five-servo start is not stationary');
   samples.push(structuredClone(sample));previous=sample;
   if(now()-started>=MIN_COLLECT_MS&&samples.length>=MIN_COLLECT_SAMPLES)break;
   await wait(300,token.abort.signal);
   const clockNow=now();if(clockNow-previousClock<300)throw Error('Start qualification clock or bounded wait failed to advance monotonically');previousClock=clockNow;
   const during=await freshAdmission(readAdmission,controller,name,now());
   if(during.admissionDigest!==admission.admissionDigest||during.consentId!==admission.consentId||during.configDigest!==admission.configDigest||!sameHashes(during.sourceHashes,sourcePins)||!sameHashes(hashSources(ALL_SOURCE_FILES()),sourcePins))throw Error('Consent, configuration or hardware source changed during start qualification');
   const currentHistoryPin=await currentHistory(controller);if(currentHistoryPin.sha256!==historyPin.sha256)throw Error('Movement history changed during start qualification');
  }
  if(now()-started<MIN_COLLECT_MS||samples.length<MIN_COLLECT_SAMPLES)throw Error('Five-servo start qualification did not collect its minimum dwell and samples');
  for(let i=1;i<samples.length;i++){
   const elapsed=Date.parse(samples[i].observedAt)-Date.parse(samples[i-1].observedAt);
   if(elapsed<=0||elapsed>MAX_GAP_MS||samples[i].bootId!==samples[i-1].bootId||samples[i].sequence<=samples[i-1].sequence)throw Error('Five-servo start feedback chronology is interrupted');
  }
  for(let index=0;index<5;index++){const values=samples.map(sample=>sample.servos[index].encoderCount);if(Math.max(...values)-Math.min(...values)>1)throw Error(`Servo ID ${samples[0].servos[index].id} start span exceeds one encoder tick`);}
  const fresh=await freshAdmission(readAdmission,controller,name,now());
  if(fresh.admissionDigest!==admission.admissionDigest||fresh.configDigest!==admission.configDigest||fresh.consentId!==admission.consentId||fresh.reviewId!==admission.reviewId)throw Error('Hardware admission changed during start qualification');
  const historyAgain=await currentHistory(controller);if(historyAgain.sha256!==historyPin.sha256)throw Error('Movement history changed during start qualification');
  const sourceAgain=hashSources(ALL_SOURCE_FILES());
  if(!sameHashes(admission.sourceHashes,sourceAgain))throw Error('Hardware source changed during start qualification');
  const final=samples.at(-1),startPose={ticks:final.ticks,observedAt:Date.parse(final.observedAt),source:'T:1051',commandId:historyPin.row.id,historyRowSHA256:historyPin.sha256};
  const programSources={...admission.sourceHashes,...sourceAgain};
  const program=compileHardwarePhysicalProgram({name,start:startPose,sourceHashes:programSources,now:now()});
  const ticket={};TICKET.set(ticket,{controller,name,admission,readAdmission,historyPin,sourcePins:sourceAgain,bootId:final.bootId,sequence:final.sequence,baseline:structuredClone(final),program,expiresAt:Math.min(admission.until,now()+MAX_TICKET_MS),generation:start.generation,stopEpoch:start.stopEpoch,used:false});
  return ticket;
 }catch(error){token.abort.abort();await releaseReservation(controller,token,{disconnect:true});throw error;}
 finally{if(controller.owner===OWNER)await releaseReservation(controller,token);}
}

/** Execute an opaque qualified proposal through the existing Controller; this never establishes physical proof. */
export async function executeDynamicPhysicalProgram({controller,ticket,cameraForPredecessor,now=Date.now,wait=delayWithSignal,readAdmission=readDynamicHardwareAdmission}={}){
 const held=TICKET.get(ticket);if(!held||held.controller!==controller||held.used)throw Error('Exact unconsumed private dynamic-start ticket required');
 if(typeof now!=='function'||typeof wait!=='function'||typeof cameraForPredecessor!=='function')throw Error('Dynamic execution requires a live clock, bounded wait and per-predecessor camera inspection');
 held.used=true;
 if(now()>=held.expiresAt||controller.generation!==held.generation||controller.stopEpoch!==held.stopEpoch)throw Error('Dynamic start ticket expired or Controller epoch changed');
 assertControllerReady(controller);
 const token=await reserve(controller,'dynamic-physical-execution');let activeRow=null,history=null,programId=randomUUID(),grantSent=false,previousCamera=null,previousSample=held.baseline,rows=[];
 const gate=()=>assertLive(controller,token,held,now);
 const saveIntent=async row=>{
  gate();const onDisk=await controller.movement.history();if(hash(JSON.stringify(onDisk))!==hash(JSON.stringify(history)))throw Error('Movement history changed before intent persistence');
  history.commands.push(row);await controller.movement.save(history,()=>gate());activeRow=row;
 };
 const finalizeRow=async(result,error)=>{
  if(!activeRow)return;
  activeRow.finishedAt=new Date(now()).toISOString();activeRow.state=error?'blocked':'complete';
  const localCleanup=!error&&controller.outstanding.size===0;
  activeRow.result={...(result??{}),outcome:error?'uncertain':'telemetry-reached',error:error?.message??null,cleanupVerified:localCleanup,cleanupScope:'Controller bounded bridge requests settled; finite permit may remain for next named leg',requiresReconciliation:Boolean(error||!localCleanup),physicalMovementVerified:false,physicalStopVerified:false};
  if(!localCleanup)activeRow.state='blocked';
  await controller.movement.save(history);rows.push(structuredClone(activeRow));activeRow=null;
 };
 let finalResult=null,executionError=null,completedLegs=0,finalCleanupVerified=false,grantAttempted=false,bridgeSequence=held.sequence,bridgeBootId=held.bootId;
 try{
  history=(await controller.movement.readyHistory());
  const latest=history.commands.at(-1);if(!latest||latest.id!==held.historyPin.row.id||hash(JSON.stringify(latest))!==held.historyPin.sha256)throw Error('Clean predecessor movement-history row changed after qualification');
  for(const leg of held.program.legs){
   gate();
   const current=await controller.movement.readyHistory();if(hash(JSON.stringify(current))!==hash(JSON.stringify(history)))throw Error('Movement history changed before next dynamic leg');
   const predecessor=history.commands.at(-1),priorCamera=previousCamera;
   await verifyAdmission(readAdmission,controller,held.name,held,now);
   const camera=validateCameraProof(await cameraForPredecessor(structuredClone(predecessor)),predecessor,now(),priorCamera);previousCamera=camera;
   await verifyAdmission(readAdmission,controller,held.name,held,now);
   previousSample=await query(controller,token,held.admission.buildId,now,null,true);
   if(previousSample.bootId!==bridgeBootId||previousSample.sequence<=bridgeSequence||!ticksClose(previousSample.ticks,leg.fromTicks,1))throw Error('Fresh stationary five-servo start differs from the compiled immediate predecessor');
   bridgeSequence=Math.max(bridgeSequence,previousSample.sequence);
   const row=intentRow({...held.program,id:programId},leg,predecessor,now(),held,camera);
   const command={...structuredClone(leg.command),requestId:randomUUID()};
   row.plan.command=command;row.dispatchedAt=new Date(now()).toISOString();
   await saveIntent(row);
   if(!grantSent){
    gate();await verifyAdmission(readAdmission,controller,held.name,held,now);
    const grant={T:117,requestId:randomUUID(),programId,expectedBuildId:held.admission.buildId,ttlMs:Math.min(MAX_TICKET_MS,held.expiresAt-now()),steps:held.program.legs.map(item=>({joint:item.command.joint,tick:item.targetTicks[item.move.joint]}))};
    grantAttempted=true;
    const response=await controller.bounded(()=>controller.transport.bridgeRequest(grant,{expectedBuildId:held.admission.buildId,signal:token.abort.signal}),token.abort.signal);
    if(response?.T!==1171||response?.status!=='armed'||response?.programId!==programId||response?.requestId!==grant.requestId||response?.buildId!==held.admission.buildId||response?.bootId!==bridgeBootId||!Number.isInteger(response?.sequence)||response.sequence<=bridgeSequence||response.stepCount!==grant.steps.length||response.ttlMs!==grant.ttlMs)throw Error('Finite bridge permit was not confirmed for this exact program');grantSent=true;bridgeSequence=response.sequence;
   }
   gate();await verifyAdmission(readAdmission,controller,held.name,held,now);
   // The synchronous final gate runs in the same event-loop turn as the typed bridge request.
   row.dispatchedAt=new Date(now()).toISOString();await controller.movement.save(history,()=>gate());
   const dispatch=await controller.bounded(()=>{gate();validateCameraProof(camera,predecessor,now(),priorCamera);row.transportInvokedAt=new Date(now()).toISOString();return controller.transport.bridgeRequest(command,{expectedBuildId:held.admission.buildId,signal:token.abort.signal});},token.abort.signal);
   validateStepDispatch(dispatch,{command,leg,programId,buildId:held.admission.buildId,bootId:bridgeBootId,previousSequence:bridgeSequence,previousAt:Date.parse(previousSample.observedAt),now});bridgeSequence=dispatch.sequence;
   const dispatchPredecessor={...previousSample,sequence:dispatch.sequence,observedAt:dispatch.observedAt??previousSample.observedAt};
   const observation=await observeLeg(controller,token,held,leg,now,wait,dispatchPredecessor,gate);
   previousSample=observation.lastSample;bridgeSequence=Math.max(bridgeSequence,previousSample.sequence);
   const result={outcome:'telemetry-reached',receipt:'bound-T1011-bridge-dispatch',bridgeDispatch:{requestId:dispatch.requestId,bootId:dispatch.bootId,sequence:dispatch.sequence,index:dispatch.index,status:dispatch.status},dispatchedAt:row.dispatchedAt,observations:observation.observations,observed:observation.observed,observedTicks:observation.observedTicks,observationDurationMs:observation.durationMs,stableDwellMs:observation.dwellMs,stableDwellSamples:observation.dwellSamples,programId,physicalMovementVerified:false,physicalStopVerified:false};
   await finalizeRow(result,null);
   completedLegs++;
   history=await controller.movement.history();
   if(leg.pauseAfterMs){previousSample=await pauseBetween(controller,token,held,leg.pauseAfterMs,now,wait,previousSample,gate);bridgeSequence=Math.max(bridgeSequence,previousSample.sequence);}
  }
  const skippedJoints=held.name==='reference-return'?JOINTS.filter(joint=>held.program.legs.every(leg=>leg.move.joint!==joint)):[];
  finalResult={schema:'roarm-dynamic-physical-execution-v1',name:held.name,programId,status:'complete',plannedLegCount:held.program.finiteSession.legCount,completedLegCount:completedLegs,skippedNoOpJoints:skippedJoints,rows,observed:rows.at(-1)?.result?.observed,physicalMovementVerified:false,physicalStopVerified:false,cleanupVerified:false};
 }catch(error){
  if(activeRow){await finalizeRow({programId,grantSent,rows:rows.length},error).catch(()=>{});}
  executionError=error;
 }finally{
  token.abort.abort();await releaseReservation(controller,token);
  let stopped=null,status=null;try{stopped=await controller.stop('Dynamic hardware bridge run ended');if(token.ownedInternally)status=await controller.disconnect();}catch{}
  const allLegsCompleted=!executionError&&completedLegs===held.program.legs.length;
  const permitCleanupVerified=!grantAttempted||allLegsCompleted||stopped?.permitRevoked===true;
  finalCleanupVerified=stopped?.cleanupVerified===true&&permitCleanupVerified&&(!token.ownedInternally||status?.connected===false&&status?.execution?.cleanupPending===false&&!status?.execution?.recoveryRequired);
  try{
   const saved=await controller.movement.history(),programRows=saved.commands.filter(row=>row.plan?.programId===programId);
   for(const row of programRows){row.result.finalControllerCleanupVerified=finalCleanupVerified;row.result.permitRevocationVerified=stopped?.permitRevoked===true||allLegsCompleted;row.result.physicalMovementVerified=false;row.result.physicalStopVerified=false;}
   if((executionError||completedLegs!==held.program.legs.length||!finalCleanupVerified)&&programRows.length){
    const last=programRows.at(-1);last.state='blocked';last.result.requiresReconciliation=true;
    last.result.error=executionError?.message??(!finalCleanupVerified?'Final Controller stop or disconnect was not verified':'Named routine ended before its complete finite program');
    last.result.cleanupVerified=finalCleanupVerified;
   }
   await controller.movement.save(saved);
   rows.splice(0,rows.length,...programRows.map(row=>structuredClone(row)));
   if(finalResult){finalResult.rows=rows;finalResult.observed=rows.at(-1)?.result?.observed;finalResult.cleanupVerified=finalCleanupVerified;finalResult.permitRevocationVerified=stopped?.permitRevoked===true||allLegsCompleted;finalResult.controllerOwnershipRetained=!token.ownedInternally;finalResult.completedLegCount=completedLegs;
    if(!finalCleanupVerified)finalResult.status='blocked';if(executionError||completedLegs!==held.program.legs.length)finalResult.status='blocked';}
  }catch(error){if(!executionError)executionError=error;}
 }
 if(executionError)throw executionError;
 if(finalResult?.status!=='complete')throw Error('Dynamic physical program ended without a verified complete Controller result');
 return finalResult;
}

