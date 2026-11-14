// This is an in-memory DOM unit test. It opens no browser, native window,
// display connection, device service, or user desktop surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Window} from 'happy-dom';
import {IDBFactory} from 'fake-indexeddb';
import {StylusLearningWorkerBridge} from './helpers/stylus-learning-web-worker.mjs';
import {createServer} from 'vite';
import * as THREE from 'three';
import {DEFAULT_DESK} from '../src/replica/state.js';
import {DEFAULT_POSE} from '../apps/bot-crossing/src/arm-manual/model.js';
const directory=fileURLToPath(new URL('..',import.meta.url));
test('Learning Lab opens a real saved run, tours generations, scrubs exact samples and restores its caller',async()=>{
 const virtual=new Window({url:'http://localhost/'}),old=new Map();
 for(const key of ['document','Option','localStorage','indexedDB','Worker']){old.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='indexedDB'?undefined:key==='Worker'?class{constructor(){throw Error('This replay test must not start training.');}}:virtual[key]});}
 const server=await createServer({configFile:path.join(directory,'vite.config.js'),server:{middlewareMode:true,hmr:false},appType:'custom',logLevel:'silent'});
 let panel;
 try{
  const {mountLearningPanel}=await server.ssrLoadModule(path.join(directory,'src/replica/learning/panel.js'));
  const root=document.createElement('main');root.className='replica-lab';document.body.append(root);const scene=new THREE.Scene(),calls={open:0,close:0,frames:0,poses:[],experiments:[]};
  const layouts=[];root.addEventListener('odradek-learning-layout',event=>layouts.push(event.detail.compact));
  panel=mountLearningPanel({root,scene,getContext:()=>({desk:DEFAULT_DESK,pose:DEFAULT_POSE}),onOpen:()=>calls.open++,onClose:()=>calls.close++,onFrame:()=>calls.frames++,onPose:pose=>calls.poses.push(pose),onExperiment:value=>calls.experiments.push(value),notify:()=>{}});
  const field=name=>root.querySelector(`[data-field="${name}"]`),action=name=>root.querySelector(`[data-action="${name}"]`);
  panel.open();assert.equal(panel.active,true);assert.equal(calls.open,1);assert.ok(root.classList.contains('learning-open'));assert.equal(root.querySelector('.learning-panel').hidden,false);assert.equal(panel.run.history.length,800);assert.equal(panel.run.seed,20261115);assert.equal(panel.run.version,2);assert.equal(field('example').value,'corner-after');assert.equal(field('example').options.length,4);assert.equal(field('example').closest('label'),root.querySelector('[data-page="watch"] .learning-status').nextElementSibling);assert.match(root.querySelector('[data-output="study"]').textContent,/simulation results/);assert.ok(root.querySelector('.learning-map polyline'));assert.match(root.querySelector('[data-output="contact-error"]').textContent,/mm/);assert.equal(calls.poses.at(-1).gripper,panel.run.experiment.gripper);
  const feasibilitySvg=root.querySelector('[data-map="feasibility"]'),feasibilityCell=feasibilitySvg.querySelector('rect'),feasibilityLegend=root.querySelector('.learning-feasibility-legend');assert.equal(feasibilitySvg.getAttribute('role'),'group');assert.equal(feasibilitySvg.getAttribute('aria-describedby'),'learning-feasibility-summary');assert.equal(feasibilitySvg.querySelectorAll('rect').length,135);assert.match(feasibilitySvg.getAttribute('aria-label'),/target 45\.0 degrees, tolerance 3\.0 degrees/);assert.match(feasibilityCell.getAttribute('aria-label'),/Across 0%, forward 0%.*angle error/i);assert.match(root.querySelector('[data-output="feasibility-summary"]').textContent,/within 3\.0°; mean error 3\.23°, maximum 8\.34°/);assert.match(feasibilityLegend.getAttribute('aria-label'),/amber.*through 5\.0 degrees/);assert.deepEqual([...root.querySelectorAll('.learning-feasibility-legend [data-state]')].map(node=>node.dataset.state),['within','near','outside','collision','unavailable']);
  const trialDetails=root.querySelector('.learning-trial-detail'),signalPlots=root.querySelectorAll('.learning-signal'),signalCursors=[...root.querySelectorAll('[data-signal-cursor]')];assert.equal(trialDetails.open,false);assert.equal(signalPlots.length,3);assert.equal(signalCursors.length,3);assert.match(trialDetails.textContent,/requested contact samples, not proof of contact/);assert.match(trialDetails.textContent,/N\* is an assumed proxy, not measured force/);trialDetails.open=true;assert.ok(signalCursors.every(cursor=>Number(cursor.getAttribute('x1'))===32));
  const compact=action('compact-toggle'),content=root.querySelector('.learning-panel-content'),compactTools=root.querySelector('.learning-compact-tools');assert.equal(compact.getAttribute('aria-expanded'),'true');compact.click();assert.equal(compact.getAttribute('aria-expanded'),'false');assert.equal(content.hidden,true);assert.equal(compactTools.hidden,false);assert.ok(root.querySelector('.learning-panel').classList.contains('learning-compact'));assert.deepEqual(layouts,[true]);assert.equal(action('compact-tour').hidden,false);action('compact-frame').click();assert.equal(calls.frames,1);action('compact-play').click();panel.update(.1);assert.ok(panel.currentFrame.time>0);assert.ok(signalCursors.every(cursor=>Number(cursor.getAttribute('x1'))>32));assert.strictEqual(feasibilitySvg.querySelector('rect'),feasibilityCell,'animation-frame replay should not recompute the geometry map');action('compact-restart').click();assert.equal(panel.currentFrame.time,0);assert.ok([...root.querySelectorAll('[data-signal-cursor]')].every(cursor=>Number(cursor.getAttribute('x1'))===32));action('compact-tour').click();for(let n=0;n<32;n++)panel.update(.25);assert.ok(Number(root.querySelector('[data-output="generation"]').textContent)>0,'compact Watch evolution should tour saved generations');assert.equal(trialDetails.open,true,'snapshot changes should preserve the disclosure state');
  const importField=field('import'),badFile=new virtual.File(['{broken json'],'bad.json',{type:'application/json'});Object.defineProperty(importField,'files',{configurable:true,value:[badFile]});importField.dispatchEvent(new virtual.Event('change',{bubbles:true}));const errorDeadline=Date.now()+1000;while(root.querySelector('.learning-error').hidden&&Date.now()<errorDeadline)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(root.querySelector('.learning-error').hidden,false);assert.match(root.querySelector('.learning-error').textContent,/valid learning-run JSON/i);assert.notEqual(root.querySelector('.learning-error').parentElement,content);
  compact.click();assert.equal(content.hidden,false);assert.equal(compact.getAttribute('aria-expanded'),'true');assert.deepEqual(layouts,[true,false]);
  assert.match(root.querySelector('[data-output="fitness"]').textContent,/seven moving trials/);action('frame').click();assert.equal(calls.frames,2);
  action('tour').click();for(let n=0;n<32;n++)panel.update(.25);assert.ok(Number(root.querySelector('[data-output="generation"]').textContent)>0,'tour should advance to a later saved generation');
  field('kind').value='failure';field('kind').dispatchEvent(new virtual.Event('change'));const comparisonGeneration=Number(root.querySelector('[data-output="generation"]').textContent);
  field('example').value='first-run';field('example').dispatchEvent(new virtual.Event('change'));action('example').click();assert.equal(panel.run.seed,20261114);assert.equal(panel.run.version,1);assert.equal(panel.run.snapshots.length,82);assert.equal(field('kind').value,'best');assert.equal(Number(root.querySelector('[data-output="generation"]').textContent),comparisonGeneration);assert.match(root.querySelector('[data-output="study"]').textContent,/best-policy snapshots only/);assert.equal([...field('kind').options].find(option=>option.value==='failure').disabled,true);
  action('tour').click();for(let n=0;n<32;n++)panel.update(.25);assert.ok(Number(root.querySelector('[data-output="generation"]').textContent)>0,'legacy study tour should advance through saved generations');
  field('example').value='mount-exploration';field('example').dispatchEvent(new virtual.Event('change'));const priorFeasibilityCell=feasibilitySvg.querySelector('rect');action('example').click();assert.equal(panel.run.experiment.tool.mountPitch,4);assert.equal(field('example').options.length,4);assert.notStrictEqual(feasibilitySvg.querySelector('rect'),priorFeasibilityCell,'loading a different run should recompute nominal reference geometry');assert.match(root.querySelector('[data-output="study"]').textContent,/alternative fixed tool mounting angle/);
  field('example').value='corner-before';field('example').dispatchEvent(new virtual.Event('change'));action('example').click();assert.equal(trialDetails.open,true);field('task').value='test-poke-0.87-0.87';field('task').dispatchEvent(new virtual.Event('change'));field('generation').value=String(Number(field('generation').max));field('generation').dispatchEvent(new virtual.Event('input'));assert.equal(root.querySelector('[data-output="generation"]').textContent,'800');const digTitle=root.querySelector('[data-signal="gap"] circle title');assert.ok(digTitle,`missing retained marker for ${field('task').value}`);assert.equal(digTitle.textContent,'dig at 0.20 s');field('time').value='3.25';field('time').dispatchEvent(new virtual.Event('input'));const actual=panel.currentFrame;assert.ok(actual.time<=3.25&&actual.time>3);assert.equal(actual.pose.gripper,panel.run.experiment.gripper);const scrubCursor=Number(root.querySelector('[data-signal="gap"] [data-signal-cursor]').getAttribute('x1'));assert.ok(scrubCursor>32&&scrubCursor<308);
  action('play').click();panel.update(.1);assert.ok(panel.currentFrame.time>=actual.time);assert.ok(Number(root.querySelector('[data-signal="gap"] [data-signal-cursor]').getAttribute('x1'))>=scrubCursor);panel.close();assert.equal(panel.active,false);assert.equal(calls.close,1);assert.equal(root.querySelector('.learning-panel').hidden,true);assert.equal(root.classList.contains('learning-open'),false);panel.dispose();assert.equal(scene.children.length,0);assert.equal(root.querySelector('.learning-panel'),null);
 }finally{panel?.dispose();await server.close();virtual.happyDOM.abort();for(const[key,descriptor]of old){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});

