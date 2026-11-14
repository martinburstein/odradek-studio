import {forwardKinematics, GEOMETRY, OFFSET_MODEL_REVISION, KINEMATIC_MODELS} from './kinematics.mjs';
import {validateObservedJoints} from './safety.mjs';
import {observedTicks,feedbackAtTicks,elbowCommandForTick,SERVO_STEP,Z_LIFT_COMMAND_REVISION} from './z-lift-actuators.mjs';

export const Z_LIFT_POLICY = Object.freeze({liftMm:2, maxJointDelta:0.02, driftRad:SERVO_STEP/4,
  arrivalRad:0.0024, trackingRad:0.0065, previewLifetimeMs:60000, durationMs:8000,
  speedStepsPerSecond:20, acceleration:1});
export const JOINT_NAMES = Object.freeze(['base','shoulder','elbow','gripper']);
// Explicit preview model; never selected by fitting a hardware sample.
export const Z_LIFT_MODEL_REVISION = OFFSET_MODEL_REVISION;
const forward = joints => forwardKinematics(joints,Z_LIFT_MODEL_REVISION);
// Bounds from the pinned actuator implementation, not an approved work envelope.
const SOURCE_BOUNDS = {base:[-Math.PI,Math.PI],shoulder:[-Math.PI/2,Math.PI/2],
  elbow:[-Math.PI/4,Math.PI],gripper:[-Math.PI/4,7*Math.PI/4]};

export function assertPoseNear(actual,expected,tolerance=Z_LIFT_POLICY.driftRad){
  validateObservedJoints(actual);
  for(const key of JOINT_NAMES)if(Math.abs(actual[key]-expected[key])>tolerance)throw Error('Arm position changed; prepare a new lift preview');
}

export function planZLift(input,firmwareCartesian){
  const start=validateObservedJoints(input);
  const from=forward(start);
  const goal={...from,z:from.z+Z_LIFT_POLICY.liftMm};
  const initialTicks=observedTicks(start);
  // Only the elbow is commanded. Other joints retain their observed angles;
  // in particular this never sends a goal to the unobserved shoulder servo 13.
  const maxTicks=Math.floor(Z_LIFT_POLICY.maxJointDelta/SERVO_STEP);
  let best=null;
  for(let de=-maxTicks;de<=maxTicks;de++){
    if(de===0)continue;
    const tick=initialTicks.elbow+de;
    let command;try{command=elbowCommandForTick(tick);}catch{continue;}
    const target={...start,elbow:feedbackAtTicks({...initialTicks,elbow:tick}).elbow};
    const endpoint=forward(target),rise=endpoint.z-from.z;
    if(JOINT_NAMES.some(k=>Math.abs(target[k]-start[k])>Z_LIFT_POLICY.maxJointDelta)||rise<1.75||rise>2.25)continue;
    let lateral=0,minRise=0,maxRise=0;
    for(let e=0;e<=20;e++){
      const p=forward({...start,elbow:start.elbow+(target.elbow-start.elbow)*e/20});
      lateral=Math.max(lateral,Math.hypot(p.x-from.x,p.y-from.y));minRise=Math.min(minRise,p.z-from.z);maxRise=Math.max(maxRise,p.z-from.z);
    }
    if(lateral>1||minRise< -0.25||maxRise>2.25)continue;
    const error=Math.hypot(endpoint.x-goal.x,endpoint.y-goal.y,endpoint.z-goal.z);
    if(!best||error<best.error)best={target,command,tick,rise,error,lateral,minRise,maxRise};
  }
  if(!best)throw Error('No elbow-only integer target meets the small-lift model envelope');
  const {target,command,tick}=best;
  const predictedRiseMm=best.rise;
  const delta={};
  for(const key of JOINT_NAMES){
    if([start[key],target[key]].some(v=>v<SOURCE_BOUNDS[key][0]||v>SOURCE_BOUNDS[key][1]))throw Error('Pose is outside the pinned model range; inspect geometry before a lift');
    delta[key]=target[key]-start[key];
    if(Math.abs(delta[key])>Z_LIFT_POLICY.maxJointDelta)throw Error('Lift requires too much joint travel or a different inverse branch');
  }
  const {lateral,minRise,maxRise}=best;
  let modelAgreementMm=null;
  if(firmwareCartesian&&['x','y','z'].every(k=>typeof firmwareCartesian[k]==='number'&&Number.isFinite(firmwareCartesian[k]))){
    modelAgreementMm=Math.hypot(...['x','y','z'].map(k=>from[k]-firmwareCartesian[k]));
    if(modelAgreementMm>1)throw Error('Firmware coordinates disagree with the pinned geometry; physical test blocked');
  }
  return {start,target,command,servoTargets:{elbow:tick},heldServoTicks:{base:initialTicks.base,shoulder:initialTicks.shoulder,gripper:initialTicks.gripper},commandRevision:Z_LIFT_COMMAND_REVISION,delta,from,goal,liftMm:2,predictedRiseMm,modelAgreementMm,
    sampledPath:{maxLateralMm:lateral,minRiseMm:minRise,maxRiseMm:maxRise},
    modelRevision:Z_LIFT_MODEL_REVISION,modelLabel:KINEMATIC_MODELS[Z_LIFT_MODEL_REVISION].label,toolMode:GEOMETRY.mode,
    speedStepsPerSecond:Z_LIFT_POLICY.speedStepsPerSecond,acceleration:Z_LIFT_POLICY.acceleration,
    durationMs:Z_LIFT_POLICY.durationMs,physicalPathVerified:false,
    limitations:'Model prediction only. Firmware coordinates are calculated, not independent position measurements. No automatic return or repeat.'};
}

export function validateTrialFeedback(joints,plan){
  if(plan.modelRevision!==Z_LIFT_MODEL_REVISION)throw Error('Trial model revision does not match the current lift model');
  validateObservedJoints(joints);
  for(const key of JOINT_NAMES){
    if(joints[key]<Math.min(plan.start[key],plan.target[key])-Z_LIFT_POLICY.trackingRad||
       joints[key]>Math.max(plan.start[key],plan.target[key])+Z_LIFT_POLICY.trackingRad)throw Error('Unexpected joint displacement; physical intervention may be required');
  }
  const point=forward(joints),rise=point.z-plan.from.z;
  if(rise< -1||rise>3.5||Math.hypot(point.x-plan.from.x,point.y-plan.from.y)>2.5)throw Error('Observed joints imply unexpected travel; physical intervention may be required');
  return {estimatedRiseMm:rise,withinTarget:rise>=0.5&&JOINT_NAMES.every(k=>Math.abs(joints[k]-plan.target[k])<=Z_LIFT_POLICY.arrivalRad)};
}
