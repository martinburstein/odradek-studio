import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createPresetLibrary,projectPresetFeedback,exportPreset} from './preset-library.mjs';
import {createStudioRepair,controllerRepairClient,ensureStudioController} from './studio-repair.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PUBLIC=path.join(ROOT,'public/presets');
const assets={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css','/motion-score.js':'motion-score.js','/motion-recipes.js':'motion-recipes.js','/motion-renderer.js':'motion-renderer.js','/motion-lab.js':'motion-lab.js','/motion-lab.css':'motion-lab.css','/kinematics.js':'../kinematics.js'};
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
export function controllerClient(directory){
 return async(route='status',body)=>{
  const {token}=JSON.parse(await fs.readFile(path.join(directory,'access.json'),'utf8'));
  if(!['status','stop'].includes(route))throw Error('Unsupported Studio controller operation');
  const response=await fetch('http://127.0.0.1:8787/api/'+route,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(body?12000:3500)});
  if(!response.ok)throw Error('Controller unavailable. Open Manual to check its connection');
  return response.json();
 };
}
export async function createPresetServer({directory=path.join(ROOT,'runtime/movement-presets'),port=8790,client=controllerClient(path.join(ROOT,'runtime')),readStatus=()=>client('status'),launchFile=null,repair=createStudioRepair({api:controllerRepairClient(ROOT),ensureController:()=>ensureStudioController(ROOT)})}={}){
 const library=createPresetLibrary(directory),sessions=new Set();let url;
 const startup=async()=>{
  if(!launchFile)return null;
  try{const s=JSON.parse(await fs.readFile(launchFile,'utf8'));return typeof s.id==='string'&&/^[a-f0-9-]{36}$/.test(s.id)&&['manual','automatic','presets'].includes(s.tab)?{id:s.id,tab:s.tab}:null;}catch{return null;}
 };
 const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
 const server=http.createServer({requestTimeout:10000,headersTimeout:5000},async(req,res)=>{
  try{
   if(req.headers.host!==new URL(url).host||req.headers.origin&&req.headers.origin!==url)return send(res,403,{error:'Local app origin required'});
   const route=new URL(req.url,url).pathname;
   if(route==='/api/health'&&req.method==='GET')return send(res,200,{application:'roarm-preset-studio',ok:true});
   if(req.method==='GET'&&assets[route]){
    if(route==='/'||route==='/index.html'){
     if(sessions.size>=64)sessions.delete(sessions.values().next().value);
     const token=randomBytes(32).toString('hex');sessions.add(token);
     res.setHeader('Set-Cookie',`preset_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
    }
    const file=path.join(PUBLIC,assets[route]);res.writeHead(200,{'Content-Type':types[path.extname(file)],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src http://127.0.0.1:8787 http://127.0.0.1:5274; frame-ancestors 'none'; base-uri 'none'"});return res.end(await fs.readFile(file));
   }
   const cookies=(req.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith('preset_session='));
   if(cookies.length!==1||!sessions.has(cookies[0].slice(15)))return send(res,401,{error:'Reload Preset Studio to reconnect'});
   if(req.method==='GET'){
    if(route==='/api/library')return send(res,200,await library.read());
    if(route==='/api/feedback'){
     try{return send(res,200,{controllerOnline:true,...projectPresetFeedback(await readStatus()),startup:await startup()});}
     catch{return send(res,200,{controllerOnline:false,available:false,capturable:false,reason:'Controller offline. Launch Odradek Studio to start its controller.'});}
    }
    if(route==='/api/export'){
     const id=new URL(req.url,url).searchParams.get('id'),data=await library.read();
     return send(res,200,id?exportPreset(data.presets.find(p=>p.id===id)):data);
    }
   }
   if(req.method!=='POST')return send(res,404,{error:'Not found'});
   if(req.headers.origin!==url||req.headers['content-type']!=='application/json')return send(res,403,{error:'Local JSON request required'});
   let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>65536)return send(res,413,{error:'Request too large'});}
   const body=JSON.parse(raw);
   if(!body||typeof body!=='object'||Array.isArray(body))throw Error('Invalid request');
   if(route==='/api/stop')return send(res,200,await client('stop',{}));
   if(route==='/api/repair')return send(res,200,await repair(body));
   if(route==='/api/create')return send(res,200,await library.create(body));
   if(route==='/api/design')return send(res,200,await library.design(body));
   if(route==='/api/update')return send(res,200,await library.update(body));
   if(route==='/api/capture')return send(res,200,await library.capture(body,readStatus));
   return send(res,404,{error:'Not found'});
  }catch(error){send(res,error.status??400,{error:['ENOENT','ECONNREFUSED'].includes(error.code)?'Controller unavailable; start it and connect in Manual':error.message});}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});url=`http://127.0.0.1:${server.address().port}`;
 return {url,library,close:()=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();})};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const app=await createPresetServer({launchFile:path.join(ROOT,'runtime/studio-launch.json')});console.log(`Movement Preset Studio: ${app.url}`);
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void app.close());
}
