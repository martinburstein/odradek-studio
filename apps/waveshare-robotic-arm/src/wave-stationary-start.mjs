import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import {SERVO_STEP,observedTicks,assertLiftHealth} from './z-lift-actuators.mjs';
import {elbowFeedforwardGeometry} from './elbow-feedforward-geometry.mjs';
import {DRAMATIC_WAVE_GESTURE_COMPLETION,DRAMATIC_WAVE_GESTURE_COMPLETION_SHA256} from './dramatic-wave.mjs';

const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digestBytes=value=>createHash('sha256').update(value).digest('hex');
const joints=['base','shoulder','elbow','gripper'];
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const resetAssertionHash=value=>sha(value);

function validateResetAssertion(assertion,prior,now){
 if(!assertion||Object.keys(assertion).sort().join(',')!=='consentId,issuedAt,operatorAssertedReset,sourceInstruction'||assertion.operatorAssertedReset!==true||typeof assertion.sourceInstruction!=='string'||assertion.sourceInstruction.length<12||assertion.sourceInstruction.length>2000||typeof assertion.issuedAt!=='string'||!Number.isFinite(Date.parse(assertion.issuedAt))||new Date(assertion.issuedAt).toISOString()!==assertion.issuedAt||!uuid(assertion.consentId))throw Error('Exact user-asserted power-reset consent required');
 const issued=Date.parse(assertion.issuedAt),finished=Date.parse(prior?.finishedAt);
 if(!Number.isFinite(now)||issued>now||now-issued>3600000||!Number.isFinite(finished)||issued<=finished)throw Error('Power-reset assertion must be current and follow the predecessor');
 return true;
}

export function assertWaveResetPredecessor(history,resetAssertion,now=Date.now()){
 const rows=history?.commands,prior=rows?.at(-1);
 const completionMs=prior?.result?.completion?.observationDurationMs??prior?.result?.observationDurationMs,maxDrift=prior?.result?.completion?.maxLaterDriftTicks;
 if(!Array.isArray(rows)||!prior||prior.mode!=='serial'||prior.state!=='complete'||prior.result?.cleanupVerified!==true||prior.result?.requiresReconciliation!==false||prior.result?.outcome!=='telemetry-reached'||prior.result?.completion?.mode!=='shadow'||!prior.result.completion.candidate||prior.result.completion.lateDeparture!==false||!Number.isFinite(maxDrift)||maxDrift>1+1e-6||!Number.isFinite(completionMs)||completionMs<DRAMATIC_WAVE_GESTURE_COMPLETION.minimumObservationMs||!Array.isArray(prior.result?.observations)||prior.result.observations.length<DRAMATIC_WAVE_GESTURE_COMPLETION.minimumSamples||prior.result?.gestureArrival!==true||prior.plan?.movementJoint!=='elbow'||prior.finiteElbowGesture?.scope!=='camera-inspected-dramatic-wave-v1'||prior.finiteElbowGesture.ordinal!==1||prior.finiteElbowGesture.desiredTick!==2389||sha(prior.finiteElbowGesture.gestureCompletion)!==sha(DRAMATIC_WAVE_GESTURE_COMPLETION)||prior.finiteElbowGesture.gestureCompletionSHA256!==DRAMATIC_WAVE_GESTURE_COMPLETION_SHA256||!Number.isFinite(Date.parse(prior.finiteElbowGesture.authorizationUntil))||Date.parse(prior.finiteElbowGesture.authorizationUntil)>=now||Math.abs(observedTicks(prior.result.observed).elbow-2389)>DRAMATIC_WAVE_GESTURE_COMPLETION.endpointToleranceTicks)throw Error('Power-reset start requires the latest completed clean expressive outward phase');
 if(rows.slice(0,-1).some(row=>!(row.state==='complete'&&row.result?.cleanupVerified===true&&row.result?.requiresReconciliation!==true)&&!row.reconciliation&&!row.poseRecovery&&!row.resetRecovery))throw Error('Earlier failed movement requires its existing reconciliation or pose/reset recovery');
 validateResetAssertion(resetAssertion,prior,now);
 return prior;
}

