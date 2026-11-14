import * as dramatic from './dramatic-wave.mjs';
import {createHash} from 'node:crypto';
import * as qualification from './elbow-feedforward-qualification.mjs';
import * as repeat from './finite-elbow-repeat.mjs';
import {SERVO_STEP,observedTicks,feedbackAtTicks,commandForTicks} from './z-lift-actuators.mjs';
import {Z_LIFT_POLICY,JOINT_NAMES,Z_LIFT_MODEL_REVISION} from './z-lift-plan.mjs';
import {forwardKinematics} from './kinematics.mjs';
import {RESET_POSE} from './other-joint-plan.mjs';
import {expressiveElbowCandidate} from './expressive-elbow-candidate.mjs';

export const FINITE_ELBOW_GESTURE_SCOPE='finite-inspected-elbow-gesture-v1';
export const FINITE_ELBOW_GESTURE_AUTHORIZATION_UNTIL='2026-10-10T06:30:00.000Z';
export const FINITE_ELBOW_GESTURE_SHORTFALL_ID='d5cc665f-51ea-4a6d-921f-b6bf05f957bb';
export const FINITE_ELBOW_GESTURE_RESET_ID='fa7b492e-2475-494f-a2a9-a406635d455c';
export const FINITE_ELBOW_GESTURE_ORIGINAL_SHORTFALL_SHA256='ee774261bfacdd7d2f51b14d6a4949c279f82e82c79345c64c242f5962a01d88';
export const FINITE_ELBOW_GESTURE_REQUIRED_SOURCE_HASHES=Object.freeze([
 'src/pilot-control.mjs','test/pilot-control.test.mjs','src/pilot-commands.mjs','test/pilot-commands.test.mjs','tools/pilot-client.mjs','test/pilot-client.test.mjs',
 'src/dramatic-wave.mjs','test/dramatic-wave.test.mjs','tools/wave-now-client.mjs','test/wave-now-client.test.mjs','src/routine-motion-consent.mjs','test/routine-motion-consent.test.mjs','tools/prepare-wave-now.mjs',
 'src/finite-elbow-repeat.mjs','test/finite-elbow-repeat.test.mjs',
 'src/elbow-feedforward-qualification.mjs','src/elbow-feedforward-geometry.mjs','src/elbow-stationary-recovery.mjs','test/elbow-feedforward-qualification.test.mjs',
 'src/finite-elbow-gesture.mjs','src/expressive-elbow-candidate.mjs','src/training-envelope.mjs',
 'src/kinematics.mjs','src/z-lift-plan.mjs','src/z-lift-actuators.mjs','src/movement.mjs',
 'src/motion-config.mjs','src/other-joint-plan.mjs','src/feedback-completion.mjs','src/server.mjs',
 'tools/movement.mjs','test/finite-elbow-gesture.test.mjs'
]);
export const FINITE_ELBOW_GESTURE_POLICY=Object.freeze({maxLegs:2,forwardDegrees:120,sessionSeconds:90,maxLegTicks:360,
 speedStepsPerSecond:20,acceleration:1,arrivalRad:Z_LIFT_POLICY.arrivalRad,trackingRad:Z_LIFT_POLICY.trackingRad,
 heldJointTicks:1,observationWindowMs:36000,settlingDwellMs:1600,minimumSamples:9,maxSampleAgeMs:500,bodyHeightMm:0,selfSeparationMm:24});
