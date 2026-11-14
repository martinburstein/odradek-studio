const {ipcRenderer}=require('electron');
let serviceState={busy:false,message:'Ready. Only app-owned services are restarted; external Controller services are left running.'};
function renderServiceState(){const button=document.getElementById('lab-clean-restart'),status=document.getElementById('lab-restart-status');if(button)button.disabled=serviceState.busy;if(status){status.textContent=serviceState.message;status.classList.toggle('error',Boolean(serviceState.error));}}
ipcRenderer.on('odradek:service-state',(_event,state)=>{serviceState=state;renderServiceState();});
// Observe only the existing workspace selection so navigation within the dock
// (for example “Adjust in Manual”) keeps the surrounding simulation tabs in sync.
window.addEventListener('DOMContentLoaded',()=>{
 const live=document.getElementById('automatic-live');
 if(live&&!document.getElementById('lab-safety-actions')){
  const actions=document.createElement('section');actions.id='lab-safety-actions';actions.className='lab-restart-panel';actions.setAttribute('aria-label','Clean restart and recovery');
  actions.innerHTML=`<p class="eyebrow">RECOVERY / CLEAN RESTART</p><h2>Restore a clean connection.</h2><p class="small">Use the existing controls below when stopping, reconnecting or recovering after a crash.</p><div class="lab-restart-actions"><div><button id="lab-stop-arm" class="stop">■ Stop &amp; disarm</button><p>Request the existing software stop. Keep the physical power switch reachable.</p></div><div><button id="lab-repair-controller">Repair Controller</button><p>Restore the connection and review eligible interrupted, shortfall or aborted moves. The existing stationary inspection appears above.</p></div><div><button id="lab-clean-restart">Clean restart app services</button><p>Shut down app-owned services through their cleanup path, reopen them, then return to Safety Check. No move is retried.</p></div></div><p id="lab-restart-status" role="status" aria-live="polite"></p><p class="small">The Automatic checklist below is separate. A software restart does not record a physical inspection or power-cycle the arm.</p>`;
  live.prepend(actions);
  document.getElementById('lab-stop-arm').addEventListener('click',()=>document.getElementById('stop')?.click());
  document.getElementById('lab-repair-controller').addEventListener('click',()=>document.getElementById('repair-controller')?.click());
  document.getElementById('lab-clean-restart').addEventListener('click',event=>{if(event.isTrusted&&!serviceState.busy)ipcRenderer.send('odradek:service-restart');});
  renderServiceState();
 }
 let last;
 const report=()=>{
  const tab=['manual','automatic','presets','map'].find(name=>document.getElementById('tab-'+name)?.getAttribute('aria-selected')==='true');
  const liveMode=['sync','camera','safety'].includes(document.documentElement.dataset.labView)?document.documentElement.dataset.labView:'sync';
  const mode=tab==='automatic'?(document.getElementById('automatic-live')?.hidden?'automatic':liveMode):tab;
  if(mode&&mode!==last){last=mode;ipcRenderer.send('odradek:studio-tab',mode);}
 };
 new MutationObserver(report).observe(document.body,{attributes:true,subtree:true,attributeFilter:['hidden','aria-selected','aria-pressed']});report();
 const readouts=document.getElementById('lab-readouts');let pending=false;
 const preview=()=>{pending=false;if(document.getElementById('panel-automatic')?.hidden||!document.getElementById('automatic-live')?.hidden)return;const pose={};for(const box of readouts?.children??[])pose[box.dataset.joint]=Number.parseFloat(box.querySelector('strong')?.textContent);ipcRenderer.send('odradek:rehearsal',pose);};
 if(readouts){new MutationObserver(()=>{if(!pending){pending=true;requestAnimationFrame(preview);}}).observe(readouts,{childList:true,characterData:true,subtree:true});preview();}
});
