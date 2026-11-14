import {tabletopGeometryPolicy,TABLETOP_CLEARANCE_REVISION} from './training-envelope.mjs';
export const DRAMATIC_WAVE_EXPERIMENT='camera-inspected-dramatic-wave-v1';
import {validateObservedJoints} from './safety.mjs';
import {trainingBodyBounds} from './training-envelope.mjs';
import {SERVO_STEP,observedTicks,feedbackAtTicks,commandForTicks,commandTicks} from './z-lift-actuators.mjs';
import {forwardKinematics} from './kinematics.mjs';
import {Z_LIFT_MODEL_REVISION,Z_LIFT_POLICY,JOINT_NAMES} from './z-lift-plan.mjs';
export const OTHER_COMMAND_REVISION='roarm-m2-260630-t101-base-gripper-v1';
export const OTHER_ENVELOPE_REVISION='shoulder-plane-base-gripper-v1';
export const OTHER_EXPERIMENTS=Object.freeze({base:'supervised-base-characterization-v1',gripper:'supervised-gripper-characterization-v1'});
export const OTHER_15_ENVELOPE_REVISION='shoulder-plane-base-gripper-15deg-v1';
export const OTHER_15_EXPERIMENTS=Object.freeze({base:'supervised-base-15deg-v1',gripper:'supervised-gripper-15deg-v1'});
export const SHARED_ENVELOPE_REVISION='shared-shoulder-frame-v3';
export const SHARED_COMMAND_REVISION='roarm-m2-260630-t101-held-shoulder-v2';
export const SHARED_EXPERIMENTS=Object.freeze({base:'shared-base-v2',elbow:'shared-elbow-v2',gripper:'shared-gripper-v2'});
export const GRIPPER_CALIBRATION_EXPERIMENT='held-reset-gripper-opening-v1';
export const FACTORY_GRIPPER_CALIBRATION_EXPERIMENT='factory-gripper-23tick-opening-v1';
export const BASE_WAVE_EXPERIMENT='held-pose-base-wave-v1';
export const CLOSED_BASE_WAVE_EXPERIMENT='held-closed-claw-base-wave-v1';
export const RESET_BASE_WAVE_EXPERIMENT='held-reset-pose-base-wave-v1';
export const ELBOW_REPEAT_EXPERIMENT='finite-inspected-elbow-repeat-v1';
export const ELBOW_FEEDFORWARD_EXPERIMENT='directional-elbow-feedforward-qualification-v1';
export const FINITE_ELBOW_GESTURE_EXPERIMENT='finite-inspected-elbow-gesture-v1';
export const RESET_POSE=Object.freeze({base:0.001533981,shoulder:0.010737866,elbow:1.57693225,gripper:3.138524692});
export const BASE_WAVE_EXPERIMENTS=Object.freeze([BASE_WAVE_EXPERIMENT,CLOSED_BASE_WAVE_EXPERIMENT,RESET_BASE_WAVE_EXPERIMENT]);
export const CLAW_CLOSE_EXPERIMENT='held-pose-claw-close-v1';
// Stay one encoder tick before the human-observed 2050-tick closed reference.
export const CLAW_CLOSE_MAX_TICK=2049;
export const isOtherExperiment=x=>[...Object.values(OTHER_EXPERIMENTS),...Object.values(OTHER_15_EXPERIMENTS),...Object.values(SHARED_EXPERIMENTS),GRIPPER_CALIBRATION_EXPERIMENT,FACTORY_GRIPPER_CALIBRATION_EXPERIMENT,...BASE_WAVE_EXPERIMENTS,CLAW_CLOSE_EXPERIMENT,FINITE_ELBOW_GESTURE_EXPERIMENT,ELBOW_FEEDFORWARD_EXPERIMENT,ELBOW_REPEAT_EXPERIMENT,DRAMATIC_WAVE_EXPERIMENT].includes(x);
export function otherExperimentPolicy(experiment){
 if(experiment===FACTORY_GRIPPER_CALIBRATION_EXPERIMENT)return {joint:'gripper',shared:true,fifteen:true,calibration:true,factoryCalibration:true,envelopeRevision:experiment,profileFile:null,maxCommandDeltaTicks:23,observationWindowMs:24000,durationMs:32000};
 if(experiment===DRAMATIC_WAVE_EXPERIMENT)return {joint:'elbow',shared:true,fifteen:true,expressive:true,envelopeRevision:DRAMATIC_WAVE_EXPERIMENT,profileFile:null,maxCommandDeltaTicks:360,observationWindowMs:36000,durationMs:45000};
 if(experiment===ELBOW_REPEAT_EXPERIMENT)return {joint:'elbow',shared:true,fifteen:true,expressive:true,envelopeRevision:ELBOW_REPEAT_EXPERIMENT,profileFile:null,maxCommandDeltaTicks:360,observationWindowMs:36000,durationMs:45000};
 if(experiment===ELBOW_FEEDFORWARD_EXPERIMENT)return {joint:'elbow',shared:true,fifteen:true,expressive:true,envelopeRevision:ELBOW_FEEDFORWARD_EXPERIMENT,profileFile:null,maxCommandDeltaTicks:360,observationWindowMs:36000,durationMs:45000};
 if(experiment===FINITE_ELBOW_GESTURE_EXPERIMENT)return {joint:'elbow',shared:true,fifteen:true,expressive:true,envelopeRevision:FINITE_ELBOW_GESTURE_EXPERIMENT,profileFile:null,maxCommandDeltaTicks:360,observationWindowMs:36000,durationMs:45000};
 if(experiment===CLAW_CLOSE_EXPERIMENT)return {joint:'gripper',shared:true,fifteen:true,closing:true,envelopeRevision:CLAW_CLOSE_EXPERIMENT,profileFile:null,maxCommandDeltaTicks:341,observationWindowMs:24000,durationMs:32000};
 if(BASE_WAVE_EXPERIMENTS.includes(experiment))return {joint:'base',shared:true,fifteen:true,wave:true,closedClaw:experiment===CLOSED_BASE_WAVE_EXPERIMENT,resetPose:experiment===RESET_BASE_WAVE_EXPERIMENT,envelopeRevision:experiment,profileFile:null,maxCommandDeltaTicks:114,observationWindowMs:12000,durationMs:20000};
 if(experiment===GRIPPER_CALIBRATION_EXPERIMENT)return {joint:'gripper',shared:true,fifteen:true,calibration:true,envelopeRevision:GRIPPER_CALIBRATION_EXPERIMENT,profileFile:null,maxCommandDeltaTicks:341,observationWindowMs:24000,durationMs:32000};
 if(Object.values(SHARED_EXPERIMENTS).includes(experiment)){
  const joint=Object.keys(SHARED_EXPERIMENTS).find(k=>SHARED_EXPERIMENTS[k]===experiment);
  return {joint,shared:true,fifteen:true,envelopeRevision:SHARED_ENVELOPE_REVISION,profileFile:null,maxCommandDeltaTicks:{base:171,gripper:341,elbow:512}[joint],observationWindowMs:{base:12000,gripper:24000,elbow:36000}[joint],durationMs:{base:20000,gripper:32000,elbow:45000}[joint]};
 }
 const fifteen=Object.values(OTHER_15_EXPERIMENTS).includes(experiment),map=fifteen?OTHER_15_EXPERIMENTS:OTHER_EXPERIMENTS;
 const joint=Object.keys(map).find(k=>map[k]===experiment);if(!joint)throw Error('Unsupported other-joint experiment');
 return {joint,fifteen,envelopeRevision:fifteen?OTHER_15_ENVELOPE_REVISION:OTHER_ENVELOPE_REVISION,profileFile:joint+(fifteen?'-15deg':'')+'-preflight.json',maxCommandDeltaTicks:fifteen?172:58,sequenceStepTicks:fifteen?171:57,observationWindowMs:fifteen?12000:8000,durationMs:fifteen?20000:15000};
}
const jointFor=x=>otherExperimentPolicy(x).joint;
const range=(lo,hi)=>{const n=Math.max(1,Math.ceil((hi-lo)/.004));return Array.from({length:n+1},(_,i)=>lo+(hi-lo)*i/n);};
const sep=(a,b)=>Math.max(...[0,1,2].map(k=>Math.max(a.min[k]-b.max[k],b.min[k]-a.max[k])));
const forward=j=>forwardKinematics(j,Z_LIFT_MODEL_REVISION);

