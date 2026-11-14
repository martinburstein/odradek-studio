import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {readFile,mkdtemp,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {makeLearningRun,parseLearningRun,replayEpisode,frameAt,snapshotOptions} from '../src/replica/learning/run.js';
import {createExperiment,trainingFitness,LEARNING_VERSION,POLICY_SIZE} from '../src/replica/learning/simulation.js';
import {createEvolution,initializeEvolution,evolveGeneration} from '../src/replica/learning/evolution.js';

function spawnWorker(){
 const url=new URL('../src/replica/learning/worker.js',import.meta.url).href;
 const code=`(async()=>{const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:value=>parentPort.postMessage(value)};await import(${JSON.stringify(url)});parentPort.on('message',data=>self.onmessage({data}));})()`;
 const worker=new Worker(code,{eval:true}),messages=[];worker.on('message',message=>messages.push(message));
 return{worker,messages,async wait(type,from=0){for(let i=from;i<messages.length;i++)if(messages[i].type===type)return{message:messages[i],index:i+1};return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`Timed out waiting for ${type}`)),30000);const onMessage=message=>{if(message.type===type){clearTimeout(timer);worker.off('message',onMessage);resolve({message,index:messages.length});}};worker.on('message',onMessage);});}};
}

test('run import rejects malformed histories, policies, and optimizer checkpoints',()=>{
 const run=makeLearningRun(undefined,{seed:17,population:12,generations:3}),text=JSON.stringify({...run,script:'javascript:alert(1)',externalUrl:'https://invalid.test'});
 const parsed=parseLearningRun(text);assert.equal(parsed.checkpoint,null);assert.equal('script'in parsed,false);assert.equal('externalUrl'in parsed,false);
 for(const change of [x=>x.history=[{generation:1,evaluations:-1,bestLoss:1,winnerLoss:1,worstLoss:1,medianLoss:1,sigma:.3}],x=>x.snapshots[0].policy[0]=Infinity,x=>x.previewOnly=false]){
  const bad=JSON.parse(text);change(bad);assert.throws(()=>parseLearningRun(JSON.stringify(bad)));
 }
 const invalidCheckpoint=JSON.parse(text);invalidCheckpoint.checkpoint={rng:12};assert.throws(()=>parseLearningRun(JSON.stringify(invalidCheckpoint)));
 const external=JSON.parse(text);external.experiment.networkUrl='https://invalid.test';assert.equal('networkUrl'in parseLearningRun(JSON.stringify(external)).experiment,false);
 assert.throws(()=>parseLearningRun('x'.repeat(8*1024*1024+1)));
});

test('replay uses actual sampled simulation frames and has no interpolation path',()=>{
 const run=makeLearningRun(),parsed=parseLearningRun(JSON.stringify(run)),snapshot=parsed.snapshots[0],episode=replayEpisode(parsed,snapshot,{split:'train'});
 assert.ok(episode.frames.length>2);for(const sample of episode.frames)assert.deepEqual(frameAt(episode,sample.time),sample);
 assert.equal(frameAt(episode,-1),episode.frames[0]);assert.equal(frameAt(episode,episode.duration+2),episode.frames.at(-1));
});

test('worker permits one run, pauses and resumes between candidate batches, then cancels cleanly',async t=>{
 const w=spawnWorker();t.after(()=>w.worker.terminate());
 w.worker.postMessage({type:'start',options:{seed:52,population:12,generations:8}});
 const started=await w.wait('started');assert.equal(started.message.run.status,'running');
 w.worker.postMessage({type:'pause'});w.worker.postMessage({type:'start',options:{seed:2,population:12,generations:2}});
 const rejected=await w.wait('error',started.index);assert.match(rejected.message.message,/active run/);
 const paused=await w.wait('paused',rejected.index);
 assert.equal(paused.message.run.status,'paused');const pending=paused.message.state.pending;assert.ok(!pending||pending.candidates.length<=4,`pending candidate count: ${pending?.candidates.length}`);
 w.worker.postMessage({type:'resume'});const resumed=await w.wait('resumed',paused.index);assert.equal(resumed.message.type,'resumed');
 const generation=await w.wait('generation',resumed.index);assert.equal(generation.message.row.generation,paused.message.state.generation+1);
 w.worker.postMessage({type:'cancel'});const finished=await w.wait('finished',generation.index);
 assert.equal(finished.message.run.status,'cancelled');assert.equal(finished.message.state.stopReason,'cancelled');
});

