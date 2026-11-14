import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const unavailable=()=>({tokens:null,remaining:null,tokenStatus:'unavailable',accountStatus:'unavailable'});
// Optional native/SQLite readers run outside the hardware-owning process.
export function createSyncUsage({root,directory,forkImpl=fork,timeoutMs=5000,retryMs=60000}){
 let child=null,id=0,retryAt=0,idle;const pending=new Map();
 const finish=(key,value)=>{const p=pending.get(key);if(p){clearTimeout(p.timer);pending.delete(key);p.resolve(value);}};
 const retire=(worker,backoff=false)=>{if(child!==worker)return;child=null;clearTimeout(idle);if(backoff)retryAt=Date.now()+retryMs;for(const key of pending.keys())finish(key,unavailable());try{worker.kill();}catch{}};
 const close=()=>{if(child)retire(child);};
 const read=async()=>{
  if(!child){
   if(Date.now()<retryAt)return unavailable();
   try{
    const worker=forkImpl(fileURLToPath(new URL('./sync-usage-worker.mjs',import.meta.url)),[root,directory],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],execArgv:[]});child=worker;
    worker.on('message',message=>{if(message&&Number.isSafeInteger(message.id)&&message.value)finish(message.id,message.value);});
    worker.once('error',()=>retire(worker,true));worker.once('exit',()=>retire(worker,true));
   }catch{retryAt=Date.now()+retryMs;return unavailable();}
  }
  clearTimeout(idle);idle=setTimeout(close,60000);idle.unref();const worker=child,key=++id;
  return new Promise(resolve=>{const timer=setTimeout(()=>retire(worker,true),timeoutMs);timer.unref();pending.set(key,{resolve,timer});try{worker.send({id:key},error=>{if(error)retire(worker,true);});}catch{retire(worker,true);}});
 };
 return {read,close};
}
