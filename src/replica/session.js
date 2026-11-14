import {DEFAULT_DESK,validateDesk,validPose} from './state.js';
import {validateAsset} from './rig.js';
import {POINTS} from '../../apps/bot-crossing/src/arm-manual/model.js';
export const SESSION_KEY='odradek.lab.simulator.session.v1';
export function makeSession({pose,desk,asset=null,name='Workbench',selectedJoint='base',selectedPoint='PRINT_SCREEN',fullPull=10,gripLocked=true,showLive=false}){
 if(!validPose(pose))throw Error('Session has invalid joint angles.');
 if(!['base','shoulder','elbow','gripper'].includes(selectedJoint))throw Error('Session has an unknown joint.');
 if(selectedPoint!=='PRINT_SCREEN'&&!POINTS.some(p=>p.id===selectedPoint))throw Error('Session has an unknown point.');
 if(![1,10,30].includes(fullPull)||typeof gripLocked!=='boolean'||typeof showLive!=='boolean')throw Error('Session has invalid preview controls.');
 const dimensions=validateDesk({...DEFAULT_DESK,...desk});if(asset)validateAsset(asset);
 return {format:'odradek-simulator-session',version:1,previewOnly:true,name:String(name).trim().slice(0,80)||'Workbench',savedAt:new Date().toISOString(),pose:{...pose},desk:dimensions,selectedJoint,selectedPoint,fullPull,gripLocked,showLive,...(asset?{asset}: {})};
}
export function parseSession(text){
 if(typeof text!=='string'||text.length>6000000)throw Error('Session file must be under 6 MB.');
 let data;try{data=JSON.parse(text);}catch{throw Error('This file is not valid JSON.');}
 if(data?.format!=='odradek-simulator-session'||data.version!==1||data.previewOnly!==true)throw Error('Use an Odradek simulator session, version 1.');
 return makeSession(data);
}