test('minimum viewport starts compact and respects the user choice on reopen',async()=>{
 const virtual=new Window({url:'http://localhost/'}),old=new Map();
 Object.defineProperty(virtual,'matchMedia',{configurable:true,value:query=>({media:query,matches:query==='(max-width: 900px) and (max-height: 700px)'})});
 for(const key of ['document','Option','localStorage','indexedDB','Worker']){old.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='indexedDB'?undefined:key==='Worker'?class{constructor(){throw Error('This layout test must not start training.');}}:virtual[key]});}
 const server=await createServer({configFile:path.join(directory,'vite.config.js'),server:{middlewareMode:true,hmr:false},appType:'custom',logLevel:'silent'});let panel;
 try{
  const {mountLearningPanel}=await server.ssrLoadModule(path.join(directory,'src/replica/learning/panel.js'));
  const root=document.createElement('main');root.className='replica-lab';document.body.append(root);const layouts=[];root.addEventListener('odradek-learning-layout',event=>layouts.push(event.detail.compact));
  panel=mountLearningPanel({root,scene:new THREE.Scene(),getContext:()=>({desk:DEFAULT_DESK,pose:DEFAULT_POSE}),onOpen(){},onClose(){},onExperiment(){},onPose(){},notify(){}});
  const toggle=root.querySelector('[data-action="compact-toggle"]'),content=root.querySelector('.learning-panel-content'),tools=root.querySelector('.learning-compact-tools');
  panel.open();assert.equal(panel.active,true);assert.equal(root.querySelector('.learning-panel').hidden,false);assert.ok(root.querySelector('.learning-panel').classList.contains('learning-compact'));assert.equal(content.hidden,true);assert.equal(tools.hidden,false);assert.equal(toggle.getAttribute('aria-expanded'),'false');assert.deepEqual(layouts,[true]);
  toggle.click();assert.equal(content.hidden,false);assert.equal(toggle.getAttribute('aria-expanded'),'true');panel.close();panel.open();assert.equal(content.hidden,false);assert.deepEqual(layouts,[true,false]);
 }finally{panel?.dispose();await server.close();virtual.happyDOM.abort();for(const[key,descriptor]of old){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});

