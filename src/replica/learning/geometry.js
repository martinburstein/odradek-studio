// Pure simulator geometry. No Controller, transport, device or network imports.
// Same Type-0 dimensions and coordinate convention as the existing replica.
export const DEG = Math.PI / 180;
export const ARM = Object.freeze({height:126.06, upper:Math.hypot(236.82,30), distal:Math.hypot(280.15,1.73), upperOffset:Math.atan2(30,236.82), distalOffset:Math.atan2(1.73,280.15)});
export const AXES = Object.freeze(['base','shoulder','elbow']);
export const JOINT_LIMITS = Object.freeze({base:[-Math.PI,Math.PI],shoulder:[-Math.PI/2,Math.PI/2],elbow:[0,Math.PI]});
export const DEFAULT_TOOL = Object.freeze({frontReach:107.5,rearReach:42.5,mountPitch:0,lateralOffset:1.2,end:'front',targetTilt:45,tapeRadius:5.5,barrelRadius:3.4,nibRadius:1.5});
const finite=(value,name)=>{if(typeof value!=='number'||!Number.isFinite(value))throw Error(`${name} must be finite.`);return value;};
export const clamp=(value,lo,hi)=>Math.max(lo,Math.min(hi,value));
export const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
export function validateTool(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!Object.hasOwn(DEFAULT_TOOL,k)))throw Error('Unknown stylus setting.');
 const tool={...DEFAULT_TOOL,...input};
 for(const [key,lo,hi]of [['frontReach',20,220],['rearReach',5,150],['mountPitch',-90,90],['lateralOffset',-30,30],['targetTilt',5,85],['tapeRadius',2,15],['barrelRadius',1,8],['nibRadius',.2,8]])if(finite(tool[key],key)<lo||tool[key]>hi)throw Error(`${key} must be between ${lo} and ${hi}.`);
 if(!['front','rear'].includes(tool.end))throw Error('Choose the front or rear stylus end.');
 if(tool.nibRadius>tool.barrelRadius||tool.tapeRadius<tool.barrelRadius)throw Error('Stylus radii must fit the barrel and tape.');
 return tool;
}
export function requirePose(pose){for(const key of AXES)finite(pose?.[key],key);finite(pose?.gripper,'gripper');return pose;}
export function pointAt(radial,height,base){return{x:radial*Math.sin(base),y:height,z:radial*Math.cos(base)};}
export function toolGeometry(pose,configuration=DEFAULT_TOOL){
 requirePose(pose);const tool=configuration,s=pose.shoulder+ARM.upperOffset,d=pose.shoulder+pose.elbow+ARM.distalOffset,a=d+tool.mountPitch*DEG;
 const upperRadial=ARM.upper*Math.sin(s),upperY=ARM.height+ARM.upper*Math.cos(s),radial=upperRadial+ARM.distal*Math.sin(d),height=upperY+ARM.distal*Math.cos(d);
 const origin=pointAt(radial,height,pose.base),along={x:Math.sin(a)*Math.sin(pose.base),y:Math.cos(a),z:Math.sin(a)*Math.cos(pose.base)};
 const endpoint=length=>pointAt(radial+length*Math.sin(a)+tool.lateralOffset*Math.cos(a),height+length*Math.cos(a)-tool.lateralOffset*Math.sin(a),pose.base);
 const front=endpoint(tool.frontReach),rear=endpoint(-tool.rearReach);
 return{shoulder:{x:0,y:ARM.height,z:0},elbow:pointAt(upperRadial,upperY,pose.base),wrist:origin,front,rear,tip:tool.end==='front'?front:rear,axis:along,tilt:Math.asin(clamp(Math.abs(along.y),0,1))/DEG,distalAngle:d/DEG};
}
export function trackpadFrame(desk){
 const yaw=desk.laptopYaw*DEG,c=Math.cos(yaw),s=Math.sin(yaw),localX=-.3/.035*(desk.laptopWidth/(11.25/.035)),localZ=2.05/.035*(desk.laptopDepth/(7.42/.035));
 return{center:{x:desk.laptopX+c*localX+s*localZ,y:desk.laptopHeight+(.19+.0125-.202)/.035,z:desk.laptopZ-s*localX+c*localZ},yaw,width:desk.trackpadWidth,depth:desk.trackpadDepth,cos:c,sin:s};
}
export function padPoint(frame,u,v,height=0){const x=(u-.5)*frame.width,z=(v-.5)*frame.depth;return{x:frame.center.x+frame.cos*x+frame.sin*z,y:frame.center.y+height,z:frame.center.z-frame.sin*x+frame.cos*z};}
export function padCoordinates(frame,point){const x=point.x-frame.center.x,z=point.z-frame.center.z;return{u:(frame.cos*x-frame.sin*z)/frame.width+.5,v:(frame.sin*x+frame.cos*z)/frame.depth+.5,gap:point.y-frame.center.y};}

