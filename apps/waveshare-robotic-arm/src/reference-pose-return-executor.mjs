import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {validateReferenceStart} from './reference-pose-start.mjs';
import {assertCurrentWavePredecessor} from './current-wave-start.mjs';
import {planReferenceSequence,assertReferencePhysicalAdmission} from './reference-pose-return-control.mjs';
import {planReferenceLeg,validateReferenceFeedback,referenceArrived,REFERENCE_JOINT_ORDER,REFERENCE_RETURN_SCOPE,REFERENCE_TARGET_TICKS} from './reference-pose-return.mjs';
import {observedTicks,SERVO_STEP,assertLiftHealth} from './z-lift-actuators.mjs';
const OWNER='melchior-pilot',keys=REFERENCE_JOINT_ORDER;
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const bytesHash=x=>createHash('sha256').update(x).digest('hex');
const tickets=new WeakMap();
const configuration=c=>()=>fs.readFile(path.join(c.directory,'commissioning','motion.json'));
const iso=ms=>new Date(ms).toISOString();
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(x);
function inspection(value){if(!value||Object.keys(value).length!==4||!['stationary','noContact','cablesSlack','noUnusualNoise'].every(k=>value[k]===true))throw Error('Current physical inspection required');}
function idle(c){c.movement.setup(OWNER);if(c.mode!=='serial'||c.movement.session||c.movement.active)throw Error('Idle, uncommissioned serial Pilot Controller required');}
function live(c,ticket,gate,now){
 gate();c.assertOwner(OWNER);
 if(ticket.invalid||c.generation!==ticket.generation||c.stopEpoch!==ticket.stopEpoch||!c.connected||c.mode!=='serial'||c.armed||c.commissioned||c.movement.session||c.recoveryFault||now()>=ticket.until)throw Error('Recovery ticket cancelled, changed or expired');
}
function camera(value,prior,now){
 const at=Date.parse(value?.observedAt);
 if(!value||value.inspectedBy!=='root'||value.commandId!==prior.id||value.confirmedShowsArm!==true||value.fullSweepVisible!==true||value.visibleObstacles!==false||value.frameSaved!==false||!Number.isInteger(value.sequence)||value.sequence<1||typeof value.cameraSessionId!=='string'||!value.cameraSessionId||!Number.isFinite(at)||at>now||now-at>60000||at<Date.parse(prior.finishedAt))throw Error('Fresh unsaved root camera inspection bound to the immediate predecessor required');
}
async function sample(c,abort,observations,now){
 const pose=await c.movement.fresh(abort.signal),at=Date.parse(c.telemetryUpdatedAt),t=now();
 observedTicks(pose);assertLiftHealth(c.liftHealth);
 if(!Number.isFinite(at)||at>t||t-at>500||observations.length&&(at<=Date.parse(observations.at(-1).observedAt)||at-Date.parse(observations.at(-1).observedAt)>500))throw Error('Recovery telemetry stale, repeated or interrupted');
 const observation={source:'hardware',observedAt:c.telemetryUpdatedAt,joints:{...pose},health:{...c.liftHealth}};
 observations.push(observation);return observation;
}