// A positive projection gap along ANY unit axis is a lower bound on the
// Euclidean distance between the two complete conservative boxes. Use upper
// and distal local axes instead of losing the distal orientation in an AABB.
// This is the same vendor-box geometry and existing 60 mm joint-collar cut.
export function adjacentLinkSeparationMm(elbow){
 if(!Number.isFinite(elbow))throw Error('Finite elbow angle required');
 const rect=(x0,x1,y0,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
 const upper=rect(-10.1,246.9,-15.6,40.1),c=Math.cos(Math.PI/2+elbow),s=Math.sin(Math.PI/2+elbow);
 const distal=rect(-15.6,20.1,-283.9,-60).map(([x,y])=>[236.815132922094+c*x-s*y,30.0023995170449+s*x+c*y]);
 return Math.max(...[[1,0],[0,1],[c,s],[-s,c]].map(axis=>{
  const a=upper.map(p=>p[0]*axis[0]+p[1]*axis[1]),b=distal.map(p=>p[0]*axis[0]+p[1]*axis[1]);
  return Math.max(Math.min(...a)-Math.max(...b),Math.min(...b)-Math.max(...a));
 }));
}

// Narrow exploratory region, not vendor limits. Shoulder stays fixed; only
// the shared v2 path additionally admits elbow movement.
export function otherJointEnvelope(start,target,joint,experiment=OTHER_EXPERIMENTS[joint]){
 const policy=otherExperimentPolicy(experiment);if(policy.joint!==joint)throw Error('Envelope joint mismatch');
 if(policy.expressive)throw Error('Finite elbow gesture envelope must be supplied by the source-bound gesture planner');
 for(const p of [start,target]){
  validateObservedJoints(p);
  if(policy.factoryCalibration){
   if(Math.abs(p.base)>.04||p.shoulder<.006||p.shoulder>.019||p.elbow<1.54||p.elbow>1.62||p.gripper<3.10||p.gripper>3.145)throw Error('Pose outside the narrow factory gripper calibration region');
  }else if(policy.closing){
   if(Math.abs(p.base)>.12||p.shoulder<.012||p.shoulder>.019||p.elbow<1.59||p.elbow>1.60||p.gripper<1.59||p.gripper>CLAW_CLOSE_MAX_TICK*SERVO_STEP+1e-9)throw Error('Pose outside held-pose claw closing region');
  }else if(policy.resetPose){
   if(Math.abs(p.base)>.12||['shoulder','elbow','gripper'].some(k=>Math.abs(p[k]-RESET_POSE[k])>SERVO_STEP+1e-9))throw Error('Pose outside exact reset-pose base wave region');
  }else if(policy.wave){
   if(Math.abs(p.base)>.12||p.shoulder<.012||p.shoulder>.019||p.elbow<1.59||p.elbow>1.60||p.gripper<(policy.closedClaw?3.12:1.59)||p.gripper>(policy.closedClaw?3.15:1.61))throw Error('Pose outside held-pose base wave region');
  }else if(policy.calibration){
   if(Math.abs(p.base)>.04||p.shoulder<.012||p.shoulder>.019||p.elbow<1.59||p.elbow>1.60||p.gripper<1.08||p.gripper>3.15)throw Error('Pose outside held-reset gripper calibration region');
  }else if(Math.abs(p.base)>(policy.fifteen?.30:.10)||p.shoulder<.012||p.shoulder>.019||p.elbow<(policy.shared?.12:1.44)||p.elbow>1.48||p.gripper<(policy.shared?2.30:policy.fifteen?2.86:3.04)||p.gripper>3.15)throw Error('Pose outside other-joint experimental region');
 }
 if(policy.calibration&&target.gripper>=start.gripper)throw Error('Calibration permits opening only; no closing into a stop');
 if(policy.closing&&target.gripper<=start.gripper)throw Error('Claw closing permits positive travel only');
 for(const k of JOINT_NAMES)if(k!==joint&&start[k]!==target[k])throw Error('Other joints must be held');
 const u=.0465+(policy.resetPose||policy.factoryCalibration?SERVO_STEP:0),ss=range(start.shoulder-u,start.shoulder+u),es=range(Math.min(start.elbow,target.elbow)-u,Math.max(start.elbow,target.elbow)+u);
 const gs=range(Math.min(start.gripper,target.gripper)-u,Math.max(start.gripper,target.gripper)+u);
 let gap=Infinity,count=0;const minima={upperFree:Infinity,distal:Infinity,finger:Infinity};
 // Internal separations do not depend on the shared shoulder rotation.
 // Evaluate them once per elbow/hand pair, not once per shoulder sample.
 if(policy.shared)for(const elbow of es){
  gap=Math.min(gap,adjacentLinkSeparationMm(elbow));
  for(const gripper of gs){const r=trainingBodyBounds({...start,shoulder:0,elbow,gripper});gap=Math.min(gap,sep(r.upper,r.finger));}
 }
 for(const shoulder of ss)for(const elbow of es)for(const gripper of gs){
  const b=trainingBodyBounds({...start,shoulder,elbow,gripper});count++;
  for(const k of Object.keys(minima))minima[k]=Math.min(minima[k],b[k].min[2]);
  if(!policy.shared)gap=Math.min(gap,sep(b.upper,b.distalBeyondJoint),sep(b.upper,b.finger));
  gap=Math.min(gap,sep(b.mount,b.distal),sep(b.mount,b.finger));
 }
 const floorPolicy=tabletopGeometryPolicy();
 for(const k of Object.keys(minima))minima[k]+=floorPolicy.modelHeightOffsetMm;
 // Keep position/interpolation uncertainty and the 24mm pair check.
 if(Object.values(minima).some(x=>x<floorPolicy.requiredBodyHeightMm)||gap<24)throw Error('Whole-body clearance margin insufficient');
 return {revision:policy.envelopeRevision,plane:floorPolicy.plane,...floorPolicy.fields,wholeIntervalChecked:true,uncertaintyRad:u,maximumGridStepRad:.004,gridConfigurations:count,
  minimumBodyHeightMm:minima,requiredBodyHeightMm:floorPolicy.requiredBodyHeightMm,minimumSelfSeparationMm:gap,requiredSelfSeparationMm:24,interpolationRemainderMm:2,
  physicalGeometryVerified:false,exceptions:['Existing proximal shoulder attachment; shoulder held','Designed elbow collar excluded only from adjacent-link comparison'],
  limitations:['Base-relative rigid body model does not measure external swept workspace, fixed base housing, cables or jaw contents; physical clearance inspection required','No independently verified physical stop']};
}
export function planOtherJoint(input,cartesian,experiment,targetTick){
 const policy=otherExperimentPolicy(experiment),joint=policy.joint;
 const start=validateObservedJoints(input),ticks=observedTicks(start);
 if(!Number.isInteger(targetTick)||Math.abs(targetTick-ticks[joint])<1||Math.abs(targetTick-ticks[joint])>policy.maxCommandDeltaTicks)throw Error('Other-joint request must move 1 to '+policy.maxCommandDeltaTicks+' encoder ticks');
 const t={...ticks,[joint]:targetTick},rad=commandForTicks(t)[joint];
 if(commandTicks({...start,[joint]:rad})[joint]!==targetTick)throw Error('Integer target round trip failed');
 const command={T:101,joint:{base:1,elbow:3,gripper:4}[joint],rad,spd:20,acc:1};
 const target={...start,[joint]:feedbackAtTicks(t)[joint]},envelope=otherJointEnvelope(start,target,joint,experiment);
 const from=forward(start),goal=forward(target);
 if(!cartesian||!['x','y','z'].every(k=>Number.isFinite(cartesian[k])))throw Error('Fresh firmware coordinates required');
 const modelAgreementMm=Math.hypot(...['x','y','z'].map(k=>from[k]-cartesian[k]));
 if(modelAgreementMm>1)throw Error('Firmware coordinates disagree with geometry');
 return {experiment,movementJoint:joint,start,target,command,servoTargets:{[joint]:targetTick},heldServoTicks:Object.fromEntries(JOINT_NAMES.filter(k=>k!==joint).map(k=>[k,ticks[k]])),
  commandRevision:policy.shared?SHARED_COMMAND_REVISION:OTHER_COMMAND_REVISION,modelRevision:Z_LIFT_MODEL_REVISION,toolMode:'EEMode 0',envelopeRevision:policy.envelopeRevision,envelope,
  delta:Object.fromEntries(JOINT_NAMES.map(k=>[k,target[k]-start[k]])),from,goal,liftMm:null,predictedRiseMm:goal.z-from.z,modelAgreementMm,
  speedStepsPerSecond:20,acceleration:1,durationMs:policy.durationMs,observationWindowMs:policy.observationWindowMs,physicalPathVerified:false,
  limitations:'One uncompensated joint command. All other joints held. No automatic retry or return.'};
}
export function validateOtherFeedback(joints,plan){
 validateObservedJoints(joints);
 if(!isOtherExperiment(plan.experiment)||plan.movementJoint!==jointFor(plan.experiment)||plan.envelopeRevision!==otherExperimentPolicy(plan.experiment).envelopeRevision)throw Error('Other-joint plan mismatch');
 const active=plan.movementJoint,commandTarget=(plan.baseFeedforward||plan.finiteBaseWave||plan.visibleBaseWave||(plan.finiteElbowGesture&&plan.commandTarget))?plan.commandTarget:plan.target,direction=Math.sign(commandTarget[active]-plan.start[active]);
 if((joints[active]-plan.start[active])*direction<-(SERVO_STEP+1e-9))throw Error('Wrong-direction joint movement; reconcile before continuing');
 for(const k of JOINT_NAMES){
  const tolerance=k===plan.movementJoint?Z_LIFT_POLICY.trackingRad:SERVO_STEP+1e-9;
  if(joints[k]<Math.min(plan.start[k],commandTarget[k])-tolerance||joints[k]>Math.max(plan.start[k],commandTarget[k])+tolerance)throw Error('Unexpected joint displacement; physical intervention may be required');
 }
 const gesture=plan.gestureCompletion;if(gesture&&(plan.experiment!==DRAMATIC_WAVE_EXPERIMENT||gesture.revision!=='expressive-settling-v1'||gesture.endpointToleranceTicks!==4||gesture.heldJointTicks!==1||4*SERVO_STEP>Z_LIFT_POLICY.trackingRad))throw Error('Invalid scoped gesture endpoint tolerance');
 const preciseArrival=JOINT_NAMES.every(k=>Math.abs(joints[k]-plan.target[k])<=Z_LIFT_POLICY.arrivalRad);
 const withinTarget=gesture?JOINT_NAMES.every(k=>Math.abs(joints[k]-plan.target[k])<=(k===active?4*SERVO_STEP:SERVO_STEP)+1e-9):preciseArrival;
 return {withinTarget,preciseArrival,estimatedRiseMm:forward(joints).z-plan.from.z};
}
export function classifyOtherSettling(observations,plan){
 if(!Array.isArray(observations)||observations.length<8)throw Error('Insufficient settling observations');
 const last=observations.at(-1),end=Date.parse(last.observedAt),window=observations.filter(s=>end-Date.parse(s.observedAt)<=1600);
 if(window.length<8||end-Date.parse(window[0].observedAt)<1200)throw Error('Insufficient final settling dwell');
 for(const s of observations)validateOtherFeedback(s.joints,plan);
 for(const k of JOINT_NAMES)if(window.some(s=>Math.abs(s.joints[k]-last.joints[k])>SERVO_STEP+1e-9))throw Error('Arm has not settled');
 const observation=validateOtherFeedback(last.joints,plan),movementTicks=Math.abs(last.joints[plan.movementJoint]-plan.start[plan.movementJoint])/SERVO_STEP;
 return {outcome:observation.withinTarget?'telemetry-reached':movementTicks>1?'telemetry-settled-off-target':'telemetry-no-motion',preciseArrival:observation.preciseArrival,...(plan.gestureCompletion?{gestureArrival:observation.withinTarget,endpointToleranceTicks:4}:{}),settled:true,
  settlingToleranceTicks:1,settlingDwellMs:end-Date.parse(window[0].observedAt),signedEndpointErrorRad:last.joints[plan.movementJoint]-plan.target[plan.movementJoint],observed:{...last.joints},estimatedRiseMm:observation.estimatedRiseMm,requiresReconciliation:movementTicks<=1};
}
