import test from 'node:test';
import assert from 'node:assert/strict';
import {createExperiment,POLICY_SIZE,simulateTask} from '../src/replica/learning/simulation.js';
import {resolvePlant} from '../src/replica/learning/plant.js';

const experiment=createExperiment();
const policy=()=>{const value=Array(POLICY_SIZE).fill(0);value[1]=.2;value[10+2]=-.15;return value;};
const task={id:'plant-poke',kind:'poke',u:.2,v:.5,duration:4};

test('omitted plant and explicit identity plant preserve the nominal rollout exactly',()=>{
 const frozen={experiment:structuredClone(experiment),policy:policy(),task:structuredClone(task)};
 const omitted=simulateTask(frozen.policy,frozen.task,experiment,{trace:true});
 const identity=simulateTask(frozen.policy,frozen.task,experiment,{trace:true,plant:{}});
 const reference=simulateTask(frozen.policy,frozen.task,experiment,{trace:true,reference:true});
 const referenceIdentity=simulateTask(frozen.policy,frozen.task,experiment,{trace:true,reference:true,plant:{}});
 assert.deepEqual(identity,omitted);
 assert.deepEqual(referenceIdentity,reference);
 assert.deepEqual(experiment,frozen.experiment);
 assert.deepEqual(frozen.policy,policy());
 assert.deepEqual(frozen.task,task);
});

test('plant geometry changes actual tip and deck contact while commands and targets stay nominal',()=>{
 const toolPlant=resolvePlant(experiment,{tool:{frontReach:experiment.tool.frontReach+2}});
 const shiftedPlant=resolvePlant(experiment,{desk:{laptopX:experiment.desk.laptopX+3}});
 assert.deepEqual(toolPlant.tool.end,experiment.tool.end);
 assert.equal(toolPlant.tool.targetTilt,experiment.tool.targetTilt);
 assert.deepEqual(toolPlant.desk,experiment.desk);
 assert.deepEqual(shiftedPlant.tool,experiment.tool);
 assert.notDeepEqual(shiftedPlant.frame,experiment.frame);
 const nominal=simulateTask(policy(),{...task,u:.01},experiment,{trace:true,reference:true});
 const shifted=simulateTask(policy(),{...task,u:.01},experiment,{trace:true,reference:true,plant:{desk:{laptopX:experiment.desk.laptopX+3}}});
 assert.deepEqual(shifted.frames.map(row=>row.target),nominal.frames.map(row=>row.target));
 assert.deepEqual(shifted.frames.map(row=>row.pose),nominal.frames.map(row=>row.pose));
 assert.notDeepEqual(shifted.frames.map(row=>row.contact),nominal.frames.map(row=>row.contact));
 const nominalReach=simulateTask(policy(),task,experiment,{trace:true,reference:true});
 const longTool=simulateTask(policy(),task,experiment,{trace:true,reference:true,plant:{tool:{frontReach:experiment.tool.frontReach+2}}});
 assert.notDeepEqual(longTool.frames.map(row=>row.tip),nominalReach.frames.map(row=>row.tip));
 assert.deepEqual(longTool.frames.map(row=>row.target),nominalReach.frames.map(row=>row.target));
});

test('plant changes preserve nominal targets, zero-policy joint commands, seed pose, and gripper',()=>{
 const p=Array(POLICY_SIZE).fill(0),nominal=simulateTask(p,task,experiment,{trace:true}),variant=simulateTask(p,task,experiment,{trace:true,plant:{desk:{laptopYaw:1},tool:{frontReach:experiment.tool.frontReach+2}}});
 assert.deepEqual(variant.frames.map(row=>row.target),nominal.frames.map(row=>row.target));
 assert.ok(variant.frames.every(row=>row.pose.base===experiment.seedPose.base&&row.pose.shoulder===experiment.seedPose.shoulder&&row.pose.elbow===experiment.seedPose.elbow));
 assert.ok(variant.frames.every(row=>row.pose.gripper===experiment.gripper));
});

test('plant speed cap changes execution repeatably without changing nominal targets',()=>{
 const line={id:'plant-line',kind:'line',from:[.15,.5],to:[.85,.5],duration:4};
 const p=policy(),nominal=simulateTask(p,line,experiment,{trace:true,reference:true}),slow=simulateTask(p,line,experiment,{trace:true,reference:true,plant:{maxSpeed:experiment.maxSpeed*.01}}),slowAgain=simulateTask(p,line,experiment,{trace:true,reference:true,plant:{maxSpeed:experiment.maxSpeed*.01}});
 assert.deepEqual(slowAgain,slow);
 assert.deepEqual(slow.frames.map(row=>row.target),nominal.frames.map(row=>row.target));
 assert.notDeepEqual(slow.frames.map(row=>row.pose),nominal.frames.map(row=>row.pose));
});

test('plant overrides reject unknown, nonfinite, invalid, and objective-changing inputs',()=>{
 for(const overrides of [{mystery:1},{desk:{laptopX:NaN}},{tool:{frontReach:Infinity}},{desk:{laptopX:900}},{tool:{end:'rear'}},{tool:{targetTilt:44}},{maxSpeed:0},{maxSpeed:500},{maxSpeed:undefined},{maxAcceleration:Infinity},{maxAcceleration:undefined},{desk:null},{desk:undefined},{tool:null},{tool:undefined},{tool:{unknown:1}}]){
  assert.throws(()=>resolvePlant(experiment,overrides),undefined,JSON.stringify(overrides));
 }
});