test('worker run metadata matches normalized optimizer defaults',async t=>{
 const w=spawnWorker();t.after(()=>w.worker.terminate());w.worker.postMessage({type:'start'});
 const started=await w.wait('started');assert.equal(started.message.run.population,started.message.state.population);assert.equal(started.message.run.generationLimit,started.message.state.generations);
 w.worker.postMessage({type:'cancel'});await w.wait('finished',started.index);
});

test('worker restores a partial checkpoint with the same deterministic next generation',async t=>{
 const experiment=createExperiment(),options={seed:812,population:12,generations:1},full=createEvolution(options),expected=evolveGeneration(full,experiment);
 const partial=createEvolution(options);let checks=0;
 assert.equal(evolveGeneration(partial,experiment,{fitness:trainingFitness,cancelled:()=>checks++>=4}),null);
 assert.equal(partial.pending.candidates.length,4);
 const run=makeLearningRun(experiment,options);run.status='cancelled';run.checkpoint=partial;run.snapshots[0].loss=partial.best.loss;
 const w=spawnWorker();t.after(()=>w.worker.terminate());w.worker.postMessage({type:'restore',run});
 const started=await w.wait('started');assert.equal(started.message.state.pending.candidates.length,4);
 const generated=await w.wait('generation',started.index);assert.deepEqual(generated.message.row,{generation:expected.generation,evaluations:expected.evaluations,bestLoss:expected.best.loss,winnerLoss:expected.winner.loss,worstLoss:expected.worst.loss,medianLoss:expected.medianLoss,sigma:expected.sigma,failedCount:expected.failedCandidates.length,failedCandidates:expected.failedCandidates});
 w.worker.postMessage({type:'cancel'});await w.wait('finished',generated.index);
});

test('worker records invalid candidates but omits their non-replayable policies',async t=>{
 const experiment=createExperiment(),options={seed:43,population:12,generations:1},state=createEvolution(options);initializeEvolution(state,experiment);
 state.status='running';state.pending={generation:1,oldMean:[...state.mean],candidates:Array.from({length:state.population},(_,index)=>{const policy=Array(POLICY_SIZE).fill(0);policy[0]=101+index;return{policy,y:Array(POLICY_SIZE).fill(0),loss:1e12,failed:true,reason:'policy-out-of-bounds'};})};
 const run=makeLearningRun(experiment,options);run.status='paused';run.checkpoint=state;run.snapshots[0].loss=state.best.loss;
 const w=spawnWorker();t.after(()=>w.worker.terminate());w.worker.postMessage({type:'restore',run});
 const started=await w.wait('started'),generated=await w.wait('generation',started.index);
 assert.equal(generated.message.row.failedCount,12);assert.equal(generated.message.row.failedCandidates.length,12);assert.equal(generated.message.row.failedCandidates[0].reason,'policy-out-of-bounds');
 assert.equal(generated.message.snapshots.some(snapshot=>snapshot.kind==='failure'||snapshot.kind==='winner'),false);
 const finished=await w.wait('finished',generated.index);assert.equal(finished.message.run.status,'complete');assert.equal(snapshotOptions(finished.message.run,{kind:'failure'}).length,0);
});

test('fresh worker training is deterministic and imports no network or device control modules',async t=>{
 const rows=[];
 for(let pass=0;pass<2;pass++){
  const w=spawnWorker();t.after(()=>w.worker.terminate());w.worker.postMessage({type:'start',options:{seed:991,population:12,generations:1}});
  const started=await w.wait('started'),generation=await w.wait('generation',started.index);rows.push(generation.message.row);
  const unsuccessful=generation.message.snapshots.find(snapshot=>snapshot.kind==='failure');assert.equal(unsuccessful.loss,generation.message.row.worstLoss);assert.equal(unsuccessful.failed,false);assert.equal(unsuccessful.failureReason,undefined);
  w.worker.postMessage({type:'cancel'});await w.wait('finished',generation.index);
 }
 assert.deepEqual(rows[0],rows[1]);
 const source=(await Promise.all(['../src/replica/learning/worker.js','../src/replica/learning/run.js'].map(p=>readFile(new URL(p,import.meta.url),'utf8')))).join('\n');
 assert.doesNotMatch(source,/fetch\s*\(|WebSocket|serialport|controller\.mjs|movement\.mjs|http:\/\//i);
});

