// A separate, read-only start proof. It never rewrites a movement receipt.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {observedTicks,SERVO_STEP,assertLiftHealth} from './z-lift-actuators.mjs';
import {elbowFeedforwardGeometry} from './elbow-feedforward-geometry.mjs';
const keys=['base','shoulder','elbow','gripper'];
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const bytesHash=x=>createHash('sha256').update(x).digest('hex');
const clean=r=>r?.mode==='serial'&&r.state==='complete'&&r.result?.outcome==='telemetry-reached'&&r.result.cleanupVerified===true&&r.result.requiresReconciliation===false;

export function assertCurrentWavePredecessor(history,now=Date.now()){
 const rows=history?.commands,p=rows?.at(-1),m=p?.finiteElbowGesture;
 if(!Array.isArray(rows)||!clean(p)||m?.scope!=='camera-inspected-dramatic-wave-v1'||m.ordinal!==2||m.desiredTick!==2052||p.plan?.movementJoint!=='elbow'||p.result.completion?.mode!=='shadow'||!p.result.completion.candidate||p.result.completion.lateDeparture!==false||!Number.isFinite(p.result.completion.maxLaterDriftTicks)||p.result.completion.maxLaterDriftTicks>1+1e-6||!Number.isFinite(Date.parse(m.authorizationUntil))||Date.parse(m.authorizationUntil)>=now||Math.abs(observedTicks(p.result.observed).elbow-2052)>4)throw Error('Current-start qualification requires the latest expired clean horizontal return');
 if(rows.slice(0,-1).some(r=>!(r.state==='complete'&&r.result?.cleanupVerified===true&&r.result?.requiresReconciliation!==true)&&!r.reconciliation&&!r.poseRecovery&&!r.resetRecovery))throw Error('Unresolved historical movement blocks current-start qualification');
 return p;
}
export function validateCurrentWaveStart({proof,history,sourceHashes,consentId,now=Date.now()}){
 const prior=assertCurrentWavePredecessor(history,now),samples=proof?.observations;
 if(!proof||proof.revision!=='clean-horizontal-current-start-v1'||proof.cause!=='unknown'||proof.noMotionCommandIssued!==true||!proof.id||proof.consentId!==consentId||!consentId||!/^[a-f0-9]{64}$/.test(proof.configDigest??'')||proof.predecessorId!==prior.id||proof.predecessorRowSHA256!==sha(prior)||proof.historySHA256!==sha(history)||proof.sourceHashesSHA256!==sha(sourceHashes)||!Array.isArray(samples)||samples.length<100||samples.length>300)throw Error('Current-start proof must bind consent, source, history and configuration');
 const first=Date.parse(samples[0]?.observedAt),last=Date.parse(samples.at(-1)?.observedAt),start=samples.at(-1)?.joints;
 if(!Number.isFinite(first)||!Number.isFinite(last)||last-first<30000||last>now||now-last>60000||first<Date.parse(prior.finishedAt)||proof.observationDurationMs!==last-first||proof.observationCount!==samples.length||JSON.stringify(start)!==JSON.stringify(proof.expectedStart)||!['stationary','noContact','cablesSlack','noUnusualNoise'].every(k=>proof.inspection?.[k]===true))throw Error('Thirty seconds of fresh stationary feedback and current inspection required');
 for(let i=0;i<samples.length;i++){
  const s=samples[i],at=Date.parse(s.observedAt);observedTicks(s.joints);assertLiftHealth(s.health);
  if(s.source!=='hardware'||!Number.isFinite(at)||at>now||i&&(at<=Date.parse(samples[i-1].observedAt)||at-Date.parse(samples[i-1].observedAt)>500))throw Error('Current-start samples are stale, interrupted or not hardware');
 }
 if(keys.some(k=>Math.max(...samples.map(s=>s.joints[k]))-Math.min(...samples.map(s=>s.joints[k]))>SERVO_STEP+1e-9))throw Error('Current-start full-span drift exceeds one tick');
 const ticks=observedTicks(start),previous=observedTicks(prior.result.observed);
 if(Math.abs(ticks.base-previous.base)>4||Math.abs(ticks.shoulder-previous.shoulder)>4||Math.abs(ticks.gripper-previous.gripper)>1||ticks.elbow<2048||ticks.elbow>2056)throw Error('Current pose exceeds the separately bounded horizontal start region');
 elbowFeedforwardGeometry({start,desiredTick:2389,commandTick:2389,currentPoseQualified:true});
 elbowFeedforwardGeometry({start:{...start,elbow:2389*SERVO_STEP-Math.PI/2},desiredTick:2052,commandTick:2034,currentPoseQualified:true});
 return {...start};
}
export async function collectCurrentWaveStart({controller,history,sourceHashes,inspection,consentId,gate,now=Date.now,wait=delay,readConfigBytes=()=>fs.readFile(path.join(controller.directory,'commissioning','motion.json'))}){
 assertCurrentWavePredecessor(history,now());
 return controller.withForeground(async()=>{
  const c=controller,generation=c.generation,abort=new AbortController(),observations=[],timer=setTimeout(()=>abort.abort(),40000);
  if(c.mode!=='serial'||!c.connected||c.armed||c.commissioned||c.busy||c.taskActive||c.movement.session||c.movement.active){clearTimeout(timer);throw Error('Current-start collection requires an idle disarmed serial Controller');}
  c.busy=true;c.taskActive=true;c.abort=abort;c.lifecycle='current-wave-stationary-observation';
  const check=()=>{gate();if(abort.signal.aborted||c.generation!==generation||!c.connected||c.armed||c.commissioned||c.movement.session)throw Error('Current-start collection cancelled');};
  try{
   const configBytes=await readConfigBytes(),profile=JSON.parse(configBytes),configDigest=bytesHash(configBytes),historySHA256=sha(history);
   if(profile.finiteElbowGesture!=='camera-inspected-dramatic-wave-v1'||profile.completionMode!=='shadow')throw Error('Existing reviewed dramatic-wave profile required');
   do{
    check();const pose=await c.movement.fresh(abort.signal),at=Date.parse(c.telemetryUpdatedAt),t=now();observedTicks(pose);assertLiftHealth(c.liftHealth);
    if(!Number.isFinite(at)||at>t||t-at>500||observations.length&&(at<=Date.parse(observations.at(-1).observedAt)||at-Date.parse(observations.at(-1).observedAt)>500))throw Error('Current-start feedback stale or interrupted');
    if(observations.some(s=>keys.some(k=>Math.abs(s.joints[k]-pose[k])>SERVO_STEP+1e-9)))throw Error('Arm moved during current-start qualification');
    observations.push({source:'hardware',observedAt:c.telemetryUpdatedAt,joints:{...pose},health:{...c.liftHealth}});
    if(observations.length>300)throw Error('Current-start sample budget exceeded');
    if(observations.length<100||at-Date.parse(observations[0].observedAt)<30000)await wait(150,undefined,{signal:abort.signal});
   }while(observations.length<100||Date.parse(observations.at(-1).observedAt)-Date.parse(observations[0].observedAt)<30000);
   check();if(sha(await c.movement.readyHistory())!==historySHA256||bytesHash(await readConfigBytes())!==configDigest)throw Error('Current-start history or configuration changed');
   const p=history.commands.at(-1),proof={id:randomUUID(),revision:'clean-horizontal-current-start-v1',cause:'unknown',noMotionCommandIssued:true,consentId,predecessorId:p.id,predecessorRowSHA256:sha(p),historySHA256,sourceHashesSHA256:sha(sourceHashes),configDigest,inspection:{...inspection},expectedStart:{...observations.at(-1).joints},observationCount:observations.length,observationDurationMs:Date.parse(observations.at(-1).observedAt)-Date.parse(observations[0].observedAt),observations};
   validateCurrentWaveStart({proof,history,sourceHashes,consentId,now:now()});check();return proof;
  }finally{clearTimeout(timer);if(c.abort===abort)c.abort=null;c.busy=false;c.taskActive=false;c.lifecycle=null;}
 });
}
