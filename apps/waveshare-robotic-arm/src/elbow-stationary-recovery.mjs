import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {digest,exact} from './motion-config.mjs';
import {SERVO_STEP,observedTicks} from './z-lift-actuators.mjs';
import {elbowFeedforwardGeometry} from './elbow-feedforward-geometry.mjs';
import {ELBOW_FEEDFORWARD_SCOPE,ELBOW_FEEDFORWARD_DEADLINE,ELBOW_FEEDFORWARD_FIRST_ID,ELBOW_FEEDFORWARD_ORIGINAL_SHA256,ELBOW_FEEDFORWARD_REQUIRED_SOURCE_HASHES} from './elbow-feedforward-qualification.mjs';

export const ELBOW_STATIONARY_INSPECTION_KEYS=Object.freeze(['stationary','noContact','cablesSlack','noUnusualNoise']);
const joints=['base','shoulder','elbow','gripper'];
const original=row=>{const x={...row};delete x.reconciliation;delete x.poseRecovery;delete x.resetRecovery;return digest(JSON.stringify(x));};
const same=(a,b)=>!!a&&!!b&&joints.every(k=>Number.isFinite(a[k])&&Number.isFinite(b[k])&&Math.abs(a[k]-b[k])<=1e-9);
export function isReviewedElbowBaseShift(row){
 const r=row?.poseRecovery,v=r?.frozenReview;
 return row?.id===ELBOW_FEEDFORWARD_FIRST_ID&&original(row)===ELBOW_FEEDFORWARD_ORIGINAL_SHA256&&row.mode==='serial'&&row.state==='blocked'&&row.result?.outcome==='telemetry-settled-off-target'&&row.result?.cleanupVerified===true&&r?.revision==='reviewed-elbow-base-shift-v1'&&r.disposition==='accept-current-pose-for-elbow-qualification-only'&&r.originalRowSHA256===original(row)&&r.noMotionCommandIssued===true&&r.cause==='unknown'&&r.observationDurationMs>=30000&&r.observationCount>=100&&r.observations?.length>=100&&ELBOW_STATIONARY_INSPECTION_KEYS.every(k=>r.inspection?.[k]===true)&&typeof r.owner==='string'&&r.owner.length>0&&Number.isFinite(Date.parse(r.inspectedAt))&&/^[a-f0-9]{64}$/.test(r.configDigest??'')&&v?.revision==='stationary-elbow-base-shift-review-v1'&&v.originalRowSHA256===original(row)&&digest(JSON.stringify(v,null,2))===r.reviewSHA256&&same(v.expectedObserved,r.expectedObserved)&&same(r.observations.at(-1)?.joints,r.expectedObserved)&&Number.isFinite(r.changedBaseRad)&&Math.abs(r.changedBaseRad)>SERVO_STEP+1e-9&&Math.abs(r.changedBaseRad)<=4*SERVO_STEP+1e-9&&['shoulder','elbow','gripper'].every(k=>Math.abs(r.expectedObserved[k]-row.result.observed[k])<=SERVO_STEP+1e-9);
}
export async function recoverElbowCurrentPose(m,input,admission=()=>{}){
 exact(input,['owner','commandId','originalRowSHA256','inspection','note']);exact(input.inspection,ELBOW_STATIONARY_INSPECTION_KEYS);
 if(ELBOW_STATIONARY_INSPECTION_KEYS.some(k=>input.inspection[k]!==true)||typeof input.note!=='string'||input.note.length<20||input.note.length>500)throw Error('Current inspection and unexplained base-shift acknowledgment required');
 return m.c.withForeground(async()=>{
  m.setup(input.owner);const c=m.c,generation=c.generation;if(m.session||m.active||c.mode!=='serial')throw Error('Idle serial setup required for no-motion elbow baseline');
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),45000),samples=[];c.abort=abort;c.busy=true;c.taskActive=true;c.lifecycle='elbow-pose-recovery';
  const gate=()=>{admission();c.assertOwner(input.owner);if(abort.signal.aborted||c.generation!==generation||!c.connected||c.armed||c.commissioned||m.session)throw Error('Elbow baseline cancelled');};
  try{
   const cfg=await m.physicalConfig(),history=await m.history(),historySHA256=digest(JSON.stringify(history)),row=history.commands.at(-1),ev=cfg.profile.evidence.elbowPoseRecovery;
   if(cfg.profile.finiteElbowGesture!==ELBOW_FEEDFORWARD_SCOPE||cfg.profile.completionMode!=='shadow'||!ev)throw Error('Exact independently reviewed elbow baseline scope required');
   if(row?.id!==input.commandId||row.id!==ELBOW_FEEDFORWARD_FIRST_ID||original(row)!==input.originalRowSHA256||input.originalRowSHA256!==ELBOW_FEEDFORWARD_ORIGINAL_SHA256||row.reconciliation||row.poseRecovery||row.mode!=='serial'||row.state!=='blocked'||row.result?.outcome!=='telemetry-settled-off-target'||row.result.settled!==true||row.result.cleanupVerified!==true||row.result.completion?.candidate!==null||row.result.completion?.lateDeparture!==false||Math.abs(row.result.signedEndpointErrorRad)>24*SERVO_STEP)throw Error('Only the exact preserved elbow return shortfall is eligible');
   if(history.commands.slice(0,-1).some(x=>x.state!=='complete'&&!x.reconciliation&&!x.poseRecovery&&!x.resetRecovery))throw Error('Another unresolved movement prevents baseline recovery');
   const review=JSON.parse(await fs.readFile(path.join(c.directory,'commissioning',ev.file),'utf8')),now=Date.now();
   if(review.revision!=='stationary-elbow-base-shift-review-v1'||review.disposition!=='elbow-qualification-only'||review.commandId!==row.id||review.originalRowSHA256!==original(row)||review.historySHA256!==historySHA256||review.cause!=='unknown'||typeof review.reviewedBy!=='string'||!review.reviewedBy||typeof review.independentlyReviewedBy!=='string'||!review.independentlyReviewedBy||review.reviewedBy===review.independentlyReviewedBy||!Number.isFinite(Date.parse(review.reviewedAt))||Date.parse(review.reviewedAt)>now||now-Date.parse(review.reviewedAt)>3600000||review.deadlineAt!==cfg.profile.physicalDeadlineAt||Date.parse(review.deadlineAt)>Date.parse(ELBOW_FEEDFORWARD_DEADLINE)||now>=Date.parse(review.deadlineAt)||digest(JSON.stringify(review,null,2))!==ev.sha256)throw Error('Current independent source/history-bound elbow baseline review required');
   const sourceRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url))),currentSources=Object.fromEntries(await Promise.all(ELBOW_FEEDFORWARD_REQUIRED_SOURCE_HASHES.map(async f=>[f,digest(await fs.readFile(path.join(sourceRoot,f)))])));
   if(ELBOW_FEEDFORWARD_REQUIRED_SOURCE_HASHES.some(f=>review.sourceHashes?.[f]!==currentSources[f]))throw Error('Elbow baseline source changed');
   const expected=review.expectedObserved;exact(expected,joints);observedTicks(expected);const changedBaseRad=expected.base-row.result.observed.base;
   if(Math.abs(changedBaseRad)<=SERVO_STEP+1e-9||Math.abs(changedBaseRad)>4*SERVO_STEP+1e-9||['shoulder','elbow','gripper'].some(k=>Math.abs(expected[k]-row.result.observed[k])>SERVO_STEP+1e-9))throw Error('Review must bind only a small changed stationary base');
   const geometry=elbowFeedforwardGeometry({start:expected,desiredTick:2052,commandTick:2034});if(digest(JSON.stringify(geometry))!==review.geometrySHA256)throw Error('Baseline whole-path geometry changed');
   elbowFeedforwardGeometry({start:row.result.observed,desiredTick:2052,commandTick:2034});
   let firstAt=null,lastAt=null;
   do{
    gate();const pose=await m.fresh(abort.signal),at=Date.parse(c.telemetryUpdatedAt),now=Date.now();if(!Number.isFinite(at)||at>now||now-at>500||(lastAt!==null&&(at<=lastAt||at-lastAt>500)))throw Error('Elbow baseline feedback stale or interrupted');
    if(joints.some(k=>Math.abs(pose[k]-expected[k])>SERVO_STEP+1e-9||samples.some(s=>Math.abs(pose[k]-s.joints[k])>SERVO_STEP+1e-9)))throw Error('Elbow baseline differs from reviewed pose or is moving');
    firstAt??=at;lastAt=at;samples.push({observedAt:c.telemetryUpdatedAt,joints:pose,health:{...c.liftHealth}});if(lastAt-firstAt<30000||samples.length<100)await delay(150,undefined,{signal:abort.signal});
   }while(lastAt-firstAt<30000||samples.length<100);
   if((await m.physicalConfig()).digest!==cfg.digest||digest(JSON.stringify(await m.history()))!==historySHA256)throw Error('Elbow baseline config or history changed');
   gate();row.poseRecovery={revision:'reviewed-elbow-base-shift-v1',disposition:'accept-current-pose-for-elbow-qualification-only',originalRowSHA256:input.originalRowSHA256,owner:input.owner,inspectedAt:new Date().toISOString(),inspection:{...input.inspection},note:input.note,configDigest:cfg.digest,reviewSHA256:ev.sha256,frozenReview:review,sourceHashes:currentSources,expectedObserved:{...expected},changedBaseRad,cause:'unknown',geometry,observationDurationMs:lastAt-firstAt,observationCount:samples.length,observations:samples,preciseArrival:false,physicalStopVerified:false,noMotionCommandIssued:true};
   if(!isReviewedElbowBaseShift(row))throw Error('Elbow baseline proof failed validation');
   await m.save(history,()=>{gate();if(Date.now()>=Date.parse(review.deadlineAt)||digest(readFileSync(path.join(c.directory,'commissioning/motion.json')))!==cfg.digest||digest(readFileSync(path.join(c.directory,'commissioning',ev.file)))!==ev.sha256||digest(JSON.stringify(JSON.parse(readFileSync(m.file,'utf8'))))!==historySHA256||ELBOW_FEEDFORWARD_REQUIRED_SOURCE_HASHES.some(f=>digest(readFileSync(path.join(sourceRoot,f)))!==currentSources[f]))throw Error('Elbow baseline review/source/history/deadline changed before commit');});
   m.result=structuredClone(row);return {id:row.id,state:row.state,outcome:row.result.outcome,recovered:true,disposition:row.poseRecovery.disposition,cause:'unknown',observed:samples.at(-1).joints,noMotionCommandIssued:true};
  }finally{clearTimeout(timer);if(c.abort===abort)c.abort=null;c.busy=false;c.taskActive=false;c.lifecycle=null;}
 });
}
