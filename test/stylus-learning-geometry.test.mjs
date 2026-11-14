import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createReplicaModel,MM_SCALE} from '../src/replica/rig.js';
import {DEFAULT_DESK} from '../src/replica/state.js';
import {DEFAULT_POSE} from '../apps/bot-crossing/src/arm-manual/model.js';
import {DEG,DEFAULT_TOOL,toolGeometry,trackpadFrame,padPoint,padCoordinates,referenceIK,distance,validateTool,geometryContacts} from '../src/replica/learning/geometry.js';
import {makeTasks,taskTarget,minJerk} from '../src/replica/learning/tasks.js';
const close=(a,b,tolerance=1e-7)=>assert.ok(Math.abs(a-b)<tolerance,`${a} vs ${b}`);
test('pure tool FK agrees with the actual editable 3D replica, including lateral nib offset',async()=>{
 const asset=JSON.parse(await fs.readFile(new URL('../assets/roarm/RoArm-M2-S.bbmodel',import.meta.url))),rig=createReplicaModel(asset,{textures:false});
 for(const pose of [DEFAULT_POSE,{base:.3,shoulder:.2,elbow:1.2,gripper:2.5},{base:-1,shoulder:-.5,elbow:.4,gripper:1.8}]){
  rig.setPose(pose);const g=toolGeometry(pose),tip=rig.tip(),wrist=rig.positionOf('gripper');
  for(const key of ['x','y','z']){close(g.tip[key],tip[key]/MM_SCALE);close(g.wrist[key],wrist[key]/MM_SCALE);}
  const altered=toolGeometry({...pose,gripper:1.5});assert.deepEqual(altered,g);
 }
 rig.dispose();
});
test('both selectable stylus ends are opposite points on the same rigid held tool',()=>{
 const a=toolGeometry(DEFAULT_POSE),b=toolGeometry(DEFAULT_POSE,{...DEFAULT_TOOL,end:'rear'});
 close(distance(a.front,a.rear),DEFAULT_TOOL.frontReach+DEFAULT_TOOL.rearReach);assert.deepEqual(a.front,b.front);assert.deepEqual(b.tip,b.rear);assert.equal(a.tilt,b.tilt);
 const tilted=toolGeometry(DEFAULT_POSE,{...DEFAULT_TOOL,mountPitch:15});assert.ok(Math.abs(tilted.tilt-a.tilt)>10);
});
test('pad coordinates preserve dimensions and rotation and match the rendered nominal top surface',()=>{
 for(const yaw of [-90,-31,0,52,180]){const frame=trackpadFrame({...DEFAULT_DESK,laptopYaw:yaw});for(const u of [0,.5,1])for(const v of [0,.5,1]){const p=padPoint(frame,u,v,4.5),uv=padCoordinates(frame,p);close(uv.u,u);close(uv.v,v);close(uv.gap,4.5);}}
 const frame=trackpadFrame(DEFAULT_DESK);close(frame.center.y,DEFAULT_DESK.laptopHeight+1/70);close(distance(padPoint(frame,0,.5),padPoint(frame,1,.5)),115);
});
test('independent inverse position reference reconstructs held-out targets with either end and mount tilt',()=>{
 for(const configuration of [{},{mountPitch:13},{end:'rear',mountPitch:-10}]){const tool=validateTool(configuration);for(const pose of [{...DEFAULT_POSE,shoulder:.3,elbow:1.2},{...DEFAULT_POSE,base:-.6,shoulder:.6,elbow:1.8}]){const target=toolGeometry(pose,tool).tip,candidates=referenceIK(target,tool);assert.ok(candidates.length);for(const recovered of candidates)close(distance(toolGeometry(recovered,tool).tip,target),0);}}
 assert.deepEqual(referenceIK({x:0,y:0,z:2000}),[]);
});
test('exact target contact exposes the pitch tradeoff across the trackpad rather than inventing a wrist',()=>{
 const f=trackpadFrame(DEFAULT_DESK),tilts=[];for(const v of [.15,.5,.85]){const p=referenceIK(padPoint(f,.5,v,-.2))[0];assert.ok(p);tilts.push(toolGeometry(p).tilt);}assert.ok(Math.max(...tilts)-Math.min(...tilts)>5);
});
test('nominal contact is distinct from hovering and reports gross body collisions',()=>{
 const f=trackpadFrame(DEFAULT_DESK),p=referenceIK(padPoint(f,.5,.5,-.2))[0],g=toolGeometry(p),contact=geometryContacts(g,DEFAULT_DESK,f);assert.equal(contact.inside,true);close(contact.gap,-.2);assert.equal(contact.collision,false);
 const bad=toolGeometry({...DEFAULT_POSE,shoulder:Math.PI/2,elbow:Math.PI/2});assert.equal(geometryContacts(bad,DEFAULT_DESK,f).collision,true);
});
test('task sets are disjoint and trajectories have smooth approach/contact/lift phases',()=>{
 const sets=['train','validation','test'].map(makeTasks),ids=sets.flat().map(t=>t.id);assert.equal(new Set(ids).size,ids.length);const f=trackpadFrame(DEFAULT_DESK);
 for(const tasks of sets)for(const task of tasks){assert.equal(taskTarget(task,0,f).contact,false);assert.equal(taskTarget(task,task.duration/2,f).contact,true);assert.equal(taskTarget(task,task.duration,f).contact,false);for(let n=0;n<=100;n++){const a=taskTarget(task,task.duration*n/100,f);assert.ok(Object.values(a.point).every(Number.isFinite));assert.ok(a.u>=0&&a.u<=1&&a.v>=0&&a.v<=1);}}
 close(minJerk(0),0);close(minJerk(1),1);assert.ok(minJerk(.001)<1e-7);
});
test('invalid tool profiles and nonfinite poses fail before simulation',()=>{
 for(const input of [{frontReach:NaN},{frontReach:0},{end:'magic'},{extra:1},{tapeRadius:2,barrelRadius:5},{nibRadius:6,barrelRadius:3}])assert.throws(()=>validateTool(input));assert.throws(()=>toolGeometry({...DEFAULT_POSE,elbow:Infinity}));
});
