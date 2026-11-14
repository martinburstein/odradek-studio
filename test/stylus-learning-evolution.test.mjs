import test from 'node:test';
import assert from 'node:assert/strict';
import {createExperiment,trainingFitness,POLICY_SIZE} from '../src/replica/learning/simulation.js';
import {createEvolution,evolveGeneration,validateEvolution} from '../src/replica/learning/evolution.js';

const clone=value=>JSON.parse(JSON.stringify(value));
const cheap=(policy)=>({loss:policy.reduce((sum,x)=>sum+x*x,0),staticLoss:1,dynamicLoss:2});

test('seeded optimizer produces identical generations after serializable mid-generation cancellation',()=>{
 const full=createEvolution({seed:44,population:12,generations:3}),split=createEvolution({seed:44,population:12,generations:3});
 for(let i=0;i<3;i++)evolveGeneration(full,{}, {fitness:cheap});
 let calls=0;const partial=evolveGeneration(split,{}, {fitness:cheap,cancelled:()=>calls++>=5});
 assert.equal(partial,null);assert.equal(split.status,'cancelled');assert.equal(split.pending.candidates.length,5);
 const resumed=validateEvolution(clone(split));resumed.status='running';resumed.stopReason=null;
 while(resumed.generation<3)evolveGeneration(resumed,{}, {fitness:cheap});
 assert.deepEqual(resumed,full);
});

test('checkpoint validator rejects malformed budgets, strategy parameters, covariance, and best state',()=>{
 const state=createEvolution();
 for(const mutate of [s=>s.population=1,s=>s.generations=2001,s=>s.rng=NaN,s=>s.cs=-1,s=>s.weights[0]=0,s=>s.covariance[0][0]=-1,s=>s.best={policy:Array(POLICY_SIZE).fill(0),loss:-1,generation:0}]){
  const bad=clone(state);mutate(bad);assert.throws(()=>validateEvolution(bad));
 }
 assert.equal(validateEvolution(state),state);
});

test('best policy never regresses, failed candidates are recorded, and incomplete generations do not select',()=>{
 const state=createEvolution({seed:7,population:12,generations:2,initialPolicy:Array(POLICY_SIZE).fill(0)});
 let first=true;const record=evolveGeneration(state,{}, {fitness:()=>{if(first){first=false;return{loss:0};}throw Error('injected failure');}});
 assert.equal(record.failedCandidates.length,12);assert.equal(record.winner.failed,true);assert.equal(state.best.loss,0);
 assert.equal(record.worst.loss,1e12);
});

test('training selector is isolated from validation and test task IDs; actual fitness can improve',()=>{
 const experiment=createExperiment(),initial=Array(POLICY_SIZE).fill(0),state=createEvolution({seed:20261114,population:48,generations:120});
 const baseline=trainingFitness(initial,experiment).loss;
 while(state.status!=='complete')evolveGeneration(state,experiment);
 assert.ok(state.best.loss<baseline,`${state.best.loss} should improve on ${baseline}`);
});
