import {SERVO_STEP,assertLiftHealth} from './z-lift-actuators.mjs';
import {validateOtherFeedback} from './other-joint-plan.mjs';

export const FEEDBACK_COMPLETION_REVISION='target-arrival-dwell-v1';
export const FEEDBACK_COMPLETION_POLICY=Object.freeze({minimumElapsedMs:2500,dwellMs:1600,minimumSamples:9,maxSampleGapMs:500,maxAgeMs:500});
export const completionScope=plan=>`${plan.movementJoint}:${Math.round((plan.target[plan.movementJoint]-plan.start[plan.movementJoint])/SERVO_STEP)}`;

// T105 on this arm has no verified moving/done bit. Stable shortfall is never
// early completion. This monitor establishes encoder arrival, not physical stop.
export function createFeedbackCompletion(plan,startedAt){
 if(!Number.isFinite(startedAt))throw Error('Completion needs a finite dispatch time');
 const p=FEEDBACK_COMPLETION_POLICY,samples=[];
 let previous=null,firstCandidate=null,lateDeparture=false,maxLaterDriftTicks=0;
 const snapshot=()=>({revision:FEEDBACK_COMPLETION_REVISION,policy:{...p},candidate:firstCandidate?structuredClone(firstCandidate):null,
  lateDeparture,maxLaterDriftTicks,sampleCount:samples.length,stallFlagsAvailable:samples.length?['Stalltor','Stalltep','Stallvol'].every(k=>Object.hasOwn(samples.at(-1).health,k)):false,
  physicalMovementVerified:false,physicalStopVerified:false});
 return {
  observe(sample,now){
   const at=Date.parse(sample?.observedAt);
   if(!Number.isFinite(now)||!Number.isFinite(at)||at<startedAt||at>now||now-at>p.maxAgeMs)throw Error('Completion feedback is stale, future dated or predates dispatch');
   if((previous===null&&at-startedAt>p.maxSampleGapMs)||(previous!==null&&(at<=previous||at-previous>p.maxSampleGapMs)))throw Error('Completion feedback timestamps repeated, regressed or were interrupted');
   assertLiftHealth(sample.health);
   const validation=validateOtherFeedback(sample.joints,plan);
   previous=at;samples.push(structuredClone(sample));
   if(firstCandidate){
    const drift=Math.max(...Object.keys(plan.start).map(k=>Math.abs(sample.joints[k]-firstCandidate.observed[k])/SERVO_STEP));
    maxLaterDriftTicks=Math.max(maxLaterDriftTicks,drift);
    if(drift>1+1e-6||!validation.withinTarget)lateDeparture=true;
   }
   // Include the point immediately before the boundary so the full dwell is
   // measured, with every inter-sample gap already validated above.
   const boundary=samples.findIndex(x=>Date.parse(x.observedAt)>=at-p.dwellMs);
   const dwell=samples.slice(Math.max(0,boundary-1));
   const moved=Math.abs(sample.joints[plan.movementJoint]-plan.start[plan.movementJoint])>SERVO_STEP+1e-9;
   const trajectoryDwellReady=!plan.guardedTrajectory||at-startedAt>=plan.guardedTrajectory.policy.durationMs+p.dwellMs;
   const ready=trajectoryDwellReady&&at-startedAt>=p.minimumElapsedMs&&moved&&dwell.length>=p.minimumSamples&&
    at-Date.parse(dwell[0].observedAt)>=p.dwellMs&&
    dwell.every(x=>validateOtherFeedback(x.joints,plan).withinTarget)&&Object.keys(plan.start).every(k=>{
     const values=dwell.map(x=>x.joints[k]);return Math.max(...values)-Math.min(...values)<=SERVO_STEP+1e-9;
    });
   if(ready&&!firstCandidate)firstCandidate={elapsedMs:at-startedAt,observedAt:sample.observedAt,observed:{...sample.joints},samples:samples.length};
   return {ready:ready&&!lateDeparture,...snapshot()};
  },snapshot
 };
}
