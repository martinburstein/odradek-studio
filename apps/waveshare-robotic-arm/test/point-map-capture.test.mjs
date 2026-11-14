import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createPresetLibrary,projectPresetFeedback} from '../src/preset-library.mjs';

// Run the actual Point Map capture coordinator against a disposable library.
// The fixture has no Controller client, serial connection or movement endpoint.
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'point-map-capture-'));
 t.after(async()=>{if(!path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('Cleanup outside temporary root');await fs.rm(directory,{recursive:true,force:true});});
 const store=createPresetLibrary(directory),calls=[],messages=[];
 let state={mode:'serial',connected:true,telemetryUpdatedAt:new Date().toISOString(),measured:{base:.21,shoulder:.03,elbow:1.32,gripper:2.68},movement:{},execution:{}};
 let beforeCapture=null;
 const context=vm.createContext({Date,Number,Boolean,Error,library:await store.read(),selectedId:null,busy:false,feedback:null,lastFeedbackAt:0,
  saveDetails:async()=>{},detailsDirty:()=>false,renderCapture(){},renderLibrary(){},renderEditor(){},notify:(message,error)=>messages.push({message,error}),
  api:async(route,body)=>{
   calls.push({route,body});
   if(route==='feedback')return projectPresetFeedback(state);
   if(route==='library')return store.read();
   if(route==='create')return store.create(body);
   if(route==='capture'){if(beforeCapture)await beforeCapture();return store.capture(body,async()=>state);}
   throw Error('Unexpected operation: '+route);
  }
 });
 context.load=async()=>{context.library=await store.read();};
 const source=await fs.readFile(new URL('../public/presets/app.js',import.meta.url),'utf8');
 const definitions=source.slice(source.indexOf('const CALIBRATION_POINT_DEFS'),source.indexOf('function mountTrackpadMatrix('));
 const capture=source.slice(source.indexOf('async function captureMapPoint('),source.indexOf('function setTab('));
 vm.runInContext(definitions+capture,context);
 return {store,calls,messages,context,capture:(point,mode)=>context.captureMapPoint(point,mode),setState:change=>{state={...state,...change};},beforeCapture:fn=>{beforeCapture=fn;}};
}

test('Point Map persists distinct exact encoder poses for each point and mode',async t=>{
 const f=await fixture(t);
 for(const point of ['LEFT_CLICK','RIGHT_CLICK'])for(const mode of ['hover','contact'])await f.capture(point,mode);
 const library=await f.store.read();assert.equal(library.presets.length,4);
 assert.deepEqual(library.presets.map(p=>p.name),['Point Map · Left Click · Hover','Point Map · Left Click · Contact','Point Map · Right Click · Hover','Point Map · Right Click · Contact']);
 for(const p of library.presets){assert.equal(p.source,'encoder');assert.equal(p.positions.length,1);assert.deepEqual(p.positions[0].radians,{base:.21,shoulder:.03,elbow:1.32,gripper:2.68});assert.equal(p.positions[0].degrees.shoulder,90+.03*180/Math.PI);}
 assert.equal(f.messages.filter(m=>!m.error).length,4);
 assert.ok(f.calls.every(c=>['feedback','library','create','capture'].includes(c.route)));
});

test('updating one map pose preserves its identity and other points',async t=>{
 const f=await fixture(t);await f.capture('LEFT_CLICK','hover');await f.capture('RIGHT_CLICK','contact');
 const before=await f.store.read(),left=before.presets[0],right=structuredClone(before.presets[1]);
 f.setState({telemetryUpdatedAt:new Date().toISOString(),measured:{base:.25,shoulder:.04,elbow:1.4,gripper:2.68}});
 await f.capture('LEFT_CLICK','hover');const after=await f.store.read();
 assert.equal(after.presets.length,2);assert.equal(after.presets[0].id,left.id);assert.equal(after.presets[0].positions.length,1);assert.equal(after.presets[0].positions[0].id,left.positions[0].id);
 assert.equal(after.presets[0].positions[0].radians.base,.25);assert.deepEqual(after.presets[1],right);
 assert.equal(f.calls.filter(c=>c.route==='create').length,2);
 assert.equal(f.calls.filter(c=>c.route==='capture').at(-1).body.replacePositionId,left.positions[0].id);
});

test('disconnected, simulator, stale or busy feedback never creates or captures a point',async t=>{
 for(const change of [{connected:false},{mode:'simulator',simulated:{base:0,shoulder:0,elbow:1,gripper:2}},{telemetryUpdatedAt:new Date(Date.now()-10000).toISOString()},{movement:{active:true}},{execution:{cleanupPending:true}},{execution:{recoveryRequired:true}}]){
  const f=await fixture(t);f.setState(change);await f.capture('NW','hover');
  assert.equal((await f.store.read()).presets.length,0);assert.ok(f.calls.every(c=>c.route==='feedback'));assert.equal(f.messages.at(-1).error,true);assert.equal(f.context.busy,false);
 }
});

test('a capture-time shortfall in feedback leaves no invented pose and does not retry',async t=>{
 const f=await fixture(t);f.beforeCapture(async()=>f.setState({movement:{active:true}}));
 await f.capture('LEFT_CLICK','contact');const library=await f.store.read();
 assert.equal(library.presets.length,1);assert.equal(library.presets[0].positions.length,0);assert.equal(library.presets[0].source,null);
 assert.equal(f.calls.filter(c=>c.route==='capture').length,1);assert.equal(f.messages.at(-1).error,true);
});

test('a concurrent library edit is preserved and the map mutation is not replayed',async t=>{
 const f=await fixture(t);let once=true;f.beforeCapture(async()=>{if(once){once=false;await f.store.create({revision:(await f.store.read()).revision,name:'Another window'});}});
 await f.capture('E','hover');const library=await f.store.read();
 assert.equal(library.presets.length,2);assert.equal(library.presets[0].positions.length,0);assert.equal(library.presets[1].name,'Another window');
 assert.equal(f.calls.filter(c=>c.route==='capture').length,1);assert.equal(f.messages.at(-1).error,true);assert.equal(f.context.library.revision,library.revision);
});
