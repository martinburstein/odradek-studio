import {tabletopGeometryPolicy,TABLETOP_CLEARANCE_REVISION} from './training-envelope.mjs';
import {createHash} from 'node:crypto';
import {SERVO_STEP,observedTicks} from './z-lift-actuators.mjs';
import {RESET_POSE,adjacentLinkSeparationMm} from './other-joint-plan.mjs';
import {trainingBodyBounds} from './training-envelope.mjs';
const memo=new Map();const gap=(a,b)=>Math.max(...[0,1,2].map(k=>Math.max(a.min[k]-b.max[k],b.min[k]-a.max[k])));
const range=(lo,hi)=>{const n=Math.max(1,Math.ceil((hi-lo)/.004));return Array.from({length:n+1},(_,i)=>lo+(hi-lo)*i/n);};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Full swept conservative body check from actual command tick through desired endpoint, with ±0.0465 rad + one-tick uncertainty. */
export function elbowFeedforwardGeometry({start,desiredTick,commandTick,currentPoseQualified=false}){
 if(!start||!['base','shoulder','elbow','gripper'].every(k=>Number.isFinite(start[k]))||!Number.isInteger(desiredTick)||!Number.isInteger(commandTick))throw Error('Finite complete start pose and exact feedback ticks required');
 const ticks=observedTicks(start);
 // Current-pose admission is separately proof-bound by the wave validator.
 // This option never removes the uncertainty or whole-path clearance checks.
 const shoulderOK=currentPoseQualified===true ? ticks.shoulder>=2052&&ticks.shoulder<=2060 : Math.abs(start.shoulder-RESET_POSE.shoulder)<=SERVO_STEP+1e-9;
 if(Math.abs(start.base)>.12||!shoulderOK||Math.abs(start.gripper-RESET_POSE.gripper)>SERVO_STEP+1e-9)throw Error('Base, shoulder or gripper is outside the held reset envelope');
 const key=hash({start,desiredTick,commandTick});if(memo.has(key))return memo.get(key);
 const u=.0465+SERVO_STEP,startTick=observedTicks(start).elbow,elbowLo=Math.min(startTick,desiredTick,commandTick)*SERVO_STEP-Math.PI/2,elbowHi=Math.max(startTick,desiredTick,commandTick)*SERVO_STEP-Math.PI/2;
 const ss=range(start.shoulder-u,start.shoulder+u),es=range(elbowLo-u,elbowHi+u),gs=range(start.gripper-u,start.gripper+u);
 let upper=Infinity,distal=Infinity,finger=Infinity,separation=Infinity,count=0;
 for(const e of es){separation=Math.min(separation,adjacentLinkSeparationMm(e));for(const g of gs){const b=trainingBodyBounds({...start,shoulder:0,elbow:e,gripper:g});separation=Math.min(separation,gap(b.upper,b.finger));}}
 for(const s of ss)for(const e of es)for(const g of gs){const b=trainingBodyBounds({...start,shoulder:s,elbow:e,gripper:g});count++;upper=Math.min(upper,b.upperFree.min[2]);distal=Math.min(distal,b.distal.min[2]);finger=Math.min(finger,b.finger.min[2]);separation=Math.min(separation,gap(b.mount,b.distal),gap(b.mount,b.finger));}
 const floorPolicy=tabletopGeometryPolicy();upper+=floorPolicy.modelHeightOffsetMm;distal+=floorPolicy.modelHeightOffsetMm;finger+=floorPolicy.modelHeightOffsetMm;
 if(upper<floorPolicy.requiredBodyHeightMm||distal<floorPolicy.requiredBodyHeightMm||finger<floorPolicy.requiredBodyHeightMm||separation<24)throw Error('Command-path elbow geometry fails actual tabletop plane / 24 mm separation');
 const result=Object.freeze({revision:'directional-elbow-feedforward-command-path-geometry-v1',...floorPolicy.fields,plane:floorPolicy.plane,wholeCommandPathChecked:true,uncertaintyRad:u,maximumGridStepRad:.004,gridConfigurations:count,minimumBodyHeightMm:{upperFree:upper,distal,finger},requiredBodyHeightMm:floorPolicy.requiredBodyHeightMm,minimumSelfSeparationMm:separation,requiredSelfSeparationMm:24,desiredTick,commandTick,limitations:['Base-relative model does not verify external workspace, cables, contact, or a physical stop.']});memo.set(key,result);return result;
}
