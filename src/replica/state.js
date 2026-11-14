import {JOINTS,BOUNDS,degrees,radians,validPose} from '../../apps/bot-crossing/src/arm-manual/model.js';
export {JOINTS,BOUNDS,degrees,radians,validPose};
export const DESK_FIELDS=Object.freeze([
 ['laptopWidth','Laptop width',321.35,150,600],['laptopDepth','Laptop depth',212,100,450],['laptopHeight','Deck height',18,1,100],
 ['laptopX','Laptop center X',82,-700,700],['laptopZ','Laptop center Z',405,100,1000],['laptopYaw','Laptop rotation',0,-180,180],
 ['trackpadWidth','Trackpad width',115,50,220],['trackpadDepth','Trackpad depth',67,30,150],['toolLength','Stylus reach',107.5,30,220],
]);
export const DEFAULT_DESK=Object.freeze(Object.fromEntries(DESK_FIELDS.map(([key,,value])=>[key,value])));
export function validateDesk(data){if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!DESK_FIELDS.some(([key])=>key===k)))throw Error('Unknown desk setting.');const result={};for(const[key,label,,min,max]of DESK_FIELDS){const value=data[key];if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw Error(`${label}: enter ${min} to ${max}${key==='laptopYaw'?' degrees':' mm'}.`);result[key]=value;}return result;}
export function slingshot(pose,joint,projection,fullPull=10){
 if(!validPose(pose)||!JOINTS.includes(joint)||!Number.isFinite(projection)||![1,10,30].includes(fullPull))throw Error('Invalid pull.');
 // Pull back: the target turns in the opposite direction to the stretched band.
 const requested=Math.abs(projection)<5?0:-Math.max(-1,Math.min(1,projection/180))*fullPull,start=degrees(joint,pose[joint]);
 const target=Math.max(BOUNDS[joint][0],Math.min(BOUNDS[joint][1],start+requested));
 return {pose:{...pose,[joint]:radians(joint,target)},joint,target,delta:target-start,power:Math.min(1,Math.abs(projection)/180),limited:Math.abs(target-start-requested)>1e-8};
}
export function exactTarget(pose,joint,target){if(!validPose(pose)||!JOINTS.includes(joint)||typeof target!=='number'||!Number.isFinite(target)||target<BOUNDS[joint][0]||target>BOUNDS[joint][1])throw Error(`Use ${BOUNDS[joint]?.[0]}° to ${BOUNDS[joint]?.[1]}° for this joint.`);return {...pose,[joint]:radians(joint,target)};}
export function createPoseHistory(pose){const states=[{...pose}];let cursor=0;return {push(next){if(!validPose(next))throw Error('Invalid pose.');if(JOINTS.every(j=>Math.abs(next[j]-states[cursor][j])<1e-10))return;states.splice(cursor+1);states.push({...next});if(states.length>50)states.shift();cursor=states.length-1;},undo(){if(cursor>0)cursor--;return {...states[cursor]};},redo(){if(cursor<states.length-1)cursor++;return {...states[cursor]};},canUndo:()=>cursor>0,canRedo:()=>cursor<states.length-1};}
