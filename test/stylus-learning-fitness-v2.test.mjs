import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {FITNESS_V1,FITNESS_V2} from '../src/replica/learning/fitness-version.js';
import {createExperiment,simulateTask,trainingFitness,trainingFitnessForVersion,trainingFitnessV1,trainingFitnessV2} from '../src/replica/learning/simulation.js';
import {makeTasks} from '../src/replica/learning/tasks.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const savedRunPath=path.join(root,'assets','learning','stylus-corner-before-v1.json');

async function savedBest(t){
 const run=JSON.parse(await fs.readFile(savedRunPath,'utf8'));
 const snapshot=run.snapshots.find(item=>item.kind==='best'&&item.generation===800);
 assert.ok(snapshot,'expected the recorded generation-800 best snapshot');
 return{run,policy:snapshot.policy,experiment:createExperiment(run.experiment)};
}

test('V1 alias and selector preserve the saved worker fitness exactly',async t=>{
 const{policy,experiment}=await savedBest(t);
 const expected={loss:0.08737630174443563,staticLoss:0.0058531568759012005,dynamicLoss:0.18701570102819995};
 assert.deepEqual(trainingFitness(policy,experiment),expected);
 assert.deepEqual(trainingFitnessV1(policy,experiment),expected);
 assert.deepEqual(trainingFitnessForVersion(FITNESS_V1)(policy,experiment),expected);
 assert.throws(()=>trainingFitnessForVersion(undefined),/Unsupported/);
 assert.throws(()=>trainingFitnessForVersion('stylus-fitness-v99'),/Unsupported/);
});

test('V2 averages only the seven existing training paths and charges the observed off-center corner path',async t=>{
 const{policy,experiment}=await savedBest(t),tasks=makeTasks('train');
 const selected=[tasks[0],tasks[2],tasks[4],tasks[6],tasks[8],tasks[9],tasks[10]];
 assert.deepEqual(selected.map(task=>task.id),[
  'train-poke-0.2-0.2','train-poke-0.2-0.8','train-poke-0.5-0.5',
  'train-poke-0.8-0.2','train-poke-0.8-0.8','train-horizontal','train-vertical'
 ]);
 const corner=simulateTask(policy,selected[4],experiment);
 assert.ok(corner.loss>0,'the saved candidate incurs a dynamic loss on the existing train corner path');
 const dynamicLoss=selected.reduce((sum,task)=>sum+simulateTask(policy,task,experiment).loss,0)/selected.length;
 const staticLoss=trainingFitness(policy,experiment).staticLoss;
 const expected={loss:staticLoss*.55+dynamicLoss*.45,staticLoss,dynamicLoss};
 assert.deepEqual(trainingFitnessV2(policy,experiment),expected);
 assert.deepEqual(trainingFitnessForVersion(FITNESS_V2)(policy,experiment),expected);
 assert.notEqual(expected.dynamicLoss,trainingFitnessV1(policy,experiment).dynamicLoss);
});
