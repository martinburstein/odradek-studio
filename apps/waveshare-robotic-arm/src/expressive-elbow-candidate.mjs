import {tabletopGeometryPolicy,TABLETOP_CLEARANCE_REVISION} from './training-envelope.mjs';
// Offline geometry candidate only. It cannot admit or send a hardware command.
import {trainingBodyBounds} from './training-envelope.mjs';
import {adjacentLinkSeparationMm,RESET_POSE} from './other-joint-plan.mjs';
import {SERVO_STEP} from './z-lift-actuators.mjs';
const samples=(lo,hi)=>{const n=Math.max(1,Math.ceil((hi-lo)/.004));return Array.from({length:n+1},(_,i)=>lo+(hi-lo)*i/n);};
const gap=(a,b)=>Math.max(...[0,1,2].map(k=>Math.max(a.min[k]-b.max[k],b.min[k]-a.max[k])));
export function expressiveElbowCandidate(start,endDegrees=120){
 if(!start||!['base','shoulder','elbow','gripper'].every(k=>Number.isFinite(start[k]))||Math.abs(start.base)>.12||['shoulder','elbow','gripper'].some(k=>Math.abs(start[k]-RESET_POSE[k])>SERVO_STEP+1e-9))throw Error('Exact reset-pose candidate start required');
 const end=endDegrees*Math.PI/180;
 if(!Number.isFinite(end)||end<=start.elbow||end-start.elbow>45*Math.PI/180)throw Error('One forward elbow candidate within 45 degrees required');
 const u=.0465+SERVO_STEP,ss=samples(start.shoulder-u,start.shoulder+u),es=samples(start.elbow-u,end+u),gs=samples(start.gripper-u,start.gripper+u);
 const minima={upperFree:Infinity,distal:Infinity,finger:Infinity};let separation=Infinity,count=0;
 for(const elbow of es){separation=Math.min(separation,adjacentLinkSeparationMm(elbow));for(const gripper of gs){const b=trainingBodyBounds({...start,shoulder:0,elbow,gripper});separation=Math.min(separation,gap(b.upper,b.finger));}}
 for(const shoulder of ss)for(const elbow of es)for(const gripper of gs){const b=trainingBodyBounds({...start,shoulder,elbow,gripper});count++;for(const k of Object.keys(minima))minima[k]=Math.min(minima[k],b[k].min[2]);separation=Math.min(separation,gap(b.mount,b.distal),gap(b.mount,b.finger));}
 const floorPolicy=tabletopGeometryPolicy();
 for(const k of Object.keys(minima))minima[k]+=floorPolicy.modelHeightOffsetMm;
 const geometry={...floorPolicy.fields,plane:floorPolicy.plane,uncertaintyRad:u,maximumGridStepRad:.004,gridConfigurations:count,minimumBodyHeightMm:minima,requiredBodyHeightMm:floorPolicy.requiredBodyHeightMm,minimumSelfSeparationMm:separation,requiredSelfSeparationMm:24};
 if(Object.values(minima).some(v=>v<floorPolicy.requiredBodyHeightMm)||separation<24)throw Error('Elbow candidate fails unchanged whole-body clearance margins');
 return {revision:'offline-expressive-elbow-candidate-v1',start:{...start},target:{...start,elbow:end},elbowStartDegrees:start.elbow*180/Math.PI,elbowEndDegrees:endDegrees,changeDegrees:(end-start.elbow)*180/Math.PI,geometry,dispatchEligible:false,physicalGeometryVerified:false,requirements:['Resolve the existing movement lock through the reviewed procedure.','Independently review and commission a finite elbow scope; existing reset-wave scope holds elbow fixed.','Fresh supervised state, cable/workspace inspection and in-memory camera before movement.'],noAutomaticReturn:true};
}
