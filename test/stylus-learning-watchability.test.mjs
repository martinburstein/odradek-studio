// In-memory panel regressions for stale archive/import/startup reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Window} from 'happy-dom';
import * as THREE from 'three';
import {createServer} from 'vite';
import {DEFAULT_DESK} from '../src/replica/state.js';
import {DEFAULT_POSE} from '../apps/bot-crossing/src/arm-manual/model.js';
import {makeLearningRun} from '../src/replica/learning/run.js';
import {createEvolution} from '../src/replica/learning/evolution.js';

const directory=fileURLToPath(new URL('..',import.meta.url));
const until=async predicate=>{const end=Date.now()+10000;while(Date.now()<end){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Timed out waiting for the learning panel state.');};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};

async function makeFixture({latest=async()=>null,load=async()=>null}={}){
 const virtual=new Window({url:'http://127.0.0.1:5291/arm-manual/'}),savedDescriptors=new Map(),workers=[],saves=[];
 class WorkerStub{
  constructor(){workers.push(this);}
  postMessage(message){
   if(message.type==='start'){this.state=createEvolution(message.options);this.run=makeLearningRun(message.experiment,message.options);this.run.status='running';this.run.checkpoint=this.state;queueMicrotask(()=>this.onmessage({data:{type:'started',run:this.run,state:this.state}}));}
   else if(message.type==='restore'){this.run=message.run;this.state=message.run.checkpoint;queueMicrotask(()=>this.onmessage({data:{type:'started',run:this.run,state:this.state}}));}
   else if(message.type==='pause'){this.run.status='paused';this.run.checkpoint=this.state;queueMicrotask(()=>this.onmessage({data:{type:'paused',run:this.run,state:this.state}}));}
   else if(message.type==='resume'){queueMicrotask(()=>{this.onmessage({data:{type:'resumed'}});this.state.status='complete';this.state.stopReason='generation-budget';this.run.status='complete';this.run.stopReason='generation-budget';this.onmessage({data:{type:'finished',run:this.run,state:this.state}});});}
  }
  terminate(){this.terminated=true;}
  emit(data){this.onmessage({data});}
 }
 for(const[key,value]of Object.entries({document:virtual.document,Option:virtual.Option,localStorage:virtual.localStorage,Worker:WorkerStub})){
  savedDescriptors.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
 }
 const server=await createServer({configFile:path.join(directory,'vite.config.js'),server:{middlewareMode:true,hmr:false},appType:'custom',logLevel:'silent'});
 const archived=makeLearningRun(undefined,{seed:9});archived.id='archived-run';
 const store={list:async()=>[{id:archived.id,seed:archived.seed,generation:0,status:'ready',updatedAt:archived.updatedAt}],latest,load,save:async run=>{saves.push(run);return run;},close:async()=>{}};
 const root=document.createElement('main');document.body.append(root);
 let panel;
 try{
  const{mountLearningPanel}=await server.ssrLoadModule(path.join(directory,'src/replica/learning/panel.js'));
  panel=mountLearningPanel({root,scene:new THREE.Scene(),store,getContext:()=>({desk:DEFAULT_DESK,pose:DEFAULT_POSE}),onOpen(){},onClose(){},onExperiment(){},onPose(){},notify(){}});
  await until(()=>root.querySelector('[data-field="archive"]').options.length===2);
  panel.open();
  return{virtual,root,panel,workers,saves,archived,server,cleanup:async()=>{panel?.dispose();await server.close();virtual.happyDOM.abort();for(const[key,descriptor]of savedDescriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}};
 }catch(error){panel?.dispose();await server.close();virtual.happyDOM.abort();for(const[key,descriptor]of savedDescriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}throw error;}
}

async function startSmallRun(fixture){
 fixture.root.querySelector('[data-view="train"]').click();
 fixture.root.querySelector('[data-config="seed"]').value='431';fixture.root.querySelector('[data-config="generations"]').value='3';fixture.root.querySelector('[data-config="population"]').value='36';
 fixture.root.querySelector('.learning-config').dispatchEvent(new fixture.virtual.Event('submit',{bubbles:true,cancelable:true}));
 await until(()=>fixture.workers.length===1&&fixture.panel.run.seed===431&&fixture.panel.run.checkpoint);
 assert.equal(fixture.root.querySelector('.learning-error').hidden,true,'the simulator accepted the new run');
 fixture.workers[0].emit({type:'generation',row:{generation:1,evaluations:37,bestLoss:1,winnerLoss:2,worstLoss:4,medianLoss:3,sigma:.2},snapshots:[],status:'running'});
 await until(()=>fixture.panel.run.history.length===1&&fixture.panel.dirty);
}

test('a delayed archive read cannot replace or clear a newly started dirty training run',async t=>{
 const read=deferred(),fixture=await makeFixture({load:()=>read.promise});t.after(()=>fixture.cleanup());
 const archive=fixture.root.querySelector('[data-field="archive"]');archive.value=fixture.archived.id;archive.dispatchEvent(new fixture.virtual.Event('change'));
 await startSmallRun(fixture);const activeRunId=fixture.panel.run.id;
 assert.equal(fixture.panel.dirty,true);assert.equal(fixture.panel.run.history.length,1);
 read.resolve(fixture.archived);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(fixture.panel.run.id,activeRunId);assert.equal(fixture.panel.run.history.length,1);assert.equal(fixture.panel.dirty,true);
 assert.equal(fixture.workers[0].terminated,undefined,'the active worker remains running');
});

test('an import resolving after close-save acknowledgement cannot mutate or save the run',async t=>{
 const fixture=await makeFixture();t.after(()=>fixture.cleanup());
 const importField=fixture.root.querySelector('[data-field="import"]'),fileText=deferred(),imported=makeLearningRun(undefined,{seed:88});imported.id='late-import';
 Object.defineProperty(importField,'files',{configurable:true,value:[{size:100,text:()=>fileText.promise}]});importField.dispatchEvent(new fixture.virtual.Event('change'));
 const beforeId=fixture.panel.run.id,ack=await fixture.panel.saveBeforeClose();
 assert.equal(ack.saved,false);assert.equal(fixture.panel.closePending,true);
 fileText.resolve(JSON.stringify(imported));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(fixture.panel.run.id,beforeId);assert.equal(fixture.saves.length,0);assert.equal(fixture.panel.closePending,true);
});

test('a startup latest-run response cannot overwrite a later archive selection',async t=>{
 const latestRead=deferred(),archiveRead=deferred(),fixture=await makeFixture({latest:()=>latestRead.promise,load:()=>archiveRead.promise});t.after(()=>fixture.cleanup());
 const archive=fixture.root.querySelector('[data-field="archive"]');archive.value=fixture.archived.id;archive.dispatchEvent(new fixture.virtual.Event('change'));
 archiveRead.resolve(fixture.archived);await until(()=>fixture.panel.run.id===fixture.archived.id);
 const later=makeLearningRun(undefined,{seed:73});later.id='startup-latest';latestRead.resolve(later);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(fixture.panel.run.id,fixture.archived.id,'the user-selected archive remains current');
});

test('resuming an existing worker invalidates an earlier archive request even after the worker finishes',async t=>{
 const saved=makeLearningRun(undefined,{seed:15,population:36,generations:3});saved.id='paused-run';saved.status='paused';saved.checkpoint=createEvolution({seed:15,population:36,generations:3});
 const archiveRead=deferred(),fixture=await makeFixture({latest:async()=>saved,load:()=>archiveRead.promise});t.after(()=>fixture.cleanup());
 await until(()=>fixture.panel.run.id===saved.id&&fixture.panel.run.checkpoint);
 fixture.root.querySelector('[data-action="resume"]').click();await until(()=>fixture.workers.length===1&&fixture.panel.training);
 const pause=fixture.panel.saveBeforeClose();await pause;fixture.panel.cancelClose();await until(()=>fixture.panel.training===false);
 const archive=fixture.root.querySelector('[data-field="archive"]');archive.value=fixture.archived.id;archive.dispatchEvent(new fixture.virtual.Event('change'));
 fixture.root.querySelector('[data-action="resume"]').click();await until(()=>fixture.panel.run.status==='complete'&&fixture.panel.training===false);
 archiveRead.resolve(fixture.archived);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(fixture.panel.run.id,saved.id);assert.equal(fixture.panel.run.status,'complete');
});
