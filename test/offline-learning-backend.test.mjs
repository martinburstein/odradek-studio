import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createRequire} from 'node:module';

const root=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),{Supervisor}=require('../desktop/supervisor.cjs'),{version}=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const packagedRoot=process.env.ODRADEK_TEST_PACKAGED_ROOT,packaged=Boolean(packagedRoot),resources=packaged?path.resolve(packagedRoot):root;
async function freePort(){
 const server=net.createServer();await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
async function sentinel(port){
 let requests=0;const server=net.createServer(socket=>{requests++;socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');});
 await new Promise((resolve,reject)=>server.listen(port,'127.0.0.1',resolve).once('error',reject));return{server,get requests(){return requests;},close:()=>new Promise(resolve=>server.close(resolve))};
}
async function tree(directory){
 const result=[];for(const entry of await fs.readdir(directory,{withFileTypes:true})){const full=path.join(directory,entry.name);result.push(entry.isDirectory()?`${entry.name}/`:entry.name);if(entry.isDirectory())result.push(...(await tree(full)).map(value=>`${entry.name}/${value}`));}return result;
}

test(`offline learning serves its viewer only (${packaged?'packaged candidate':'source tree'})`,async t=>{
 const dataRoot=await fs.mkdtemp(path.join(os.tmpdir(),'odradek-offline-learning-'));
 assert.ok(path.resolve(dataRoot).startsWith(path.resolve(os.tmpdir())+path.sep));
 const controllerPort=await freePort(),studioPort=await freePort(),previewPort=await freePort(),appPort=await freePort(),bridgePort=await freePort();
 const oldPorts=process.env.ODRADEK_TEST_PORTS,oldBridge=process.env.ODRADEK_EXTERNAL_OBSERVATION_URL,originalFetch=globalThis.fetch,requests=[],allowedOrigin=`http://127.0.0.1:${appPort}`;
 const ports=JSON.stringify({controller:controllerPort,studio:studioPort,preview:previewPort,appPreview:appPort});
 process.env.ODRADEK_TEST_PORTS=ports;process.env.ODRADEK_EXTERNAL_OBSERVATION_URL=`http://127.0.0.1:${bridgePort}/api/roarm/observation`;
 const probes=[await sentinel(controllerPort),await sentinel(studioPort),await sentinel(previewPort)],bridge=await sentinel(bridgePort);
 globalThis.fetch=(input,...args)=>{
  const target=new URL(input instanceof Request?input.url:String(input));requests.push(target.href);
  if(target.origin!==allowedOrigin)throw Error(`Offline backend test blocked unexpected parent fetch: ${target.href}`);
  return originalFetch(input,...args);
 };
 const supervisor=new Supervisor({resources,dataRoot,packaged,version,offlineLearning:true});
 t.after(async()=>{
  let stopError;try{const stopStarted=Date.now();await supervisor.stop();assert.ok(Date.now()-stopStarted<5000,'offline viewer must shut down promptly');}catch(error){stopError=error;}
  if(supervisor.child?.exitCode===null)try{supervisor.child.kill();}catch{}
  for(const probe of probes)await probe.close();await bridge.close();globalThis.fetch=originalFetch;
  if(oldPorts===undefined)delete process.env.ODRADEK_TEST_PORTS;else process.env.ODRADEK_TEST_PORTS=oldPorts;
  if(oldBridge===undefined)delete process.env.ODRADEK_EXTERNAL_OBSERVATION_URL;else process.env.ODRADEK_EXTERNAL_OBSERVATION_URL=oldBridge;
  await fs.rm(dataRoot,{recursive:true,force:true});if(stopError)throw stopError;
 });
 assert.equal(supervisor.offlineLearning,true);assert.equal(supervisor.reused,false);
 await supervisor.start();assert.equal(supervisor.ready,true);
 const base=allowedOrigin,health=await(await fetch(`${base}/api/health`)).json();assert.equal(health.application,'odradek-lab-preview');assert.equal(health.version,version);assert.equal(health.previewOnly,true);
 const page=await fetch(`${base}/arm-manual/`);assert.equal(page.status,200);assert.match(await page.text(),/Odradek · Joint Manual/);
 const observation=await(await fetch(`${base}/api/roarm/observation`)).json();assert.deepEqual(observation,{state:'offline',source:null,pose:null,observedAt:null,offlineLearning:true});
 assert.deepEqual(probes.map(probe=>probe.requests),[0,0,0]);assert.equal(bridge.requests,0);
 assert.ok(requests.every(url=>new URL(url).origin===allowedOrigin));
 const files=await tree(dataRoot);assert.equal(files.includes('access.json'),false);assert.equal(files.some(name=>/history|commissioning/i.test(name)),false);
 const log=await fs.readFile(path.join(dataRoot,'application.log'),'utf8');assert.match(log,/"event":"ready"/);assert.match(log,/"offlineLearning":true/);assert.match(log,/"controller":null.*"studio":null.*"preview":null/);
 if(packaged){assert.equal((await fs.stat(path.join(resources,'backend','backend.mjs'))).isFile(),true);assert.equal((await fs.stat(path.join(resources,'node','node.exe'))).isFile(),true);assert.equal((await fs.stat(path.join(resources,'viewer','arm-manual','index.html'))).isFile(),true);}
});
