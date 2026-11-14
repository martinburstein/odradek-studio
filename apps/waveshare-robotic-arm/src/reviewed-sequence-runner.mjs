// Uses the existing guarded controller API. Never creates physical authority.
import {randomUUID} from 'node:crypto';
import {CommissioningSequenceLedger,reviewedPlanDigest} from './commissioning-sequence-ledger.mjs';
import {observedTicks} from './z-lift-actuators.mjs';
import {OTHER_EXPERIMENTS,otherExperimentPolicy} from './other-joint-plan.mjs';
const clean=j=>Object.fromEntries(['base','shoulder','elbow','gripper'].map(k=>[k,j[k]]));
const ticks=j=>observedTicks(clean(j));
export async function runReviewedSequence({api,directory,plan,supervisedUntil,confirmations,checkOnly=false,now=Date.now,onStep=()=>{}}){
 if(!['base','gripper'].includes(plan?.joint))throw Error('Only reviewed base or gripper sequences are supported');
 const planDigest=reviewedPlanDigest(plan);
 const experiment=plan.experiment??OTHER_EXPERIMENTS[plan.joint],policy=otherExperimentPolicy(experiment);
 const owner='sequence-'+randomUUID(),ledger=new CommissioningSequenceLedger(directory,{now});let claimed=false,sequence=null,stopEpoch;
 const results=[];
 const activeStatus=s=>{
  if(s.mode!=='serial'||!s.connected||s.armed||s.commissioned||s.error||s.execution?.recoveryRequired||s.execution?.outstandingTransportOperations)throw Error('Controller is not in a clean disarmed experimental state');
  if(!Number.isInteger(s.execution?.stopEpoch))throw Error('Server lacks sequence cancellation support');
  if(stopEpoch!==undefined&&s.execution.stopEpoch!==stopEpoch)throw Error('Sequence cancelled by a stop or authority change');
 };
 const prepare=()=>api('z-lift/prepare',{owner,experiment,targetTick:plan.targets[results.length],expectedStopEpoch:stopEpoch});
 try{
  const before=await api('status');activeStatus(before);if(before.owner)throw Error('Another operator owns the controller');stopEpoch=before.execution.stopEpoch;
  await api('owner',{owner});claimed=true;
  let preview=await prepare();if(!preview.ready)throw Error(preview.blockers.join('; '));
  if(preview.sequencePlanDigest!==planDigest)throw Error('Sequence plan does not match independently installed preflight approval');
  if(checkOnly)return {ready:true,preview,motionCommandsSent:0,physicalMovementVerified:false};
  sequence=await ledger.create(plan,{supervisedUntil});
  for(let index=1;index<=5;index++){
   const status=await api('status');activeStatus(status);if(status.owner!==owner)throw Error('Sequence ownership changed');
   if(index>1)preview=await prepare();
   if(!preview.ready||preview.sequencePlanDigest!==planDigest||preview.stopEpoch!==stopEpoch||preview.plan.movementJoint!==plan.joint||preview.plan.servoTargets[plan.joint]!==plan.targets[index-1]||preview.plan.observationWindowMs!==policy.observationWindowMs||preview.plan.durationMs!==policy.durationMs)throw Error('Fresh preview differs from the reviewed sequence');
   const intent=await ledger.beginStep(sequence.id,index,ticks(preview.plan.start));
   const result=await api('z-lift/execute',{owner,previewId:preview.id,expectedStopEpoch:stopEpoch,confirmations});
   if(result.id!==preview.id||result.movementJoint!==plan.joint||ticks(result.target)[plan.joint]!==intent.targetTick)throw Error('Trial receipt does not match admitted preview');
   if(!result.dispatchAt||!result.observations?.length||Date.parse(result.observations.at(-1).observedAt)-Date.parse(result.dispatchAt)<policy.observationWindowMs)throw Error('Incomplete required observation window');
   const recorded=await ledger.recordStep(sequence.id,index,{trialId:result.id,outcome:result.outcome,settled:result.settled,cleanupVerified:result.cleanupVerified,requiresReconciliation:result.requiresReconciliation,endTicks:ticks(result.observed),observations:result.observations.map(o=>ticks(o.joints))});
   results.push(result);await onStep({index,id:result.id,outcome:result.outcome,targetTick:intent.targetTick,endTick:ticks(result.observed)[plan.joint]});
   if(!recorded.continueAllowed)throw Error(recorded.reason);
  }
  return {sequenceId:sequence.id,outcome:'completed',results,physicalMovementVerified:false};
 }catch(error){if(sequence)await ledger.abort(sequence.id,error.message).catch(()=>{});throw error;}
 finally{
  if(claimed){try{await api('release',{owner});}catch(error){await api('stop',{}).catch(()=>{});throw Error('Sequence ended but ownership release failed: '+error.message);}}
 }
}
