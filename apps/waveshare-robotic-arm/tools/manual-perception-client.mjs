import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

// Read-only numeric image measurements. This child cannot issue robot commands.
export async function createManualPerception({expiresAt,spawnProcess=spawn,requestTimeoutMs=5000,trackingMethod='median'}={}){
 const remaining=Date.parse(expiresAt)-Date.now();
 if(!Number.isFinite(remaining)||remaining<1000||remaining>300000||!Number.isInteger(requestTimeoutMs)||requestTimeoutMs<1||requestTimeoutMs>5000)throw Error('Finite camera comparison session required');
 if(!['median','affine'].includes(trackingMethod))throw Error('Unknown image tracking method');
 const child=spawnProcess('python',['-u',fileURLToPath(new URL('./perception/compare-camera-frames.py',import.meta.url)),'--seconds',String(Math.ceil(remaining/1000)),'--tracking-method',trackingMethod],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 let pending=null,ready=false,closed=false,closing=false,faulted=false,closePromise=null,readyResolve,readyReject;
 const readiness=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 const reader=createInterface({input:child.stdout,crlfDelay:Infinity});
 let closeResolve;const exited=new Promise(resolve=>closeResolve=resolve);
 const rejectPending=error=>{if(pending){const value=pending;pending=null;clearTimeout(value.timer);value.reject(error);}};
 const fail=error=>{faulted=true;readyReject(error);rejectPending(error);};
 child.stderr.on('data',()=>{}); // Never forward arbitrary subprocess output.
 child.on('error',()=>fail(Error('Camera comparison process could not start')));
 child.stdin.on('error',()=>fail(Error('Camera comparison input failed')));
 child.stdout.on('error',()=>fail(Error('Camera comparison output failed')));
 child.on('close',()=>{closed=true;reader.close();fail(Error('Camera comparison process ended'));closeResolve();});
 reader.on('line',line=>{
  let value;try{if(line.length>16384)throw Error();value=JSON.parse(line);}catch{fail(Error('Invalid camera comparison response'));return;}
  if(!ready&&!faulted&&value?.event==='ready'&&value.imagesSaved===false&&value.hardwareAccess===false){
   if((trackingMethod==='affine'||value.trackingMethod!==undefined)&&value.trackingMethod!==trackingMethod){fail(Error('Camera tracking method acknowledgement mismatch'));return;}
   ready=true;readyResolve();return;
  }
  if(value?.event==='closed'){fail(Error('Camera comparison deadline or input ended'));return;}
  if(!pending||value?.id!==pending.id){fail(Error('Unexpected camera comparison response'));return;}
  const current=pending;pending=null;clearTimeout(current.timer);
  if(value.ok!==true){faulted=true;current.reject(Error('Camera comparison failed: '+String(value.error??'unknown').slice(0,300)));}
  else if(value.result?.imagesSaved!==false){faulted=true;current.reject(Error('Camera comparison response lacked memory-only evidence'));}
  else current.resolve(value.result);
 });
 async function request(action){
  if(closed||closing||faulted||!ready||pending)throw Error('Camera comparison process is unavailable');
  return new Promise((resolve,reject)=>{
   const id=randomUUID(),timer=setTimeout(()=>{fail(Error('Camera comparison request timed out'));child.kill();},requestTimeoutMs);
   pending={id,timer,resolve,reject};
   child.stdin.write(JSON.stringify({id,action})+'\n',error=>{if(error){rejectPending(Error('Camera comparison input failed'));child.kill();}});
  });
 }
 function close(){
  if(closePromise)return closePromise;
  closePromise=(async()=>{
  closing=true;rejectPending(Error('Camera comparison closing'));
  if(!closed){child.stdin.end();child.kill();}
  let timer;try{await Promise.race([exited,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Camera comparison cleanup was not confirmed')),2000))]);}finally{clearTimeout(timer);}
  })();return closePromise;
 }
 const timer=setTimeout(()=>{fail(Error('Camera comparison startup timed out'));child.kill();},requestTimeoutMs);
 try{await readiness;}catch(error){await close();throw error;}finally{clearTimeout(timer);}
 return {reference:()=>request('reference'),compare:()=>request('compare'),close};
}
