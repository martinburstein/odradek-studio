import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {makeLearningRun,parseLearningRun} from '../src/replica/learning/run.js';
import {createEvolution,validateEvolution} from '../src/replica/learning/evolution.js';
import {FITNESS_V1,FITNESS_V2,DEFAULT_FITNESS_VERSION,checkpointFitnessVersion} from '../src/replica/learning/fitness-version.js';
import {createExperiment,validatePolicy,LEARNING_VERSION,POLICY_SIZE,simulateTask} from '../src/replica/learning/simulation.js';
import {makeTasks} from '../src/replica/learning/tasks.js';

function spawnWorker(){
 const url=new URL('../src/replica/learning/worker.js',import.meta.url).href;
 const code=`(async()=>{const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:value=>parentPort.postMessage(value)};await import(${JSON.stringify(url)});parentPort.on('message',data=>self.onmessage({data}));})()`;
 const worker=new Worker(code,{eval:true}),messages=[];worker.on('message',message=>messages.push(message));
 return{worker,messages,wait(type,from=0){for(let i=from;i<messages.length;i++)if(messages[i].type===type)return Promise.resolve({message:messages[i],index:i+1});return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`Timed out waiting for ${type}`)),30000);const onMessage=message=>{if(message.type===type){clearTimeout(timer);worker.off('message',onMessage);resolve({message,index:messages.length});}};worker.on('message',onMessage);});}};
}

test('portable envelopes preserve v1 and require matching explicit v2 fitness metadata',()=>{
 const legacy=makeLearningRun(undefined,{seed:81,population:12,generations:2});
 assert.equal(legacy.version,1);assert.equal(Object.hasOwn(legacy,'fitnessVersion'),false);
 const parsedLegacy=parseLearningRun(JSON.stringify(legacy));assert.equal(parsedLegacy.version,1);assert.equal(Object.hasOwn(parsedLegacy,'fitnessVersion'),false);
 const modern=makeLearningRun(undefined,{seed:82,population:12,generations:2,fitnessVersion:FITNESS_V2});
 assert.equal(modern.version,2);assert.equal(modern.fitnessVersion,FITNESS_V2);assert.equal(parseLearningRun(JSON.stringify(modern)).fitnessVersion,FITNESS_V2);
 for(const mutate of [run=>delete run.fitnessVersion,run=>run.fitnessVersion='unknown',run=>run.fitnessVersion=FITNESS_V1]){
  const malformed=structuredClone(modern);mutate(malformed);assert.throws(()=>parseLearningRun(JSON.stringify(malformed)),/fitness/i);
 }
 const ambiguous=structuredClone(legacy);ambiguous.fitnessVersion=FITNESS_V1;assert.throws(()=>parseLearningRun(JSON.stringify(ambiguous)),/fitness/i);
});
test('portable run rejects a checkpoint whose resolved fitness differs from its envelope',()=>{
 const state=createEvolution({seed:83,population:12,generations:2});
 assert.equal(checkpointFitnessVersion(state),FITNESS_V1);assert.equal(validateEvolution(state),state);
 const modern=makeLearningRun(undefined,{seed:83,population:12,generations:2,fitnessVersion:FITNESS_V2});modern.checkpoint=state;
 assert.throws(()=>parseLearningRun(JSON.stringify(modern)),/fitness version/i);
 const modernState=createEvolution({seed:83,population:12,generations:2,fitnessVersion:FITNESS_V2});
 assert.equal(checkpointFitnessVersion(modernState),FITNESS_V2);
 modern.checkpoint=modernState;assert.equal(parseLearningRun(JSON.stringify(modern)).checkpoint.fitnessVersion,FITNESS_V2);
 const unknown=structuredClone(modern);unknown.checkpoint.fitnessVersion='future-fitness';assert.throws(()=>parseLearningRun(JSON.stringify(unknown)),/fitness/i);
});

test('frozen 0.5.0 parser accepts a legacy run and rejects a new v2 envelope',async()=>{
 const frozen=await readFile(new URL('../test/fixtures/stylus-v0.5.0-run.js.txt',import.meta.url),'utf8');
 assert.equal(createHash('sha256').update(frozen).digest('hex'),'f8e2c0a0f79bfc9563e0d6cc7f30d870cba70f5e272e8efe9163151d1a592e5e');
 const oldParserSource=frozen.replace(/^import .+;\r?\n/gm,'').replace(/^export /gm,'')+'\nglobalThis.oldParseLearningRun=parseLearningRun; globalThis.oldRunVersion=RUN_VERSION;';
 const oldParser=vm.createContext({createExperiment,validatePolicy,LEARNING_VERSION,POLICY_SIZE,simulateTask,makeTasks,validateEvolution});
 vm.runInContext(oldParserSource,oldParser,{filename:'stylus-v0.5.0-run.js'});
 assert.equal(oldParser.oldRunVersion,1);
 const legacy=await readFile(new URL('../assets/learning/stylus-example-v1.json',import.meta.url),'utf8');
 assert.equal(oldParser.oldParseLearningRun(legacy).version,1);
 const next=makeLearningRun(undefined,{seed:85,population:12,generations:2,fitnessVersion:FITNESS_V2});
 assert.equal(next.version,2);assert.throws(()=>oldParser.oldParseLearningRun(JSON.stringify(next)),/compatible preview-only/);
});

test('worker defaults new runs to v2 and restores each saved fitness profile',async t=>{
 for(const [options,expected] of [[{},DEFAULT_FITNESS_VERSION],[{fitnessVersion:FITNESS_V1},FITNESS_V1]]){
  const w=spawnWorker();t.after(()=>w.worker.terminate());
  w.worker.postMessage({type:'start',options:{seed:84,population:12,generations:4,...options}});
  const started=await w.wait('started');assert.equal(started.message.state.fitnessVersion,expected===FITNESS_V1?undefined:FITNESS_V2);
  assert.equal(started.message.run.version,expected===FITNESS_V1?1:2);
  assert.equal(expected===FITNESS_V1?Object.hasOwn(started.message.run,'fitnessVersion'):started.message.run.fitnessVersion===expected,expected===FITNESS_V1?false:true);
  w.worker.postMessage({type:'pause'});const paused=await w.wait('paused',started.index);
  assert.equal(checkpointFitnessVersion(paused.message.state),expected);
  assert.equal(parseLearningRun(JSON.stringify(paused.message.run)).version,expected===FITNESS_V1?1:2);
  assert.ok(!paused.message.state.pending||paused.message.state.pending.candidates.length<=4);
  assert.equal(paused.message.run.checkpoint.fitnessVersion,paused.message.state.fitnessVersion);
  w.worker.postMessage({type:'restore',run:paused.message.run});
  const restored=await w.wait('started',paused.index);
  assert.equal(checkpointFitnessVersion(restored.message.state),expected);
  assert.equal(restored.message.run.version,expected===FITNESS_V1?1:2);
  w.worker.postMessage({type:'cancel'});await w.wait('finished',restored.index);
 }
});

test('worker defaults only when the fitness option is absent and rejects conflicting aliases',async t=>{
 for(const request of [
  {type:'start',fitnessVersion:null},
  {type:'start',fitnessVersion:undefined},
  {type:'start',options:{fitnessVersion:null}},
  {type:'start',options:{fitnessVersion:undefined}},
  {type:'start',fitnessVersion:FITNESS_V2,options:{fitnessVersion:FITNESS_V1}},
 ]){
  const w=spawnWorker();t.after(()=>w.worker.terminate());w.worker.postMessage(request);
  const error=await w.wait('error');assert.match(error.message.message,/fitness|version/i);
 }
});