// The internal hook supports independently tested transport fixtures. The fixed
// public Pilot integration supplies no hook and rejects uncommissioned hardware.
export async function collectReferencePoseStart({controller:c,history,sourceHashes,inspection:physicalInspection,consentId,gate,now=Date.now,wait=delay,readConfigBytes=configuration(c),assertHardwareReady=assertReferencePhysicalAdmission}={}){
 if(!c||typeof gate!=='function'||typeof assertHardwareReady!=='function')throw Error('Controller, admission gate and hardware readiness required');
 gate();await assertHardwareReady();inspection(physicalInspection);
 if(!uuid(consentId))throw Error('Current reference consent UUID required');
 const anchor=assertCurrentWavePredecessor(history,now());
 return c.withForeground(async()=>{
  idle(c);const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),40000),observations=[];
  const originalHistorySHA256=sha(history),startedAt=now();
  const ticket={controller:c,generation:c.generation,stopEpoch:c.stopEpoch,sourceSHA256:sha(sourceHashes),configDigest:null,originalHistorySHA256,historySHA256:originalHistorySHA256,consentId,anchor:structuredClone(anchor),nextIndex:0,seriesId:randomUUID(),until:startedAt+300000,hardwareGate:assertHardwareReady,invalid:false};
  c.busy=true;c.taskActive=true;c.lifecycle='reference-start-observation';c.abort=abort;
  const check=()=>{live(c,ticket,gate,now);if(abort.signal.aborted||now()-startedAt>40000)throw Error('Recovery start observation timed out');};
  try{
   const configDigest=bytesHash(await readConfigBytes());ticket.configDigest=configDigest;check();
   if(sha(await c.movement.readyHistory())!==originalHistorySHA256)throw Error('Recovery history changed before observation');
   do{
    check();await assertHardwareReady();const s=await sample(c,abort,observations,now);
    if(observations.some(previous=>keys.some(k=>Math.abs(previous.joints[k]-s.joints[k])>SERVO_STEP+1e-9)))throw Error('Arm moved during recovery qualification');
    if(observations.length>300)throw Error('Recovery qualification sample budget exceeded');
    if(observations.length<100||Date.parse(s.observedAt)-Date.parse(observations[0].observedAt)<30000)await wait(150,undefined,{signal:abort.signal});
   }while(observations.length<100||Date.parse(observations.at(-1).observedAt)-Date.parse(observations[0].observedAt)<30000);
   check();if(bytesHash(await readConfigBytes())!==configDigest||sha(await c.movement.readyHistory())!==originalHistorySHA256||sha(sourceHashes)!==ticket.sourceSHA256)throw Error('Recovery configuration, source or history changed');
   const proof={id:randomUUID(),revision:'reference-current-start-v1',cause:'unknown',noMotionCommandIssued:true,issuedAt:observations.at(-1).observedAt,consentId,configDigest,
    predecessorId:anchor.id,predecessorRowSHA256:sha(anchor),historySHA256:originalHistorySHA256,sourceHashesSHA256:ticket.sourceSHA256,
    inspection:{...physicalInspection},expectedStart:{...observations.at(-1).joints},observationCount:observations.length,observationDurationMs:Date.parse(observations.at(-1).observedAt)-Date.parse(observations[0].observedAt),observations};
   validateReferenceStart({proof,history,sourceHashes,consentId,configDigest,now:now()});
   const sequence=planReferenceSequence({start:proof.expectedStart});
   if(sequence.status==='BLOCKED')throw Error('Whole reference sequence blocked: '+sequence.blockers.map(b=>b.reason).join('; '));
   ticket.expectedPose={...proof.expectedStart};ticket.proofSHA256=sha(proof);tickets.set(proof,ticket);return proof;
  }finally{clearTimeout(timer);if(c.abort===abort)c.abort=null;c.busy=false;c.taskActive=false;c.lifecycle=null;}
 });
}

