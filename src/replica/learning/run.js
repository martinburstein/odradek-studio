import {createExperiment,validatePolicy,LEARNING_VERSION,POLICY_SIZE,simulateTask} from './simulation.js';
import {makeTasks} from './tasks.js';
import {validateEvolution} from './evolution.js';
import {FITNESS_V1,FITNESS_V2,validateFitnessVersion,checkpointFitnessVersion} from './fitness-version.js';
export const RUN_FORMAT='odradek-stylus-learning';
export const RUN_VERSION=2;
export const RUN_STORAGE_KEY='odradek.stylus-learning.v1';
const MAX_BYTES=8*1024*1024;
const MAX_FAILURE_REASON=240;
const statusValues=new Set(['ready','running','paused','complete','cancelled']);
const kinds=new Set(['baseline','best','winner','failure']);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const integer=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
const finite=(value,min=0,max=1e15)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const safeDate=value=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));
export function makeLearningRun(experiment,{seed=20261114,population=36,generations=800,fitnessVersion=FITNESS_V1}={}){
 fitnessVersion=validateFitnessVersion(fitnessVersion);
 const now=new Date().toISOString();
 const version=fitnessVersion===FITNESS_V2?2:1;
 return{format:RUN_FORMAT,version,...(version===2?{fitnessVersion}:{}),simulationVersion:LEARNING_VERSION,previewOnly:true,id:`${seed}-${Date.now()}`,createdAt:now,updatedAt:now,seed,population,generationLimit:generations,status:'ready',stopReason:null,experiment:createExperiment(experiment),history:[],snapshots:[{generation:0,kind:'baseline',policy:Array(POLICY_SIZE).fill(0),loss:null}],checkpoint:null};
}
export function parseLearningRun(text){
 if(typeof text!=='string'||text.length>MAX_BYTES)throw Error('Choose a learning run under 8 MB.');
 let data;try{data=JSON.parse(text);}catch{throw Error('This is not a valid learning-run JSON file.');}
 if(!plain(data)||data.format!==RUN_FORMAT||![1,2].includes(data.version)||data.simulationVersion!==LEARNING_VERSION||data.previewOnly!==true)throw Error('Use a compatible preview-only Odradek learning run.');
 const fitnessVersion=data.version===1?FITNESS_V1:validateFitnessVersion(data.fitnessVersion);
 if(data.version===1&&Object.hasOwn(data,'fitnessVersion')||data.version===2&&fitnessVersion!==FITNESS_V2)throw Error('Learning-run fitness version does not match its envelope.');
 if(!integer(data.seed,0,0xffffffff)||!integer(data.population,12,128)||!integer(data.generationLimit,1,2000)||!statusValues.has(data.status)||!safeDate(data.createdAt)||!safeDate(data.updatedAt)||typeof data.id!=='string'||data.id.length>100)throw Error('Invalid learning-run settings.');
 const experiment=createExperiment(data.experiment);
 if(!Array.isArray(data.history)||data.history.length>2000||!Array.isArray(data.snapshots)||!data.snapshots.length||data.snapshots.length>6001)throw Error('Invalid learning history size.');
 const history=[];let previous=0,best=Infinity,lastEvaluations=0;
 for(const row of data.history){
  if(!plain(row)||!integer(row.generation,1,data.generationLimit)||row.generation!==previous+1||!integer(row.evaluations,1,300001)||row.evaluations!==1+row.generation*data.population||row.evaluations<=lastEvaluations||!finite(row.bestLoss)||row.bestLoss>best+1e-9||!finite(row.winnerLoss)||row.bestLoss>row.winnerLoss+1e-9||!finite(row.worstLoss)||!finite(row.medianLoss)||row.winnerLoss>row.medianLoss+1e-9||row.medianLoss>row.worstLoss+1e-9||!finite(row.sigma,0,10))throw Error('Invalid or inconsistent generation history.');
  const hasFailures=Object.hasOwn(row,'failedCandidates'),hasCount=Object.hasOwn(row,'failedCount');
  if(hasFailures!==hasCount||hasFailures&&(!Array.isArray(row.failedCandidates)||row.failedCandidates.length>data.population||!integer(row.failedCount,0,data.population)||row.failedCount!==row.failedCandidates.length||row.failedCandidates.some(item=>!plain(item)||!finite(item.loss)||typeof item.reason!=='string'||!item.reason.trim()||item.reason.length>MAX_FAILURE_REASON||/[\u0000-\u001f\u007f]/.test(item.reason))||row.failedCandidates.some(item=>item.loss>row.worstLoss)))throw Error('Invalid candidate failure records.');
  previous=row.generation;best=row.bestLoss;
  lastEvaluations=row.evaluations;
  const normalized={generation:row.generation,evaluations:row.evaluations,bestLoss:row.bestLoss,winnerLoss:row.winnerLoss,worstLoss:row.worstLoss,medianLoss:row.medianLoss,sigma:row.sigma};
  if(hasFailures){normalized.failedCount=row.failedCount;normalized.failedCandidates=row.failedCandidates.map(item=>({loss:item.loss,reason:item.reason}));}
  history.push(normalized);
 }
 if(data.status==='ready'&&history.length)throw Error('A ready run cannot contain completed generations.');
 const snapshots=data.snapshots.map(row=>{
  if(!plain(row)||!integer(row.generation,0,data.generationLimit)||row.generation>(previous||0)||!kinds.has(row.kind)||!(row.loss===null||finite(row.loss)))throw Error('Invalid replay snapshot.');
  if(Object.hasOwn(row,'failed')&&typeof row.failed!=='boolean'||Object.hasOwn(row,'failureReason')&&(typeof row.failureReason!=='string'||!row.failureReason.trim()||row.failureReason.length>MAX_FAILURE_REASON||/[\u0000-\u001f\u007f]/.test(row.failureReason))||row.failed===false&&row.failureReason!==undefined)throw Error('Invalid candidate snapshot outcome.');
  const generation=history.find(item=>item.generation===row.generation);
  if(generation&&row.generation>0&&row.loss!==null&&((row.kind==='best'&&Math.abs(row.loss-generation.bestLoss)>1e-9)||(row.kind==='winner'&&Math.abs(row.loss-generation.winnerLoss)>1e-9)||(row.kind==='failure'&&Math.abs(row.loss-generation.worstLoss)>1e-9)))throw Error('Snapshot loss does not match its generation record.');
  if(generation&&row.kind==='failure'&&Object.hasOwn(generation,'failedCount')){
   if(row.failed===true&&(!generation.failedCandidates.some(item=>Math.abs(item.loss-row.loss)<1e-9)||generation.failedCount===0))throw Error('Failure snapshot does not match a failed evaluation.');
   if(row.failed===true&&row.failureReason&&!generation.failedCandidates.some(item=>Math.abs(item.loss-row.loss)<1e-9&&item.reason===row.failureReason))throw Error('Snapshot failure reason is not in its generation record.');
   if(row.failed===false&&row.failureReason!==undefined)throw Error('A valid worst-performing candidate cannot carry a failure reason.');
   if(row.failed===false&&generation.failedCandidates.some(item=>Math.abs(item.loss-row.loss)<1e-9))throw Error('Invalid evaluation failure cannot be labelled a valid candidate snapshot.');
  }
  validatePolicy(row.policy);const normalized={generation:row.generation,kind:row.kind,policy:[...row.policy],loss:row.loss};
  if(Object.hasOwn(row,'failed'))normalized.failed=row.failed;if(Object.hasOwn(row,'failureReason'))normalized.failureReason=row.failureReason;
  return normalized;
 });
 if(!snapshots.some(row=>row.generation===0&&row.kind==='baseline'))throw Error('The initial baseline must remain in the run.');
 const stopReason=data.stopReason===null?null:typeof data.stopReason==='string'&&data.stopReason.length<=160?data.stopReason:null;
 let checkpoint=null;
 if(data.checkpoint!==null&&data.checkpoint!==undefined){
  checkpoint=validateEvolution(data.checkpoint);
  if(checkpointFitnessVersion(checkpoint)!==fitnessVersion||checkpoint.seed!==data.seed||checkpoint.population!==data.population||checkpoint.generations!==data.generationLimit||checkpoint.generation!==previous||checkpoint.best&&history.length&&Math.abs(checkpoint.best.loss-history.at(-1).bestLoss)>1e-9||checkpoint.best&&checkpoint.generation===0&&snapshots.some(row=>row.generation===0&&row.kind==='baseline'&&row.loss!==null&&Math.abs(row.loss-checkpoint.best.loss)>1e-9)||checkpoint.status==='complete'&&data.status!=='complete'||data.status==='complete'&&checkpoint.status!=='complete'||data.status==='cancelled'&&checkpoint.status!=='cancelled'||checkpoint.status==='running'&&data.status==='complete'&&!['generation-budget','plateau'].includes(checkpoint.stopReason))throw Error('Optimizer checkpoint does not match its learning history or fitness version.');
  if(checkpoint.best){const latestBest=snapshots.find(row=>row.generation===checkpoint.generation&&row.kind==='best');if(latestBest&&Math.abs(latestBest.loss-checkpoint.best.loss)>1e-9)throw Error('Best snapshot does not match the optimizer checkpoint.');if(latestBest&&checkpoint.best.policy.some((value,index)=>Math.abs(value-latestBest.policy[index])>1e-9))throw Error('Best snapshot policy does not match the optimizer checkpoint.');}
 }
 // Retain only supported fields. Imports cannot carry device authorization,
 // arbitrary HTML, external resource URLs, executable code or episode frames.
 return{format:RUN_FORMAT,version:data.version,...(data.version===2?{fitnessVersion}:{}),simulationVersion:LEARNING_VERSION,previewOnly:true,id:data.id,createdAt:data.createdAt,updatedAt:data.updatedAt,seed:data.seed,population:data.population,generationLimit:data.generationLimit,status:['ready','running'].includes(data.status)?'paused':data.status,stopReason,experiment,history,snapshots,checkpoint};
}
export function snapshotOptions(run,{kind='best'}={}){
 const selected=run.snapshots.filter(row=>row.kind===kind||(kind==='best'&&row.generation===0&&row.kind==='baseline')).sort((a,b)=>a.generation-b.generation);
 return selected.filter((row,index)=>index===0||row.generation!==selected[index-1].generation);
}
export function replayEpisode(run,snapshot,{split='train',taskId}={}){
 if(!run.snapshots.includes(snapshot))throw Error('Choose a saved snapshot from this run.');
 const tasks=makeTasks(split),task=tasks.find(value=>value.id===taskId)??tasks.find(value=>value.kind==='line')??tasks[0];
 return simulateTask(snapshot.policy,task,run.experiment,{trace:true});
}
export function frameAt(episode,time){
 const frames=episode?.frames;if(!Array.isArray(frames)||!frames.length)return null;
 // Replay actual sampled simulation frames. No synthetic encoder interpolation.
 const target=Math.max(0,Math.min(episode.duration,time));let lo=0,hi=frames.length-1;
 while(lo<hi){const middle=Math.ceil((lo+hi)/2);if(frames[middle].time<=target)lo=middle;else hi=middle-1;}
 return frames[lo];
}
export function createReplayClock(){
 let episode=null,time=0,playing=false,speed=1;
 return{load(next){episode=next;time=0;playing=false;return frameAt(episode,time);},play(){if(episode){if(time>=episode.duration)time=0;playing=true;}},pause(){playing=false;},seek(next){if(!Number.isFinite(next))throw Error('Invalid replay time.');time=Math.max(0,Math.min(episode?.duration??0,next));return frameAt(episode,time);},setSpeed(next){if(![.25,.5,1,2,4].includes(next))throw Error('Unsupported playback speed.');speed=next;},update(dt){if(!Number.isFinite(dt)||dt<0)return frameAt(episode,time);if(playing){time=Math.min(episode.duration,time+Math.min(.25,dt)*speed);if(time>=episode.duration)playing=false;}return frameAt(episode,time);},get state(){return{time,playing,speed,duration:episode?.duration??0};}};
}
