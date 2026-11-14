import path from 'node:path';
import fs from 'node:fs/promises';
import {validateJoints,validateObservedJoints,validateCartesian,validateSequence,validateCommissioning,LIMITS} from './safety.mjs';
import {encodeJoints,encodeCartesian,createTransport} from './transport.mjs';
import {createSimulator} from './simulator.mjs';
import {createPoseStore} from './poses.mjs';
import {createHistory} from './telemetry.mjs';
import {createTaskRunner} from './task-runner.mjs';
import {inverseKinematics} from './kinematics.mjs';
import {ZLiftCommissioning} from './z-lift-commissioning.mjs';
import {assertOperatingEnvelope} from './operating-envelope.mjs';
import {Movement} from './movement.mjs';

export class Controller {
 constructor({directory='runtime',transportFactory,timeoutMs=2500}={}) {
  this.directory=directory; this.factory=transportFactory; this.timeoutMs=timeoutMs;
  this.connected=false;this.armed=false;this.commissioned=false;this.mode='disconnected';this.firmware=null;this.owner=null;this.error=null;
  this.commanded=null;this.measured=null;this.simulated=null;this.telemetryUpdatedAt=null;
  this.stopEpoch=0;this.generation=0;this.busy=false;this.taskActive=false;this.transport=null;this.lifecycle=null;this.lifecycleAbort=null;this.stopping=null;this.outstanding=new Set();this.recoveryFault=null;
  this.polling=null;this.pollAbort=null;this.foregroundRequests=0;
  this.poses=createPoseStore({directory:path.join(directory,'poses')});
  this.zLift=new ZLiftCommissioning(this);this.movement=new Movement(this);this.firmwareCartesian=null;this.liftHealth=null;
  this.history=createHistory({directory:path.join(directory,'history')});
  this.runner=createTaskRunner({execute:(step,context)=>this.move({...step,owner:context.owner},true,context.signal,context.admission),stop:()=>this.stop('Task stopped',true)});
 }
 async record(event){await this.history.record({...event,mode:this.mode,at:new Date().toISOString()});}
 // Wait only for a background read, never queue behind a movement. Reserving
 // the handoff prevents another timer poll from taking the same idle slot.
 async withForeground(action){
  const generation=this.generation;this.foregroundRequests++;
  try{
   if(this.polling)await this.polling;
   if(generation!==this.generation)throw Error('Command cancelled while waiting for telemetry');
   return await action();
  }finally{this.foregroundRequests--;}
 }
 assertIdle(){if(this.recoveryFault)throw Error('Transport cleanup is unverified; explicitly disconnect and verify closure before recovery');if(this.busy||this.taskActive||this.lifecycle||this.stopping||this.outstanding.size||this.runner.status().active)throw Error('Stop active execution and wait for transport cleanup before continuing');}
 clearConnection(){this.connectionPort=null;this.zLift.invalidate();this.movement.invalidate();this.firmwareCartesian=null;this.liftHealth=null;this.connected=false;this.commissioned=false;this.armed=false;this.owner=null;this.firmware=null;this.profile=null;this.commanded=null;this.measured=null;this.simulated=null;this.telemetryUpdatedAt=null;this.mode='disconnected';}
 async connect(config={mode:'simulator'}) {
  return this.withForeground(()=>this.connectIdle(config));
 }
 async connectIdle(config){
  this.assertIdle();
  if(!['simulator','http','serial'].includes(config.mode))throw Error('Select simulator, http or serial');
  this.lifecycle='connecting';this.busy=true;const lifecycleAbort=new AbortController();this.lifecycleAbort=lifecycleAbort;
  const previous=this.transport;let transport,connecting,connectSettled=true;
  try{
   this.generation++;this.armed=false;
   if(previous){await this.bounded(()=>previous.stop(),lifecycleAbort.signal);await this.bounded(()=>previous.disconnect(),lifecycleAbort.signal);}
   this.clearConnection();
   if(lifecycleAbort.signal.aborted)throw Error('Connection cancelled before dispatch');
   transport=this.factory?this.factory(config):config.mode==='simulator'?createSimulator():createTransport({...config,timeoutMs:this.timeoutMs});this.transport=transport;
   connectSettled=false;connecting=Promise.resolve().then(()=>transport.connect());
   connecting.then(()=>{connectSettled=true;},()=>{connectSettled=true;});
   await this.bounded(()=>connecting,lifecycleAbort.signal);
   if(lifecycleAbort.signal.aborted)throw Error('Connection cancelled before admission');
   this.connected=true;this.mode=config.mode;this.connectionPort=config.mode==='serial'?config.port:null;this.error=null;
   if(config.mode==='http'&&!this.factory)this.error='HTTP endpoint reachable; measured telemetry unavailable. USB serial is required for physical commissioning.';
   else await this.refresh();
   await this.record({kind:'connection',outcome:'connected'});
   if(lifecycleAbort.signal.aborted)throw Error('Connection cancelled before completion');
  }catch(error){this.clearConnection();this.error=error.message;const cleanup=transport??previous;
   if(cleanup&&!connectSettled){
    // Closing before connect settles cannot prove a late-opened resource closed.
    this.transport=cleanup;this.recoveryFault='Cancelled connection requires verified closure after it settles';
    const pending=connecting.catch(()=>{}).then(()=>this.bounded(()=>cleanup.disconnect()));
    this.pendingConnectionClose=pending;pending.catch(closeError=>{this.recoveryFault=closeError.message;}).finally(()=>{if(this.pendingConnectionClose===pending)this.pendingConnectionClose=null;});
   }else if(cleanup)try{await this.bounded(()=>cleanup.disconnect());this.transport=null;}catch(cleanupError){this.transport=cleanup;this.recoveryFault=cleanupError.message;}
   throw error;
  }
  finally{this.busy=false;this.lifecycle=null;this.lifecycleAbort=null;}
  return this.status();
 }
 async bounded(action,signal,{timeoutMs=this.timeoutMs,timeoutMessage='Command timeout; physical result unknown'}={}){
  if(signal?.aborted)throw Error('Command cancelled before dispatch');
  let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(timeoutMessage)),timeoutMs);});
  let abort; const cancelled=new Promise((_,reject)=>{abort=()=>reject(Error('Command cancelled; physical result unknown'));if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});
  const operation=Promise.resolve().then(()=>{if(signal?.aborted)throw Error('Command cancelled before dispatch');return action();});
  this.outstanding.add(operation);operation.then(()=>this.outstanding.delete(operation),()=>this.outstanding.delete(operation));
  try{return await Promise.race([operation,timeout,cancelled]);}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
 async preparedSend(prepare,send,signal,{preparationMs=8000}={}){
  // File verification and durable intent use the preparation budget. The
  // transport deadline starts only after preparation succeeds. A late
  // preparation completion cannot call send after cancellation or timeout.
  await this.bounded(prepare,signal,{timeoutMs:preparationMs,timeoutMessage:'Movement preparation timeout; no position command sent'});
  return this.bounded(send,signal);
 }
 async disconnect(){
  if(this.lifecycle){await this.stop('Connection transition cancelled');throw Error('Connection transition cancelled; wait for cleanup before disconnecting');}
  this.lifecycle='disconnecting';const transport=this.transport;
  try{
   if(this.pendingConnectionClose)await this.bounded(()=>this.pendingConnectionClose);
   // Disarming is immediate even when stop-history or resource cleanup fails.
   await this.stop('Disconnected').catch(error=>{this.error=error.message;});
   if(transport)try{await this.bounded(()=>transport.disconnect());}catch(error){this.recoveryFault=error.message;this.error=error.message;this.clearConnection();throw Error('Transport closure is unverified; retry disconnect after cleanup settles');}
   this.transport=null;this.recoveryFault=null;this.clearConnection();return await this.status();
  }
  finally{this.lifecycle=null;}
 }
 async commission(config){
  return this.withForeground(()=>this.commissionIdle(config));
 }
 async commissionIdle(config){
  this.assertIdle();if(!this.connected||this.armed)throw Error('Commission only connected, disarmed, idle setup');
  this.busy=true;const generation=this.generation;
  try{
  config=validateCommissioning(config);
  if(this.mode==='simulator'&&config.variant!=='simulator')throw Error('Simulator mode requires the simulator commissioning profile');
  if(this.mode!=='simulator'){
   if(!['RoArm-M2-S','RoArm-M2-Pro'].includes(config.variant))throw Error('Exact physical variant must be identified');
   let profile;try{profile=JSON.parse(await fs.readFile(path.join(this.directory,'verified-hardware.json'),'utf8'));}catch{throw Error('Physical commissioning evidence profile is not installed');}
   if(profile.variant!==config.variant||profile.firmware!==config.firmware||profile.jointControlVerified!==true||typeof profile.evidence!=='string'||!profile.evidence.trim())throw Error('Verified hardware profile/evidence mismatch');
   await this.refresh();if(!this.measured)throw Error('Fresh measured joint feedback required for physical commissioning');
   validateJoints(this.measured);
  }
  if(generation!==this.generation)throw Error('Commissioning cancelled before admission');
  this.commissioned=true;this.profile={...config};this.firmware=this.mode==='simulator'?'simulator / no physical firmware':`${config.firmware} (operator confirmed; no automatic firmware identification)`;
  await this.record({kind:'commissioning',outcome:'operator-confirmed',variant:config.variant});
  if(generation!==this.generation)throw Error('Commissioning cancelled during persistence');
  const status=await this.status();if(generation!==this.generation)throw Error('Commissioning cancelled before completion');return status;
  }catch(error){this.commissioned=false;this.armed=false;this.profile=null;this.firmware=null;this.error=error.message;this.generation++;throw error;
  }finally{this.busy=false;}
 }
 async claim(owner){
  return this.withForeground(()=>this.claimIdle(owner));
 }
 async claimIdle(owner){
  this.assertIdle();if(this.armed)throw Error('Disarm before claiming ownership; renew an existing device lease separately');
  if(typeof owner!=='string'||!/^[-\w]{1,64}$/.test(owner))throw Error('Valid owner identifier required');
  if(this.owner&&this.owner!==owner)throw Error('Another command owner holds this setup');
  this.busy=true;const generation=this.generation;
  try{const status=await this.status();if(generation!==this.generation)throw Error('Ownership claim cancelled');this.owner=owner;return {...status,owner};}finally{this.busy=false;}
 }
 assertOwner(owner){if(!this.owner||owner!==this.owner)throw Error('Command owner mismatch');}
 async arm(armed,owner){
  // Disarming must interrupt immediately, without waiting behind a read.
  return armed===false?this.armIdle(armed,owner):this.withForeground(()=>this.armIdle(armed,owner));
 }
 async armIdle(armed,owner){
  if(typeof armed!=='boolean')throw Error('armed must be boolean');this.assertOwner(owner);
  if(!armed){await this.stop('Disarmed');return this.status();}
  this.assertIdle();if(!this.connected||!this.commissioned)throw Error('Connected, commissioned, idle setup required');
  this.busy=true;const generation=this.generation;
  try{
  if(this.mode!=='simulator'){await this.refresh();this.requireFresh();}
  else this.requireCurrentFeedback();
  if(generation!==this.generation)throw Error('Arming cancelled before admission');
  this.armed=true;this.error=null;await this.record({kind:'arming',outcome:'armed'});
  if(generation!==this.generation)throw Error('Arming cancelled during persistence');
  const status=await this.status();if(generation!==this.generation)throw Error('Arming cancelled before completion');return status;
  }catch(error){this.armed=false;this.error=error.message;this.generation++;throw error;
  }finally{this.busy=false;}
 }
 requireFresh(){const age=Date.now()-Date.parse(this.telemetryUpdatedAt);if(!this.measured||!Number.isFinite(age)||age<0||age>5000)throw Error('Fresh physical telemetry required');}
 requireCurrentFeedback(){if(this.mode!=='simulator')return this.requireFresh();const age=Date.now()-Date.parse(this.telemetryUpdatedAt);if(!this.simulated||!Number.isFinite(age)||age<0||age>5000)throw Error('Fresh simulator telemetry required');}
 async refresh(signal){
  if(!this.connected||!this.transport)return;
  const generation=this.generation;
  const feedback=await this.bounded(()=>this.transport.feedback({signal}),signal);
  if(!feedback||!feedback.joints)throw Error('Malformed or missing joint telemetry');
  const joints=this.mode==='simulator'?validateJoints(feedback.joints):validateObservedJoints(feedback.joints);
  // Allow observation before commissioning without weakening any control gate.
  // Commissioning separately validates the pose; once commissioned/armed,
  // feedback outside the motion envelope still fails closed as before.
  if(this.mode!=='simulator'&&(this.commissioned||this.armed))validateJoints(joints);
  const timestamp=feedback.observedAt;
  if(!Number.isFinite(Date.parse(timestamp)))throw Error('Feedback timestamp invalid');
  if(generation!==this.generation)throw Error('Feedback cancelled before state admission');
  if(this.mode!=='simulator'&&(Date.now()-Date.parse(timestamp)>5000||Date.parse(timestamp)>Date.now()+1000))throw Error('Physical feedback is stale or future dated');
  if(this.mode==='simulator'){if(feedback.source!=='simulator')throw Error('Simulator feedback provenance mismatch');this.simulated=joints;this.measured=null;}
  else {if(feedback.source!=='hardware')throw Error('Measured hardware provenance required');this.measured=joints;this.simulated=null;}
  this.telemetryUpdatedAt=timestamp;
  this.liftHealth=this.mode==='serial'&&feedback.raw?Object.fromEntries(['v','torswitchB','torswitchS','torswitchE','torswitchH','torB','torS','torE','torH','Stalltor','Stalltep','Stallvol'].filter(k=>Object.hasOwn(feedback.raw,k)).map(k=>[k,feedback.raw[k]])):null;
  this.firmwareCartesian=this.mode==='serial'&&feedback.cartesian&&['x','y','z','t'].every(k=>typeof feedback.cartesian[k]==='number'&&Number.isFinite(feedback.cartesian[k]))?Object.fromEntries(['x','y','z','t'].map(k=>[k,feedback.cartesian[k]])):null;
 }
 poll(){
  if(!this.connected||this.foregroundRequests||this.polling||this.busy||this.taskActive||this.lifecycle||this.stopping||this.outstanding.size||(this.mode==='http'&&!this.factory))return Promise.resolve();
  this.busy=true;const generation=this.generation,abort=new AbortController();this.pollAbort=abort;
  const operation=(async()=>{
   try{
    await this.refresh(abort.signal);
    if(this.mode==='simulator'){
     const age=Date.now()-Date.parse(this.telemetryUpdatedAt);
     if(age<0||age>5000){
      this.error='Simulator telemetry is stale';this.polling=null;this.pollAbort=null;this.busy=false;
      await this.stop('Stale simulator telemetry');
     }
    }
   }
   catch(error){
    // Stop/release/disconnect intentionally invalidate a read. They own its
    // cleanup; recursively stopping here would deadlock and mark a false loss.
    if(generation===this.generation&&!abort.signal.aborted){
     this.error=error.message;this.connected=false;this.commissioned=false;
     // Drop this read's reservation before fault cleanup so stop cannot join
     // its own promise. Unsettled I/O remains tracked in outstanding.
     this.polling=null;this.pollAbort=null;this.busy=false;
     await this.stop('Telemetry lost');
    }
   }finally{if(this.polling===operation){this.polling=null;this.pollAbort=null;this.busy=false;}}
  })();
  this.polling=operation;return operation;
 }
 async move({kind,target,owner},fromTask=false,parentSignal,admission){
  return this.withForeground(()=>this.moveIdle({kind,target,owner},fromTask,parentSignal,admission));
 }
 async moveIdle({kind,target,owner},fromTask=false,parentSignal,admission){
  if(parentSignal?.aborted)throw Error('Task cancelled before motion admission');
  this.assertOwner(owner);if(!this.connected||!this.armed||!this.commissioned)throw Error('Arm a connected commissioned setup before motion');
  if(this.busy||this.lifecycle||this.stopping||this.outstanding.size||(this.taskActive&&!fromTask)||(!fromTask&&this.runner.status().active))throw Error('Another command, task or cleanup is active');
  if(!['joints','cartesian'].includes(kind))throw Error('Motion kind must be joints or cartesian');
  const normalized=kind==='joints'?validateJoints(target):validateCartesian(target);
  this.requireCurrentFeedback();
  if(kind==='cartesian'&&this.mode==='simulator')validateJoints(inverseKinematics(normalized));
  if(this.mode!=='simulator'){
   this.requireFresh();
   if(kind==='cartesian')throw Error('Physical Cartesian control awaits verified exact firmware/geometry commissioning');
   for(const key of Object.keys(normalized))if(Math.abs(normalized[key]-this.measured[key])>0.08)throw Error('Commissioning step exceeds 0.08 radians');
  }
  this.busy=true;const generation=this.generation;this.abort=new AbortController();
  const abortController=this.abort;const abortFromParent=()=>abortController.abort();
  parentSignal?.addEventListener('abort',abortFromParent,{once:true});
  try{
   const command=kind==='joints'?encodeJoints(normalized):encodeCartesian(normalized);
   // Never permit a faster commissioning override through encoded commands.
   if(kind==='joints'){command.spd=65;command.acc=1;}
   await this.record({kind:'motion',outcome:'intent',target:normalized,coordinate:kind});
   const result=await this.bounded(async()=>{
    if(this.mode!=='simulator')await assertOperatingEnvelope(this.directory,null);
    admission?.();
    this.requireCurrentFeedback();
    this.assertOwner(owner);if(generation!==this.generation||!this.armed||!this.connected||!this.commissioned)throw Error('Motion authority cancelled before dispatch');
    if(this.mode!=='simulator'){this.requireFresh();for(const key of Object.keys(normalized))if(Math.abs(normalized[key]-this.measured[key])>0.08)throw Error('Commissioning step exceeds 0.08 radians');}
    return this.transport.send(command,{signal:abortController.signal});
   },abortController.signal);
   if(generation!==this.generation)throw Error('Motion cancelled before result admission');
   if(!result||(this.mode==='simulator'?result.acknowledged!==true:result.sent!==true&&result.acknowledged!==true))throw Error('Transport did not confirm local delivery; physical result unknown');
   this.commanded={kind,target:normalized};await this.record({kind:'motion',outcome:this.mode==='simulator'?'simulated':result.acknowledged===true?'acknowledged':'sent',target:normalized});
   await this.refresh();this.requireCurrentFeedback();if(generation!==this.generation)throw Error('Motion cancelled during feedback');
   return {sent:true,acknowledged:result.acknowledged===true,simulated:this.mode==='simulator',physicalMovementVerified:false,feedbackSource:this.mode==='simulator'?'simulator':'hardware'};
  }catch(error){this.armed=false;this.error=error.message;this.generation++;this.abort?.abort();const transport=this.transport;if(transport)await this.bounded(()=>transport.stop()).catch(cleanupError=>{this.recoveryFault=cleanupError.message;});this.connected=false;this.commissioned=false;await this.record({kind:'error',outcome:'unknown',message:error.message});throw error;}
  finally{parentSignal?.removeEventListener('abort',abortFromParent);this.busy=false;this.abort=null;}
 }
 async stop(reason='Operator software stop',fromRunner=false,{trialCleanup=false}={}){
  if(!trialCleanup){this.stopEpoch++;this.movement.invalidate();}
  this.zLift.invalidate();
  const poll=this.polling;
  this.generation++;this.armed=false;this.abort?.abort();this.lifecycleAbort?.abort();this.pollAbort?.abort();
  const result={ok:true,armed:false,physicalStopVerified:false,message:'Software queue stopped and disarmed. Servo motion may continue; physical intervention may be required.'};
  if(this.stopping)return fromRunner?{...result,cleanupPending:true}:this.stopping;
  const transport=this.transport;
  const cleanup=Promise.resolve().then(async()=>{
   if(!fromRunner)await this.runner.stop(reason);
   let cleanupError=null,transportCleanup=null;
   if(transport)try{transportCleanup=await this.bounded(()=>transport.stop());}catch(error){cleanupError=error;this.error=error.message;this.recoveryFault=error.message;this.connected=false;this.commissioned=false;}
   if(poll)await poll;
   const cleanupPending=Boolean(this.outstanding.size||this.pendingConnectionClose||this.busy||this.runner.status().active);
   if(transport)await this.record({kind:'stop',outcome:'queue-stopped',reason,physicalStopVerified:false,cleanupVerified:!cleanupError&&!cleanupPending});
   return cleanupError?{...result,ok:false,cleanupVerified:false,recoveryRequired:true}: {...result,cleanupVerified:!cleanupPending,cleanupPending,permitRevoked:transportCleanup?.permitRevoked===true};
  });this.stopping=cleanup;
  try{return await cleanup;}finally{this.stopping=null;}
 }
 async runTask(task,admission){
  return this.withForeground(()=>this.runTaskIdle(task,admission));
 }
 async runTaskIdle(task,admission){
  validateSequence(task.steps);
  if(this.mode==='simulator')for(const step of task.steps)if(step.kind==='cartesian')validateJoints(inverseKinematics(step.target));
  this.assertOwner(task.owner);this.assertIdle();
  if(!this.armed)throw Error('Explicit arming required');this.taskActive=true;
  try{return await this.runner.run(task,{owner:task.owner,admission});}finally{this.taskActive=false;}
 }
 async captureCalibration({name,owner}){
  return this.withForeground(()=>this.captureCalibrationIdle({name,owner}));
 }
 async captureCalibrationIdle({name,owner}){
  this.assertOwner(owner);this.assertIdle();if(!this.connected||this.armed)throw Error('Capture a reference only while connected, disarmed and idle');
  this.busy=true;const generation=this.generation;
  try{await this.refresh();this.requireCurrentFeedback();const joints=this.mode==='simulator'?this.simulated:this.measured;if(!joints)throw Error('Fresh joint feedback is required');
   const observation={source:this.mode==='simulator'?'simulator':'hardware',observedAt:this.telemetryUpdatedAt,joints:{...joints}};
   const saved=await this.poses.save(name,observation.joints);if(generation!==this.generation)throw Error('Calibration reference cancelled during persistence');
   await this.record({kind:'calibration-reference',outcome:observation.source==='simulator'?'simulated':'observed',name,physicalCalibrationApplied:false});
   if(generation!==this.generation)throw Error('Calibration reference cancelled before completion');
   return {saved,source:observation.source,observedAt:observation.observedAt,physicalCalibrationApplied:false,message:'Reference pose captured. Servo zero offsets and firmware calibration were not changed.'};
  }finally{this.busy=false;}
 }
 async status(){return {movement:await this.movement.status(),zLift:this.zLift.snapshot(),mode:this.mode,connected:this.connected,armed:this.armed,commissioned:this.commissioned,firmware:this.firmware,owner:this.owner,commanded:this.commanded,measured:this.measured,simulated:this.simulated,motorHealth:this.liftHealth,firmwareCartesian:this.firmwareCartesian,telemetryUpdatedAt:this.telemetryUpdatedAt,updatedAt:new Date().toISOString(),task:this.runner.status(),execution:{stopEpoch:this.stopEpoch,busy:this.busy,lifecycle:this.lifecycle,cleanupPending:Boolean(this.stopping),outstandingTransportOperations:this.outstanding.size,recoveryRequired:Boolean(this.recoveryFault),recoveryReason:this.recoveryFault},history:await this.history.list(),poses:await this.poses.list(),error:this.error,limits:LIMITS,physicalMovementVerified:false};}
}
