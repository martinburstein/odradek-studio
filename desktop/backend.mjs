// Runs in the bundled stock Node runtime, never Electron's native-module ABI.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createPreviewServer} from './preview-server.mjs';
const root=path.resolve(process.env.ODRADEK_RESOURCE_ROOT??path.join(import.meta.dirname,'..'));
const runtime=path.resolve(process.env.ODRADEK_DATA_ROOT??path.join(root,'runtime'));
const arm=path.join(root,'apps/waveshare-robotic-arm');
const ports=JSON.parse(process.env.ODRADEK_TEST_PORTS??'{"controller":8787,"studio":8790,"preview":5274}');
const appPreviewPort=ports.appPreview??(process.env.ODRADEK_TEST_PORTS?0:5291),previewOnly=process.env.ODRADEK_PREVIEW_ONLY==='1';
const offlineLearning=process.env.ODRADEK_OFFLINE_LEARNING==='1';
const previewOptions={directory:process.env.ODRADEK_VIEWER_ROOT??path.join(root,'viewer'),version:process.env.ODRADEK_APP_VERSION??'0.2.0'};
const load=file=>import(pathToFileURL(path.join(arm,'src',file)));
const services=[];let closing=false;
async function shutdown(){
 if(closing)return;closing=true;
 for(const service of services.toReversed()){
  const result=await service.close();
  if(result?.cleanupVerified===false)throw Error('Controller cleanup remains unresolved; inspect hardware before reopening.');
 }
}
try{
 await fs.mkdir(runtime,{recursive:true});
 let controller,studio,preview,appPreview;
 if(offlineLearning){
  const offlineObservation=Object.freeze({state:'offline',source:null,pose:null,observedAt:null,offlineLearning:true});
  appPreview=await createPreviewServer({...previewOptions,port:appPreviewPort,readObservation:async()=>({...offlineObservation})});services.push(appPreview);
 }else if(previewOnly){
  const endpoint=new URL(process.env.ODRADEK_EXTERNAL_OBSERVATION_URL??'http://127.0.0.1:5274/api/roarm/observation');
  if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||endpoint.pathname!=='/api/roarm/observation'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw Error('Expected a fixed loopback observation bridge.');
  appPreview=await createPreviewServer({...previewOptions,port:appPreviewPort,readObservation:async()=>{try{const r=await fetch(endpoint,{method:'GET',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(2500)});if(!r.ok)throw Error();const value=await r.json();return {state:value.state,source:value.source,pose:value.pose,observedAt:value.observedAt};}catch{return {state:'offline',source:null,pose:null,observedAt:null};}}});services.push(appPreview);
 }else{
 const {createServer}=await load('server.mjs');
 controller=await createServer({directory:runtime,port:ports.controller});services.push(controller);
 const {createPresetServer}=await load('preset-server.mjs');
 const {createStudioRepair}=await load('studio-repair.mjs');
 const api=async(route,body)=>{
  const {token}=JSON.parse(await fs.readFile(path.join(runtime,'access.json')));
  const r=await fetch(controller.url+'/api/'+route,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(65000)});
  const value=await r.json();if(!r.ok)throw Error(value.error??'Controller request failed');return value;
 };
 studio=await createPresetServer({directory:path.join(runtime,'movement-presets'),port:ports.studio,client:api,
  repair:createStudioRepair({api,ensureController:async()=>{const r=await fetch(controller.url+'/api/health');if(!r.ok)throw Error('Use Application → Repair local services.');}})});services.push(studio);
 const {projectPresetFeedback}=await load('preset-library.mjs');
 const readObservation=async()=>{
  try{const feedback=projectPresetFeedback(await api('status'));return {state:feedback.capturable?'live':'offline',source:feedback.capturable?(feedback.source==='encoder'?'hardware':feedback.source==='simulator'?'simulator':null):null,pose:feedback.capturable?feedback.radians:null,observedAt:feedback.measuredAt??null};}
  catch{return {state:'offline',source:null,pose:null,observedAt:null};}
 };
 preview=await createPreviewServer({...previewOptions,port:ports.preview,readObservation});services.push(preview);
 appPreview=await createPreviewServer({...previewOptions,port:appPreviewPort,readObservation});services.push(appPreview);
 }
 console.log(JSON.stringify({event:'ready',controller:controller?.url??null,studio:studio?.url??(offlineLearning?null:'http://127.0.0.1:8790'),preview:preview?.url??null,appPreview:appPreview.url,connected:controller?.controller.connected??null,armed:controller?.controller.armed??null,previewOnly:previewOnly||offlineLearning,offlineLearning,runtime}));
 process.on('message',message=>{if(message?.type==='shutdown')void shutdown().then(()=>process.exit(0),error=>{console.error(error.message);process.exit(2);});});
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>void shutdown().then(()=>process.exit(0),()=>process.exit(2)));
 process.once('disconnect',()=>void shutdown().then(()=>process.exit(0),()=>process.exit(2)));
}catch(error){console.error(error.stack);await shutdown().catch(()=>{});process.exitCode=1;}
