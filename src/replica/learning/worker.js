import {createExperiment,trainingFitnessForVersion,validatePolicy} from './simulation.js';
import {createEvolution,initializeEvolution,evolveGeneration,validateEvolution} from './evolution.js';
import {makeLearningRun,parseLearningRun} from './run.js';
import {DEFAULT_FITNESS_VERSION,validateFitnessVersion,checkpointFitnessVersion} from './fitness-version.js';

let state=null,experiment=null,run=null,active=false,pauseRequested=false,cancelRequested=false;
const send=(type,detail={})=>self.postMessage({type,...detail});
const checkpoint=()=>({run:{...run,checkpoint:state},state});
const yieldTurn=()=>new Promise(resolve=>setTimeout(resolve,0));
async function loop(){
 if(active)return;active=true;
 try{
  while(state&&!['complete','cancelled'].includes(state.status)){
   if(pauseRequested){run.status='paused';run.updatedAt=new Date().toISOString();send('paused',checkpoint());return;}
   if(cancelRequested){state.status='cancelled';state.stopReason='cancelled';run.status='cancelled';break;}
   // Yield between small candidate batches so pause/cancel messages can be
   // handled without waiting for an entire population. The optimizer retains
   // its exact pending candidates and random state across these chunks.
   let evaluated=0;
   const fitness=trainingFitnessForVersion(checkpointFitnessVersion(state));
   const result=evolveGeneration(state,experiment,{fitness:(...args)=>{evaluated++;return fitness(...args);},cancelled:()=>evaluated>=4});
   if(!result){state.status='running';state.stopReason=null;await yieldTurn();continue;}
   const failedCandidates=result.failedCandidates.map(candidate=>({loss:candidate.loss,reason:candidate.reason}));
   const row={generation:result.generation,evaluations:result.evaluations,bestLoss:result.best.loss,winnerLoss:result.winner.loss,worstLoss:result.worst.loss,medianLoss:result.medianLoss,sigma:result.sigma,failedCount:failedCandidates.length,failedCandidates};
   run.history.push(row);run.updatedAt=new Date().toISOString();run.status=result.status;run.stopReason=result.stopReason;
   const saveSnapshot=result.generation===1||result.generation%10===0||result.status==='complete';
   const replayable=policy=>{try{validatePolicy(policy);return true;}catch{return false;}};
   const snapshots=saveSnapshot?[
    ...(replayable(result.best.policy)?[{generation:result.generation,kind:'best',policy:result.best.policy,loss:result.best.loss}]:[]),
    ...(replayable(result.winner.policy)?[{generation:result.generation,kind:'winner',policy:result.winner.policy,loss:result.winner.loss}]:[]),
    ...(replayable(result.worst.policy)?[{generation:result.generation,kind:'failure',policy:result.worst.policy,loss:result.worst.loss,failed:result.worst.failed}]:[]),
   ]:[];
   run.snapshots.push(...snapshots);
   send('generation',{row,snapshots,status:run.status});
   if(result.generation%20===0||result.status==='complete')send('checkpoint',checkpoint());
   await yieldTurn();
  }
  run.status=state.status;run.stopReason=state.stopReason;run.updatedAt=new Date().toISOString();send('finished',checkpoint());
 }catch(error){if(run){run.status='paused';run.updatedAt=new Date().toISOString();}send('error',{message:error.message,...(run?checkpoint():{})});}
 finally{active=false;}
}
self.onmessage=event=>{
 const message=event.data;
 try{
  if(message?.type==='pause'){pauseRequested=true;return;}
  if(message?.type==='cancel'){cancelRequested=true;return;}
  if(message?.type==='resume'){
   if(active)throw Error('Wait for the current generation to finish pausing.');
   if(!state||!run||run.status!=='paused')throw Error('No paused run is available.');
   pauseRequested=false;cancelRequested=false;run.status='running';send('resumed');void loop();return;
  }
  if(message?.type==='restore'){
   if(active)throw Error('Pause or cancel the active run before restoring another.');
   run=parseLearningRun(JSON.stringify(message.run));
   if(!run.checkpoint||run.checkpoint.status==='complete')throw Error('This run has no unfinished optimizer checkpoint.');
   state=validateEvolution(run.checkpoint);state.status='running';state.stopReason=null;experiment=createExperiment(run.experiment);run.status='running';pauseRequested=false;cancelRequested=false;
   send('started',checkpoint());void loop();return;
  }
  if(message?.type!=='start')return;
  if(active)throw Error('Pause or cancel the active run before starting another.');
   const hasMessageFitness=Object.hasOwn(message,'fitnessVersion'),hasOptionFitness=Object.hasOwn(message.options??{},'fitnessVersion');
   if(hasMessageFitness&&hasOptionFitness&&message.fitnessVersion!==message.options.fitnessVersion)throw Error('Conflicting start fitness versions.');
   const requestedFitness=hasMessageFitness?message.fitnessVersion:hasOptionFitness?message.options.fitnessVersion:DEFAULT_FITNESS_VERSION;
   const fitnessVersion=validateFitnessVersion(requestedFitness);
   experiment=createExperiment(message.experiment);state=createEvolution({...message.options,fitnessVersion});run=makeLearningRun(experiment,{seed:state.seed,population:state.population,generations:state.generations,fitnessVersion:checkpointFitnessVersion(state)});
  initializeEvolution(state,experiment);run.status='running';run.snapshots[0].loss=state.best.loss;
  pauseRequested=false;cancelRequested=false;send('started',checkpoint());void loop();
 }catch(error){send('error',{message:error.message});}
};