// Independent exact-position reference, never used inside the learned policy.
// It makes unavoidable angle/position compromises inspectable.
export function referenceIK(target,tool=DEFAULT_TOOL,gripper=154*DEG){
 const length=tool.end==='front'?tool.frontReach:-tool.rearReach,m=tool.mountPitch*DEG,A=ARM.distal+length*Math.cos(m)-tool.lateralOffset*Math.sin(m),B=length*Math.sin(m)+tool.lateralOffset*Math.cos(m),link=Math.hypot(A,B),offset=Math.atan2(B,A);
 const radial=Math.hypot(target.x,target.z),height=target.y-ARM.height,cos=(radial*radial+height*height-ARM.upper**2-link**2)/(2*ARM.upper*link);
 if(radial<1e-8||cos< -1||cos>1)return[];
 return[1,-1].map(sign=>{const relative=sign*Math.acos(clamp(cos,-1,1)),shoulder=Math.atan2(radial,height)-Math.atan2(link*Math.sin(relative),ARM.upper+link*Math.cos(relative))-ARM.upperOffset;return{base:Math.atan2(target.x,target.z),shoulder,elbow:relative+ARM.upperOffset-ARM.distalOffset-offset,gripper};}).filter(pose=>AXES.every(key=>pose[key]>=JOINT_LIMITS[key][0]&&pose[key]<=JOINT_LIMITS[key][1]));
}
export function geometryContacts(geometry,desk,frame,tool=DEFAULT_TOOL){
 const contact=padCoordinates(frame,geometry.tip),inside=contact.u>=0&&contact.u<=1&&contact.v>=0&&contact.v<=1;
 const deck=point=>{const dx=point.x-desk.laptopX,dz=point.z-desk.laptopZ,c=frame.cos,s=frame.sin;return Math.abs(c*dx-s*dz)<desk.laptopWidth/2&&Math.abs(s*dx+c*dz)<desk.laptopDepth/2;};
 // Capsule samples are a transparent approximation, not a calibrated collision mesh.
 let bodyCollision=false,tableCollision=false;
 for(const [a,b,radius]of [[geometry.shoulder,geometry.elbow,17],[geometry.elbow,geometry.wrist,15],[geometry.wrist,geometry.wrist,20]])for(let n=0;n<=8;n++){
  const p={x:a.x+(b.x-a.x)*n/8,y:a.y+(b.y-a.y)*n/8,z:a.z+(b.z-a.z)*n/8};
  if(p.y-radius<0)tableCollision=true;
  if(deck(p)&&p.y-radius<desk.laptopHeight)bodyCollision=true;
 }
 const other=tool.end==='front'?geometry.rear:geometry.front;
 const otherCollision=other.y-tool.nibRadius<0||(deck(other)&&other.y-tool.nibRadius<desk.laptopHeight);
 const shaftLength=distance(geometry.front,geometry.rear);let shaftCollision=false;
 // Leave the chosen endpoint's final 8 mm for the compliant nib.
 for(let n=0;n<=12;n++){const t=n/12,p={x:geometry.front.x+(geometry.rear.x-geometry.front.x)*t,y:geometry.front.y+(geometry.rear.y-geometry.front.y)*t,z:geometry.front.z+(geometry.rear.z-geometry.front.z)*t};if(distance(p,geometry.tip)<8)continue;const radius=distance(p,geometry.wrist)<18?tool.tapeRadius:tool.barrelRadius;if(p.y-radius<0||(deck(p)&&p.y-radius<desk.laptopHeight))shaftCollision=true;}
 return{...contact,inside,bodyCollision,tableCollision,otherCollision,shaftCollision,shaftLength,collision:bodyCollision||tableCollision||otherCollision||shaftCollision};
}
