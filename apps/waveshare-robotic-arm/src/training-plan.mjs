import {forwardKinematics} from './kinematics.mjs';
import {validateObservedJoints} from './safety.mjs';
import {observedTicks,feedbackAtTicks,elbowCommandForTick,SERVO_STEP} from './z-lift-actuators.mjs';
import {Z_LIFT_MODEL_REVISION,Z_LIFT_POLICY,JOINT_NAMES} from './z-lift-plan.mjs';
import {validateTrainingTrajectory,TRAINING_ENVELOPE_REVISION} from './training-envelope.mjs';
export const TRAINING_EXPERIMENT='supervised-elbow-characterization-v1';
export function planTrainingElbow(input,cartesian,targetTick){
 const start=validateObservedJoints(input),ticks=observedTicks(start);
 if(!Number.isInteger(targetTick)||Math.abs(targetTick-ticks.elbow)<1||Math.abs(targetTick-ticks.elbow)>114)throw Error('Training request must move 1 to 114 encoder ticks');
 const command=elbowCommandForTick(targetTick);
 const target={...start,elbow:feedbackAtTicks({...ticks,elbow:targetTick}).elbow};
 const envelope=validateTrainingTrajectory(start,target);
 const from=forwardKinematics(start,Z_LIFT_MODEL_REVISION),goal=forwardKinematics(target,Z_LIFT_MODEL_REVISION);
 if(!cartesian||!['x','y','z'].every(k=>Number.isFinite(cartesian[k])))throw Error('Fresh firmware coordinates required');
 const modelAgreementMm=Math.hypot(...['x','y','z'].map(k=>from[k]-cartesian[k]));
 if(modelAgreementMm>1)throw Error('Firmware coordinates disagree with training geometry');
 return {experiment:TRAINING_EXPERIMENT,start,target,command,servoTargets:{elbow:targetTick},heldServoTicks:{base:ticks.base,shoulder:ticks.shoulder,gripper:ticks.gripper},
   commandRevision:'roarm-m2-260630-t101-elbow-v1',modelRevision:Z_LIFT_MODEL_REVISION,toolMode:'EEMode 0',envelopeRevision:TRAINING_ENVELOPE_REVISION,envelope,
   delta:Object.fromEntries(JOINT_NAMES.map(k=>[k,target[k]-start[k]])),from,goal,liftMm:null,predictedRiseMm:goal.z-from.z,modelAgreementMm,
   speedStepsPerSecond:20,acceleration:1,durationMs:15000,observationWindowMs:8000,physicalPathVerified:false,
   limitations:'Single uncompensated elbow experiment under supervised session authority. No automatic retry, return or next command.'};
}
export function validateTrainingFeedback(joints,plan){
 validateObservedJoints(joints);
 if(plan.experiment!==TRAINING_EXPERIMENT||plan.envelopeRevision!==TRAINING_ENVELOPE_REVISION)throw Error('Training envelope revision mismatch');
 for(const key of JOINT_NAMES)if(joints[key]<Math.min(plan.start[key],plan.target[key])-Z_LIFT_POLICY.trackingRad||joints[key]>Math.max(plan.start[key],plan.target[key])+Z_LIFT_POLICY.trackingRad)throw Error('Unexpected joint displacement during training; physical intervention may be required');
 return {withinTarget:JOINT_NAMES.every(k=>Math.abs(joints[k]-plan.target[k])<=Z_LIFT_POLICY.arrivalRad),estimatedRiseMm:forwardKinematics(joints,Z_LIFT_MODEL_REVISION).z-plan.from.z};
}
export function classifyTrainingSettling(observations,plan){
 if(!Array.isArray(observations)||observations.length<8)throw Error('Insufficient settling observations');
 const last=observations.at(-1),end=Date.parse(last.observedAt),window=observations.filter(s=>end-Date.parse(s.observedAt)<=1600);
 if(window.length<8||end-Date.parse(window[0].observedAt)<1200)throw Error('Insufficient final settling dwell');
 for(const key of JOINT_NAMES)if(window.some(s=>Math.abs(s.joints[key]-last.joints[key])>SERVO_STEP+1e-9))throw Error('Arm has not settled; reconcile before further motion');
 const observation=validateTrainingFeedback(last.joints,plan);
 const movementTicks=Math.abs(last.joints.elbow-plan.start.elbow)/SERVO_STEP;
 return {outcome:observation.withinTarget?'telemetry-reached':movementTicks>1?'telemetry-settled-off-target':'telemetry-no-motion',
   preciseArrival:observation.withinTarget,settled:true,settlingToleranceTicks:1,settlingDwellMs:end-Date.parse(window[0].observedAt),
   signedEndpointErrorRad:last.joints.elbow-plan.target.elbow,observed:{...last.joints},estimatedRiseMm:observation.estimatedRiseMm,
   requiresReconciliation:movementTicks<=1};
}
