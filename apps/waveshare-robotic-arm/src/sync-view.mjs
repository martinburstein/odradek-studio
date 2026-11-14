import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SerialPort} from 'serialport';
import {assertLiftHealth,observedTicks} from './z-lift-actuators.mjs';
import {manualEnvelope} from './manual-joints.mjs';
import {readMotionConfig} from './motion-config.mjs';

export const ARM_SERIAL='508E797BEB72EF1197387E4F8FCC3FA0';
const probe=async fn=>{try{return {ok:true,value:await fn()};}catch(error){return {ok:false,error:error.message};}};
const json=async(url,headers)=>{const r=await fetch(url,{headers,signal:AbortSignal.timeout(2000)});if(!r.ok)throw Error(`Service returned ${r.status}`);return r.json();};
export function projectSync({status,ports=[],camera,magi,review,connectionPort,generation,instanceId,now=Date.now()}){
 const plugs=[];
 const add=(id,label,ok,detail,state=ok?'connected':'blocked')=>plugs.push({id,label,connected:ok===true,state,detail});
 const working=Boolean(status.movement?.active||status.execution?.busy||status.execution?.lifecycle||status.execution?.cleanupPending);
 const arm=ports.filter(p=>p.serialNumber===ARM_SERIAL&&p.vendorId?.toLowerCase()==='10c4'&&p.productId?.toLowerCase()==='ea60');
 const serial=status.connected&&status.mode==='serial';
 const age=now-Date.parse(status.telemetryUpdatedAt),fresh=serial&&Number.isFinite(age)&&age>=0&&age<=500;
 add('controller','CONTROLLER',!status.execution?.recoveryRequired&&!status.execution?.cleanupPending,'Shared Controller · '+(status.execution?.recoveryReason||status.execution?.lifecycle||'online'));
 add('usb','ARM USB',arm.length===1,arm.length===1?`${arm[0].path} · arm identity matched`:'Expected arm adapter absent or ambiguous');
 add('feedback','FEEDBACK',fresh&&arm.length===1&&connectionPort===arm[0].path,serial?`Encoder feedback · ${Number.isFinite(age)?Math.max(0,age):'unknown'} ms old`:'Connect the arm for measured feedback');
 let health;try{if(!fresh)throw Error('Waiting for fresh hardware feedback');assertLiftHealth(status.motorHealth);health={ok:true,detail:`${(status.motorHealth.v/100).toFixed(2)} V · four torque flags on`};}catch(e){health={ok:false,detail:e.message};}
 add('health','JOINT HEALTH',health.ok,health.detail);
 let ticks=null,pose;try{if(!fresh)throw Error('Waiting for fresh measured pose');ticks=observedTicks(status.measured);if(working)pose={ok:false,state:'active',detail:'Tracking live pose · stationary geometry check deferred until idle'};else{manualEnvelope(status.measured,status.measured);pose={ok:true,detail:'Current stationary geometry passes · path checked per move'};}}catch(e){pose={ok:false,detail:e.message};}
 add('pose','CURRENT POSE',pose.ok,pose.detail,pose.state??(pose.ok?'connected':'blocked'));
 const historyDeferred=working&&status.movement?.historyCheckDeferred===true;
 add('history','MOVEMENT HISTORY',status.movement?.historyReady===true&&!historyDeferred,historyDeferred?'Recording controller activity · full history check resumes when idle':status.movement?.historyReady?'No unresolved movement receipts':status.movement?.historyError||`${status.movement?.unresolved?.length??0} unresolved movement receipt(s)`,historyDeferred?'active':status.movement?.historyReady?'connected':'blocked');
 add('sources','MOVEMENT SOURCES',review?.ok===true,review?.ok?'Installed source-bound profile verified':review?.error||'Source check unavailable');
 const cameraAge=now-Date.parse(camera?.value?.receivedAt);
 add('camera','LIVE CAMERA',camera?.ok&&camera.value?.fresh===true&&cameraAge>=0&&cameraAge<=2000,camera?.ok&&camera.value?.fresh?`Live · frame ${camera.value.sequence} · memory only`:camera?.error||camera?.value?.error||'No fresh camera frame');
 add('magi','MAGI',magi?.ok===true,magi?.ok?magi.value.detail:'MAGI service unavailable');
 const session=status.movement?.session;
 const sessionReady=session?.mode==='serial'&&Date.parse(session.expiresAt)>now;
 add('session','MOVEMENT SESSION',sessionReady,session?`Admitted session · ${session.remaining} leg(s) remaining`:'Idle · no movement session admitted',sessionReady?'connected':session?'blocked':'idle');
 return {checkedAt:new Date(now).toISOString(),generation,instanceId,plugs,ticks,connected:serial,selectedPort:arm.length===1?arm[0].path:null,active:status.movement?.active===true,working,armed:status.armed===true,physicalMovementVerified:false,ready:plugs.every(p=>p.connected),camera:{fresh:plugs.find(p=>p.id==='camera').connected,receivedAt:camera?.value?.receivedAt??null},lastError:status.error??null};
}
export function createSyncReader({controller,root,directory}){
 const instanceId=randomUUID();
 let pending;
 return ()=>pending??=(async()=>{
  const [ports,magi,review,camera]=await Promise.all([
   SerialPort.list().catch(()=>[]),
   probe(async()=>{
    const endpoint=JSON.parse(await fs.readFile(path.resolve(root,'../swarm-protocol/runtime/launcher/endpoint.json'),'utf8'));
    const target=new URL(endpoint.url);if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||!target.hash)throw Error('Invalid MAGI endpoint');
    const s=await json(target.origin+'/api/status',{'X-Launcher-Token':target.hash.slice(1),Origin:target.origin});
    if(typeof s.phase!=='string')throw Error('Unrecognized MAGI response');
    return {detail:`Service online · ${s.phase} · coordinator ${s.coordinator?.phase??'unknown'}`};
   }),
   probe(async()=>{await readMotionConfig(directory);return true;}),
   probe(()=>json('http://127.0.0.1:8788/status'))
  ]);
  // Share the tracked background-read handoff with movement and status calls.
  // A direct refresh inside withForeground can overlap another foreground
  // reader and expose an outstanding transport operation as false activity.
  await controller.poll();
  const status=await controller.withForeground(async()=>{
   // Avoid replaying the entire historical proof set on the event loop while
   // recovery or motion must collect feedback at intervals below 500 ms.
   const working=controller.busy||controller.lifecycle||controller.taskActive||controller.stopping;
   const snapshot=working?{connected:controller.connected,mode:controller.mode,armed:controller.armed,error:controller.error,measured:controller.measured,motorHealth:controller.liftHealth,telemetryUpdatedAt:controller.telemetryUpdatedAt,movement:{...controller.movement.snapshot(),historyReady:false,historyCheckDeferred:true},execution:{busy:controller.busy,lifecycle:controller.lifecycle,recoveryRequired:Boolean(controller.recoveryFault),recoveryReason:controller.recoveryFault,cleanupPending:Boolean(controller.stopping)}}:await controller.status();
   return snapshot;
  });
  // External service delays must not age the encoder snapshot we just read.
  // Each service still has its own freshness check in the projection.
  return projectSync({status,ports,camera,magi,review,connectionPort:controller.connectionPort,generation:controller.generation,instanceId});
 })().finally(()=>{pending=null;});
}
