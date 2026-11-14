import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {Worker as NodeWorker} from 'node:worker_threads';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Window} from 'happy-dom';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import * as THREE from 'three';
import {createExperiment} from '../src/replica/learning/simulation.js';
import {DEFAULT_TOOL} from '../src/replica/learning/geometry.js';
import {createLearningStore} from '../src/replica/learning/storage.js';
import {makeTasks,taskLabel} from '../src/replica/learning/tasks.js';
import {parseLearningRun,snapshotOptions,replayEpisode,createReplayClock} from '../src/replica/learning/run.js';
import {createLearningVisuals} from '../src/replica/learning/visuals.js';
import {fixedAngleFeasibility} from '../src/replica/learning/feasibility.js';
import {buildTrialSignals,trialSignalMarkup,updateSignalCursor} from '../src/replica/learning/signals.js';

const root=path.resolve(import.meta.dirname,'..'),panelPath=path.join(root,'src/replica/learning/panel.js'),workerUrl=pathToFileURL(path.join(root,'src/replica/learning/worker.js')).href;
const timeout=(promise,ms=20000)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`Timed out after ${ms} ms`)),ms);Promise.resolve(promise).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
async function waitFor(predicate,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const result=await predicate();if(result)return result;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Timed out waiting for learning state.');}

class WorkerBridge{
 constructor(){
  const source=`(async()=>{const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:value=>parentPort.postMessage(value)};await import(${JSON.stringify(workerUrl)});parentPort.on('message',data=>self.onmessage({data}));})()`;
  this.worker=new NodeWorker(source,{eval:true});this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.(error));
 }
 postMessage(value){this.worker.postMessage(value);}
 terminate(){return this.worker.terminate();}
}

async function makeMount({localStorage,toolLength=DEFAULT_TOOL.frontReach}={}){
 const window=new Window({url:'http://127.0.0.1:5291/arm-manual/'}),document=window.document,rootElement=document.createElement('div');document.body.append(rootElement);
 const exampleText=await fs.readFile(path.join(root,'assets/learning/stylus-example-v1.json'),'utf8');
 const bundledExamples=[{id:'first-run',label:'First learning run',isDefault:true,text:exampleText}];
 let source=await fs.readFile(panelPath,'utf8');source=source.replace(/^import .*;\s*$/gm,'').replace('export function mountLearningPanel','function mountLearningPanel').replace("new Worker(new URL('./worker.js',import.meta.url),{type:'module'})","new Worker('./worker.js',{type:'module'})").replace('const number=',`const bundledExamples=globalThis.__bundledExamples;\nconst defaultExample=bundledExamples.find(example=>example.isDefault);\nconst fixedAngleFeasibility=globalThis.__fixedAngleFeasibility;\nconst buildTrialSignals=globalThis.__buildTrialSignals;\nconst trialSignalMarkup=globalThis.__trialSignalMarkup;\nconst updateSignalCursor=globalThis.__updateSignalCursor;\nconst number=`)+'\nthis.mountLearningPanel=mountLearningPanel;';
 const context=vm.createContext({document,window,Option:window.Option,Worker:WorkerBridge,createExperiment,makeTasks,taskLabel,parseLearningRun,snapshotOptions,replayEpisode,createReplayClock,createLearningStore,createLearningVisuals,fixedAngleFeasibility,buildTrialSignals,trialSignalMarkup,updateSignalCursor,console,setTimeout,clearTimeout,URL,Blob,globalThis:null,__bundledExamples:bundledExamples,__fixedAngleFeasibility:fixedAngleFeasibility,__buildTrialSignals:buildTrialSignals,__trialSignalMarkup:trialSignalMarkup,__updateSignalCursor:updateSignalCursor});context.globalThis=context;
 vm.runInContext(source,context,{filename:panelPath});
 const indexedDB=new IDBFactory(),store=createLearningStore({indexedDB,localStorage:localStorage??window.localStorage});
 const pose={base:0,shoulder:0,elbow:Math.PI/2,gripper:2.6},desk={...createExperiment().desk,toolLength};
 const panel=context.mountLearningPanel({root:rootElement,scene:new THREE.Scene(),store,getContext:()=>({pose:{...pose},desk:{...desk}}),onOpen(){},onClose(){},onExperiment(){},onPose(){},notify(){}});
 return{window,document,root:rootElement,store,indexedDB,panel,close:async()=>{panel.dispose();await store.close();window.close();}};
}

async function startTraining(fixture,{generations=800}={}){
 fixture.panel.open();const form=fixture.root.querySelector('.learning-config');
 fixture.root.querySelector('[data-config="generations"]').value=String(generations);
 fixture.root.querySelector('[data-config="population"]').value='36';
 form.dispatchEvent(new fixture.window.Event('submit',{bubbles:true,cancelable:true}));
 await waitFor(()=>fixture.panel.training);
}

async function spawnRestorer(run){
 const worker=new WorkerBridge();let messages=[];worker.onmessage=event=>messages.push(event.data);
 const started=waitFor(()=>messages.find(message=>message.type==='started'));
 worker.postMessage({type:'restore',run});const message=await started;return{worker,message,stop:async()=>{worker.postMessage({type:'cancel'});await waitFor(()=>messages.find(row=>row.type==='finished'));await worker.terminate();}};
}

