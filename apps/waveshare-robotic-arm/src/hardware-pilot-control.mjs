import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {dynamicMoves} from './dynamic-moves.mjs';
import {readDynamicHardwareAdmission} from './hardware-bridge-admission.mjs';
import {collectDynamicPhysicalStart,executeDynamicPhysicalProgram} from './dynamic-physical-executor.mjs';

const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
export const hardwareRoutineNames=()=>['reference-return',...dynamicMoves().map(m=>m.name)];

// Private metadata is supplied only after root actually inspects a memory-only
// frame. HTTP callers cannot supply camera or commissioning assertions here.
export async function readHardwarePilotCamera({directory,predecessor,now=Date.now()}={}){
 const file=path.join(directory,'wave-now-camera-metadata.json'),stat=await fs.lstat(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw Error('Private root camera metadata must be a small regular file');
 const v=JSON.parse(await fs.readFile(file,'utf8')),at=Date.parse(v.observedAt);
 if(v.inspectedBy!=='root'||v.commandId!==predecessor.id||v.confirmedShowsArm!==true||v.fullSweepVisible!==true||v.visibleObstacles!==false||v.frameSaved!==false||!Number.isInteger(v.sequence)||v.sequence<1||typeof v.cameraSessionId!=='string'||!v.cameraSessionId||!Number.isFinite(at)||at>now||now-at>60000||at<Date.parse(predecessor.finishedAt)||!['stationary','noContact','cablesSlack','noUnusualNoise'].every(k=>v.inspection?.[k]===true))throw Error('New root-inspected camera clearance for this predecessor is required');
 return {observedAt:v.observedAt,sequence:v.sequence,sessionId:v.cameraSessionId,predecessorId:v.commandId,fullSweepClear:true,frameSaved:false};
}

export function createHardwarePilotControl({controller,authority,claim,release,now=Date.now,readAdmission=readDynamicHardwareAdmission,collect=collectDynamicPhysicalStart,execute=executeDynamicPhysicalProgram,readCamera=readHardwarePilotCamera}={}){
 const used=new Set();let current=null,epoch=0,pending=null;
 const phase=(name,extra={})=>{current={...current,phase:name,...extra,updatedAt:new Date(now()).toISOString()};};
 async function run(context,myEpoch){
  let claimed=false,task=false,completed=null;const name=current.name;
  const check=()=>{context.checkLive();if(myEpoch!==epoch)throw Error('Hardware Pilot cancelled');context.admit();};
  const admission=async input=>{check();return readAdmission(input);};
  try{
   context.checkLive();if(myEpoch!==epoch)throw Error('Hardware Pilot cancelled before ownership claim');await claim(context);claimed=true;
   authority.beginHardwareProgramTask();task=true;
   phase('qualifying');check();
   const ticket=await collect({controller,name,now,readAdmission:admission});check();
   phase('executing');
   const result=await execute({controller,ticket,now,readAdmission:admission,cameraForPredecessor:async predecessor=>{
    phase('awaiting-camera',{predecessorId:predecessor.id});const deadline=now()+15000;
    do{
     check();
     try{const proof=await readCamera({directory:controller.directory,predecessor,now:now()});check();phase('executing');return proof;}
     catch(error){if(now()>=deadline)throw error;}
     await delay(250);
    }while(now()<deadline);
    throw Error('Current root camera inspection did not arrive within its finite window');
   }});
   if(result.status!=='complete'||result.cleanupVerified!==true)throw Error('Hardware program cleanup was not verified');
   completed={status:result.status,rows:result.rows.map(r=>({id:r.id,outcome:r.result?.outcome})),physicalMovementVerified:false,cleanupVerified:true};
   phase('releasing',{result:completed});
  }catch(error){phase('failed',{error:error.message,physicalMovementVerified:false});}
  finally{
   if(task)authority.endTask();
   if(claimed)try{await release(context);}catch(error){
    // Disconnect may already have closed/cleared the Controller owner. Expire
    // forgets that binding only after actual closure, never transfers it.
    await authority.expire();if(controller.owner!==null||controller.connected||controller.outstanding.size||controller.recoveryFault||authority.snapshot().cleanupPending){completed=null;phase('failed',{error:'Hardware Pilot owner cleanup failed: '+error.message});}
   }
   if(completed)phase('complete',{result:completed});
  }
 }
 return {
  async submit({commandId,name},context){
   if(!uuid(commandId)||used.has(commandId)||!hardwareRoutineNames().includes(name))throw Error('Unique UUID and exact named hardware program required');
   if(current&&!['complete','failed','cancelled'].includes(current.phase))throw Error('Hardware Pilot already has one outstanding program');
   context.checkLive();await readAdmission({controller,name,now:now()});
   if(current&&!['complete','failed','cancelled'].includes(current.phase))throw Error('Hardware Pilot already has one outstanding program');
   used.add(commandId);current={id:commandId,name,phase:'accepted',acceptedAt:new Date(now()).toISOString()};
   const captured=epoch;
   pending=new Promise(resolve=>setImmediate(()=>{void run(context,captured).catch(error=>phase('failed',{error:error.message})).finally(resolve);}));
   return {accepted:true,job:{...current}};
  },state:()=>current?structuredClone(current):null,
  settle:async()=>{if(pending)await pending;},
  cancel(){epoch++;if(current&&!['complete','failed','cancelled'].includes(current.phase))phase('cancelling');}
 };
}
