// Reuse the existing local-page session bootstrap after a server restart.
// Only idempotent display reads are retried; control requests are never replayed.
export function createSyncFetch(fetchImpl=globalThis.fetch.bind(globalThis)){
 let renewal=null,generation=0;
 const readPaths=new Set(['/api/sync','/api/sync/usage','/camera/frame']);
 return async function syncFetch(url,options={}){
  const initialGeneration=generation;
  const request=()=>fetchImpl(url,{credentials:'same-origin',cache:'no-store',...options,signal:options.signal??AbortSignal.timeout(6000)});
  let response=await request();
  if(response.status!==401||(options.method??'GET')!=='GET'||!readPaths.has(url))return response;
  if(generation===initialGeneration){
   renewal??=(async()=>{
    const page=await fetchImpl('/sync/index.html',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(6000)});
    if(!page.ok)throw Error('Waiting for the local controller to restart');
    await page.arrayBuffer();generation++;
   })().finally(()=>{renewal=null;});
   await renewal;
  }
  response=await request();return response;
 };
}

export function syncPresentation(s){
 const problems=s.plugs.filter(p=>(p.state??(p.connected?'connected':'blocked'))==='blocked');
 const active=s.plugs.filter(p=>p.state==='active').length;
 const connected=s.plugs.filter(p=>p.connected).length;
 return {
  headline:s.active?'Movement in progress':s.working?'Controller working':problems.length?'Attention needed':s.connected?'Connected · idle':'Connect the arm',
  count:`${connected} / ${s.plugs.length}${active?` · ${active} active`:''}`,
  summary:problems.map(p=>p.label.toLowerCase()).join(' · ')||(s.working?'Live feedback continues during movement. Checks marked ACTIVE resume when idle.':'Live services connected. Movement sessions are admitted only when requested.')
 };
}

// A timed-out reader must never update a later frame or restart image decoding.
export function decodeCameraFrame(img,blob,{Reader=globalThis.FileReader,timeoutMs=3000}={}){
 return new Promise((resolve,reject)=>{
  const reader=new Reader();let settled=false;
  const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);reader.onload=reader.onerror=reader.onabort=null;img.onload=img.onerror=null;if(error){if(reader.readyState===1)reader.abort();reject(error);}else resolve();};
  const timer=setTimeout(()=>finish(Error('Camera decode timed out')),timeoutMs);
  reader.onload=()=>{if(settled)return;img.onload=()=>finish();img.onerror=()=>finish(Error('Camera decode failed'));img.src=reader.result;};
  reader.onerror=()=>finish(Error('Camera read failed'));reader.onabort=()=>finish(Error('Camera read cancelled'));
  try{reader.readAsDataURL(blob);}catch(error){finish(error);}
 });
}
