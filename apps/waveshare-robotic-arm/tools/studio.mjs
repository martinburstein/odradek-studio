#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {SerialPort} from 'serialport';
import {prepareStudioConnection} from './studio-connection.mjs';
import {randomUUID} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),exec=promisify(execFile),args=process.argv.slice(2);
const tab=args.find(a=>a.startsWith('--tab='))?.slice(6)??'manual';
if(!['manual','automatic','presets'].includes(tab)||args.some(a=>!['--offline','--no-view','--tab=manual','--tab=automatic','--tab=presets'].includes(a)))throw Error('Use studio.mjs [--offline] [--no-view] [--tab=manual|automatic|presets]');
async function get(url){const r=await fetch(url,{signal:AbortSignal.timeout(2500)});if(!r.ok)throw Error(`Service returned ${r.status}`);return r.json();}
async function launch(exe,argv,name){const logs=path.join(root,'runtime/startup');await fs.mkdir(logs,{recursive:true});const file=await fs.open(path.join(logs,name+'.log'),'a');try{const child=spawn(exe,argv,{cwd:root,detached:true,windowsHide:true,stdio:['ignore',file.fd,file.fd]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();}finally{await file.close();}}
async function ensure(url,valid,start){try{const value=await get(url);if(!valid(value))throw Error('Unexpected service identity');return;}catch(e){if(e.cause?.code!=='ECONNREFUSED')throw e;}await start();for(let n=0;n<60;n++){try{const value=await get(url);if(!valid(value))throw Error('Unexpected service identity');return;}catch(e){if(e.cause?.code!=='ECONNREFUSED')throw e;}await delay(200);}throw Error('Service startup timed out');}
let controllerNode=process.execPath;
try{const saved=JSON.parse(await fs.readFile(path.join(root,'runtime/startup/controller-runtime.json'),'utf8'));if(path.isAbsolute(saved.executable)&&saved.version==='v24.22.1'){const actual=await exec(saved.executable,['--version'],{windowsHide:true,timeout:5000});if(actual.stdout.trim()===saved.version)controllerNode=saved.executable;}}catch{}
// Reuse services. Startup may open the exact arm's read-only serial connection;
// it never claims ownership, arms controls, starts MAGI or sends position targets.
if(!args.includes('--offline'))await ensure('http://127.0.0.1:8787/api/health',s=>s.application==='waveshare-robotic-arm',()=>launch(controllerNode,['--report-on-fatalerror','--report-uncaught-exception','--report-exclude-env','--report-directory='+path.join(root,'runtime/startup'),'src/server.mjs'],'controller'));
await ensure('http://127.0.0.1:8790/api/health',s=>s.application==='roarm-preset-studio',()=>launch(process.execPath,['src/preset-server.mjs'],'studio'));
// Bot Crossing's preview uses its existing renderer/server, with no Swarm boot
// or robot write endpoint. A failed preview leaves classic Manual available.
let jointPreviewError=null;
try{
 const botRoot=path.resolve(root,'../bot-crossing-clone'),previewUrl='http://127.0.0.1:5274/arm-manual/';
 const check=async()=>{const r=await fetch(previewUrl,{signal:AbortSignal.timeout(2500)});if(!r.ok||!(await r.text()).includes('Odradek · Joint Manual'))throw Error('Expected Bot Crossing joint preview is unavailable');};
 try{await check();}catch(error){
  if(error.cause?.code!=='ECONNREFUSED')throw error;
  await fs.access(path.join(botRoot,'dist/arm-manual/index.html'));
  await launch(process.execPath,[path.join(botRoot,'server/serve.mjs')],'joint-preview');
  let lastError;for(let i=0;i<30;i++){try{await check();lastError=null;break;}catch(e){lastError=e;await delay(200);}}if(lastError)throw lastError;
 }
}catch(error){jointPreviewError=error.message;}
let cameraError=null;if(!args.includes('--offline'))try{await ensure('http://127.0.0.1:8788/status',s=>s.robotAccess===false,()=>launch('python',['-u','tools/webcam.py'],'camera'));}catch(e){cameraError=e.message;}
let connection=null,connectionError=null;
if(!args.includes('--offline'))try{
 const {token}=JSON.parse(await fs.readFile(path.join(root,'runtime/access.json'),'utf8'));
 const api=async(route,body)=>{
  const r=await fetch('http://127.0.0.1:8787/api/'+route,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12000)});
  const value=await r.json();if(!r.ok)throw Error(value.error||'Controller connection unavailable');return value;
 };
 connection=await prepareStudioConnection({api,listPorts:()=>SerialPort.list()});
}catch(error){connectionError=error.message;}
// Existing usage panel follows the caller; this starts no model turn.
if(/^[a-f0-9-]{36}$/i.test(process.env.CODEX_THREAD_ID??''))await fs.writeFile(path.join(root,'runtime/sync-view.json'),JSON.stringify({chatId:process.env.CODEX_THREAD_ID},null,2)+'\n');
const url=`http://127.0.0.1:8790/#${tab}`;let layout=null;
if(!args.includes('--no-view')){
 const chrome=path.join(process.env.PROGRAMFILES,'Google/Chrome/Application/chrome.exe'),profile=path.join(root,'runtime/studio-browser');
 const existing=await exec('powershell.exe',['-NoProfile','-Command',"@(Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -in @('Odradek Studio','Odradek Studio - Google Chrome') }).Count"],{windowsHide:true});
 if(Number(existing.stdout.trim())===0){await fs.writeFile(path.join(root,'runtime/studio-launch.json'),JSON.stringify({id:randomUUID(),tab})+'\n');const child=spawn(chrome,[`--app=${url}`,`--user-data-dir=${profile}`],{detached:true,stdio:'ignore',windowsHide:false});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();}
 let lastError;for(let i=0;i<20;i++){try{const result=await exec('powershell.exe',['-NoProfile','-File',path.join(root,'tools/studio-layout.ps1')],{windowsHide:true,timeout:10000});layout=JSON.parse(result.stdout);break;}catch(e){lastError=e;}await delay(300);}if(!layout)throw lastError;
}
console.log(JSON.stringify({url,layout,cameraError,jointPreviewError,connection,connectionError,offline:args.includes('--offline'),hardwareConnectedByLauncher:connection?.connected===true&&connection.reused===false,commandsSent:0},null,2));
