import {MM_SCALE} from '../rig.js';
import {toolGeometry,referenceIK,padPoint} from './geometry.js';

// Framing data for the existing Bot Crossing CameraRig, never another camera
// or navigation controller. Include the deck and nominal working poses so low
// stylus trials do not inherit Manual's upright-arm framing.
export function learningFramePoints(experiment){
 const {desk,tool,frame,seedPose,gripper}=experiment,points=[];
 const put=p=>points.push({x:p.x*MM_SCALE,y:p.y*MM_SCALE,z:p.z*MM_SCALE});
 for(const x of [-45,45])for(const z of [-45,45])for(const y of [0,126.06])put({x,y,z});
 const yaw=desk.laptopYaw*Math.PI/180,c=Math.cos(yaw),s=Math.sin(yaw);
 for(const x of [-desk.laptopWidth/2,desk.laptopWidth/2])for(const z of [-desk.laptopDepth/2,desk.laptopDepth/2])put({x:desk.laptopX+c*x+s*z,y:desk.laptopHeight,z:desk.laptopZ-s*x+c*z});
 const poses=[seedPose];
 for(const u of [0,.5,1])for(const v of [0,.5,1])for(const height of [0,12])poses.push(...referenceIK(padPoint(frame,u,v,height),tool,gripper));
 for(const pose of poses){const geometry=toolGeometry(pose,tool);for(const key of ['shoulder','elbow','wrist','front','rear'])put(geometry[key]);}
 return points;
}

export function fitLearningFrame(points,{width,height,fov,rectangle,azimuth=-.62,polar=.94,maxDistance=100}){
 if(!Array.isArray(points)||!points.length||points.some(p=>![p.x,p.y,p.z].every(Number.isFinite)))throw Error('Framing needs finite scene points.');
 if(![width,height,fov,maxDistance,azimuth,polar,rectangle?.left,rectangle?.right,rectangle?.top,rectangle?.bottom].every(Number.isFinite)||width<=0||height<=0||fov<=0||fov>=180||maxDistance<4)throw Error('Invalid learning viewport.');
 const {left,right,top,bottom}=rectangle;
 if(!(left>=0&&right<=width&&top>=0&&bottom<=height&&right>left&&bottom>top))throw Error('Learning viewport rectangle must fit inside the canvas.');
 const center={};for(const key of ['x','y','z'])center[key]=(Math.min(...points.map(p=>p[key]))+Math.max(...points.map(p=>p[key])))/2;
 const sin=Math.sin(azimuth),cos=Math.cos(azimuth),sp=Math.sin(polar),cp=Math.cos(polar),basis={right:{x:cos,y:0,z:-sin},up:{x:-cp*sin,y:sp,z:-cp*cos},back:{x:sp*sin,y:cp,z:sp*cos}};
 const dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z,k=height/(2*Math.tan(fov*Math.PI/360));
 const local=points.map(point=>{const delta={x:point.x-center.x,y:point.y-center.y,z:point.z-center.z};return{right:dot(delta,basis.right),up:dot(delta,basis.up),back:dot(delta,basis.back)};});
 // At a fixed distance each point gives an interval of valid right/up target
 // shifts. Their intersection finds the closest fit without empty space caused
 // by centering a world-space box instead of the projected working scene.
 const intervals=distance=>{
  let xLow=-Infinity,xHigh=Infinity,yLow=-Infinity,yHigh=Infinity,depthValid=true;
  for(const point of local){const depth=distance-point.back;if(depth<=.5)depthValid=false;
   xLow=Math.max(xLow,point.right-(right-width/2)*depth/k);xHigh=Math.min(xHigh,point.right-(left-width/2)*depth/k);
   yLow=Math.max(yLow,point.up+(top-height/2)*depth/k);yHigh=Math.min(yHigh,point.up+(bottom-height/2)*depth/k);
  }
  return{x:(xLow+xHigh)/2,y:(yLow+yHigh)/2,fits:depthValid&&xLow<=xHigh&&yLow<=yHigh};
 };
 let low=4,high=maxDistance;const fitted=intervals(high).fits;
 if(fitted)for(let n=0;n<32;n++){const mid=(low+high)/2;if(intervals(mid).fits)high=mid;else low=mid;}
 const shift=intervals(high),target=Object.fromEntries(['x','y','z'].map(key=>[key,center[key]+basis.right[key]*shift.x+basis.up[key]*shift.y]));
 return{target,distance:high,azimuth,polar,fitted};
}

export function captureRigView(rig){return{target:rig.target.clone(),desiredTarget:rig.desiredTarget.clone(),distance:rig.distance,desiredDistance:rig.desiredDistance,azimuth:rig.azimuth,desiredAzimuth:rig.desiredAzimuth,polar:rig.polar,desiredPolar:rig.desiredPolar,orbiting:rig.orbiting};}
export function restoreRigView(rig,view){
 rig.focus(view.desiredTarget,{distance:view.desiredDistance,elevated:true});rig.setOrbit(view.orbiting);
 for(const key of ['target','desiredTarget'])rig[key].copy(view[key]);
 for(const key of ['distance','desiredDistance','azimuth','desiredAzimuth','polar','desiredPolar'])rig[key]=view[key];
 rig.update(0);
}
