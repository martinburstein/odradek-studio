import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {SerialPort} from 'serialport';
import {prepareStudioConnection} from '../tools/studio-connection.mjs';
import {CRASH_RECOVERY_INSPECTIONS} from './manual-crash-recovery.mjs';

const exec=promisify(execFile);
export function controllerRepairClient(root){
 return async(route,body)=>{
  if(!['status','manual/state','connect','owner','release','movement/crash-recover'].includes(route))throw Error('Unsupported repair operation');
  const {token}=JSON.parse(await fs.readFile(path.join(root,'runtime/access.json'),'utf8'));
  const r=await fetch('http://127.0.0.1:8787/api/'+route,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});
  const data=await r.json();if(!r.ok)throw Error(data.error??'Controller repair request failed');return data;
 };
}
export async function ensureStudioController(root){
 try{
  const r=await fetch('http://127.0.0.1:8787/api/health',{signal:AbortSignal.timeout(3000)});
  const data=await r.json();if(!r.ok||data.application!=='waveshare-robotic-arm')throw Error('Unexpected Controller service');
 }catch(error){
  // An unhealthy or occupied listener is not permission to kill a live process.
  if(error.cause?.code!=='ECONNREFUSED')throw error;
  await exec(process.execPath,['tools/studio.mjs','--no-view'],{cwd:root,windowsHide:true,timeout:25000,maxBuffer:32768});
 }
}
function assertIdle(s){
 const e=s.execution??{};
 if(s.armed||s.commissioned||s.owner||s.task?.active||s.movement?.active||s.movement?.session||e.busy||e.lifecycle||e.cleanupPending||e.outstandingTransportOperations||e.recoveryRequired)throw Error('Controller is busy or needs transport cleanup. Stop and inspect before repair.');
}
export function createStudioRepair({api,ensureController,listPorts=()=>SerialPort.list()}){
 let busy=false;
 async function inspect(){
  const s=await api('status');assertIdle(s);
  const manual=await api('manual/state');
  return {s,manual};
 }
 const summary=({s,manual})=>({connected:s.connected,ready:s.connected&&manual.ready===true,recovery:['crash','shortfall','aborted'].includes(manual.recovery?.kind)?manual.recovery:null,message:!s.connected?'Connect and power on the arm, then press Repair Controller again.':manual.ready?'Controller connected. Manual is ready.':manual.reason??'This hold requires its existing recovery procedure.'});
 return async function repair(body={}){
  if(!body||Object.keys(body).some(k=>!['confirmed','commandId','originalRowSHA256'].includes(k))||body.confirmed!==undefined&&body.confirmed!==true)throw Error('Invalid repair request');
  if(busy)throw Error('Controller repair is already running');
  busy=true;let owned=false;
  const owner='studio-crash-repair';
  try{
   await ensureController();
   await prepareStudioConnection({api,listPorts});
   let current=await inspect();
   if(body.confirmed!==true)return summary(current);
   const recovery=current.manual.recovery;
   if(!['crash','shortfall','aborted'].includes(recovery?.kind)||body.commandId!==recovery.commandId||body.originalRowSHA256!==recovery.originalRowSHA256)throw Error('The interrupted move changed. Inspect the current repair panel again.');
   if(!current.s.connected||current.s.mode!=='serial')throw Error('Connected physical arm required');
   await api('owner',{owner});owned=true;
   const receipt=await api('movement/crash-recover',{owner,commandId:body.commandId,originalRowSHA256:body.originalRowSHA256,inspection:Object.fromEntries(CRASH_RECOVERY_INSPECTIONS.map(k=>[k,true])),note:'Operator confirmed the stationary, contact-free arm and unchanged setup in Studio. Preserve the interrupted move and accept only its observed current pose; no retry.'});
   if(receipt.recovered!==true||receipt.noMotionCommandIssued!==true)throw Error('Recovery completion was not verified. Inspect Controller state.');
   await api('release',{owner});owned=false;
   current=await inspect();
   return {...summary(current),recovered:true,message:current.manual.ready?'Stationary position verified. Manual is ready; the interrupted move was preserved and was not replayed.':current.manual.reason};
  }finally{
   try{if(owned)await api('release',{owner});}finally{busy=false;}
  }
 };
}
