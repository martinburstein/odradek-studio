import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import {createReplicaModel,validateAsset,MM_SCALE,RIG_NAMES} from '../src/replica/rig.js';
import {slingshot,exactTarget,createPoseHistory,DEFAULT_DESK,validateDesk,JOINTS,degrees,radians,BOUNDS} from '../src/replica/state.js';
import {makeSession,parseSession} from '../src/replica/session.js';
import {DEFAULT_POSE} from '../apps/bot-crossing/src/arm-manual/model.js';
import {roarmForwardKinematics} from '../apps/bot-crossing/src/world/roarm-model.js';
const asset=JSON.parse(await fs.readFile(new URL('../assets/roarm/RoArm-M2-S.bbmodel',import.meta.url)));
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} vs ${b}`);
test('the editable Blockbench assembly contains major hardware and all four joint pivots',()=>{
 validateAsset(asset);assert.ok(asset.elements.length>=180);for(const text of ['Base servo 11','Shoulder servo 12','Shoulder servo 13','Elbow servo 14','Gripper servo 15','ESP32','OLED','USB-C ESP32','DC power','Wi-Fi antenna','Carbon upper','Distal carbon','Jaw finger','Stylus nib'])assert.ok(asset.elements.some(e=>e.name.includes(text)),text);
 assert.ok(asset.textures.every(t=>t.source.startsWith('data:image/png;base64,')));
});
test('replica wrist agrees with sourced EEMode-0 forward kinematics across different poses',()=>{
 const rig=createReplicaModel(asset,{textures:false});
 for(const pose of [DEFAULT_POSE,{base:.3,shoulder:.2,elbow:1.2,gripper:2.5},{base:-1,shoulder:-.5,elbow:.4,gripper:1.8}]){
  rig.setPose(pose);const expected=roarmForwardKinematics(pose),actual=rig.positionOf('gripper');close(actual.x,expected.x);close(actual.y,expected.y-.7);close(actual.z,expected.z);
 }
 rig.dispose();
});
test('shoulder servo housings stay on the yaw support while upper links articulate; base casing stays fixed',()=>{
 const rig=createReplicaModel(asset,{textures:false});rig.setPose(DEFAULT_POSE);const p=rig.parts.get('Shoulder servo 12 casing').getWorldPosition(new THREE.Vector3()),base=rig.parts.get('Base servo 11 body').getWorldPosition(new THREE.Vector3());
 rig.setPose({...DEFAULT_POSE,shoulder:.4});assert.ok(p.distanceTo(rig.parts.get('Shoulder servo 12 casing').getWorldPosition(new THREE.Vector3()))<1e-8);
 rig.setPose({...DEFAULT_POSE,base:.8});assert.ok(base.distanceTo(rig.parts.get('Base servo 11 body').getWorldPosition(new THREE.Vector3()))<1e-8);rig.dispose();
});
test('gripper affects opposing jaws and does not rotate the wrist or move the stylus',()=>{
 const rig=createReplicaModel(asset,{textures:false});rig.setPose(DEFAULT_POSE);const wrist=rig.positionOf('gripper'),tip=rig.tip();rig.setPose({...DEFAULT_POSE,gripper:radians('gripper',75)});
 assert.ok(rig.joints.leftJaw.rotation.z<0);assert.ok(rig.joints.rightJaw.rotation.z>0);assert.ok(wrist.distanceTo(rig.positionOf('gripper'))<1e-8);assert.ok(tip.distanceTo(rig.tip())<1e-8);rig.dispose();
});
test('slingshot pulls turn opposite the drag, grow monotonically, affect one joint and clamp to travel',()=>{
 for(const joint of JOINTS){let prior=0;for(const pixels of [10,40,90,180,400]){const result=slingshot(DEFAULT_POSE,joint,pixels,10);assert.ok(result.delta<=0);assert.ok(Math.abs(result.delta)>=prior);prior=Math.abs(result.delta);for(const other of JOINTS.filter(j=>j!==joint))assert.equal(result.pose[other],DEFAULT_POSE[other]);}
  const upper={...DEFAULT_POSE,[joint]:radians(joint,BOUNDS[joint][1])};const limited=slingshot(upper,joint,-180,30);close(limited.target,BOUNDS[joint][1]);assert.equal(limited.limited,true);
 }assert.equal(slingshot(DEFAULT_POSE,'base',4).delta,0);assert.throws(()=>slingshot(DEFAULT_POSE,'base',NaN));
});
test('exact angles preserve decimal precision and reject incomplete, non-finite or unsupported values',()=>{
 for(const joint of JOINTS){const value=joint==='base'?12.345:100.125,result=exactTarget(DEFAULT_POSE,joint,value);close(degrees(joint,result[joint]),value);for(const bad of [NaN,Infinity,'90',BOUNDS[joint][1]+1])assert.throws(()=>exactTarget(DEFAULT_POSE,joint,bad));}
});
test('undo and redo retain immutable pose snapshots and branching discards the old redo',()=>{
 const h=createPoseHistory(DEFAULT_POSE),a=exactTarget(DEFAULT_POSE,'base',10),b=exactTarget(a,'elbow',30);h.push(a);h.push(b);a.base=999;assert.equal(h.undo().elbow,DEFAULT_POSE.elbow);assert.equal(h.redo().elbow,b.elbow);h.undo();h.push(exactTarget(DEFAULT_POSE,'base',-5));assert.equal(h.canRedo(),false);
});
test('portable sessions round trip the exact asset, pose and desk without creating hardware claims',()=>{
 const desk={...DEFAULT_DESK,laptopWidth:350.25,laptopX:-90.5},pose=exactTarget(DEFAULT_POSE,'shoulder',135.25),session=makeSession({pose,desk,asset,name:'Desk A',selectedJoint:'elbow',selectedPoint:'LEFT_CLICK',fullPull:1,gripLocked:false,showLive:true}),restored=parseSession(JSON.stringify(session));
 assert.deepEqual(restored.asset,asset);assert.deepEqual(restored.pose,pose);assert.deepEqual(restored.desk,desk);assert.equal(restored.previewOnly,true);assert.equal(restored.selectedJoint,'elbow');assert.equal(restored.authorization,undefined);
 assert.equal(restored.selectedPoint,'LEFT_CLICK');assert.equal(restored.fullPull,1);assert.equal(restored.gripLocked,false);assert.equal(restored.showLive,true);
 for(const change of [{version:2},{previewOnly:false},{pose:{base:99}},{desk:{...desk,toolLength:9999}}])assert.throws(()=>parseSession(JSON.stringify({...session,...change})));
 assert.throws(()=>validateDesk({...DEFAULT_DESK,extra:1}));
});
test('session parsing rejects unknown control settings and reads prior exports with safe defaults',()=>{
 const legacy=makeSession({pose:DEFAULT_POSE,desk:DEFAULT_DESK});delete legacy.selectedPoint;delete legacy.fullPull;delete legacy.gripLocked;delete legacy.showLive;const restored=parseSession(JSON.stringify(legacy));assert.equal(restored.selectedPoint,'PRINT_SCREEN');assert.equal(restored.gripLocked,true);assert.equal(restored.showLive,false);
 for(const change of [{selectedPoint:'UNKNOWN'},{fullPull:360},{gripLocked:'false'},{selectedJoint:'wrist'},{showLive:'yes'}])assert.throws(()=>parseSession(JSON.stringify({...legacy,...change})));
});
test('malformed edited assets fail before installation instead of fetching external textures or losing joint identity',()=>{
 for(const change of [a=>a.groups.pop(),a=>a.textures[0].source='https://example.test/texture.png',a=>a.elements[0].from=[NaN,0,0],a=>a.outliner[0].children.push(a.elements[0].uuid),a=>a.groups.find(g=>g.name===RIG_NAMES.elbow).name='wrong']){const next=structuredClone(asset);change(next);assert.throws(()=>validateAsset(next));}
});
test('texture dimensions are bounded before image decode, and polygon vertices cannot resolve inherited object fields',()=>{
 const huge=structuredClone(asset),bytes=Buffer.from(huge.textures[0].source.split(',')[1],'base64');bytes.writeUInt32BE(100000,16);huge.textures[0].source='data:image/png;base64,'+bytes.toString('base64');assert.throws(()=>validateAsset(huge),/dimensions/);
 const malformed=structuredClone(asset),face=Object.values(malformed.elements.find(e=>e.type==='mesh').faces)[0];face.vertices[0]='__proto__';assert.throws(()=>validateAsset(malformed),/polygon/);
});
test('edited cube UV rectangles and texture UV dimensions reach the rendered geometry',()=>{
 const edited=structuredClone(asset),cube=edited.elements.find(e=>e.type==='cube');edited.textures[cube.faces.east.texture].uv_width=16;edited.textures[cube.faces.east.texture].uv_height=16;cube.faces.east.uv=[4,2,12,10];
 const rig=createReplicaModel(edited,{textures:false}),uv=rig.parts.get(cube.name).children[0].geometry.attributes.uv;close(uv.getX(0),.25);close(uv.getY(0),.875);close(uv.getX(3),.75);close(uv.getY(3),.375);rig.dispose();
});
