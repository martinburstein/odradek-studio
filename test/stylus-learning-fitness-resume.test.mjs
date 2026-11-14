import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createExperiment,simulateTask,trainingFitnessV2} from '../src/replica/learning/simulation.js';
import {makeTasks} from '../src/replica/learning/tasks.js';
import {createEvolution,evolveGeneration,initializeEvolution,validateEvolution} from '../src/replica/learning/evolution.js';
import {FITNESS_V1,FITNESS_V2} from '../src/replica/learning/fitness-version.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixture=JSON.parse(await fs.readFile(path.join(root,'test/fixtures/stylus-learning-v1.json'),'utf8'));
const clone=value=>JSON.parse(JSON.stringify(value));

test('default and explicit V1 states retain the legacy serialized shape',()=>{
 const options={seed:91,population:12,generations:2},implicit=createEvolution(options),explicit=createEvolution({...options,fitnessVersion:FITNESS_V1});
 assert.deepEqual(explicit,implicit);
 assert.equal(JSON.stringify(explicit),JSON.stringify(implicit));
 assert.equal(Object.hasOwn(implicit,'fitnessVersion'),false);
 const v2=createEvolution({...options,fitnessVersion:FITNESS_V2});
 assert.equal(v2.fitnessVersion,FITNESS_V2);
 assert.throws(()=>createEvolution({...options,fitnessVersion:'unknown'}),/fitness version/);
 assert.throws(()=>createEvolution({...options,fitnessVersion:undefined}),/fitness version/);
});

test('legacy partial V1 checkpoint resumes to golden optimizer state, history, and trajectories',()=>{
 const run=fixture.partialRun,state=validateEvolution(clone(run.checkpoint));
 assert.equal(Object.hasOwn(state,'fitnessVersion'),false);
 assert.equal(state.pending.candidates.length,4);
 const experiment=createExperiment(run.experiment),history=[];
 while(state.generation<run.generationLimit){
  const result=evolveGeneration(state,experiment);
  history.push({generation:result.generation,evaluations:result.evaluations,bestLoss:result.best.loss,winnerLoss:result.winner.loss,worstLoss:result.worst.loss,medianLoss:result.medianLoss,sigma:result.sigma,failedCount:result.failedCandidates.length,failedCandidates:result.failedCandidates});
 }
 assert.deepEqual(state,fixture.expectedFinalState);
 assert.deepEqual(history,fixture.expectedHistory);
 for(const expected of fixture.trajectories){
  const task=makeTasks(expected.split).find(item=>item.id===expected.taskId);
  assert.ok(task,`missing golden task ${expected.taskId}`);
  const episode=simulateTask(fixture.expectedFinalState.best.policy,task,experiment,{trace:true});
  assert.equal(episode.frames.length,expected.frames);
  assert.equal(createHash('sha256').update(JSON.stringify(episode.frames)).digest('hex'),expected.frameSha256,expected.taskId);
 }
});

test('V2 chooses its fitness by checkpoint version and has deterministic interrupted continuation',()=>{
 const experiment=createExperiment(),v2=createEvolution({seed:17,population:12,generations:2,fitnessVersion:FITNESS_V2});
 const measured=initializeEvolution(v2,experiment),direct=trainingFitnessV2(v2.mean,experiment);
 assert.equal(measured.loss,direct.loss);assert.equal(measured.staticLoss,direct.staticLoss);assert.equal(measured.dynamicLoss,direct.dynamicLoss);
 const full=createEvolution({seed:31,population:12,generations:2,fitnessVersion:FITNESS_V2}),split=createEvolution({seed:31,population:12,generations:2,fitnessVersion:FITNESS_V2});
 while(full.generation<2)evolveGeneration(full,experiment);
 let calls=0;assert.equal(evolveGeneration(split,experiment,{cancelled:()=>calls++>=5}),null);
 assert.equal(split.pending.candidates.length,5);
 const resumed=validateEvolution(clone(split));resumed.status='running';resumed.stopReason=null;
 while(resumed.generation<2)evolveGeneration(resumed,experiment);
 assert.deepEqual(resumed,full);
 assert.equal(resumed.fitnessVersion,FITNESS_V2);
});

test('custom fitness overrides checkpoint selection for both baseline and candidate evaluations',()=>{
 const state=createEvolution({seed:8,population:12,generations:1,fitnessVersion:FITNESS_V2});let calls=0;
 const custom=(policy)=>{calls++;return{loss:policy.reduce((sum,value)=>sum+value*value,0)+7,staticLoss:3,dynamicLoss:4};};
 evolveGeneration(state,{}, {fitness:custom});
 assert.equal(calls,state.population+1);
 assert.equal(state.best.staticLoss,3);assert.equal(state.best.dynamicLoss,4);
});

test('validator treats missing fitness as V1 and rejects unknown or undefined profiles',()=>{
 const legacy=createEvolution(),v2=createEvolution({fitnessVersion:FITNESS_V2});
 assert.equal(validateEvolution(legacy),legacy);
 assert.throws(()=>validateEvolution({...legacy,fitnessVersion:'future-version'}),/fitness version/);
 assert.throws(()=>validateEvolution({...v2,fitnessVersion:undefined}),/fitness version/);
});
