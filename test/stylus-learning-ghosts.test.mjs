import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import {createIterationGhosts,iterationGhostSnapshots,MAX_ITERATION_GHOSTS} from '../src/replica/learning/ghosts.js';
import {parseLearningRun,snapshotOptions} from '../src/replica/learning/run.js';
import {createReplicaModel,RIG_NAMES} from '../src/replica/rig.js';

const asset=JSON.parse(await fs.readFile(new URL('../assets/roarm/RoArm-M2-S.bbmodel',import.meta.url),'utf8'));
const run=parseLearningRun(await fs.readFile(new URL('../assets/learning/stylus-corner-after-v2.json',import.meta.url),'utf8'));
test('ghost selection retains actual saved policies and reports bounded sampling or failed evaluations',()=>{
 const selected=iterationGhostSnapshots(run);assert.equal(selected.total,82);assert.equal(selected.selected.length,82);assert.equal(selected.sampled,false);assert.equal(selected.selected[0],run.snapshots[0]);
 const many={snapshots:Array.from({length:2001},(_,generation)=>({generation,kind:generation?'best':'baseline'}))};
 const capped=iterationGhostSnapshots(many);assert.equal(capped.selected.length,MAX_ITERATION_GHOSTS);assert.equal(capped.sampled,true);assert.equal(capped.selected[0].generation,0);assert.equal(capped.selected.at(-1).generation,2000);
 const failed=iterationGhostSnapshots({snapshots:[{generation:1,kind:'failure',failed:true},{generation:2,kind:'failure',failed:false}]},'failure');assert.equal(failed.failed,1);assert.equal(failed.selected.length,1);assert.equal(failed.selected[0].generation,2);
});
test('all saved ghost arms share actual replica geometry and follow the same sampled trial time',async()=>{
 const scene=new THREE.Scene(),ghosts=createIterationGhosts(scene,asset),replica=createReplicaModel(asset,{textures:false}),before=JSON.stringify(run);
 try{ghosts.setEnabled(true);await ghosts.load(run);assert.equal(ghosts.count,snapshotOptions(run).length);
  assert(ghosts.group.children.length<=8,'merged joint instances avoid a separate arm mesh tree per iteration');
  ghosts.setFrame(3.47);const frames=ghosts.frames;assert.equal(frames[0].frame.time,104/30);assert.equal(frames.at(-1).frame.time,104/30);
  assert.notDeepEqual(frames[0].frame.pose,frames.at(-1).frame.pose,'actual early and learned poses remain different');
  const bounds=new THREE.Box3().setFromPoints(ghosts.framePoints.map(p=>new THREE.Vector3(p.x,p.y,p.z)));
  assert.equal(ghosts.framePoints.length,8);
  for(const mesh of ghosts.group.children.filter(mesh=>mesh.name.startsWith('Iteration ghosts:'))){const transform=new THREE.Matrix4();mesh.getMatrixAt(0,transform);assert(bounds.containsBox(mesh.geometry.boundingBox.clone().applyMatrix4(transform)),'camera envelope contains the actual ghost mesh');}
  for(const index of [0,frames.length-1]){
   replica.setPose(frames[index].frame.pose);
   for(const key of ['shoulder','elbow','gripper','leftJaw','rightJaw']){const mesh=ghosts.group.children.find(child=>child.name===`Iteration ghosts: ${RIG_NAMES[key]}`);if(!mesh)continue;const actual=new THREE.Matrix4();mesh.getMatrixAt(index,actual);replica.joints[key].matrixWorld.elements.forEach((value,i)=>assert(Math.abs(actual.elements[i]-value)<2e-6,`${key} matrix matches the solid replica`));}
  }
  assert.equal(JSON.stringify(run),before,'replay cannot change the saved optimizer or policy data');
  ghosts.setOpacity(.4);assert(ghosts.group.children[0].material.opacity>0);assert.equal(ghosts.group.children[0].material.depthWrite,false);
 }finally{replica.dispose();ghosts.dispose();}
 assert.equal(scene.children.length,0);
});
test('changing attempts or disabling during preparation cannot leave stale ghost arms',async()=>{
 const scene=new THREE.Scene(),ghosts=createIterationGhosts(scene,asset);
 ghosts.setEnabled(true);const first=ghosts.load(run),second=ghosts.load(run,{kind:'winner'});await Promise.all([first,second]);
 assert.equal(ghosts.count,snapshotOptions(run,{kind:'winner'}).length);assert.equal(ghosts.frames[0].generation,1);
 const reload=ghosts.load(run,{kind:'failure'});ghosts.setEnabled(false);await reload;assert.equal(ghosts.count,0);assert.equal(ghosts.group.visible,false);
 ghosts.dispose();assert.equal(scene.children.length,0);
});
test('an imported run with the same ID and row counts cannot reuse stale ghost policies',async()=>{
 const ghosts=createIterationGhosts(new THREE.Scene(),asset);ghosts.setEnabled(true);await ghosts.load(run);ghosts.setFrame(3.47);const before=ghosts.frames[0].frame.pose;
 const changed=structuredClone(run);changed.snapshots[0].policy[0]+=.2;await ghosts.load(changed);ghosts.setFrame(3.47);
 assert.notDeepEqual(ghosts.frames[0].frame.pose,before);ghosts.dispose();
});
