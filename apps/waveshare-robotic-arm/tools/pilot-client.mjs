import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {parsePilotCommand} from '../src/pilot-commands.mjs';
const terminal=phase=>['complete','failed','cancelled'].includes(phase);
const OWNER_BOUNDARIES=new Set(['claim','renew','release','task-admit','task-begin','task-end','prepare','dispatch']);
const OWNER_PHASES=new Set(['started','completed','failed']);
const OWNER_FAILURES=new Set(['same-owner-already-assigned','lease-expired','owner-mismatch','operation-failed']);
const JOINTS=['base','shoulder','elbow','gripper'];
const TARGET_FIELDS=['desiredTick','commandTick','targetDesiredDegrees','commandedDegrees'];
function pick(source,keys){
 if(!source||typeof source!=='object'||Array.isArray(source))return undefined;
 const result={};for(const key of keys)if(Object.hasOwn(source,key))result[key]=source[key];return result;
}
function ownerSummary(value){
 const events=Array.isArray(value?.events)?value.events:[],candidate=events.at(-1);let latest=null;
 if(candidate&&Number.isSafeInteger(candidate.sequence)&&candidate.sequence>0&&OWNER_BOUNDARIES.has(candidate.boundary)&&OWNER_PHASES.has(candidate.phase)){
  const at=candidate.at===null?null:(typeof candidate.at==='string'&&Number.isFinite(Date.parse(candidate.at))?new Date(Date.parse(candidate.at)).toISOString():null);
  const durationMs=candidate.durationMs===null?null:(Number.isFinite(candidate.durationMs)&&candidate.durationMs>=0?candidate.durationMs:null);
  latest={sequence:candidate.sequence,boundary:candidate.boundary,phase:candidate.phase,at,durationMs};
  if(candidate.phase==='failed'&&OWNER_FAILURES.has(candidate.failureClass))latest.failureClass=candidate.failureClass;
  else if(candidate.phase==='failed')latest.failureClass='operation-failed';
 }
 const sourceStatus=value?.status??{};
 const counters=object=>Object.fromEntries(['capacity','retained','droppedEvents','observerFailures'].filter(key=>Number.isSafeInteger(object?.[key])&&object[key]>=0).map(key=>[key,object[key]]));
 const summary={latest,status:{}};
 if(sourceStatus.sink&&typeof sourceStatus.sink==='object')summary.status.sink=counters(sourceStatus.sink);
 if(sourceStatus.trace&&typeof sourceStatus.trace==='object')summary.status.trace=counters(sourceStatus.trace);
 for(const key of ['droppedEvents','observerFailures'])if(Number.isSafeInteger(sourceStatus[key])&&sourceStatus[key]>=0)summary.status[key]=sourceStatus[key];
 return summary;
}
function compactFeedback(state){
 const job=state?.job&&typeof state.job==='object'?{
  ...(Object.hasOwn(state.job,'id')?{id:state.job.id}:{}),...(Object.hasOwn(state.job,'phase')?{phase:state.job.phase}:{}),
  ...(Object.hasOwn(state.job,'command')?{command:state.job.command===null?null:pick(state.job.command,['kind','direction','speed','trajectory'])}:{}),
  ...(Object.hasOwn(state.job,'target')?{target:state.job.target===null?null:pick(state.job.target,TARGET_FIELDS)}:{}),
  ...(Object.hasOwn(state.job,'error')?{error:state.job.error}:{}),
  ...(Object.hasOwn(state.job,'result')?{result:state.job.result===null?null:pick(state.job.result,['id','outcome','physicalMovementVerified'])}:{})
 }:null;
 const measured=state?.measured===null?null:pick(state?.measured,JOINTS)??null;
 return {
  job,measured,measuredAt:state?.measuredAt??null,measuredAgeMs:state?.measuredAgeMs??null,source:state?.source??null,
  rawDegrees:state?.rawDegrees??null,elbowTick:state?.elbowTick??null,elbowErrorTicks:state?.elbowErrorTicks??null,
  connected:state?.connected===true,armed:state?.armed===true,busy:state?.busy===true,stopEpoch:state?.stopEpoch??null,
  ownerTrace:ownerSummary(state?.ownerTrace)
 };
}
// Persistent input stays available during motion, especially for STOP.
export async function runPilotConsole({api,readCamera,input=process.stdin,emit=value=>console.log(JSON.stringify(value)),maxDurationMs=3600000,pollMs=200,now=Date.now}={}){
 if(typeof api!=='function'||typeof readCamera!=='function'||!Number.isInteger(maxDurationMs)||maxDurationMs<1||maxDurationMs>3600000)throw Error('Finite pilot console and API required');
 if(typeof now!=='function')throw Error('Pilot clock must be a function');
 const reader=createInterface({input,crlfDelay:Infinity});let closed=false,moving=false,accepting=false,last=null,watching=false,epoch=0,movementUntil=0,wave=null;const pending=new Set(),proofReads=new Set();
 function cancelInitialProofs(){for(const cancel of proofReads)cancel();}
 async function readInitialProof(){
  let cancel;
  const cancelled=new Promise((resolve,reject)=>{cancel=reason=>reject(Error(reason??'Command cancelled before submission'));});
  proofReads.add(cancel);
  const timer=setTimeout(()=>cancel('Initial camera proof deadline expired'),60000);timer.unref();
  try{return await Promise.race([Promise.resolve().then(()=>readCamera({phase:'initial'})),cancelled]);}
  finally{clearTimeout(timer);proofReads.delete(cancel);}
 }
 function clearWave(){const action=wave;wave=null;action?.cancelWait?.();return action;}
 async function readReturnProof(action){
  const cancelled=new Promise((resolve,reject)=>{action.cancelWait=reason=>reason?reject(Error(reason)):resolve(null);});
  try{return await Promise.race([Promise.resolve().then(()=>readCamera({phase:'return'})),cancelled]);}
  finally{action.cancelWait=null;}
 }
 async function submitMove(line,proof,ticket){
  if(closed||ticket!==epoch)throw Error('Command cancelled before submission');
  const result=await api('pilot/command',{commandId:randomUUID(),line,cameraObservation:proof.cameraObservation,inspection:proof.inspection});
  moving=true;movementUntil=Date.now()+120000;last=null;emit({event:'accepted',...result});
  if(closed||ticket!==epoch)emit({event:'late-acceptance-stop',...await api('stop',{})});
  return result;
 }
 function freshReturnProof(proof,action){
  const v=proof?.cameraObservation,at=Date.parse(v?.observedAt),completed=Date.parse(action.completedAt),clock=now();
  return v?.inspectedBy==='root'&&v.confirmedShowsArm===true&&v.fullSweepVisible===true&&v.visibleObstacles===false&&v.frameSaved===false&&
   v.commandId===action.downReceiptId&&Number.isInteger(v.sequence)&&v.sequence>0&&typeof v.cameraSessionId==='string'&&v.cameraSessionId.trim()&&
   Number.isFinite(at)&&Number.isFinite(completed)&&at>=completed&&at<=clock&&clock-at<=60000&&
   (v.cameraSessionId!==action.downProof?.cameraSessionId||v.sequence>action.downProof.sequence);
 }
 async function observeWave(state){
  const action=wave;if(!action)return;
  if(state.job?.id!==action.jobId)throw Error('Wave Pilot job was replaced; no continuation permitted');
  if(action.stage==='awaiting-camera'){
   if(state.stopEpoch!==action.stopEpoch)throw Error('Stop occurred while awaiting wave camera inspection');
   if(now()>=action.cameraUntil||now()>=action.deadlineAt)throw Error('Wave camera continuation deadline expired');
   const proof=await readReturnProof(action);
   if(closed||action!==wave||action.ticket!==epoch)return;
   if(!freshReturnProof(proof,action))return;
   // The clock may advance while reading the root's proof. It never grants continuation.
   if(now()>=action.cameraUntil||now()>=action.deadlineAt)throw Error('Wave camera continuation deadline expired');
   accepting=true;
   try{
    const result=await submitMove(`UP F${action.speed}`,proof,action.ticket);
    if(action===wave&&action.ticket===epoch&&!closed){action.stage='up';action.jobId=result.job?.id;}
   }finally{accepting=false;}
   return;
  }
  if(!terminal(state.job?.phase))return;
  if(state.job.phase!=='complete'||state.job.result?.outcome!=='telemetry-reached'||typeof state.job.result?.id!=='string'){
   clearWave();emit({event:'wave-stopped',phase:state.job.phase,error:state.job.error??'Wave leg did not complete cleanly',physicalMovementVerified:false});return;
  }
  if(action.stage==='down'){
   action.stage='awaiting-camera';action.downReceiptId=state.job.result.id;action.completedAt=state.job.updatedAt;action.stopEpoch=state.stopEpoch;
   action.cameraUntil=Math.min(now()+60000,action.deadlineAt-120000);
   emit({event:'awaiting-camera-review',commandId:action.downReceiptId,deadlineAt:new Date(action.cameraUntil).toISOString()});
  }else{
   clearWave();emit({event:'wave-complete',receiptIds:[action.downReceiptId,state.job.result.id],physicalMovementVerified:false});
  }
 }
 async function handle(line){
  try{
   const command=parsePilotCommand(line);
   if(command.kind==='status'){emit({event:'state',...await api('pilot/state')});return;}
   if(command.kind==='stop'){epoch++;clearWave();cancelInitialProofs();emit({event:'stop',...await api('stop',{})});return;}
   if(moving||accepting||wave)throw Error('One outstanding movement only; commands are never queued');
   accepting=true;const ticket=epoch;
   try{
    const deadlineAt=now()+240000,proof=await readInitialProof();
    const result=await submitMove(command.kind==='wave'?`DOWN F${command.speed}`:line,proof,ticket);
    if(command.kind==='wave'&&ticket===epoch&&!closed)wave={stage:'down',speed:command.speed,ticket,jobId:result.job?.id,downProof:{...proof.cameraObservation},deadlineAt};
   }
   finally{accepting=false;}
  }catch(error){emit({event:'error',error:error.message});}
 }
 reader.on('line',line=>{if(closed)return;const operation=handle(line);pending.add(operation);void operation.finally(()=>pending.delete(operation));});
 const timer=setInterval(()=>{
  if(closed)return;
  if(wave?.stage==='awaiting-camera'&&now()>=wave.cameraUntil)wave.cancelWait?.('Wave camera continuation deadline expired');
  if((!moving&&!wave)||watching)return;watching=true;void (moving&&Date.now()>movementUntil?api('stop',{}).then(()=>{throw Error('Pilot observation deadline expired; software stop requested');}):api('pilot/state')).then(async state=>{
  const feedback=compactFeedback(state),{measuredAgeMs,...dedupeFeedback}=feedback,signature=JSON.stringify(dedupeFeedback);
  if(signature!==last){emit({event:'feedback',...feedback});last=signature;}
  if(terminal(state.job?.phase))moving=false;
  await observeWave(state);
 }).catch(async error=>{if(closed)return;emit({event:'error',error:error.message});if(wave){clearWave();epoch++;try{emit({event:'wave-aborted-stop',...await api('stop',{})});}catch(stopError){emit({event:'error',error:stopError.message});}}if(Date.now()>movementUntil)moving=false;}).finally(()=>{watching=false;});},pollMs);
 let deadline;const done=new Promise(resolve=>{reader.once('close',resolve);deadline=setTimeout(()=>{reader.close();resolve();},maxDurationMs);});
 emit({event:'ready',commands:['M114','REFERENCE QUALIFY','REFERENCE BASE','REFERENCE SHOULDER','REFERENCE ELBOW','REFERENCE GRIPPER','QUALIFY','QUALIFY RESET','QUALIFY CURRENT','WAVE F20','WAVE F40','DOWN F40','UP F40','G1 E119.970703125 F40','G1 E90.3515625 F40','M112'],referenceCorrection:'blocked until paired shoulder measurement and geometry commissioning',units:{E:'nominal elbow degrees',F:'servo steps per second'},cameraInspectionRequired:true});
 await done;closed=true;epoch++;const admissionPending=accepting,wavePending=!!clearWave();cancelInitialProofs();clearTimeout(deadline);clearInterval(timer);await Promise.allSettled([...pending]);
 // EOF or expiration must not leave an orphaned physical command.
 if(moving||accepting||admissionPending||wavePending){try{emit({event:'input-closed-stop',...await api('stop',{})});}catch(error){emit({event:'error',error:error.message});}}
}