export async function executeReferencePoseLeg({controller:c,qualification,joint,sourceHashes,cameraObservation,inspection:physicalInspection,consentId,gate,now=Date.now,wait=delay,readConfigBytes=configuration(c),assertHardwareReady=assertReferencePhysicalAdmission,commandId=randomUUID()}={}){
 if(!c||typeof gate!=='function')throw Error('Controller and admission gate required');
 gate();await assertHardwareReady();inspection(physicalInspection);
 const ticket=tickets.get(qualification);
 if(!ticket||ticket.controller!==c||ticket.hardwareGate!==assertHardwareReady||ticket.consentId!==consentId||ticket.proofSHA256!==sha(qualification)||ticket.sourceSHA256!==sha(sourceHashes)||!uuid(commandId))throw Error('Private, unchanged recovery qualification required');
 if(!keys.includes(joint)||ticket.nextIndex>=keys.length||joint!==keys[ticket.nextIndex])throw Error('Only the next fixed reference joint may execute');
 return c.withForeground(async()=>{
  idle(c);live(c,ticket,gate,now);
  const history=await c.movement.readyHistory(),prior=history.commands.at(-1);
  if(sha(history)!==ticket.historySHA256||bytesHash(await readConfigBytes())!==ticket.configDigest)throw Error('Recovery history or configuration changed');
  if(history.commands.some(r=>r.id===commandId))throw Error('Recovery command UUID already consumed');
  camera(cameraObservation,prior,now());
  if(ticket.nextIndex===0){validateReferenceStart({proof:qualification,history,sourceHashes,consentId,configDigest:ticket.configDigest,now:now()});if(Date.parse(cameraObservation.observedAt)<Date.parse(qualification.observations.at(-1).observedAt))throw Error('Camera inspection must follow start qualification');}
  if(now()+16000>=ticket.until)throw Error('Insufficient bounded correction time remains');
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),18000),observations=[];let row,attempted=false,failure,cleanup,candidate=null,maxLaterDriftTicks=0;
  const check=async()=>{live(c,ticket,gate,now);if(abort.signal.aborted)throw Error('Recovery observation cancelled');await assertHardwareReady();if(sha(sourceHashes)!==ticket.sourceSHA256||bytesHash(await readConfigBytes())!==ticket.configDigest)throw Error('Recovery source or configuration changed');};
  c.busy=true;c.taskActive=true;c.lifecycle='reference-correction';c.movement.active=true;c.abort=abort;
  try{
   await check();const start=await c.movement.fresh(abort.signal),ticks=observedTicks(start),expected=observedTicks(ticket.expectedPose);
   if(keys.some(k=>Math.abs(ticks[k]-expected[k])>1))throw Error('Recovery start pose changed');
   const pure=planReferenceLeg({start,joint});if(pure.status==='BLOCKED')throw Error(pure.blockedReason);
   row={id:commandId,state:'intent',mode:'serial',owner:OWNER,issuedAt:iso(now()),configDigest:ticket.configDigest,
    plan:{...pure,experiment:REFERENCE_RETURN_SCOPE},noMotionCommandIssued:pure.noSend,delivery:null,
    referencePoseReturn:{scope:REFERENCE_RETURN_SCOPE,seriesId:ticket.seriesId,ordinal:ticket.nextIndex+1,maxLegs:4,consentId,referenceCommandId:ticket.anchor.id,referenceRowSHA256:sha(ticket.anchor),referenceTargetTicks:{...REFERENCE_TARGET_TICKS},sourceHashes:structuredClone(sourceHashes),sourceHashesSHA256:ticket.sourceSHA256,configDigest:ticket.configDigest,authorizationUntil:iso(ticket.until),predecessorId:prior.id,predecessorRowSHA256:sha(prior),...(ticket.nextIndex===0?{stationaryStart:structuredClone(qualification)}:{})}};
   history.commands.push(row);
   await c.movement.save(history);ticket.historySHA256=sha(history);
   await check();if(sha(await c.movement.history())!==ticket.historySHA256)throw Error('Persisted intent changed before dispatch');
   camera(cameraObservation,prior,now());
   row.dispatchedAt=iso(now());row.plan.dispatchedAt=row.dispatchedAt;
   // Persist the fixed command and observation start BEFORE touching transport.
   await c.movement.save(history);ticket.historySHA256=sha(history);
   await check();if(sha(await c.movement.history())!==ticket.historySHA256)throw Error('Persisted dispatch intent changed before position write');
   const dispatchGate=()=>{
    live(c,ticket,gate,now);
    if(abort.signal.aborted||sha(sourceHashes)!==ticket.sourceSHA256)throw Error('Dispatch source or cancellation changed');
    // Actual Movement persists to this fixed file. Validate synchronously in
    // the same callback that touches transport, after all asynchronous work.
    if(typeof c.movement.file==='string'){
     if(sha(JSON.parse(readFileSync(c.movement.file,'utf8')))!==ticket.historySHA256||bytesHash(readFileSync(path.join(c.directory,'commissioning','motion.json')))!==ticket.configDigest)throw Error('Persisted history or configuration changed at dispatch');
    }
   };
   if(!pure.noSend){attempted=true;row.delivery=await c.bounded(()=>{dispatchGate();return c.transport.send(pure.command,{signal:abort.signal});},abort.signal);}
   do{
    await check();const s=await sample(c,abort,observations,now);validateReferenceFeedback(s.joints,row.plan);
    const currentTicks=observedTicks(s.joints);
    if(candidate){
     const drift=Math.max(...keys.map(k=>Math.abs(currentTicks[k]-candidate.ticks[k])));
     maxLaterDriftTicks=Math.max(maxLaterDriftTicks,drift);
     if(drift>1)throw Error('Late departure after recovery settling candidate');
    }else if(Math.abs(currentTicks[joint]-row.plan.targetTicks[joint])<=1){
     const dwell=[];
     for(let i=observations.length-1;i>=0;i--){const previous=observations[i],t=observedTicks(previous.joints);if(Math.abs(t[joint]-row.plan.targetTicks[joint])>1||keys.some(k=>Math.abs(t[k]-currentTicks[k])>1))break;dwell.unshift(previous);}
     if(dwell.length>=9&&Date.parse(s.observedAt)-Date.parse(dwell[0].observedAt)>=1600&&keys.every(k=>Math.max(...dwell.map(x=>observedTicks(x.joints)[k]))-Math.min(...dwell.map(x=>observedTicks(x.joints)[k]))<=1))candidate={ticks:currentTicks,observed:{...s.joints},observedAt:s.observedAt};
    }
    if(observations.length>160)throw Error('Recovery observation sample budget exceeded');
    if(Date.parse(s.observedAt)-Date.parse(row.dispatchedAt)<12000)await wait(150,undefined,{signal:abort.signal});
   }while(Date.parse(observations.at(-1).observedAt)-Date.parse(row.dispatchedAt)<12000);
   referenceArrived(observations,row.plan,now());if(!candidate)throw Error('Recovery settling candidate not observed');await check();
  }catch(error){failure=error;ticket.invalid=true;}
  finally{
   clearTimeout(timer);abort.abort();c.busy=false;c.taskActive=false;c.lifecycle=null;c.movement.active=false;if(c.abort===abort)c.abort=null;
   try{cleanup=await c.stop('Reference correction leg ended; no automatic return',false,{trialCleanup:true});}catch(error){failure??=error;}
  }
  const cleanupVerified=cleanup?.cleanupVerified===true&&c.generation===ticket.generation+1&&c.stopEpoch===ticket.stopEpoch&&c.connected&&c.owner===OWNER&&!c.recoveryFault;
  if(!cleanupVerified){failure??=Error('Recovery cleanup or cancellation boundary unverified');ticket.invalid=true;}
  if(!row){ticket.invalid=true;throw failure??Error('Recovery failed before intent');}
  row.finishedAt=iso(now());row.state=failure?'blocked':'complete';
  const observed=observations.at(-1)?.joints??null;
  row.result={outcome:failure?'recovery-unverified':'telemetry-reached',error:failure?.message??null,attempted,observed,observations,requiresReconciliation:!!failure,cleanupVerified,
   physicalMovementVerified:false,physicalStopVerified:false,completion:{mode:'shadow',candidate:candidate?{observed:candidate.observed,observedAt:candidate.observedAt}:null,lateDeparture:maxLaterDriftTicks>1,maxLaterDriftTicks}};
  if(!failure&&ticket.nextIndex===3)row.referencePoseReturn.complete=true;
  try{
   if(sha(await c.movement.history())!==ticket.historySHA256)throw Error('Recovery intent changed before completion persistence');
   await c.movement.save(history);
  }catch(error){ticket.invalid=true;throw error;}
  c.movement.result=structuredClone(row);
  if(failure)throw failure;
  ticket.generation=c.generation;ticket.expectedPose={...observed};ticket.historySHA256=sha(history);ticket.nextIndex++;
  return row;
 });
}
