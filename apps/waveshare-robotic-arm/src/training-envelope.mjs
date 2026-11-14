import {validateObservedJoints} from './safety.mjs';
// Outward-rounded AABBs of every vertex in the archived vendor collision STL.
// mm; URDF revision f06b2ed6c1ddc5b7690975fdbba84aab626a2229.
// The source model does not measure the installed arm or its flexible cables.
export const TRAINING_ENVELOPE_REVISION='shoulder-plane-stock-cad-v1';
export const TABLETOP_CLEARANCE_REVISION='actual-tabletop-zero-training-gap-v2';
export const TABLETOP_MODEL_ORIGIN_MM=123.059270461;
// Fresh planning uses the actual table plane. The retired 17mm value exists
// only for explicitly replaying/validating immutable historical evidence.
export function tabletopGeometryPolicy({historical=false,alreadyTabletop=false,positionUncertaintyMm=5,remainderMm=2}={}){
 return {requiredBodyHeightMm:historical?17:0,modelHeightOffsetMm:historical||alreadyTabletop?0:TABLETOP_MODEL_ORIGIN_MM-positionUncertaintyMm-remainderMm,
  plane:historical?'shoulder-pivot-height':'tabletop',fields:historical?{}:{tabletopClearanceRevision:TABLETOP_CLEARANCE_REVISION}};
}
export function recordedTabletopFloor(geometry){
 if(geometry?.tabletopClearanceRevision===TABLETOP_CLEARANCE_REVISION&&geometry.requiredBodyHeightMm===0)return 0;
 if(geometry?.tabletopClearanceRevision===undefined&&geometry?.requiredBodyHeightMm===17)return 17;
 return null;
}
export const TRAINING_ENVELOPE_POLICY=Object.freeze({
  floorMm:0,clearanceMm:10,positionUncertaintyMm:5,angleUncertaintyRad:0.04,
  interpolationStepRad:0.004,trackingRad:0.0065,
  shoulderAttachmentLengthMm:20,elbowJointCollarLengthMm:60,
  elbowMin:1.38,elbowMax:1.62,shoulderAbsMax:0.03,baseAbsMax:0.04,
  gripperMin:3.12,gripperMax:3.16
});
const boxes={
 mount:{min:[-27.4,-36.3,-39.5],max:[27.4,36.3,10.2]},
 upper:{min:[-10.1,-15.6,-39.7],max:[246.9,40.1,39.5]},
 distal:{min:[-15.6,-283.9,-18.7],max:[20.1,10.2,30.2]},
 finger:{min:[-10.1,-9.9,-20.5],max:[67.9,15.5,19.0]}
};
const multiply=(a,b)=>{
 const result=Array.from({length:4},()=>new Array(4));
 for(let i=0;i<4;i++)for(let j=0;j<4;j++){
  let sum=0;for(let k=0;k<4;k++)sum+=a[i][k]*b[k][j];result[i][j]=sum;
 }
 return result;
};
const transform=(xyz,[r,p,y])=>{
 const [sr,cr,sp,cp,sy,cy]=[Math.sin(r),Math.cos(r),Math.sin(p),Math.cos(p),Math.sin(y),Math.cos(y)];
 return [[cy*cp,cy*sp*sr-sy*cr,cy*sp*cr+sy*sr,xyz[0]],[sy*cp,sy*sp*sr+cy*cr,sy*sp*cr-cy*sr,xyz[1]],[-sp,cp*sr,cp*cr,xyz[2]],[0,0,0,1]];
};
const corners=box=>[0,1].flatMap(a=>[0,1].flatMap(b=>[0,1].map(c=>[a,b,c].map((v,k)=>v?box.max[k]:box.min[k]))));
// These vendor-local vertices and fixed transforms do not depend on a pose.
// Keep them private; transformed bounds below still allocate independent arrays.
const upperFreeBox={...boxes.upper,min:[20,...boxes.upper.min.slice(1)]};
const distalBeyondJointBox={...boxes.distal,max:[boxes.distal.max[0],-60,boxes.distal.max[2]]};
const localVertices=new Map([boxes.upper,upperFreeBox,boxes.distal,distalBeyondJointBox,boxes.finger].map(box=>[box,corners(box)]));
const shoulderOrigin=transform([0,0,0],[-Math.PI/2,-Math.PI/2,0]);
const fingerOrigin=transform([2.906,-215.99,-0.66683],[-1.5708,0,-1.5708]);
const transformed=(box,matrix)=>{
 const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
 for(const point of localVertices.get(box))for(let axis=0;axis<3;axis++){
  let value=0;for(let k=0;k<4;k++)value+=matrix[axis][k]*(k===3?1:point[k]);
  min[axis]=Math.min(min[axis],value);max[axis]=Math.max(max[axis],value);
 }
 return {min,max};
};
// Work in a frame rotated with the held base. This preserves heights and
// collision distances, and avoids weakening a box-separation test with yaw.
let lastArmFrame=null;
const copyBounds=box=>({min:[...box.min],max:[...box.max]});
export function trainingBodyBounds(joints){
 validateObservedJoints(joints);
 const shoulderValue=joints.shoulder,elbowValue=joints.elbow;
 if(!lastArmFrame||!Object.is(lastArmFrame.shoulderValue,shoulderValue)||!Object.is(lastArmFrame.elbowValue,elbowValue)){
  const shoulder=multiply(shoulderOrigin,transform([0,0,0],[0,0,shoulderValue]));
  const elbow=multiply(shoulder,transform([236.815132922094,30.0023995170449,0],[0,0,Math.PI/2+elbowValue]));
  lastArmFrame={shoulderValue,elbowValue,elbow,upper:transformed(boxes.upper,shoulder),upperFree:transformed(upperFreeBox,shoulder),distal:transformed(boxes.distal,elbow),distalBeyondJoint:transformed(distalBeyondJointBox,elbow)};
 }
 // The inner grid changes only the gripper. Keep the exact shoulder/elbow
 // calculation private, and return fresh arrays so callers cannot alter it.
 const frame=lastArmFrame;
 const finger=multiply(frame.elbow,multiply(fingerOrigin,transform([0,0,0],[0,0,Math.PI-joints.gripper])));
 return {mount:{min:[...boxes.mount.min],max:[...boxes.mount.max]},upper:copyBounds(frame.upper),
   upperFree:copyBounds(frame.upperFree),
   distal:copyBounds(frame.distal),
   distalBeyondJoint:copyBounds(frame.distalBeyondJoint),
   finger:transformed(boxes.finger,finger)};
}
const separation=(a,b)=>Math.max(...[0,1,2].map(k=>Math.max(a.min[k]-b.max[k],b.min[k]-a.max[k])));
const range=(lo,hi,step)=>{const n=Math.max(1,Math.ceil((hi-lo)/step));return Array.from({length:n+1},(_,i)=>lo+(hi-lo)*i/n);};
export function validateTrainingTrajectory(start,target){
 validateObservedJoints(start);validateObservedJoints(target);
 const p=TRAINING_ENVELOPE_POLICY;
 for(const name of ['base','shoulder','gripper'])if(start[name]!==target[name])throw Error('Training envelope permits elbow motion only');
 for(const pose of [start,target])if(Math.abs(pose.base)>p.baseAbsMax||Math.abs(pose.shoulder)>p.shoulderAbsMax||pose.elbow<p.elbowMin||pose.elbow>p.elbowMax||pose.gripper<p.gripperMin||pose.gripper>p.gripperMax)throw Error('Pose outside narrow training envelope');
 // Check the entire elbow interval, enlarged at both ends for tracking error
 // and coordinate uncertainty. Sample uncertainty in held shoulder and hand.
 // A Lipschitz remainder covers ALL intermediate grid configurations: for
 // each point, shoulder radius<=550, elbow radius<=350, hand radius<=100 mm.
 const u=p.angleUncertaintyRad+p.trackingRad,step=p.interpolationStepRad;
 const remainderMm=(550+350+100)*step/2;
 const floorPolicy=tabletopGeometryPolicy({positionUncertaintyMm:p.positionUncertaintyMm,remainderMm}),floorRequired=floorPolicy.requiredBodyHeightMm;
 const separationRequired=p.clearanceMm+2*p.positionUncertaintyMm+2*remainderMm;
 const minima={upperFree:Infinity,distal:Infinity,finger:Infinity};let gap=Infinity,count=0;
 const shoulders=range(start.shoulder-u,start.shoulder+u,step);
 const elbows=range(Math.min(start.elbow,target.elbow)-u,Math.max(start.elbow,target.elbow)+u,step);
 // The gripper is held; cover its geometric uncertainty with endpoint AND
 // interior samples, not merely the two endpoint orientations.
 const hands=range(start.gripper-u,start.gripper+u,step);
 for(const shoulder of shoulders)for(const elbow of elbows)for(const gripper of hands){
  const b=trainingBodyBounds({...start,shoulder,elbow,gripper});count++;
  for(const key of Object.keys(minima))minima[key]=Math.min(minima[key],b[key].min[2]+floorPolicy.modelHeightOffsetMm);
  gap=Math.min(gap,separation(b.upper,b.distalBeyondJoint),separation(b.upper,b.finger),separation(b.mount,b.distal),separation(b.mount,b.finger));
 }
 if(Object.values(minima).some(z=>z<floorRequired))throw Error('Whole-body floor margin is insufficient');
 if(gap<separationRequired)throw Error('Self-collision separation margin is insufficient');
 return {revision:TRAINING_ENVELOPE_REVISION,plane:floorPolicy.plane,...floorPolicy.fields,
   wholeIntervalChecked:true,gridConfigurations:count,interpolationRemainderMm:remainderMm,
   minimumBodyHeightMm:minima,requiredBodyHeightMm:floorRequired,
   minimumSelfSeparationMm:gap,requiredSelfSeparationMm:separationRequired,
   physicalGeometryVerified:false,
   exceptions:['Existing shoulder attachment within first 20 mm of upper-link local axis; shoulder held',
     'Designed elbow joint collar within first 60 mm of distal link excluded only from adjacent upper-link collision comparison'],
   limitations:['Stock vendor rigid-body bounds; installed geometry and cables require operator inspection',
     'No independent physical stop; active operator supervision required']};
}
