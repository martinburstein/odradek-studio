// In-memory UI reproduction: real Learning Lab DOM and worker, with only the
// second store write held/rejected. No browser window, disk storage, or device.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Window} from 'happy-dom';
import {StylusLearningWorkerBridge} from './helpers/stylus-learning-web-worker.mjs';
import {createServer} from 'vite';
import * as THREE from 'three';
import {DEFAULT_DESK} from '../src/replica/state.js';
import {DEFAULT_POSE} from '../apps/bot-crossing/src/arm-manual/model.js';
import {parseLearningRun} from '../src/replica/learning/run.js';

const directory=fileURLToPath(new URL('..',import.meta.url));
const waitFor=async(predicate,label,timeout=30000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error(`Timed out waiting for ${label}.`);};

test('Pause & save blocks run replacement until its checkpoint write settles',async()=>{
 const virtual=new Window({url:'http://localhost/'}),old=new Map(),workers=[];
 const storeRows=new Map(),unhandled=[];let saveCount=0,pendingSave=null,releasePending,exportedBlob=null,panel,server;
 const onUnhandled=reason=>unhandled.push(reason);process.on('unhandledRejection',onUnhandled);
 const store={
  async save(run){saveCount++;if(saveCount===1){const saved=parseLearningRun(JSON.stringify(run));storeRows.set(saved.id,saved);return saved;}if(saveCount===2){pendingSave=parseLearningRun(JSON.stringify(run));return new Promise((resolve,reject)=>{releasePending={resolve,reject};});}const saved=parseLearningRun(JSON.stringify(run));storeRows.set(saved.id,saved);return saved;},
  async list(){return [...storeRows.values()].map(run=>({id:run.id,seed:run.seed,status:run.status,generation:run.history.at(-1)?.generation??0,updatedAt:run.updatedAt}));},
  async load(id){const run=storeRows.get(id);return run?parseLearningRun(JSON.stringify(run)):null;},
  async latest(){return [...storeRows.values()][0]??null;},
  async close(){}
 };
 class TestWorker extends StylusLearningWorkerBridge{constructor(url,options){super(url);workers.push(this);}}
 for(const key of ['document','Option','localStorage','indexedDB','Worker']){old.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='indexedDB'?undefined:key==='Worker'?TestWorker:virtual[key]});}
 const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
 Object.defineProperty(URL,'createObjectURL',{configurable:true,writable:true,value:blob=>{exportedBlob=blob;return'blob:pending-save-race';}});
 Object.defineProperty(URL,'revokeObjectURL',{configurable:true,writable:true,value:()=>{}});
 try{
  server=await createServer({configFile:path.join(directory,'vite.config.js'),server:{middlewareMode:true,hmr:false},appType:'custom',logLevel:'silent'});
  const {mountLearningPanel}=await server.ssrLoadModule(path.join(directory,'src/replica/learning/panel.js'));
  const root=document.createElement('main');root.className='replica-lab';document.body.append(root);
  panel=mountLearningPanel({root,scene:new THREE.Scene(),store,getContext:()=>({desk:DEFAULT_DESK,pose:DEFAULT_POSE}),onOpen(){},onClose(){},onExperiment(){},onPose(){},notify(){}});
  const field=name=>root.querySelector(`[data-field="${name}"]`),action=name=>root.querySelector(`[data-action="${name}"]`);
  panel.open();root.querySelector('[data-view="train"]').click();
  const population=root.querySelector('[data-config="population"]'),small=document.createElement('option');small.value='12';small.textContent='12';population.add(small);
  root.querySelector('[data-config="seed"]').value='991173';
  population.value='12';
  root.querySelector('[data-config="generations"]').value='800';
  root.querySelector('.learning-config').dispatchEvent(new virtual.Event('submit',{bubbles:true,cancelable:true}));
  await waitFor(()=>panel.training&&saveCount===1,'first running checkpoint save');
  const oldRunId=panel.run.id,priorArchive=await store.load(oldRunId);
  assert.equal(panel.run.seed,991173);assert.ok(priorArchive?.checkpoint,'initial checkpoint should be retained');
  assert.equal(priorArchive.checkpoint.generation,0);

  action('pause').click();
  await waitFor(()=>pendingSave,'paused checkpoint save');
  const pausedSnapshot=pendingSave;
  assert.equal(pausedSnapshot.id,oldRunId);assert.equal(pausedSnapshot.status,'paused');
  await waitFor(()=>panel.training===false,'worker pause acknowledgement');
  assert.equal(panel.dirty,true,'the deferred paused checkpoint remains unsaved');
  assert.equal(field('example').disabled,true);assert.equal(action('example').disabled,true);
  assert.equal(field('import').disabled,true);assert.equal(field('archive').disabled,true);
  assert.equal(root.querySelector('.learning-config button').disabled,true);assert.equal(action('resume').disabled,true);
  assert.equal(action('export').disabled,false,'export stays available after the worker pauses');

  // Exercise action handlers directly as well as disabled DOM controls.
  field('example').value='corner-before';action('example').onclick();
  root.querySelector('.learning-config').dispatchEvent(new virtual.Event('submit',{bubbles:true,cancelable:true}));
  action('resume').onclick();
  field('archive').value=oldRunId;await field('archive').onchange();
  const importField=field('import'),pausedFile=new virtual.File([JSON.stringify(pendingSave)],'paused.odradek-learning.json',{type:'application/json'});
  Object.defineProperty(importField,'files',{configurable:true,value:[pausedFile]});importField.dispatchEvent(new virtual.Event('change',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(panel.run.id,oldRunId,'run-replacing handlers are guarded while the checkpoint write is pending');
  assert.equal(panel.dirty,true);
  assert.match(root.querySelector('[data-output="save"]').textContent,/Saving the latest run/);
  releasePending.reject(Error('QuotaExceededError: simulated storage quota failure'));
  await waitFor(()=>!root.querySelector('.learning-error').hidden,'old paused-save rejection');
  assert.match(root.querySelector('.learning-error').textContent,/QuotaExceededError/);
  assert.equal(panel.run.id,oldRunId,'the paused run remains active after the failed write');
  assert.equal(panel.dirty,true,'the unsaved paused checkpoint remains marked dirty');
  assert.equal(field('example').disabled,false);assert.equal(action('example').disabled,false);
  assert.equal(field('import').disabled,false);assert.equal(field('archive').disabled,false);
  assert.equal(root.querySelector('.learning-config button').disabled,false);
  const oldStillStored=await store.load(oldRunId);
  assert.equal(oldStillStored.id,oldRunId);assert.equal(oldStillStored.checkpoint.generation,priorArchive.checkpoint.generation,'the retained archive is the earlier running checkpoint');
  assert.notDeepEqual(oldStillStored.checkpoint,pendingSave.checkpoint,'the prior archive does not contain the newer paused checkpoint');
  assert.deepEqual(panel.run.checkpoint,pendingSave.checkpoint,'the failed paused checkpoint stays active in memory');

  assert.equal(action('export').disabled,false);action('export').click();assert.ok(exportedBlob,'the active paused run can be exported');
  const exported=parseLearningRun(await exportedBlob.text());
  assert.equal(exported.id,oldRunId,'Export run retains the paused run after its save fails');
  assert.deepEqual(exported.checkpoint,pendingSave.checkpoint,'the export contains the exact deferred paused checkpoint');

  // A later successful pause save also releases replacement controls.
  field('example').value='corner-before';action('example').click();
  assert.notEqual(panel.run.id,oldRunId);
  root.querySelector('[data-config="seed"]').value='991174';
  root.querySelector('.learning-config').dispatchEvent(new virtual.Event('submit',{bubbles:true,cancelable:true}));
  await waitFor(()=>panel.training&&saveCount>=3,'new run initial save');
  action('pause').click();
  await waitFor(()=>panel.run.status==='paused'&&!panel.training&&!panel.dirty&&root.querySelector('[data-output="save"]').textContent.includes('saved on this computer'),'successful paused checkpoint save');
  assert.equal(field('example').disabled,false);assert.equal(action('example').disabled,false);
  assert.equal(field('import').disabled,false);assert.equal(field('archive').disabled,false);
  assert.equal(root.querySelector('.learning-config button').disabled,false);
  await new Promise(resolve=>setTimeout(resolve,20));assert.deepEqual(unhandled,[],'the rejected save is handled without an unhandled rejection');
 }finally{
  releasePending?.resolve();panel?.dispose();await Promise.all(workers.map(worker=>worker.terminate().catch(()=>{})));
  process.off('unhandledRejection',onUnhandled);
  await server?.close();virtual.happyDOM.abort();
  for(const[key,descriptor]of old){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
  Object.defineProperty(URL,'createObjectURL',{configurable:true,writable:true,value:oldCreate});Object.defineProperty(URL,'revokeObjectURL',{configurable:true,writable:true,value:oldRevoke});
 }
});
