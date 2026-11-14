const fs=require('node:fs/promises');
const path=require('node:path');
const {fork}=require('node:child_process');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function viewerPort(offlineLearning){
 if(offlineLearning&&process.env.ODRADEK_TEST_PORTS){try{const port=JSON.parse(process.env.ODRADEK_TEST_PORTS).appPreview;if(Number.isInteger(port)&&port>0&&port<=65535)return port;}catch{}}
 return 5291;
}
async function inspectServices(){
 const urls=['http://127.0.0.1:8787/api/health','http://127.0.0.1:8790/api/health','http://127.0.0.1:5274/arm-manual/'];
 const checks=await Promise.all(urls.map(async(url,i)=>{
  try{const r=await fetch(url,{signal:AbortSignal.timeout(2500)});if(!r.ok)return 'occupied';
   if(i===2)return (await r.text()).includes('Odradek · Joint Manual')?'ready':'occupied';
   return (await r.json()).application===(i===0?'waveshare-robotic-arm':'roarm-preset-studio')?'ready':'occupied';
  }catch(error){return error.cause?.code==='ECONNREFUSED'?'absent':'occupied';}
 }));
 if(checks.every(c=>c==='ready'))return 'reuse';
 if(checks.every(c=>c==='absent'))return 'start';
 throw Error('Only part of the local Studio is running, or a required port is occupied. Close its own launcher first, then reopen Odradek Studio. The app has left those services untouched.');
}
class Supervisor{
 constructor({resources,dataRoot,packaged,version='0.2.0',offlineLearning=false}){Object.assign(this,{resources,dataRoot,packaged,version,offlineLearning:!!offlineLearning,child:null,reused:false,ready:false,stopPromise:null});}
 async start(){
  const mode=this.offlineLearning?'offline-learning':await inspectServices();this.reused=mode==='reuse';const port=viewerPort(this.offlineLearning),healthUrl=`http://127.0.0.1:${port}/api/health`;
  try{await fetch(healthUrl,{signal:AbortSignal.timeout(2500)});throw Error(`The app viewer port ${port} is occupied. Close its own app before reopening.`);}catch(error){if(error.cause?.code!=='ECONNREFUSED')throw error;}
  const node=path.join(this.resources,this.packaged?'node/node.exe':'vendor/node/node.exe'),backend=path.join(this.resources,this.packaged?'backend/backend.mjs':'desktop/backend.mjs');
  await fs.mkdir(this.dataRoot,{recursive:true});
  const log=await fs.open(path.join(this.dataRoot,'application.log'),'a');
  try{this.child=fork(backend,[],{execPath:node,cwd:this.resources,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'',ODRADEK_RESOURCE_ROOT:this.resources,ODRADEK_DATA_ROOT:this.dataRoot,ODRADEK_VIEWER_ROOT:path.join(this.resources,this.packaged?'viewer':'dist'),ODRADEK_PREVIEW_ONLY:mode==='reuse'?'1':'0',ODRADEK_OFFLINE_LEARNING:this.offlineLearning?'1':'0',ODRADEK_APP_VERSION:this.version},stdio:['ignore',log.fd,log.fd,'ipc']});}
  finally{await log.close();}
  const child=this.child;
  try{
   for(let attempt=0;attempt<60;attempt++){
    if(child.exitCode!==null||child.signalCode)throw Error('Local services exited. Application → Open data folder contains application.log.');
    try{const r=await fetch(healthUrl,{signal:AbortSignal.timeout(1500)}),value=await r.json();if(r.ok&&value.application==='odradek-lab-preview'&&value.version===this.version){this.ready=true;return;}}catch{}
    await wait(250);
   }
   throw Error('Local services did not become ready. Check application.log.');
  }catch(error){await this.stop();throw error;}
 }
 stop(){
  this.ready=false;
  if(this.stopPromise)return this.stopPromise;
  const child=this.child;if(!child)return Promise.resolve();
  const stopping=Promise.resolve().then(()=>this.stopChild(child));
  this.stopPromise=stopping;
  const clear=()=>{if(this.stopPromise===stopping)this.stopPromise=null;};
  stopping.then(clear,clear);
  return stopping;
 }
 async stopChild(child){
  if(child.exitCode!==null||child.signalCode){if(this.child===child)this.child=null;if(child.exitCode!==0)throw Error('Controller shutdown reported incomplete cleanup. Check the arm and application.log.');return;}
  let timer,onExit,ipcError;
  const outcome=await new Promise(resolve=>{
   let settled=false;
   const finish=value=>{if(settled)return;settled=true;resolve(value);};
   onExit=()=>finish('exit');
   child.once('exit',onExit);
   timer=setTimeout(()=>finish('timeout'),15000);
   if(child.exitCode!==null||child.signalCode){finish('exit');return;}
   try{
    if(child.connected===false)throw Error('Child IPC channel is closed');
    child.send({type:'shutdown'},error=>{if(error)ipcError=error;});
   }catch(error){ipcError=error;}
  });
  clearTimeout(timer);child.off('exit',onExit);
  if(outcome==='timeout'&&child.exitCode===null)throw Error((this.offlineLearning?'Offline viewer shutdown is still pending. Check application.log; no forced process termination was sent.':'Controller shutdown is still pending. Check the physical arm and application.log; no forced process termination was sent.')+(ipcError?` Shutdown IPC failed: ${ipcError.message||ipcError}`:''));
  if(this.child===child)this.child=null;
  if(child.exitCode!==0)throw Error('Controller shutdown reported incomplete cleanup. Check the arm and application.log.');
 }
}
module.exports={Supervisor,inspectServices};