test('Learning Lab trains, pauses to IndexedDB, restores in a new worker, and validates import/export',async()=>{
 const virtual=new Window({url:'http://localhost/'}),old=new Map(),oldUrl={create:URL.createObjectURL,revoke:URL.revokeObjectURL};
 const factory=new IDBFactory(),workers=[];let exportedBlob=null,fetchCalls=0,panel,server;
 class TestWorker extends StylusLearningWorkerBridge{constructor(url,options){super(url);workers.push(this);}}
 for(const[key,value]of Object.entries({document:virtual.document,Option:virtual.Option,localStorage:virtual.localStorage,indexedDB:factory,Worker:TestWorker})){
  old.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
 }
 const oldFetch=Object.getOwnPropertyDescriptor(globalThis,'fetch');
 Object.defineProperty(globalThis,'fetch',{configurable:true,writable:true,value:()=>{fetchCalls++;throw Error('No network access in the panel test.');}});
 Object.defineProperty(URL,'createObjectURL',{configurable:true,writable:true,value:blob=>{exportedBlob=blob;return'blob:in-memory-learning-run';}});
 Object.defineProperty(URL,'revokeObjectURL',{configurable:true,writable:true,value:()=>{}});
 server=await createServer({configFile:path.join(directory,'vite.config.js'),server:{middlewareMode:true,hmr:false},appType:'custom',logLevel:'silent'});
 const root=document.createElement('main');root.className='replica-lab';document.body.append(root);
 const scene=new THREE.Scene(),manual={pose:{...DEFAULT_POSE},desk:{...DEFAULT_DESK}},calls={open:0,close:0,pose:[],experiment:[]};
 const mount=async()=>{const {mountLearningPanel}=await server.ssrLoadModule(path.join(directory,'src/replica/learning/panel.js'));return mountLearningPanel({root,scene,getContext:()=>({desk:{...manual.desk},pose:{...manual.pose}}),onOpen:()=>calls.open++,onClose:()=>calls.close++,onExperiment:value=>calls.experiment.push(value),onPose:value=>calls.pose.push(value),notify:()=>{}});};
 const until=async(predicate,label,timeout=30000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error(`Timed out waiting for ${label}.`);};
 const field=name=>root.querySelector(`[data-field="${name}"]`),action=name=>root.querySelector(`[data-action="${name}"]`);
 try{
  panel=await mount();const opener=document.createElement('button');opener.textContent='Learning Lab';document.body.append(opener);opener.focus();
  panel.open();assert.equal(document.activeElement,root.querySelector('.learning-close'));
  root.querySelector('.learning-panel').dispatchEvent(new virtual.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.equal(panel.active,false);assert.equal(document.activeElement,opener);assert.equal(calls.close,1);
  panel.open();root.querySelector('[data-view="train"]').click();
  const config=name=>root.querySelector(`[data-config="${name}"]`),population=config('population'),twelve=document.createElement('option');twelve.value='12';twelve.textContent='12';population.add(twelve);population.value='12';
  config('seed').value='7741';config('generations').value='2';config('end').value='rear';
  const form=root.querySelector('.learning-config');form.dispatchEvent(new virtual.Event('submit',{bubbles:true,cancelable:true}));
  assert.equal(root.querySelector('.learning-error').hidden,false);assert.match(root.querySelector('.learning-error').textContent,/no nominal hovering seed pose/i);
  config('end').value='front';form.dispatchEvent(new virtual.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>panel.run.seed===7741||!root.querySelector('.learning-error').hidden,'training start or failure');
  assert.equal(root.querySelector('.learning-error').hidden,true,root.querySelector('.learning-error').textContent);
  assert.equal(panel.run.population,12);assert.equal(panel.run.generationLimit,2);assert.equal(panel.run.experiment.tool.end,'front');
  assert.equal(panel.run.version,2);assert.match(root.querySelector('[data-output="fitness"]').textContent,/seven moving trials/);
  action('compact-toggle').click();assert.equal(panel.training,true);assert.equal(action('compact-pause').hidden,false);assert.equal(action('compact-cancel').hidden,false);assert.equal(action('compact-play').hidden,true);assert.match(root.querySelector('[data-output="compact-status"]').textContent,/TRAINING/);action('compact-pause').click();
  await until(()=>panel.run.status==='paused'&&panel.run.checkpoint&&root.querySelector('[data-output="save"]').textContent.includes('saved on this computer'),'paused persisted checkpoint');
  assert.match(root.querySelector('[data-output="compact-status"]').textContent,/PAUSED/);
  const runId=panel.run.id,checkpoint=JSON.stringify(panel.run.checkpoint),state=panel.run.checkpoint;if(state.pending){const count=state.pending.candidates.length;assert.ok(count>0&&count<state.population);assert.equal(state.pending.generation,state.generation+1);assert.equal(state.evaluations,1+state.generation*state.population+count);}else assert.equal(state.evaluations,1+state.generation*state.population);
  panel.close();assert.deepEqual(manual.pose,DEFAULT_POSE);assert.deepEqual(manual.desk,DEFAULT_DESK);panel.dispose();panel=null;
  await new Promise(resolve=>setTimeout(resolve,20));
  panel=await mount();await until(()=>panel.run.id===runId&&root.querySelector('[data-field="archive"]').options.length>1,'local run recovery');
  assert.equal(JSON.stringify(panel.run.checkpoint),checkpoint);assert.equal(panel.run.status,'paused');
  panel.open();assert.equal(action('resume').disabled,false);action('resume').click();
  await until(()=>panel.run.status==='complete'&&!action('export').disabled||!root.querySelector('.learning-error').hidden,'worker resume to completion');
  assert.equal(panel.run.status,'complete');assert.equal(panel.run.history.at(-1).generation,2);
  await until(()=>!panel.dirty,'completed checkpoint persistence before importing another run');
  action('export').click();assert.ok(exportedBlob,'export action should create a JSON Blob: '+root.querySelector('.learning-error').textContent);
  const {parseLearningRun}=await server.ssrLoadModule(path.join(directory,'src/replica/learning/run.js'));
  const exported=parseLearningRun(await exportedBlob.text());assert.equal(exported.id,runId);assert.equal(exported.status,'complete');
  const importField=field('import'),validFile=new virtual.File([await exportedBlob.text()],'saved.odradek-learning.json',{type:'application/json'}),beforeImport=calls.experiment.length;
  Object.defineProperty(importField,'files',{configurable:true,value:[validFile]});importField.dispatchEvent(new virtual.Event('change',{bubbles:true}));
  await until(()=>calls.experiment.length>beforeImport&&panel.run.id===runId&&root.querySelector('.learning-error').hidden,'valid imported run');
  const malformed=new virtual.File(['{broken json'],'bad.json',{type:'application/json'});Object.defineProperty(importField,'files',{configurable:true,value:[malformed]});importField.dispatchEvent(new virtual.Event('change',{bubbles:true}));
  await until(()=>!root.querySelector('.learning-error').hidden,'malformed import error');
  assert.match(root.querySelector('.learning-error').textContent,/valid learning-run JSON/i);assert.equal(panel.run.id,runId);
  assert.equal(fetchCalls,0);assert.equal(calls.open,3);assert.equal(calls.close,2);
 }finally{
  panel?.close();panel?.dispose();await Promise.all(workers.map(worker=>worker.terminate().catch(()=>{})));
  await server?.close();virtual.happyDOM.abort();await new Promise(resolve=>setTimeout(resolve,1010));
  for(const[key,descriptor]of old){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
  if(oldFetch)Object.defineProperty(globalThis,'fetch',oldFetch);else delete globalThis.fetch;
  Object.defineProperty(URL,'createObjectURL',{configurable:true,writable:true,value:oldUrl.create});Object.defineProperty(URL,'revokeObjectURL',{configurable:true,writable:true,value:oldUrl.revoke});
 }
});
