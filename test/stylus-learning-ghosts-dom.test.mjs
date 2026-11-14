import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Window} from 'happy-dom';
import * as THREE from 'three';
import {createServer} from 'vite';
import {DEFAULT_DESK} from '../src/replica/state.js';
import {DEFAULT_POSE} from '../apps/bot-crossing/src/arm-manual/model.js';
const directory=fileURLToPath(new URL('..',import.meta.url));
test('iteration ghosts loop with the selected solid arm, pause with it, and clear on close',async()=>{
 const virtual=new Window({url:'http://127.0.0.1:5291/arm-manual/?offline-learning=1'}),saved=new Map(),scene=new THREE.Scene(),poses=[];
 for(const[key,value]of Object.entries({document:virtual.document,localStorage:virtual.localStorage})) {saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
 const server=await createServer({configFile:path.join(directory,'vite.config.js'),server:{middlewareMode:true,hmr:false},appType:'custom',logLevel:'silent'});
 const root=document.createElement('main');document.body.append(root);let panel;
 try{
  const asset=JSON.parse(await fs.readFile(path.join(directory,'assets/roarm/RoArm-M2-S.bbmodel'),'utf8'));
  const{mountLearningPanel}=await server.ssrLoadModule(path.join(directory,'src/replica/learning/panel.js'));
  panel=mountLearningPanel({root,scene,getAsset:()=>asset,getContext:()=>({desk:DEFAULT_DESK,pose:DEFAULT_POSE}),onOpen(){},onClose(){},onExperiment(){},onPose:pose=>poses.push(pose),notify(){},store:{latest:async()=>null,list:async()=>[],close:async()=>{}}});
  panel.open();root.querySelector('[data-action="ghosts"]').click();
  const end=Date.now()+10000;while(root.querySelector('[data-output="ghosts"]').dataset.ready!=='true'){if(Date.now()>end)throw Error(root.querySelector('[data-output="ghosts"]').textContent);await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(root.querySelector('[data-output="ghosts"]').dataset.count,'82');
  assert.equal(root.querySelector('[data-output="generation"]').textContent,'800');
  assert.equal(root.querySelector('[data-action="ghosts"]').getAttribute('aria-pressed'),'true');
  for(let i=0;i<15;i++)panel.update(.25);
  assert(Number(root.querySelector('[data-field="time"]').value)>3);
  const mesh=scene.getObjectByName('Saved iteration ghosts').children[0],before=mesh.instanceMatrix.array.slice();
  root.querySelector('[data-action="play"]').click();panel.update(.25);
  assert.deepEqual(mesh.instanceMatrix.array,before,'pause freezes every ghost as well as the solid arm');
  root.querySelector('[data-field="time"]').value='6.99';root.querySelector('[data-field="time"]').dispatchEvent(new virtual.Event('input'));
  root.querySelector('[data-action="play"]').click();panel.update(.25);panel.update(.25);
  assert(Number(root.querySelector('[data-field="time"]').value)<1,'natural completion loops the synchronized trial');
  assert.equal(root.querySelector('[data-output="generation"]').textContent,'800','ghost loop keeps the selected solid generation');
  panel.close();assert.equal(mesh.count,0);assert.equal(scene.getObjectByName('Saved iteration ghosts').visible,false);
  assert(poses.length>10);
 }finally{panel?.dispose();await server.close();virtual.happyDOM.abort();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
 assert.equal(scene.children.length,0);
});
