import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {simulateTask,createExperiment} from '../src/replica/learning/simulation.js';
import {makeTasks} from '../src/replica/learning/tasks.js';

const fixture=JSON.parse(await fs.readFile(new URL('./fixtures/stylus-v1-trajectories.json',import.meta.url),'utf8'));

test('a learned nonzero v1 policy retains every trajectory sample and metric from the frozen 0.5.0 simulator',()=>{
 assert.equal(fixture.sourceCommit,'3c85c5e9a8b45c99a69410230af281b3f4b1167e');
 assert.ok(fixture.policy.some(value=>Math.abs(value)>.01));
 const experiment=createExperiment(fixture.experiment);
 for(const expected of fixture.trajectories){
  const task=makeTasks(expected.split).find(item=>item.id===expected.taskId),episode=simulateTask(fixture.policy,task,experiment,{trace:true});
  assert.equal(episode.frames.length,expected.frameCount);
  assert.equal(createHash('sha256').update(JSON.stringify(episode.frames)).digest('hex'),expected.frameSha256,expected.taskId);
  assert.deepEqual(episode.metrics,expected.metrics);
  assert.ok(episode.frames.every(frame=>frame.pose.gripper===experiment.gripper));
 }
 const adverse=fixture.trajectories.find(item=>item.taskId==='test-poke-0.87-0.87');
 assert.ok(adverse.metrics.maxPenetration>2,'the original failure must not disappear from legacy replay');
});
