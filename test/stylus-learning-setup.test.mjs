import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_DESK} from '../src/replica/state.js';
import {DEFAULT_POSE} from '../apps/bot-crossing/src/arm-manual/model.js';
import {learningSetup} from '../src/replica/learning/setup.js';
import {makeTasks,taskLabel} from '../src/replica/learning/tasks.js';

test('learning setup selects the saved draft and returns detached pose and desk copies',()=>{
 const manualPose={...DEFAULT_POSE},manualDesk={...DEFAULT_DESK},draftPose={...DEFAULT_POSE,base:.2},draftDesk={...DEFAULT_DESK,laptopX:140,laptopYaw:18};
 const selected=learningSetup(manualPose,manualDesk,{pose:draftPose,desk:draftDesk,seed:'7741',frontReach:'107.5'});
 assert.deepEqual(selected,{pose:draftPose,desk:draftDesk});
 assert.notEqual(selected.pose,draftPose);assert.notEqual(selected.desk,draftDesk);
 selected.pose.base=.4;selected.desk.laptopX=200;
 assert.equal(draftPose.base,.2);assert.equal(draftDesk.laptopX,140);
 assert.equal(manualPose.base,DEFAULT_POSE.base);assert.equal(manualDesk.laptopX,DEFAULT_DESK.laptopX);
});

test('learning setup falls back to Manual only when there is no draft',()=>{
 const pose={...DEFAULT_POSE},desk={...DEFAULT_DESK},selected=learningSetup(pose,desk);
 assert.deepEqual(selected,{pose,desk});assert.notEqual(selected.pose,pose);assert.notEqual(selected.desk,desk);
});

test('learning setup rejects invalid selected pose or desk values',()=>{
 assert.throws(()=>learningSetup({...DEFAULT_POSE,base:9},DEFAULT_DESK),/valid saved Manual pose/);
 assert.throws(()=>learningSetup(DEFAULT_POSE,{...DEFAULT_DESK,laptopWidth:Infinity}),/Laptop width/);
 assert.throws(()=>learningSetup(DEFAULT_POSE,DEFAULT_DESK,{pose:null,desk:DEFAULT_DESK,seed:'1'}),/valid saved Manual pose/);
 assert.throws(()=>learningSetup(DEFAULT_POSE,DEFAULT_DESK,{pose:DEFAULT_POSE,desk:{...DEFAULT_DESK,laptopDepth:0},seed:'1'}),/Laptop depth/);
});

test('task labels are friendly, deterministic, and distinct across all split choices',()=>{
 const tasks=['train','validation','test'].flatMap(split=>makeTasks(split)),before=JSON.stringify(tasks),labels=tasks.map(taskLabel);
 assert.equal(JSON.stringify(tasks),before);
 assert.equal(new Set(labels).size,labels.length);
 assert.deepEqual(labels,tasks.map(taskLabel));
 assert.ok(labels.some(label=>label.startsWith('Horizontal stroke')));
 assert.ok(labels.some(label=>label.startsWith('Vertical stroke')));
 assert.equal(labels.filter(label=>label.startsWith('Diagonal stroke')).length,2);
 assert.ok(labels.some(label=>label.startsWith('Circle')));
 assert.ok(labels.some(label=>label.startsWith('Figure eight')));
 assert.ok(labels.filter(label=>label.startsWith('Poke ·')).every(label=>/across \d+(?:\.\d+)?%, forward \d+(?:\.\d+)?%/.test(label)));
 assert.throws(()=>taskLabel({kind:'unknown'}),/Cannot label/);
});