export const elbowGestureSourceFiles=scope=>scope===dramatic.DRAMATIC_WAVE_SCOPE?dramatic.DRAMATIC_WAVE_REQUIRED_SOURCE_HASHES:FINITE_ELBOW_GESTURE_REQUIRED_SOURCE_HASHES;
const digest=v=>createHash('sha256').update(Buffer.isBuffer(v)||v instanceof Uint8Array?v:(typeof v==='string'?v:JSON.stringify(v))).digest('hex');
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v);
const time=v=>Number.isFinite(Date.parse(v));
const held=['base','shoulder','gripper'];
const samePose=(a,b,ticks=1)=>!!a&&!!b&&JOINT_NAMES.every(k=>Number.isFinite(a[k])&&Number.isFinite(b[k])&&Math.abs(a[k]-b[k])<=ticks*SERVO_STEP+1e-9);
const cleanCompletion=row=>row?.mode==='serial'&&row.state==='complete'&&row.result?.cleanupVerified===true&&row.result?.requiresReconciliation!==true&&row.result?.outcome==='telemetry-reached'&&row.result?.completion?.mode==='shadow'&&!!row.result.completion.candidate&&row.result.completion.lateDeparture===false&&Number.isFinite(row.result.completion.maxLaterDriftTicks)&&row.result.completion.maxLaterDriftTicks<=1+1e-6&&row.result.completion.observationDurationMs>=FINITE_ELBOW_GESTURE_POLICY.observationWindowMs&&Array.isArray(row.result.observations)&&row.result.observations.length>=FINITE_ELBOW_GESTURE_POLICY.minimumSamples;
const resolvedShortfall=row=>{const inspection=row?.reconciliation?.inspection;return row?.id===FINITE_ELBOW_GESTURE_SHORTFALL_ID&&row.mode==='serial'&&row.state==='blocked'&&row.result?.outcome==='telemetry-settled-off-target'&&row.result?.cleanupVerified===true&&row.result?.requiresReconciliation===true&&row.result?.completion?.candidate==null&&row.result?.completion?.lateDeparture===false&&row.reconciliation?.revision==='inspected-shortfall-v1'&&row.reconciliation.disposition==='accept-observed-pose-for-new-plan'&&row.reconciliation.originalRowSHA256===FINITE_ELBOW_GESTURE_ORIGINAL_SHORTFALL_SHA256&&row.reconciliation.noMotionCommandIssued===true&&row.reconciliation.observationDurationMs>=3000&&row.reconciliation.observationCount>=16&&['stationary','noContact','cablesSlack','noUnusualNoise'].every(k=>inspection?.[k]===true);};
const geometryCache=new Map();
function geometryFor(start){
 if(!Number.isFinite(start?.elbow)||start.elbow<RESET_POSE.elbow-FINITE_ELBOW_GESTURE_POLICY.trackingRad||start.elbow>120*Math.PI/180+FINITE_ELBOW_GESTURE_POLICY.trackingRad)throw Error('Elbow start is outside the reviewed whole interval');
 const key=JSON.stringify(start);if(geometryCache.has(key))return geometryCache.get(key);
 const resetLike={...start,elbow:RESET_POSE.elbow};
 const candidate=expressiveElbowCandidate(resetLike,FINITE_ELBOW_GESTURE_POLICY.forwardDegrees);
 if(candidate.geometry.requiredBodyHeightMm!==FINITE_ELBOW_GESTURE_POLICY.bodyHeightMm||candidate.geometry.requiredSelfSeparationMm!==FINITE_ELBOW_GESTURE_POLICY.selfSeparationMm||Object.values(candidate.geometry.minimumBodyHeightMm).some(v=>v<FINITE_ELBOW_GESTURE_POLICY.bodyHeightMm)||candidate.geometry.minimumSelfSeparationMm<FINITE_ELBOW_GESTURE_POLICY.selfSeparationMm)throw Error('Full expressive elbow interval fails the unchanged clearance criteria');
 geometryCache.set(key,candidate.geometry);return candidate.geometry;
}
export const targetDegreesForOrdinal=ordinal=>ordinal===1?FINITE_ELBOW_GESTURE_POLICY.forwardDegrees:ordinal===2?RESET_POSE.elbow*180/Math.PI:null;
export const targetTickForOrdinal=(start,ordinal)=>{const d=targetDegreesForOrdinal(ordinal);if(!Number.isFinite(d))return null;return Math.round((Math.PI/2+d*Math.PI/180)/SERVO_STEP);};
export const isResolvedGesturePredecessor=row=>resolvedShortfall(row)||cleanCompletion(row);
export function validateFiniteElbowGestureAdmission({review,sourceHashes,history,deadlineAt,now=Date.now(),ordinal,seriesId}){
 if(review?.scope===dramatic.DRAMATIC_WAVE_SCOPE)return dramatic.validateDramaticWaveAdmission({review,sourceHashes,history,deadlineAt,now,ordinal,seriesId});
 if(review?.scope===repeat.ELBOW_REPEAT_SCOPE)return repeat.validateElbowRepeatAdmission({review,sourceHashes,history,deadlineAt,now,ordinal,seriesId});
 if(review?.scope===qualification.ELBOW_FEEDFORWARD_SCOPE)return qualification.validateElbowFeedforwardAdmission({review,sourceHashes,history,deadlineAt,now,ordinal,seriesId});
 if(!Number.isFinite(now)||!time(deadlineAt)||Date.parse(deadlineAt)<=now||Date.parse(deadlineAt)>Date.parse(FINITE_ELBOW_GESTURE_AUTHORIZATION_UNTIL))throw Error('Elbow authorization deadline is missing, expired, or outside the renewed window');
 if(!Number.isInteger(ordinal)||ordinal<1||ordinal>2||!uuid(seriesId))throw Error('Elbow gesture ordinal or series id is invalid');
 if(!history||!Array.isArray(history.commands)||history.commands.length<2)throw Error('Full validated movement history is required');
 const previous=history.commands.at(-1),reset=history.commands.find(r=>r.id===FINITE_ELBOW_GESTURE_RESET_ID);
 if(ordinal===1){if(!resolvedShortfall(previous))throw Error('The latest elbow gesture may begin only after exact reviewed no-motion reconciliation of the preserved shortfall');}
 else {const prior=previous?.finiteElbowGesture;if(!cleanCompletion(previous)||!prior||prior.scope!==FINITE_ELBOW_GESTURE_SCOPE||prior.seriesId!==seriesId||prior.ordinal!==1||prior.oneShotId===undefined)throw Error('Return leg requires a clean completed first gesture in the same series');
  const visual=review?.priorVisualObservation;if(!visual||visual.commandId!==previous.id||visual.confirmed!==true||visual.frameSaved!==false||typeof visual.observer!=='string'||!visual.observer.trim()||!time(visual.observedAt)||Date.parse(visual.observedAt)<Date.parse(previous.finishedAt??'')||Date.parse(visual.observedAt)>now)throw Error('Return leg requires a new operator visual confirmation of the completed first movement');}
 if(!isResolvedGesturePredecessor(previous)||!reset||!reset.resetRecovery)throw Error('Movement history or preserved reset anchor is not ready for an elbow gesture');
 if(!samePose(review.expectedStart,previous.result.observed,0)||!sha(review.resetAnchorRowSHA256)||digest(reset)!==review.resetAnchorRowSHA256)throw Error('Review does not bind the exact reconciled/observed start and preserved reset anchor');
 const d=targetDegreesForOrdinal(ordinal),target=targetTickForOrdinal(previous.result.observed,ordinal),startTick=observedTicks(previous.result.observed).elbow;
 if(!review||review.revision!=='independent-finite-elbow-leg-v1'||review.scope!==FINITE_ELBOW_GESTURE_SCOPE||review.seriesId!==seriesId||review.ordinal!==ordinal||!uuid(review.oneShotId)||review.targetDegrees!==d||review.startElbowTick!==startTick||review.targetElbowTick!==target||review.maxLegTicks!==FINITE_ELBOW_GESTURE_POLICY.maxLegTicks||Math.abs(target-startTick)>FINITE_ELBOW_GESTURE_POLICY.maxLegTicks||review.authorizationUntil!==FINITE_ELBOW_GESTURE_AUTHORIZATION_UNTIL||review.deadlineAt!==deadlineAt||review.speedStepsPerSecond!==20||review.acceleration!==1||review.arrivalRad!==FINITE_ELBOW_GESTURE_POLICY.arrivalRad||review.trackingRad!==FINITE_ELBOW_GESTURE_POLICY.trackingRad||review.heldJointTicks!==1||review.observationWindowMs!==36000||review.settlingDwellMs!==1600||review.minimumSamples!==9||review.maxSampleAgeMs!==500)throw Error('Independent review does not bind the exact one-leg elbow target and strict observation policy');
 if(typeof review.reviewedBy!=='string'||!review.reviewedBy.trim()||typeof review.independentlyReviewedBy!=='string'||!review.independentlyReviewedBy.trim()||review.reviewedBy===review.independentlyReviewedBy||!time(review.reviewedAt)||Date.parse(review.reviewedAt)>now||now-Date.parse(review.reviewedAt)>3600000||review.priorCommandId!==previous.id||review.priorRowSHA256!==digest(previous)||review.historySHA256!==digest(history)||!sha(review.originalShortfallSHA256)||review.originalShortfallSHA256!==FINITE_ELBOW_GESTURE_ORIGINAL_SHORTFALL_SHA256)throw Error('Current independent full-history and original-shortfall-bound review is required');
 const geometry=geometryFor(previous.result.observed);if(review.geometrySHA256!==digest(geometry)||review.geometry?.wholeIntervalChecked!==true)throw Error('Independent review does not bind the exact full elbow-path geometry');
 if(FINITE_ELBOW_GESTURE_REQUIRED_SOURCE_HASHES.some(f=>!sha(sourceHashes?.[f])||review.sourceHashes?.[f]!==sourceHashes[f]))throw Error('Independent source-bound elbow review is stale or incomplete');
 const used=history.commands.flatMap(r=>r.finiteElbowGesture?[r.finiteElbowGesture]:[]);if(used.some(x=>x.oneShotId===review.oneShotId)||used.some(x=>x.seriesId===seriesId&&x.ordinal===ordinal))throw Error('Elbow one-shot or ordinal was already consumed');
 return Object.freeze({scope:FINITE_ELBOW_GESTURE_SCOPE,seriesId,ordinal,oneShotId:review.oneShotId,reviewSHA256:digest(review),historySHA256:digest(history),priorCommandId:previous.id,priorRowSHA256:digest(previous),originalShortfallSHA256:FINITE_ELBOW_GESTURE_ORIGINAL_SHORTFALL_SHA256,resetAnchorRowSHA256:review.resetAnchorRowSHA256,sourceHashes:Object.freeze({...sourceHashes}),deadlineAt,expectedStart:Object.freeze({...previous.result.observed}),startElbowTick:startTick,targetElbowTick:target,targetDegrees:d,requestDegrees:(target-startTick)*SERVO_STEP*180/Math.PI,geometrySHA256:digest(geometry)});
}
export function assertFiniteElbowGestureExecution({admission,review,history,sourceHashes,now=Date.now(),owner,expectedOwner,sessionId,expectedSessionId,expiresAt,configDigest,expectedConfigDigest,stopped=false}){
 if(admission?.scope===dramatic.DRAMATIC_WAVE_SCOPE)return dramatic.assertDramaticWaveExecution({admission,review,history,sourceHashes,now,owner,expectedOwner,sessionId,expectedSessionId,expiresAt,configDigest,expectedConfigDigest,stopped});
 if(admission?.scope===repeat.ELBOW_REPEAT_SCOPE)return repeat.assertElbowRepeatExecution({admission,review,history,sourceHashes,now,owner,expectedOwner,sessionId,expectedSessionId,expiresAt,configDigest,expectedConfigDigest,stopped});
 if(admission?.scope===qualification.ELBOW_FEEDFORWARD_SCOPE)return qualification.assertElbowFeedforwardExecution({admission,review,history,sourceHashes,now,owner,expectedOwner,sessionId,expectedSessionId,expiresAt,configDigest,expectedConfigDigest,stopped});
 if(!admission||admission.scope!==FINITE_ELBOW_GESTURE_SCOPE||digest(review)!==admission.reviewSHA256||digest(history)!==admission.historySHA256||!Number.isFinite(now)||Date.parse(admission.deadlineAt)<=now||Date.parse(admission.deadlineAt)>Date.parse(FINITE_ELBOW_GESTURE_AUTHORIZATION_UNTIL)||!time(expiresAt)||Date.parse(expiresAt)<=now||Date.parse(expiresAt)>Math.min(Date.parse(admission.deadlineAt),now+90_000)||FINITE_ELBOW_GESTURE_REQUIRED_SOURCE_HASHES.some(f=>sourceHashes?.[f]!==admission.sourceHashes[f])||owner!==expectedOwner||!owner||sessionId!==expectedSessionId||!sessionId||configDigest!==expectedConfigDigest||stopped||history.commands.some(r=>r.finiteElbowGesture?.oneShotId===admission.oneShotId))throw Error('Elbow gesture authorization is stale, changed, expired, cancelled, or consumed');
 return true;
}
export function planFiniteElbowGesture({start,cartesian,admission,review}){
 if(admission?.scope===dramatic.DRAMATIC_WAVE_SCOPE)return dramatic.planDramaticWave({start,cartesian,admission,review});
 if(admission?.scope===repeat.ELBOW_REPEAT_SCOPE)return repeat.planElbowRepeat({start,cartesian,admission,review});
 if(admission?.scope===qualification.ELBOW_FEEDFORWARD_SCOPE)return qualification.planElbowFeedforward({start,cartesian,admission,review});
 if(!admission||admission.scope!==FINITE_ELBOW_GESTURE_SCOPE||digest(review)!==admission.reviewSHA256||!samePose(start,admission.expectedStart,1))throw Error('Current one-tick start and source-bound elbow review required');
 const ticks=observedTicks(start),targetTick=targetTickForOrdinal(start,admission.ordinal);if(Math.abs(targetTick-ticks.elbow)>FINITE_ELBOW_GESTURE_POLICY.maxLegTicks)throw Error('Elbow leg exceeds reviewed finite tick cap');
 const target={...start,elbow:feedbackAtTicks({...ticks,elbow:targetTick}).elbow},geometry=geometryFor(start);
 if(digest(geometry)!==admission.geometrySHA256||review.geometrySHA256!==admission.geometrySHA256)throw Error('Elbow geometry review changed');
 const from=forwardKinematics(start,Z_LIFT_MODEL_REVISION),goal=forwardKinematics(target,Z_LIFT_MODEL_REVISION);
 if(!cartesian||!['x','y','z'].every(k=>Number.isFinite(cartesian[k]))||Math.hypot(...['x','y','z'].map(k=>from[k]-cartesian[k]))>1)throw Error('Fresh firmware coordinates disagree with the reviewed geometry');
 const servoTicks={...ticks,elbow:targetTick},command={T:101,joint:3,rad:commandForTicks(servoTicks).elbow,spd:20,acc:1},held=observedTicks(start);
 return {experiment:FINITE_ELBOW_GESTURE_SCOPE,finiteElbowGesture:{scope:FINITE_ELBOW_GESTURE_SCOPE,seriesId:admission.seriesId,ordinal:admission.ordinal,oneShotId:admission.oneShotId,reviewSHA256:admission.reviewSHA256,historySHA256:admission.historySHA256,priorCommandId:admission.priorCommandId,priorRowSHA256:admission.priorRowSHA256,originalShortfallSHA256:admission.originalShortfallSHA256,resetAnchorRowSHA256:admission.resetAnchorRowSHA256,geometrySHA256:admission.geometrySHA256,targetDegrees:admission.targetDegrees,startElbowTick:ticks.elbow,targetElbowTick:targetTick,maxLegTicks:FINITE_ELBOW_GESTURE_POLICY.maxLegTicks,noRetry:true,noAutomaticReturn:true},movementJoint:'elbow',start,target,command,envelope:geometry,servoTargets:{elbow:targetTick},heldServoTicks:{base:held.base,shoulder:held.shoulder,gripper:held.gripper},commandRevision:'roarm-m2-260630-t101-elbow-v1',modelRevision:Z_LIFT_MODEL_REVISION,toolMode:'EEMode 0',envelopeRevision:FINITE_ELBOW_GESTURE_SCOPE,delta:Object.fromEntries(JOINT_NAMES.map(k=>[k,target[k]-start[k]])),from,goal,liftMm:null,predictedRiseMm:goal.z-from.z,modelAgreementMm:Math.hypot(...['x','y','z'].map(k=>from[k]-cartesian[k])),speedStepsPerSecond:20,acceleration:1,durationMs:45000,observationWindowMs:36000,physicalPathVerified:false,limitations:'One uncompensated elbow leg inside the reviewed RESET-to-120-degree geometry interval. No automatic return, retry, or chaining.'};
}
export function assertFreshElbowGestureSample({sample,previousAt=null,now=Date.now()}){
 const at=Date.parse(sample?.observedAt);if(sample?.source!=='hardware'||!Number.isFinite(at)||at>now||now-at>FINITE_ELBOW_GESTURE_POLICY.maxSampleAgeMs||(previousAt!==null&&(at<=previousAt||at-previousAt>FINITE_ELBOW_GESTURE_POLICY.maxSampleAgeMs)))throw Error('Elbow feedback is stale, reordered, or has an excessive gap');return at;
}
export function validateFiniteElbowGestureObservation({observations,plan,completion,dispatchedAt,now=Date.now()}){
 if(plan?.finiteElbowGesture?.scope===dramatic.DRAMATIC_WAVE_SCOPE)return dramatic.validateDramaticWaveObservation({observations,plan,completion,dispatchedAt,now});
 if(plan?.experiment===repeat.ELBOW_REPEAT_SCOPE)return repeat.validateElbowRepeatObservation({observations,plan,completion,dispatchedAt,now});
 if(plan?.experiment===qualification.ELBOW_FEEDFORWARD_SCOPE)return qualification.validateElbowFeedforwardObservation({observations,plan,completion,dispatchedAt,now});
 if(!Array.isArray(observations)||!observations.length||!completion?.candidate||completion.lateDeparture!==false)throw Error('Elbow leg requires a clean strict-shadow arrival candidate');
 let prev=null;for(const s of observations){const t=Date.parse(s.observedAt);if(!s.joints||!Number.isFinite(t)||t>now||s.source!=='hardware'||(prev!==null&&(t<=prev||t-prev>500)))throw Error('Elbow observation series is invalid or stale');prev=t;for(const k of JOINT_NAMES){const lo=Math.min(plan.start[k],plan.target[k])-(k==='elbow'?FINITE_ELBOW_GESTURE_POLICY.trackingRad:SERVO_STEP),hi=Math.max(plan.start[k],plan.target[k])+(k==='elbow'?FINITE_ELBOW_GESTURE_POLICY.trackingRad:SERVO_STEP);if(s.joints[k]<lo-1e-9||s.joints[k]>hi+1e-9)throw Error('Unexpected elbow path or held-joint displacement');}}
 const end=Date.parse(observations.at(-1).observedAt),boundary=observations.findIndex(s=>end-Date.parse(s.observedAt)<=FINITE_ELBOW_GESTURE_POLICY.settlingDwellMs),dwell=observations.slice(Math.max(0,Math.min(boundary-1,observations.length-FINITE_ELBOW_GESTURE_POLICY.minimumSamples)));
 if(end-Date.parse(dispatchedAt)<FINITE_ELBOW_GESTURE_POLICY.observationWindowMs||dwell.length<FINITE_ELBOW_GESTURE_POLICY.minimumSamples||end-Date.parse(dwell[0]?.observedAt)<FINITE_ELBOW_GESTURE_POLICY.settlingDwellMs)throw Error('Elbow leg lacks its full 36-second window and 1600ms/9-sample dwell');
 if(dwell.some(s=>Math.abs(s.joints.elbow-plan.target.elbow)>FINITE_ELBOW_GESTURE_POLICY.arrivalRad||held.some(k=>Math.abs(s.joints[k]-plan.start[k])>SERVO_STEP+1e-9)))throw Error('Elbow target missed or a held joint drifted');
 return true;
}