function validateSamples(proof,prior,resetAssertion,now){
 const samples=proof?.observations;
 if(!Array.isArray(samples)||samples.length<100||samples.length>300)throw Error('At least 100 healthy stationary samples are required');
 const first=Date.parse(samples[0]?.observedAt),last=Date.parse(samples.at(-1)?.observedAt),start=samples.at(-1)?.joints;
 if(!Number.isFinite(first)||!Number.isFinite(last)||last-first<30000||now-last>60000||last>now||first<Date.parse(prior.finishedAt)||first<Date.parse(resetAssertion.issuedAt)||proof.observationDurationMs!==last-first||proof.observationCount!==samples.length||JSON.stringify(start)!==JSON.stringify(proof.expectedStart)||!['stationary','noContact','cablesSlack','noUnusualNoise'].every(k=>proof.inspection?.[k]===true))throw Error('Fresh thirty-second stationary observation after reset assertion and four-part inspection required');
 for(let i=0;i<samples.length;i++){
  const sample=samples[i],at=Date.parse(sample.observedAt);observedTicks(sample.joints);assertLiftHealth(sample.health);
  if(sample.source!=='hardware'||!Number.isFinite(at)||at>now||i&&(!(at>Date.parse(samples[i-1].observedAt))||at-Date.parse(samples[i-1].observedAt)>500)||joints.some(k=>Math.abs(sample.joints[k]-start[k])>SERVO_STEP+1e-9))throw Error('Stationary samples must be fresh, healthy, hardware sourced and stable');
 }
 if(joints.some(k=>Math.max(...samples.map(s=>s.joints[k]))-Math.min(...samples.map(s=>s.joints[k]))>SERVO_STEP+1e-9))throw Error('Stationary samples exceed one tick of full-span drift');
 return start;
}

export function validateWaveResetStart({proof,history,sourceHashes,resetAssertion,now=Date.now()}){
 const prior=assertWaveResetPredecessor(history,resetAssertion,now),samples=proof?.observations;
 if(!proof||proof.revision!=='operator-reset-stationary-start-v1'||proof.cause!=='operator-asserted-power-reset-cause-unverified'||proof.noMotionCommandIssued!==true||!/^[a-f0-9]{64}$/.test(proof.configDigest??'')||proof.predecessorId!==prior.id||proof.predecessorRowSHA256!==sha(prior)||proof.historySHA256!==sha(history)||proof.sourceHashesSHA256!==sha(sourceHashes)||proof.resetAssertionSHA256!==resetAssertionHash(resetAssertion)||sha(proof.resetAssertion)!==resetAssertionHash(resetAssertion)||!Array.isArray(samples))throw Error('Exact reset assertion, source and complete history bound proof required');
 const start=validateSamples(proof,prior,resetAssertion,now),ticks=observedTicks(start);
 if(ticks.elbow<2052||ticks.elbow>2389||Math.abs(ticks.elbow-2389)>360)throw Error('Reset start exceeds the unchanged elbow tick envelope');
 elbowFeedforwardGeometry({start,desiredTick:2052,commandTick:2034});
 elbowFeedforwardGeometry({start,desiredTick:2389,commandTick:2389});
 if(Math.abs(2034-ticks.elbow)>360)throw Error('Existing elbow command delta exceeds 360 ticks');
 return {...start};
}

