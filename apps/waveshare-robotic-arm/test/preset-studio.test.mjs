import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {captureStatus,createPresetLibrary,exportPreset} from '../src/preset-library.mjs';
import {createPresetServer} from '../src/preset-server.mjs';
import {compileScore,exportScore,framesFromPreset} from '../public/presets/motion-score.js';
import {recipeFrames} from '../public/presets/motion-recipes.js';

const status=(mode='serial')=>({connected:true,mode,telemetryUpdatedAt:new Date().toISOString(),measured:{base:-1,shoulder:.1,elbow:1,gripper:1.2},simulated:{base:0,shoulder:0,elbow:1,gripper:1.3},commanded:{base:99},execution:{},movement:{historyReady:false,historyError:'Unresolved historical result'}});
async function temp(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'preset-studio-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return directory;}
test('capture uses all measured joints, preserves precision, offsets shoulder and ignores commanded targets',()=>{
 const s=status(),capture=captureStatus(s);assert.equal(capture.source,'encoder');assert.deepEqual(capture.radians,s.measured);assert.equal(capture.degrees.shoulder,90+.1*180/Math.PI);assert.equal(capture.measuredAt,s.telemetryUpdatedAt);assert.equal(capture.degrees.base,-180/Math.PI);
});
test('capture rejects stale, future, incomplete, disconnected and moving snapshots',()=>{
 for(const alter of [s=>s.telemetryUpdatedAt=new Date(Date.now()-2001).toISOString(),s=>s.telemetryUpdatedAt=new Date(Date.now()+10000).toISOString(),s=>delete s.measured.elbow,s=>s.connected=false,s=>s.mode='http',s=>s.execution.busy=true,s=>s.execution.cleanupPending=true,s=>s.execution.recoveryRequired=true,s=>s.execution.outstandingTransportOperations=1,s=>s.movement.active=true,s=>s.movement.session={id:'live'},s=>s.task={active:true}]){const s=status();alter(s);assert.throws(()=>captureStatus(s));}
 const s=status();s.measured.base=Infinity;assert.throws(()=>captureStatus(s));assert.equal(captureStatus(status('simulator')).source,'simulator');
});
test('library persists two captured positions, edits order, recaptures, exports and archives without losing data',async t=>{
 const dir=await temp(t),store=createPresetLibrary(dir);let {library,selectedId:id}=await store.create({revision:0,name:'Scroll left'});
 let result=await store.capture({revision:library.revision,id},async()=>status());library=result.library;
 const s=status();s.telemetryUpdatedAt=new Date(Date.now()-20).toISOString();s.measured.base=-.9;result=await store.capture({revision:library.revision,id},async()=>s);library=result.library;
 assert.equal(library.presets[0].positions.length,2);assert.equal(createPresetLibrary(dir).read instanceof Function,true);
 assert.deepEqual(await createPresetLibrary(dir).read(),library);
 const order=library.presets[0].positions.map(p=>p.id).reverse();({library}=await store.update({revision:library.revision,id,order}));assert.equal(library.presets[0].positions[0].radians.base,-.9);
 ({library}=await store.capture({revision:library.revision,id,replacePositionId:order[0]},async()=>({...status(),telemetryUpdatedAt:new Date(Date.now()-30).toISOString()})));
 assert.equal(library.presets[0].positions[0].id,order[0]);assert.equal(library.presets[0].positions[0].radians.base,-1);
 const exported=exportPreset(library.presets[0]);assert.equal(exported.positions.length,2);assert.equal(exported.replay.intermediatePathRecorded,false);assert.equal(exported.moves,undefined);
 ({library}=await store.update({revision:library.revision,id,archived:true}));assert.equal(library.presets[0].positions.length,2);await assert.rejects(store.capture({revision:library.revision,id},async()=>status()),/Restore/);
 ({library}=await store.update({revision:library.revision,id,archived:false}));assert.equal(library.presets[0].archived,false);
});
test('duplicate readings, mixed sources, stale revisions, name clashes and malformed edits cannot corrupt the library',async t=>{
 const store=createPresetLibrary(await temp(t));let {library,selectedId:id}=await store.create({revision:0,name:'Scroll left'});
 const s=status();({library}=await store.capture({revision:1,id},async()=>s));
 await assert.rejects(store.capture({revision:2,id},async()=>s),/already captured/);
 await assert.rejects(store.capture({revision:2,id},async()=>status('simulator')),/separate movements/);
 await assert.rejects(store.update({revision:0,id,notes:'wrong'}),/another window/);
 await assert.rejects(store.create({revision:2,name:'SCROLL LEFT'}),/already exists/);
 await assert.rejects(store.update({revision:2,id,order:['unknown']}),/each position/);
 await assert.rejects(store.update({revision:2,id,name:''}),/nonempty/);
 const results=await Promise.allSettled([store.update({revision:2,id,notes:'first'}),store.update({revision:2,id,notes:'second'})]);assert.deepEqual(results.map(r=>r.status),['fulfilled','rejected']);assert.equal((await store.read()).revision,3);
});
test('Studio HTTP enforces local sessions/origin and capture calls only the status reader',async t=>{
 const directory=await temp(t);let reads=0,stops=0;
 const app=await createPresetServer({directory,port:0,readStatus:async()=>{reads++;return status();},client:async(route)=>{assert.equal(route,'stop');stops++;return {ok:true};}});t.after(()=>app.close());
 assert.equal((await fetch(app.url+'/api/library')).status,401);
 const page=await fetch(app.url);assert.equal(page.status,200);assert.match(await page.text(),/ODRADEK/);const cookie=page.headers.get('set-cookie').split(';')[0];const headers={cookie,Origin:app.url,'Content-Type':'application/json'};
 assert.equal((await fetch(app.url+'/api/create',{method:'POST',headers:{...headers,Origin:'http://evil.test'},body:'{}'})).status,403);
 const post=async(route,body)=>{const r=await fetch(app.url+'/api/'+route,{method:'POST',headers,body:JSON.stringify(body)});return {code:r.status,data:await r.json()};};
 const created=await post('create',{revision:0,name:'Test movement'});assert.equal(created.code,200);
 assert.equal((await post('capture',{revision:1,id:created.data.selectedId})).code,200);assert.equal(reads,1);assert.equal(stops,0);
 assert.equal((await post('connect',{})).code,404);assert.equal((await post('movement/execute',{})).code,404);assert.equal((await post('stop',{})).code,200);assert.equal(stops,1);
 const feedback=await (await fetch(app.url+'/api/feedback',{headers:{cookie}})).json();assert.equal(feedback.capturable,true);assert.equal(feedback.controllerOnline,true);
 const exported=await (await fetch(app.url+'/api/export?id='+created.data.selectedId,{headers:{cookie}})).json();assert.equal(exported.positions.length,1);
});

test('offline designs preserve timings, remain distinct from captures, and reject forged measured provenance',async t=>{
 const store=createPresetLibrary(await temp(t)),score=compileScore({frames:recipeFrames('double-take'),style:'pose',tempo:1.2});
 const design=exportScore(score,{name:'Double take draft'});design.source='encoder';design.hardwareCommands=99;design.frames[0].measuredAt=new Date().toISOString();
 const {library,selectedId:id}=await store.design({revision:0,design}),p=library.presets[0];assert.equal(p.source,'designed');assert.equal(p.design.style,'pose');assert.equal(p.design.tempo,1.2);
 for(const position of p.positions){assert.equal(position.source,'designed');assert.equal(position.measuredAt,null);assert.equal(position.capturedAt,null);assert.ok(position.designedAt);}
 assert.deepEqual(framesFromPreset(p),score.frames);assert.equal(exportPreset(p).design.previewDurationMs,score.durationMs);
 const rebuilt=compileScore({frames:framesFromPreset(p),...p.design});assert.equal(rebuilt.durationMs,score.durationMs);
 await assert.rejects(store.capture({revision:library.revision,id},async()=>status()),/separate movements/);
 const invalid=structuredClone(design);invalid.name='Invalid';invalid.frames[1].pose.elbow=999;await assert.rejects(store.design({revision:library.revision,design:invalid}),/elbow/);
 assert.equal((await store.read()).revision,1);
});

test('offline design API works with a completely unavailable arm and loads every Motion Lab module',async t=>{
 const directory=await temp(t);let transportReads=0;
 const app=await createPresetServer({directory,port:0,readStatus:async()=>{transportReads++;throw Error('Arm unplugged');}});t.after(()=>app.close());
 const page=await fetch(app.url),cookie=page.headers.get('set-cookie').split(';')[0],headers={cookie,Origin:app.url,'Content-Type':'application/json'};
 const design=exportScore(compileScore({frames:recipeFrames('quiet-breath')}),{name:'Quiet breath draft'});
 const response=await fetch(app.url+'/api/design',{method:'POST',headers,body:JSON.stringify({revision:0,design})});assert.equal(response.status,200);assert.equal(transportReads,0);assert.equal((await response.json()).library.presets[0].source,'designed');
 for(const file of ['motion-score.js','motion-recipes.js','motion-lab.js','motion-renderer.js','kinematics.js','motion-lab.css']){const r=await fetch(app.url+'/'+file);assert.equal(r.status,200,file);assert.match(r.headers.get('content-type'),file.endsWith('css')?/text\/css/:/text\/javascript/);}
});

test('reordering a draft anchor adds a real incoming duration and refreshes preview metadata',async t=>{
 const store=createPresetLibrary(await temp(t)),design=exportScore(compileScore({frames:recipeFrames('curious-scan')}),{name:'Reorder draft'});
 let {library,selectedId:id}=await store.design({revision:0,design});const original=library.presets[0].positions.map(p=>p.id),order=[original[1],original[0],...original.slice(2)];
 ({library}=await store.update({revision:1,id,order}));const p=library.presets[0];assert.equal(p.positions[1].durationMs,1200);assert.equal(p.design.previewDurationMs,compileScore({frames:framesFromPreset(p),style:p.design.style,tempo:p.design.tempo}).durationMs);
 assert.equal(p.positions[0].id,original[1]);assert.equal(p.positions[1].id,original[0]);assert.equal(p.positions[0].source,'designed');
});

test('a fresh Studio launch is visible to an already-open window without changing the library or issuing controls',async t=>{
 const directory=await temp(t),launchFile=path.join(directory,'launch.json');let reads=0;
 const app=await createPresetServer({directory,port:0,launchFile,readStatus:async()=>{reads++;return status();},client:async()=>{throw Error('No control operation allowed');}});t.after(()=>app.close());
 const page=await fetch(app.url),cookie=page.headers.get('set-cookie').split(';')[0];
 const feedback=async()=>{const r=await fetch(app.url+'/api/feedback',{headers:{cookie}});assert.equal(r.status,200);return r.json();};
 assert.equal((await feedback()).startup,null);
 const first={id:'11111111-1111-1111-1111-111111111111',tab:'manual'};
 await fs.writeFile(launchFile,JSON.stringify(first));assert.deepEqual((await feedback()).startup,first);
 const second={id:'22222222-2222-2222-2222-222222222222',tab:'automatic'};
 await fs.writeFile(launchFile,JSON.stringify(second));assert.deepEqual((await feedback()).startup,second);
 await fs.writeFile(launchFile,JSON.stringify({...second,tab:'unrecognized'}));assert.equal((await feedback()).startup,null);
 assert.equal(reads,4);assert.equal((await app.library.read()).presets.length,0);
});
