// Manual motor-angle conventions from the RoArm Controller. Mechanical ranges
// describe joint travel, not collision clearance or physical execution authority.
export const JOINTS=Object.freeze(['base','shoulder','elbow','gripper'])
export const BOUNDS=Object.freeze({base:[-180,180],shoulder:[0,180],elbow:[0,180],gripper:[61.9,179.9]})
export const DEFAULT_POSE=Object.freeze({base:0,shoulder:0,elbow:Math.PI/2,gripper:154*Math.PI/180})
export const POINTS=Object.freeze([
 {id:'NW',label:'NW',u:.08,v:.12},{id:'N',label:'N',u:.5,v:.12},{id:'NE',label:'NE',u:.92,v:.12},
 {id:'W',label:'W',u:.08,v:.48},{id:'E',label:'E',u:.92,v:.48},
 {id:'SW',label:'SW',u:.08,v:.72},{id:'S',label:'S',u:.5,v:.72},{id:'SE',label:'SE',u:.92,v:.72},
 {id:'LEFT_CLICK',label:'Left Click',u:.25,v:.9},{id:'RIGHT_CLICK',label:'Right Click',u:.75,v:.9},
])
export const degrees=(joint,value)=>value*180/Math.PI+(joint==='shoulder'?90:0)
export const radians=(joint,value)=>(value-(joint==='shoulder'?90:0))*Math.PI/180
export function validPose(pose){return pose&&JOINTS.every(j=>Number.isFinite(pose[j])&&degrees(j,pose[j])>=BOUNDS[j][0]-.1&&degrees(j,pose[j])<=BOUNDS[j][1]+.1)}
export function pullTarget(pose,joint,pixels,fullPullDegrees=5){
 if(!validPose(pose)||!JOINTS.includes(joint)||!Number.isFinite(pixels)||![2,5,15].includes(fullPullDegrees))throw Error('A valid pose, joint and pull are required')
 const start=degrees(joint,pose[joint]),[min,max]=BOUNDS[joint],fraction=Math.max(-1,Math.min(1,pixels/220))
 const requested=Math.abs(pixels)<6?0:fraction*fullPullDegrees
 const value=Math.max(min,Math.min(max,start+requested))
 return {pose:{...pose,[joint]:radians(joint,value)},joint,startDegrees:start,targetDegrees:value,deltaDegrees:value-start,power:Math.abs(fraction),limited:Math.abs(value-start-requested)>1e-8}
}
export function freshObservation(value,now=Date.now()){
 const at=Date.parse(value?.observedAt)
 return value?.state==='live'&&['hardware','simulator'].includes(value.source)&&Number.isFinite(at)&&now>=at&&now-at<=5000&&validPose(value.pose)
}