// Read-only T105 observations through the shared Controller. No history edits,
// reset, correction, arming, or motion commands occur here.
export async function collectWaveResetStart({controller,history,sourceHashes,inspection,resetAssertion,gate,now=Date.now,wait=delay,readConfigBytes=()=>fs.readFile(path.join(controller.directory,'commissioning','motion.json'))}){
 assertWaveResetPredecessor(history,resetAssertion,now());
 return controller.withForeground(async()=>{
  const c=controller,generation=c.generation,abort=new AbortController(),timer=setTimeout(()=>abort.abort(),40000),observations=[];
  if(c.mode!=='serial'||!c.connected||c.armed||c.commissioned||c.busy||c.taskActive||c.movement.session||c.movement.active){clearTimeout(timer);throw Error('Stationary qualification requires an idle disarmed serial Controller');}
  c.busy=true;c.taskActive=true;c.abort=abort;c.lifecycle='stationary-wave-observation';
  const check=()=>{gate();if(abort.signal.aborted||c.generation!==generation||!c.connected||c.armed||c.commissioned||c.movement.session)throw Error('Stationary qualification cancelled');};
  try{
   const expectedHistory=sha(history),configBytes=await readConfigBytes(),configDigest=digestBytes(configBytes),profile=JSON.parse(configBytes);
   if(profile.finiteElbowGesture!=='camera-inspected-dramatic-wave-v1'||profile.completionMode!=='shadow')throw Error('Existing dramatic-wave shadow profile required for stationary qualification');
   do{
    check();const pose=await c.movement.fresh(abort.signal),at=Date.parse(c.telemetryUpdatedAt),current=now();
    if(!Number.isFinite(at)||at>current||current-at>500||observations.length&&(at<=Date.parse(observations.at(-1).observedAt)||at-Date.parse(observations.at(-1).observedAt)>500))throw Error('Stationary feedback stale or interrupted');
    observedTicks(pose);if(observations.some(s=>joints.some(k=>Math.abs(s.joints[k]-pose[k])>SERVO_STEP+1e-9)))throw Error('Arm moved during stationary qualification');
    observations.push({source:'hardware',observedAt:c.telemetryUpdatedAt,joints:pose,health:{...c.liftHealth}});
    if(observations.length>300)throw Error('Stationary qualification sample budget exceeded');
    if(observations.length<100||at-Date.parse(observations[0].observedAt)<30000)await wait(150,undefined,{signal:abort.signal});
   }while(observations.length<100||Date.parse(observations.at(-1).observedAt)-Date.parse(observations[0].observedAt)<30000);
   check();if(sha(await c.movement.readyHistory())!==expectedHistory||digestBytes(await readConfigBytes())!==configDigest)throw Error('Stationary history or configuration changed');
   const proof={id:randomUUID(),revision:'operator-reset-stationary-start-v1',cause:'operator-asserted-power-reset-cause-unverified',noMotionCommandIssued:true,predecessorId:history.commands.at(-1).id,predecessorRowSHA256:sha(history.commands.at(-1)),historySHA256:expectedHistory,sourceHashesSHA256:sha(sourceHashes),resetAssertion:{...resetAssertion},resetAssertionSHA256:resetAssertionHash(resetAssertion),configDigest,inspection:{...inspection},expectedStart:{...observations.at(-1).joints},observationDurationMs:Date.parse(observations.at(-1).observedAt)-Date.parse(observations[0].observedAt),observationCount:observations.length,observations};
   validateWaveResetStart({proof,history,sourceHashes,resetAssertion,now:now()});check();return proof;
  }finally{clearTimeout(timer);if(c.abort===abort)c.abort=null;c.busy=false;c.taskActive=false;c.lifecycle=null;}
 });
}

