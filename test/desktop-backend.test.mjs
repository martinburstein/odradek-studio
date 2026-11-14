import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import http from 'node:http';
const root=path.resolve(import.meta.dirname,'..');
const {version}=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const packaged=process.env.ODRADEK_TEST_PACKAGED_ROOT;
const resources=packaged?path.resolve(packaged):root;
test('fresh bundled backend opens the app without hardware, credentials or commissioning copied from another machine',async t=>{
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'odradek-lab-fresh-'));
 const child=fork(path.join(resources,packaged?'backend/backend.mjs':'desktop/backend.mjs'),[],{execPath:path.join(resources,packaged?'node/node.exe':'vendor/node/node.exe'),cwd:resources,windowsHide:true,silent:true,
  env:{...process.env,ODRADEK_APP_VERSION:version,ODRADEK_RESOURCE_ROOT:resources,ODRADEK_VIEWER_ROOT:path.join(resources,packaged?'viewer':'dist'),ODRADEK_DATA_ROOT:temporary,ODRADEK_TEST_PORTS:JSON.stringify({controller:0,studio:0,preview:0})}});
 let output='',errors='';child.stderr.on('data',bytes=>{errors+=bytes;});
 t.after(async()=>{
  if(child.exitCode===null){child.send({type:'shutdown'});await new Promise(resolve=>child.once('exit',resolve));}
  assert.equal(child.exitCode,0,errors);
  assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(temporary,{recursive:true,force:true});
 });
 const ready=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Backend readiness timed out: '+errors)),15000);
  child.once('exit',code=>{clearTimeout(timer);reject(Error('Backend exited '+code+': '+errors));});
  child.stdout.on('data',bytes=>{output+=bytes;for(const line of output.split('\n'))try{const value=JSON.parse(line);if(value.event==='ready'){clearTimeout(timer);resolve(value);return;}}catch{}});
 });
 assert.equal(ready.connected,false);assert.equal(ready.armed,false);
 const appHealth=await(await fetch(ready.appPreview+'/api/health')).json();assert.equal(appHealth.version,version);assert.equal(appHealth.previewOnly,true);
 const page=await fetch(ready.preview+'/arm-manual/');assert.equal(page.status,200);assert.match(await page.text(),/Odradek · Joint Manual/);
 assert.match(page.headers.get('content-security-policy'),/frame-ancestors http:\/\/127\.0\.0\.1:8790/);
 const observation=await(await fetch(ready.preview+'/api/roarm/observation')).json();assert.equal(observation.pose,null);assert.equal(observation.state,'offline');assert.equal(observation.source,null);
 assert.equal((await fetch(ready.preview+'/api/roarm/observation',{method:'POST'})).status,405);
 assert.equal((await fetch(ready.preview+'/backend/backend.mjs')).status,404);
 assert.equal((await fetch(ready.preview+'/assets/%2e%2e%2fpackage.json')).status,403);
 const studio=await fetch(ready.studio);assert.equal(studio.status,200);assert.match(await studio.text(),/joint-preview-frame/);
 const cookie=studio.headers.get('set-cookie').split(';')[0];
 const feedback=await(await fetch(ready.studio+'/api/feedback',{headers:{cookie}})).json();assert.equal(feedback.capturable,false);assert.equal(feedback.controllerOnline,true);
 const presets=await(await fetch(ready.studio+'/api/library',{headers:{cookie}})).json();assert.deepEqual(presets.presets,[]);
 const {token}=JSON.parse(await fs.readFile(path.join(temporary,'access.json')));
 const state=await(await fetch(ready.controller+'/api/status',{headers:{authorization:'Bearer '+token}})).json();assert.equal(state.connected,false);assert.equal(state.armed,false);assert.equal(state.owner,null);
 await assert.rejects(fs.access(path.join(temporary,'commissioning/motion.json')));
});
test('a reused Studio receives the bundled new viewer on its own port with only a public GET bridge',async t=>{
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'odradek-preview-only-')),requests=[];
 const bridge=http.createServer((req,res)=>{requests.push({method:req.method,url:req.url,authorization:req.headers.authorization});res.setHeader('content-type','application/json');res.end(JSON.stringify({state:'live',source:'simulator',pose:{base:0,shoulder:0,elbow:1.5,gripper:2.6},observedAt:new Date().toISOString(),privateMarker:'must-not-forward'}));});
 await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
 const child=fork(path.join(resources,packaged?'backend/backend.mjs':'desktop/backend.mjs'),[],{execPath:path.join(resources,packaged?'node/node.exe':'vendor/node/node.exe'),cwd:resources,windowsHide:true,silent:true,env:{...process.env,ODRADEK_APP_VERSION:version,ODRADEK_RESOURCE_ROOT:resources,ODRADEK_VIEWER_ROOT:path.join(resources,packaged?'viewer':'dist'),ODRADEK_DATA_ROOT:temporary,ODRADEK_PREVIEW_ONLY:'1',ODRADEK_TEST_PORTS:JSON.stringify({appPreview:0}),ODRADEK_EXTERNAL_OBSERVATION_URL:`http://127.0.0.1:${bridge.address().port}/api/roarm/observation`}});
 let errors='';child.stderr.on('data',bytes=>{errors+=bytes;});
 t.after(async()=>{if(child.exitCode===null){child.send({type:'shutdown'});await new Promise(resolve=>child.once('exit',resolve));}await new Promise(resolve=>bridge.close(resolve));assert.equal(child.exitCode,0,errors);assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(temporary,{recursive:true,force:true});});
 const ready=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Preview-only startup timed out: '+errors)),15000);child.once('exit',code=>{clearTimeout(timer);reject(Error('Exited '+code+errors));});child.stdout.on('data',bytes=>{output+=bytes;for(const line of output.split('\n'))try{const value=JSON.parse(line);if(value.event==='ready'){clearTimeout(timer);resolve(value);return;}}catch{}});});
 assert.equal(ready.previewOnly,true);assert.equal(ready.controller,null);assert.equal(ready.preview,null);
 const health=await(await fetch(ready.appPreview+'/api/health')).json();assert.equal(health.version,version);
 assert.equal((await fetch(ready.appPreview+'/arm-manual/')).status,200);
 const observation=await(await fetch(ready.appPreview+'/api/roarm/observation')).json();assert.equal(observation.privateMarker,undefined);assert.equal(observation.source,'simulator');
 assert.deepEqual(requests,[{method:'GET',url:'/api/roarm/observation',authorization:undefined}]);await assert.rejects(fs.access(path.join(temporary,'access.json')));await assert.rejects(fs.access(path.join(temporary,'movement-history.json')));
});
