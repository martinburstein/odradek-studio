import {forwardKinematics} from './kinematics.mjs';
import {validateObservedJoints} from './safety.mjs';
import {observedTicks,feedbackAtTicks,elbowCommandForTick} from './z-lift-actuators.mjs';
import {Z_LIFT_MODEL_REVISION,JOINT_NAMES,Z_LIFT_POLICY} from './z-lift-plan.mjs';

export const VISIBLE_ELBOW_EXPERIMENT='visible-elbow-57-ticks-v1';
export const TEN_DEGREE_ELBOW_EXPERIMENT='visible-elbow-114-ticks-v1';
const policies={
 [VISIBLE_ELBOW_EXPERIMENT]:{ticks:57,elbow:[1.55,1.65],rise:[22,26],lateral:4,monitorRise:28,monitorLateral:6,arrivalRise:20},
 [TEN_DEGREE_ELBOW_EXPERIMENT]:{ticks:114,elbow:[1.5,1.55],rise:[46,50],lateral:6,monitorRise:52,monitorLateral:8,arrivalRise:40}
};
export const isVisibleElbowExperiment=value=>Object.hasOwn(policies,value);
const policyFor=value=>{if(!isVisibleElbowExperiment(value))throw Error('Unsupported visible elbow experiment');return policies[value];};
const forward=j=>forwardKinematics(j,Z_LIFT_MODEL_REVISION);
// A separate, explicitly reviewed diagnostic step. The 2 mm policy is unchanged.
export function planVisibleElbow(input,cartesian,experiment=VISIBLE_ELBOW_EXPERIMENT){
 const policy=policyFor(experiment);
 const start=validateObservedJoints(input),ticks=observedTicks(start);
 if(Math.abs(start.base)>0.05||Math.abs(start.shoulder)>0.05||start.elbow<policy.elbow[0]||start.elbow>policy.elbow[1]||start.gripper<3.1||start.gripper>3.2)throw Error('Visible elbow experiment requires the reviewed startup region');
 const tick=ticks.elbow-policy.ticks,command=elbowCommandForTick(tick);
 const target={...start,elbow:feedbackAtTicks({...ticks,elbow:tick}).elbow};
 const from=forward(start),goal=forward(target);
 if(!cartesian||!['x','y','z'].every(k=>Number.isFinite(cartesian[k])))throw Error('Fresh firmware coordinates required');
 const modelAgreementMm=Math.hypot(...['x','y','z'].map(k=>from[k]-cartesian[k]));
 if(modelAgreementMm>1)throw Error('Firmware coordinates disagree with the pinned geometry');
 let maxLateralMm=0,minRiseMm=0,maxRiseMm=0;
 for(let i=0;i<=100;i++){const p=forward({...start,elbow:start.elbow+(target.elbow-start.elbow)*i/100});maxLateralMm=Math.max(maxLateralMm,Math.hypot(p.x-from.x,p.y-from.y));minRiseMm=Math.min(minRiseMm,p.z-from.z);maxRiseMm=Math.max(maxRiseMm,p.z-from.z);}
 if(minRiseMm<0||maxRiseMm>policy.rise[1]||goal.z-from.z<policy.rise[0]||maxLateralMm>policy.lateral)throw Error('Visible elbow path is outside its reviewed envelope');
 return {experiment,start,target,command,servoTargets:{elbow:tick},heldServoTicks:{base:ticks.base,shoulder:ticks.shoulder,gripper:ticks.gripper},commandRevision:'roarm-m2-260630-t101-elbow-v1',modelRevision:Z_LIFT_MODEL_REVISION,toolMode:'EEMode 0',delta:Object.fromEntries(JOINT_NAMES.map(k=>[k,target[k]-start[k]])),from,goal,liftMm:null,predictedRiseMm:goal.z-from.z,modelAgreementMm,sampledPath:{maxLateralMm,minRiseMm,maxRiseMm},speedStepsPerSecond:20,acceleration:1,durationMs:8000,physicalPathVerified:false,limitations:'One fixed elbow step, not an upright pose. No automatic return, repeat or continuation. Source-based travel prediction only.'};
}
export function validateVisibleElbowFeedback(joints,plan){
 const policy=policyFor(plan.experiment);
 if(plan.modelRevision!==Z_LIFT_MODEL_REVISION)throw Error('Wrong visible elbow experiment');
 validateObservedJoints(joints);
 for(const key of JOINT_NAMES)if(joints[key]<Math.min(plan.start[key],plan.target[key])-Z_LIFT_POLICY.trackingRad||joints[key]>Math.max(plan.start[key],plan.target[key])+Z_LIFT_POLICY.trackingRad)throw Error('Unexpected joint displacement; physical intervention may be required');
 const point=forward(joints),rise=point.z-plan.from.z;
 if(rise< -1||rise>policy.monitorRise||Math.hypot(point.x-plan.from.x,point.y-plan.from.y)>policy.monitorLateral)throw Error('Observed joints imply unexpected travel; physical intervention may be required');
 return {estimatedRiseMm:rise,withinTarget:rise>policy.arrivalRise&&JOINT_NAMES.every(k=>Math.abs(joints[k]-plan.target[k])<=Z_LIFT_POLICY.arrivalRad)};
}