// Legacy resume qualification remains available and unchanged.
export function assertWaveStationaryPredecessor(history,now=Date.now()){
 const prior=history?.commands?.at(-1);
 if(prior?.mode!=='serial'||prior.state!=='complete'||prior.result?.cleanupVerified!==true||prior.result.requiresReconciliation!==false||prior.result.outcome!=='telemetry-reached'||prior.result.completion?.mode!=='shadow'||!prior.result.completion.candidate||prior.result.completion.lateDeparture!==false||prior.finiteElbowGesture?.scope!=='camera-inspected-dramatic-wave-v1'||prior.finiteElbowGesture.ordinal!==1||prior.finiteElbowGesture.desiredTick!==2389||!Number.isFinite(Date.parse(prior.finiteElbowGesture.authorizationUntil))||Date.parse(prior.finiteElbowGesture.authorizationUntil)>=now||Math.abs(observedTicks(prior.result.observed).elbow-2389)>4)throw Error('Stationary start requires an expired clean outward phase');
 return prior;
}
export function validateWaveStationaryStart({proof,history,sourceHashes,now=Date.now()}){
 const prior=history?.commands?.at(-1),samples=proof?.observations;
 if(!proof||proof.revision!=='clean-outward-stationary-start-v1'||proof.cause!=='unknown'||proof.noMotionCommandIssued!==true||!/^[a-f0-9]{64}$/.test(proof.configDigest??'')||proof.predecessorId!==prior?.id||proof.predecessorRowSHA256!==sha(prior)||proof.historySHA256!==sha(history)||proof.sourceHashesSHA256!==sha(sourceHashes)||!Array.isArray(samples)||samples.length<100||samples.length>300)throw Error('Exact source/history-bound stationary start proof required');
 assertWaveStationaryPredecessor(history,now);
 const start=samples.at(-1)?.joints,first=Date.parse(samples[0]?.observedAt),last=Date.parse(samples.at(-1)?.observedAt);
 if(!Number.isFinite(first)||!Number.isFinite(last)||last-first<30000||now-last>60000||last>now||first<Date.parse(prior.finishedAt)||proof.observationDurationMs!==last-first||proof.observationCount!==samples.length||JSON.stringify(start)!==JSON.stringify(proof.expectedStart)||!['stationary','noContact','cablesSlack','noUnusualNoise'].every(k=>proof.inspection?.[k]===true))throw Error('Fresh thirty-second stationary observation and inspection required');
 for(let i=0;i<samples.length;i++){
  const sample=samples[i],at=Date.parse(sample.observedAt);observedTicks(sample.joints);assertLiftHealth(sample.health);
  if(sample.source!=='hardware'||!Number.isFinite(at)||at>now||i&&(!(at>Date.parse(samples[i-1].observedAt))||at-Date.parse(samples[i-1].observedAt)>500)||joints.some(k=>Math.abs(sample.joints[k]-start[k])>SERVO_STEP+1e-9))throw Error('Stationary samples must be fresh, healthy, hardware sourced and stable');
 }
 if(joints.some(k=>Math.max(...samples.map(s=>s.joints[k]))-Math.min(...samples.map(s=>s.joints[k]))>SERVO_STEP+1e-9)||Math.abs(start.base-prior.result.observed.base)>4*SERVO_STEP+1e-9||['shoulder','gripper'].some(k=>Math.abs(start[k]-prior.result.observed[k])>SERVO_STEP+1e-9)||Math.abs(observedTicks(start).elbow-2389)>4)throw Error('Stationary start exceeds the narrow unchanged endpoint envelope');
 elbowFeedforwardGeometry({start,desiredTick:2052,commandTick:2034});
 return {...start};
}
export async function collectWaveStationaryStart({controller,history,sourceHashes,inspection,gate,now=Date.now,wait=delay,readConfigBytes=()=>fs.readFile(path.join(controller.directory,'commissioning','motion.json'))}){
 assertWaveStationaryPredecessor(history,now());
 return controller.withForeground(async()=>{
  const c=controller,generation=c.generation,abort=new AbortController(),timer=setTimeout(()=>abort.abort(),40000),observations=[];
  if(c.mode!=='serial'||!c.connected||c.armed||c.commissioned||c.busy||c.taskActive||c.movement.session||c.movement.active){clearTimeout(timer);throw Error('Stationary qualification requires an idle disarmed serial Controller');}
  c.busy=true;c.taskActive=true;c.abort=abort;c.lifecycle='stationary-wave-observation';
  const check=()=>{gate();if(abort.signal.aborted||c.generation!==generation||!c.connected||c.armed||c.commissioned||c.movement.session)throw Error('Stationary qualification cancelled');};
  try{
   const expectedHistory=sha(history),configBytes=await readConfigBytes(),configDigest=createHash('sha256').update(configBytes).digest('hex'),profile=JSON.parse(configBytes);
   if(profile.finiteElbowGesture!=='camera-inspected-dramatic-wave-v1'||profile.completionMode!=='shadow')throw Error('Existing dramatic-wave shadow profile required for stationary qualification');
   do{
    check();const pose=await c.movement.fresh(abort.signal),at=Date.parse(c.telemetryUpdatedAt);
    if(!Number.isFinite(at)||at>now()||now()-at>500||observations.length&&(at<=Date.parse(observations.at(-1).observedAt)||at-Date.parse(observations.at(-1).observedAt)>500))throw Error('Stationary feedback stale or interrupted');
    observedTicks(pose);if(observations.some(s=>joints.some(k=>Math.abs(s.joints[k]-pose[k])>SERVO_STEP+1e-9)))throw Error('Arm moved during stationary qualification');
    observations.push({source:'hardware',observedAt:c.telemetryUpdatedAt,joints:pose,health:{...c.liftHealth}});
    if(observations.length>300)throw Error('Stationary qualification sample budget exceeded');
    if(observations.length<100||at-Date.parse(observations[0].observedAt)<30000)await wait(150,undefined,{signal:abort.signal});
   }while(observations.length<100||Date.parse(observations.at(-1).observedAt)-Date.parse(observations[0].observedAt)<30000);
   check();if(sha(await c.movement.readyHistory())!==expectedHistory||createHash('sha256').update(await readConfigBytes()).digest('hex')!==configDigest)throw Error('Stationary history or configuration changed');
   const proof={id:randomUUID(),revision:'clean-outward-stationary-start-v1',cause:'unknown',noMotionCommandIssued:true,predecessorId:history.commands.at(-1).id,predecessorRowSHA256:sha(history.commands.at(-1)),historySHA256:expectedHistory,sourceHashesSHA256:sha(sourceHashes),configDigest,inspection:{...inspection},expectedStart:{...observations.at(-1).joints},observationDurationMs:Date.parse(observations.at(-1).observedAt)-Date.parse(observations[0].observedAt),observationCount:observations.length,observations};
   validateWaveStationaryStart({proof,history,sourceHashes,now:now()});check();return proof;
  }finally{clearTimeout(timer);if(c.abort===abort)c.abort=null;c.busy=false;c.taskActive=false;c.lifecycle=null;}
 });
}