test('saveBeforeClose pauses and persists exact partial state that a fresh worker can restore',async t=>{
 const fixture=await makeMount();t.after(()=>fixture.close());await startTraining(fixture);
 const result=await timeout(fixture.panel.saveBeforeClose());
 assert.equal(result.status,'paused');assert.equal(fixture.panel.training,false);assert.equal(fixture.panel.dirty,false);
 const saved=await fixture.store.load(result.id);assert.equal(saved.status,'paused');assert.ok(saved.checkpoint.generation<20);
 assert.ok(saved.checkpoint.pending);assert.ok(saved.checkpoint.pending.candidates.length<=4);
 assert.deepEqual(saved.checkpoint,result.checkpoint);assert.equal(fixture.panel.closePending,true);
 assert.equal(fixture.root.querySelector('.learning-config button').disabled,true);assert.equal(fixture.root.querySelector('[data-field="example"]').disabled,true);assert.equal(fixture.root.querySelector('[data-action="example"]').disabled,true);
 assert.equal(fixture.root.querySelector('[data-action="play"]').disabled,false);
 assert.equal(fixture.panel.cancelClose(),true);assert.equal(fixture.panel.closePending,false);
 const restored=await spawnRestorer(saved);t.after(()=>restored.worker.terminate());
 assert.equal(restored.message.state.generation,saved.checkpoint.generation);assert.equal(restored.message.state.pending.candidates.length,saved.checkpoint.pending.candidates.length);assert.equal(restored.message.state.rng,saved.checkpoint.rng);
 await restored.stop();
});

test('explicit Pause & save waits for the IndexedDB transaction before reporting saved',async t=>{
 const fixture=await makeMount();t.after(()=>fixture.close());await startTraining(fixture);
 fixture.root.querySelector('[data-action="pause"]').click();
 const saved=await waitFor(async()=>{const value=await fixture.store.latest();return !fixture.panel.training&&!fixture.panel.dirty&&value?.checkpoint?.generation===0?value:null;});
 await waitFor(()=>fixture.root.querySelector('.learning-status').textContent.includes('latest checkpoint saved'));
 assert.equal(saved.status,'paused');assert.ok(saved.checkpoint.pending);assert.match(fixture.root.querySelector('.learning-status').textContent,/latest checkpoint saved/);
});

test('failed close-save rejects, retains the prior IndexedDB run, and has no unhandled rejection',async t=>{
 const fixture=await makeMount();let abortNext=false,putCount=0;const original=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(...values){const request=original.apply(this,values),transaction=this.transaction;putCount++;if(abortNext){abortNext=false;queueMicrotask(()=>{try{transaction.abort();}catch{}});}return request;};
 t.after(async()=>{IDBObjectStore.prototype.put=original;await fixture.close();});await startTraining(fixture);
 const previous=await waitFor(async()=>{const value=await fixture.store.latest();return value?.checkpoint&&value.history.length===0?value:null;});
 const unhandled=[],listener=reason=>unhandled.push(reason);process.on('unhandledRejection',listener);
 try{
  const beforeCount=putCount;abortNext=true;
  await assert.rejects(timeout(fixture.panel.saveBeforeClose()),/Could not save the learning checkpoint/);
  assert.ok(putCount>beforeCount);assert.equal(fixture.panel.dirty,true);assert.equal(fixture.panel.closePending,false);assert.equal(fixture.root.querySelector('.learning-config button').disabled,false);
  const after=await fixture.store.load(previous.id);assert.equal(after.updatedAt,previous.updatedAt);assert.equal(after.checkpoint.generation,previous.checkpoint.generation);
  await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(unhandled,[]);
 }finally{process.off('unhandledRejection',listener);}
});

test('closing the untouched bundled replay performs no run write',async t=>{
 const fixture=await makeMount();let puts=0;const original=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(...values){puts++;return original.apply(this,values);};
 t.after(async()=>{IDBObjectStore.prototype.put=original;await fixture.close();});
 fixture.panel.open();fixture.root.querySelector('[data-field="example"]').value='first-run';fixture.root.querySelector('[data-action="example"]').click();
 assert.equal(fixture.panel.run.seed,20261114);assert.equal(fixture.panel.run.version,1);
 const saved=await timeout(fixture.panel.saveBeforeClose());
 assert.equal(saved.saved,false);assert.equal(fixture.panel.dirty,false);assert.equal(puts,0);
});

test('opening seeds front reach from desk tool length but typing it prevents a later reset',async t=>{
 const fixture=await makeMount({toolLength:164});t.after(()=>fixture.close());fixture.panel.open();const input=fixture.root.querySelector('[data-config="frontReach"]');
 assert.equal(input.value,'164');input.value='173';input.dispatchEvent(new fixture.window.Event('input',{bubbles:true}));fixture.panel.close();fixture.panel.open();assert.equal(input.value,'173');
});

test('task selector uses descriptive split-prefixed labels while preserving task IDs',async t=>{
 const fixture=await makeMount();t.after(()=>fixture.close());
 const select=fixture.root.querySelector('[data-field="task"]'),line=makeTasks('train').find(task=>task.id==='train-horizontal'),option=[...select.options].find(item=>item.value===line.id);
 assert.equal(option.textContent,`Practice · ${taskLabel(line)}`);assert.equal(option.value,line.id);
});
