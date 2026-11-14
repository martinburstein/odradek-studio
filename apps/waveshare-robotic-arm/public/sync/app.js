import {createSyncFetch,syncPresentation,decodeCameraFrame} from './client.js';
const syncFetch=createSyncFetch(),$=id=>document.getElementById(id);
let snapshot=null,checked=0,cameraAt=0,closed=false,inflight=false,setupGeneration=null,statusError=false;
const tiles=new Map();
async function api(route,body){const r=await syncFetch(route,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});const v=await r.json();if(!r.ok)throw Error(v.error||`HTTP ${r.status}`);return v;}
function render(s){
 snapshot=s;checked=Date.now();
 document.body.classList.remove('status-stale');if(statusError){$('message').textContent='';statusError=false;}
 for(const p of s.plugs){
  let tile=tiles.get(p.id);if(!tile){tile=document.createElement('div');tile.className='plug';tile.innerHTML='<div class="coupler" aria-hidden="true"><i class="socket"></i><i class="pin"></i></div><div><strong></strong><p></p></div>';tiles.set(p.id,tile);$('plugs').append(tile);}
  const state=p.state??(p.connected?'connected':'blocked');tile.classList.toggle('on',p.connected);tile.classList.toggle('active',state==='active');tile.classList.toggle('idle',state==='idle');tile.querySelector('strong').textContent=p.label+' / '+({connected:'CONNECTED',active:'ACTIVE',idle:'IDLE',blocked:'CHECK'}[state]??'CHECK');tile.querySelector('p').textContent=p.detail;
 }
 const presentation=syncPresentation(s);$('headline').textContent=presentation.headline;$('count').textContent=presentation.count;$('summary').textContent=presentation.summary;
 $('check-time').textContent='CHECKED '+new Date(s.checkedAt).toLocaleTimeString();
 $('connect').hidden=s.connected||!s.selectedPort;
 $('pose').replaceChildren();for(const [k,v]of Object.entries(s.ticks||{})){const el=document.createElement('span');el.textContent=`${k.toUpperCase()} `;const b=document.createElement('b');b.textContent=v+' ticks';el.append(b);$('pose').append(el);}if(!s.ticks)$('pose').textContent='Joint feedback unavailable';
 if(setupGeneration!==null&&setupGeneration!==`${s.instanceId??''}:${s.generation}`){setupGeneration=null;$('setup-form').reset();$('setup-state').textContent='Connection changed · inspect again';$('setup-note').textContent='Previous inspection cleared after the controller connection changed.';}
}
function offline(){document.body.classList.add('status-stale');$('headline').textContent='Reconnecting to controller';$('count').textContent='— / 10';$('summary').textContent='Status is stale · last known checks shown dimmed. Retrying automatically.';$('connect').hidden=true;}
async function refresh(){if(inflight||closed)return;inflight=true;try{render(await api('/api/sync'));}catch(e){offline();statusError=true;$('message').textContent=e.message;}finally{inflight=false;}}
async function loop(){await refresh();if(!closed)setTimeout(loop,2000);}
async function camera(){if(closed)return;const img=$('camera');try{const r=await syncFetch('/camera/frame');if(!r.ok)throw Error('Camera unavailable');const blob=await r.blob();await decodeCameraFrame(img,blob);cameraAt=Date.now();$('camera-empty').hidden=true;$('camera-status').textContent='LIVE · '+new Date(cameraAt).toLocaleTimeString();}catch{img.removeAttribute('src');$('camera-empty').hidden=false;$('camera-status').textContent='CAMERA OFFLINE';}if(!closed)setTimeout(camera,200);}
async function usage(){try{const v=await api('/api/sync/usage');const fresh=v.accountStatus==='connected'&&Number.isFinite(v.remaining)&&Date.now()-Date.parse(v.accountAt)>=0&&Date.now()-Date.parse(v.accountAt)<120000;$('tokens').textContent=Number.isSafeInteger(v.tokens)?v.tokens.toLocaleString():'—';$('allowance').textContent=fresh?Math.round(v.remaining)+'%':'—';$('allowance-label').textContent=(v.windowMinutes===10080?'WEEKLY':v.windowMinutes===300?'5-HOUR':'ACCOUNT')+' LEFT';$('usage-status').textContent=(v.tokenStatus==='connected'?'This chat':'Last reported chat usage')+' · '+(fresh?'account connected':'allowance unavailable');$('tokens').title=v.tokenAt?'Reported '+v.tokenAt:'No reported usage';}catch{$('tokens').textContent='—';$('allowance').textContent='—';$('usage-status').textContent='Usage unavailable';}if(!closed)setTimeout(usage,5000);}
setInterval(()=>{if(checked&&Date.now()-checked>7000)offline();if(cameraAt&&Date.now()-cameraAt>2500){$('camera').removeAttribute('src');$('camera-empty').hidden=false;$('camera-status').textContent='CAMERA STALE';}},500);
$('refresh').onclick=refresh;
$('connect').onclick=async()=>{const button=$('connect');button.disabled=true;try{await api('/api/connect',{mode:'serial',port:snapshot.selectedPort});$('message').textContent='Read-only connection established.';await refresh();}catch(e){$('message').textContent=e.message;}finally{button.disabled=false;}};
$('stop').onclick=async()=>{try{await api('/api/stop',{});$('message').textContent='Software stop requested. Physical stop is not verified.';await refresh();}catch(e){$('message').textContent='Stop request failed: '+e.message;}};
$('setup-form').onsubmit=e=>{e.preventDefault();if(!snapshot||Date.now()-checked>7000){$('setup-note').textContent='Wait for the controller connection before recording setup.';return;}setupGeneration=`${snapshot.instanceId??''}:${snapshot.generation}`;$('setup-state').textContent='Inspected '+new Date().toLocaleTimeString();$('setup-note').textContent='Inspection recorded in this window. No movement was requested.';};
// Timers survive BFCache restoration; resume them without replacing the document.
window.addEventListener('pageshow',()=>void refresh());void loop();void camera();void usage();
