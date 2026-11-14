// Durable bookkeeping only: no transport, HTTP, profile installation or
// operating-policy mutation. A future dispatcher must enforce these receipts.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {otherExperimentPolicy} from './other-joint-plan.mjs';
const keys=['base','shoulder','elbow','gripper'];
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const write=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
function validatePlan(p){
 if(!p||typeof p!=='object'||!['base','shoulder','gripper'].includes(p.joint))throw Error('Invalid experimental joint');
 if(!p.baselineTicks||keys.some(k=>!Number.isInteger(p.baselineTicks[k])||p.baselineTicks[k]<0||p.baselineTicks[k]>4095))throw Error('Four initial encoder ticks required');
 if(!Array.isArray(p.targets)||p.targets.length!==5||p.targets.some(x=>!Number.isInteger(x)||x<0||x>4095))throw Error('Exactly five encoder targets required');
 const initial=p.baselineTicks[p.joint],offset=p.targets[0]-initial,policy=p.experiment===undefined?null:otherExperimentPolicy(p.experiment);
 if(policy&&policy.joint!==p.joint)throw Error('Sequence experiment joint mismatch');
 const max=policy?.sequenceStepTicks??57;
 if(Math.abs(offset)<2||Math.abs(offset)>max||(policy?.fifteen&&Math.abs(offset)!==171)||p.targets.some((x,i)=>x!==(i%2?initial:initial+offset)))throw Error('Five alternating fixed targets with reviewed tick spacing required');
 if(typeof p.reviewDigest!=='string'||!/^[a-f0-9]{64}$/.test(p.reviewDigest))throw Error('Reviewed packet digest required');
}
export function reviewedPlanDigest(plan){
 validatePlan(plan);
 return digest({joint:plan.joint,...(plan.experiment===undefined?{}:{experiment:plan.experiment}),baselineTicks:Object.fromEntries(keys.map(k=>[k,plan.baselineTicks[k]])),targets:plan.targets,reviewDigest:plan.reviewDigest});
}
export class CommissioningSequenceLedger{
 constructor(directory,{now=Date.now}={}){this.directory=directory;this.now=now;this.instanceId=randomUUID();}
 root(id){if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid sequence id');return path.join(this.directory,id);}
 async create(plan,{supervisedUntil}={}){
  validatePlan(plan);const now=this.now();
  if(!Number.isFinite(supervisedUntil)||supervisedUntil<now+120000||supervisedUntil>now+300000)throw Error('Current supervision must cover the two-minute sequence and expire within five minutes');
  const id=randomUUID(),root=this.root(id);await fs.mkdir(this.directory,{recursive:true});await fs.mkdir(root);
  // One campaign slot per joint, even if a caller changes the plan or digest.
  // No automatic reset: a failed or interrupted create also consumes the slot.
  await write(path.join(this.directory,`consumed-${plan.joint}.json`),{id,at:now,reviewDigest:plan.reviewDigest});
  await write(path.join(this.directory,`consumed-${digest(plan)}.json`),{id,at:now,reviewDigest:plan.reviewDigest});
  const state={schemaVersion:1,id,instanceId:this.instanceId,plan:structuredClone(plan),planDigest:digest(plan),createdAt:now,deadline:now+120000,supervisedUntil};
  // An interrupted create leaves an unusable directory, never a resumable run.
  await write(path.join(root,'sequence.json'),state);return {id,planDigest:state.planDigest,deadline:state.deadline};
 }
 async exclusive(id,fn){
  const root=this.root(id),lock=path.join(root,'lock');
  try{await fs.mkdir(lock);}catch(e){if(e.code==='EEXIST')throw Error('Sequence operation is already active or interrupted');throw e;}
  try{return await fn(root);}catch(error){
   await write(path.join(root,'terminal.json'),{outcome:'aborted',reason:error.message,at:this.now()}).catch(e=>{if(e.code!=='EEXIST')throw e;});
   throw error;
  }finally{await fs.rmdir(lock);}
 }
 async live(root){
  const state=await json(path.join(root,'sequence.json'));validatePlan(state.plan);
  if(digest(state.plan)!==state.planDigest)throw Error('Sequence plan changed');
  try{await fs.access(path.join(root,'terminal.json'));throw Error('Sequence consumed; no resume');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(state.instanceId!==this.instanceId)throw Error('Sequence belongs to a previous controller instance; no resume');
  if(this.now()+25000>Math.min(state.deadline,state.supervisedUntil))throw Error('Insufficient time for another step');return state;
 }
 async beginStep(id,index,observedTicks){return this.exclusive(id,async root=>{
  if(!Number.isInteger(index)||index<1||index>5)throw Error('Invalid step index');
  const state=await this.live(root),p=state.plan;
  for(let i=1;i<index;i++){const result=await json(path.join(root,`result-${i}.json`));if(result.continueAllowed!==true)throw Error('Prior step did not complete');}
  if(!observedTicks||keys.some(k=>!Number.isInteger(observedTicks[k])||observedTicks[k]<0||observedTicks[k]>4095))throw Error('Four measured encoder ticks in 0..4095 required');
  for(const k of keys)if(k!==p.joint&&Math.abs(observedTicks[k]-p.baselineTicks[k])>1)throw Error('Held joint drift');
  if(index===1&&Math.abs(observedTicks[p.joint]-p.baselineTicks[p.joint])>1)throw Error('Initial active joint changed');
  if(index>1){const previous=await json(path.join(root,`result-${index-1}.json`));if(Math.abs(observedTicks[p.joint]-previous.endTicks[p.joint])>1)throw Error('Active joint changed since previous result');}
  const intent={sequenceId:id,index,targetTick:p.targets[index-1],baselineTicks:observedTicks,at:this.now(),reviewDigest:p.reviewDigest,planDigest:state.planDigest};
  await write(path.join(root,`intent-${index}.json`),intent);return structuredClone(intent);
 });}
 async recordStep(id,index,{trialId,outcome,settled,cleanupVerified,requiresReconciliation,endTicks,observations}={}){return this.exclusive(id,async root=>{
  if(!Number.isInteger(index)||index<1||index>5)throw Error('Invalid step index');
  const state=await json(path.join(root,'sequence.json')),p=state.plan;validatePlan(p);
  if(digest(p)!==state.planDigest)throw Error('Sequence plan changed');
  if(state.instanceId!==this.instanceId)throw Error('Sequence belongs to a previous controller instance; no resume');
  const intent=await json(path.join(root,`intent-${index}.json`));let reason=null;
  try{
   try{await fs.access(path.join(root,'terminal.json'));throw Error('Sequence already consumed');}catch(e){if(e.code!=='ENOENT')throw e;}
   if(typeof trialId!=='string'||!/^[a-f0-9-]{36}$/.test(trialId))throw Error('Valid trial id required');
   for(let i=1;i<index;i++)if((await json(path.join(root,`result-${i}.json`))).trialId===trialId)throw Error('Duplicate trial receipt');
   if(!['telemetry-reached','telemetry-settled-off-target'].includes(outcome)||settled!==true||cleanupVerified!==true||requiresReconciliation===true)throw Error('Trial did not finish cleanly');
   if(!endTicks||keys.some(k=>!Number.isInteger(endTicks[k]))||!Array.isArray(observations)||observations.length<8)throw Error('Measured endpoint and observations required');
   for(const t of [...observations,endTicks]){
    if(keys.some(k=>!Number.isInteger(t[k])||t[k]<0||t[k]>4095))throw Error('Malformed observed ticks');
    for(const k of keys)if(k!==p.joint&&Math.abs(t[k]-p.baselineTicks[k])>1)throw Error('Held joint drift');
    if(t[p.joint]<Math.min(...p.targets)-4||t[p.joint]>Math.max(...p.targets)+4)throw Error('Observed position outside sequence corridor');
   }
   const delta=endTicks[p.joint]-intent.baselineTicks[p.joint],expected=intent.targetTick-intent.baselineTicks[p.joint];
   if(Math.abs(delta)<2||Math.sign(delta)!==Math.sign(expected))throw Error('No movement or wrong direction');
   if(Math.abs(endTicks[p.joint]-intent.targetTick)>24)throw Error('Endpoint error exceeds allowance');
   if(this.now()>Math.min(state.deadline,state.supervisedUntil))throw Error('Sequence deadline elapsed');
  }catch(e){reason=e.message;}
  const result={index,trialId:trialId??null,endTicks:endTicks??null,continueAllowed:reason===null,reason,at:this.now()};
  await write(path.join(root,`result-${index}.json`),result);
  if(reason||index===5)await write(path.join(root,'terminal.json'),{outcome:reason?'aborted':'completed',reason,at:this.now()});
  return result;
 });}
 async abort(id,reason='Operator or dispatcher stopped sequence'){return this.exclusive(id,root=>write(path.join(root,'terminal.json'),{outcome:'aborted',reason,at:this.now()}));}
}
