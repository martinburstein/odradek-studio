import {JOINTS,degrees,displayBounds,poseOf,blockedReason,moveRequest} from './model.js';
const $=id=>document.getElementById(id), cards=new Map();
let state=null,online=false,busy=false,stopping=false,epoch=0,polling=false,lastInput=0,lastRenew=0,lastMode=null,lastRecovery=null,session=null,manualEnabled=false,restartOnly=false;
const owner='manual-console';
let sessionRenewal=null;
const sessionReads=new Set(['/api/session','/api/status','/api/manual/state']);
async function requestSession(){const r=await fetch('/api/session',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('Controller session unavailable');return r;}
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
async function api(path,body){
  const request=()=>fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(path==='/api/movement/execute'?270000:path==='/api/movement/rebaseline'?60000:path==='/api/movement/preview'?30000:body===undefined?5000:30000)});
  let response=await request();
  if(response.status===401&&body===undefined&&sessionReads.has(path)){
    sessionRenewal??=fetch('/manual/index.html',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(5000)}).then(async r=>{if(!r.ok)throw Error('Controller reconnecting');await r.arrayBuffer();}).finally(()=>{sessionRenewal=null;});
    await sessionRenewal;session=await (await requestSession()).json();response=await request();
  }
  const data=await response.json();if(!response.ok)throw Error(data.error||'Controller request failed.');return data;
}
async function refresh(){const next=await api('/api/status');next.manual=state?.manual;state=next;online=true;render();if(next.mode!=='simulator'&&!busy){next.manual=await api('/api/manual/state');render();}return state;}
function writable(){return session&&['admin','control'].includes(session.role);}
function render(){
  const sim=state?.mode==='simulator',pose=poseOf(state), age=Date.now()-Date.parse(state?.telemetryUpdatedAt),fresh=online&&state?.connected&&age>=0&&age<=5000;
  if(state?.connected&&lastMode!==state.mode){if(lastMode!==null)for(const card of cards.values())card.dirty=false;$('supervision').checked=false;lastMode=state.mode;}
  const enabled=sim?state?.armed:!document.hidden&&!restartOnly&&!blockedReason(state,Date.now(),true);
  const reason=!online?'Controller unavailable.':!writable()?'Observer access: movement disabled.':state?.connected&&!sim&&state?.movement?.historyReady===false?(state?.manual?.reason||'Movement held. Use Review & repair position.'):!sim&&document.hidden?'Manual page is hidden.':!sim&&restartOnly?'Only the prepared restart program is available.':blockedReason(state,Date.now(),!sim);
  $('mode').textContent=!online?'OFFLINE':sim?'SIMULATOR':state?.connected?'ROBOT / USB':'DISCONNECTED';
  $('mode-light').className='status-light'+(online&&state?.connected?(sim?' demo':' on'):'');
  const ownershipReason=!sim&&online&&state?.ownership?.active&&!state.ownership.ownedByThisDevice?'Another control session owns these controls.':null;
  $('readiness').textContent=busy?'Working…':ownershipReason||reason||(sim?'SIMULATED MOVES ENABLED':'TARGETS CHECKED ON MOVE');
  $('link-state').textContent=fresh?'FEEDBACK LIVE':'NO FRESH FEEDBACK';
  $('authority').textContent=online&&enabled?(sim?'SIMULATOR ENABLED':'DIRECT MANUAL'):'UNAVAILABLE';
  $('enable').textContent=enabled?'Disable moves':sim?'Enable moves':'Enable manual requests';
  $('enable').hidden=!sim;
  $('supervision-row').hidden=sim||!state?.manual?.recovery||Boolean(state?.manual?.recovery?.kind);
  if($('open-repair'))$('open-repair').hidden=sim||state?.movement?.historyReady!==false;
  const recovery=state?.manual?.recovery?.kind?null:state?.manual?.recovery;
  const recoveryIdentity=recovery?JSON.stringify(recovery):null;
  if(lastRecovery!==recoveryIdentity){$('recovery-inspection').checked=false;lastRecovery=recoveryIdentity;}
  $('recovery-inspection-text').textContent=recovery?.powerCycle?'I power-cycled the arm. It is now stationary and touching nothing, in the reviewed current pose. This check does not erase the earlier unknown result.':'The arm is stationary, touching nothing, with no unusual noise. I have not repositioned it by hand or reset its power since this move.';
  $('recovery').hidden=!recovery||sim;
  $('recover').disabled=!online||!writable()||busy||stopping||!state?.connected||!recovery||!$('supervision').checked||!$('recovery-inspection').checked||Boolean(state?.ownership?.active&&!state?.ownership?.ownedByThisDevice);
  $('enable').disabled=!online||!writable()||busy||stopping||!state?.connected||(sim&&!state?.commissioned)||(!sim&&(state?.movement?.historyReady!==true||state?.manual?.ready!==true))||Boolean(state?.ownership?.active&&!state?.ownership?.ownedByThisDevice)||(!sim&&!state?.armed&&!$('supervision').checked);
  $('demo').disabled=!online||!writable()||busy||stopping||state?.connected||Boolean(state?.ownership?.active);
  $('disconnect').disabled=!online||!writable()||busy||stopping||!state?.connected||Boolean(state?.ownership?.active&&!state?.ownership?.ownedByThisDevice);
  // Software stop remains available during requests and stale status.
  $('stop').disabled=stopping||!writable();
  const endpointLimits=state?.manual?.endpointToleranceDegrees;
  $('endpoint-policy').textContent=sim?'Simulator · each path is checked':endpointLimits?JOINTS.map(j=>`${j.name} ±${endpointLimits[j.key].toFixed(2)}°`).join(' · '):'Joint-specific endpoint limits · each path is checked';
  for(const j of JOINTS){
    const c=cards.get(j.key);let range;try{range=displayBounds(j.key,state);}catch{}
    c.el.querySelector('.range-caption').textContent=sim?'SIMULATOR WINDOW':'DOCUMENTED RANGE';
    c.current.textContent=fresh&&Number.isFinite(pose?.[j.key])?`${degrees(j.key,pose[j.key]).toFixed(1)}°`:'—';
    if(range){
      const [min,max]=range;c.min.textContent=`${min}°`;c.max.textContent=`${max}°`;
      for(const input of [c.angle,c.slider]){input.min=min;input.max=max;input.disabled=false;}
      c.minus.disabled=c.plus.disabled=false;
      // Follow live feedback until the user starts a draft. Polling must never
      // rewrite a focused field, including its native partial decimal buffer.
      if(fresh&&Number.isFinite(pose?.[j.key])&&!c.dirty&&document.activeElement!==c.angle&&document.activeElement!==c.slider){
        setTarget(c,Math.max(min,Math.min(max,degrees(j.key,pose[j.key]))).toFixed(1),{fromFeedback:true});
      }
    }
    c.move.disabled=Boolean(reason)||busy||stopping;
  }
}
function setTarget(c,value,{writeAngle=true,fromFeedback=false}={}){
  if(!fromFeedback){c.dirty=true;c.editRevision=(c.editRevision??0)+1;}
  // Preserve the browser editing buffer and caret for partial decimal/sign input.
  if(writeAngle)c.angle.value=value;
  const numeric=Number(value),valid=value!==''&&Number.isFinite(numeric);
  if(valid)c.slider.value=numeric;
  c.readout.replaceChildren(document.createTextNode(valid?numeric.toFixed(1):'—'),Object.assign(document.createElement('span'),{textContent:'°'}));
  const min=Number(c.angle.min),max=Number(c.angle.max),fraction=valid?(numeric-min)/(max-min):.5;
  c.dial.style.setProperty('--rotation',`${-135+270*Math.max(0,Math.min(1,fraction))}deg`);
}
async function perform(work){
  if(busy||stopping)return;busy=true;const ticket=epoch;render();
  const check=()=>{if(ticket!==epoch)throw Error('Action cancelled by Stop.');};
  const post=async(path,body)=>{check();const result=await api(path,body);check();return result;};
  try{await work(post,check);}catch(error){message(error.name==='TimeoutError'?'Request timed out. Outcome is unknown; check controller state before trying again.':error.message,true);}
  finally{busy=false;try{await refresh();}catch{online=false;render();}}
}
for(const [index,j] of JOINTS.entries()){
  const el=$('joint-template').content.firstElementChild.cloneNode(true);
  el.querySelector('h2').textContent=j.name;el.querySelector('.servo').textContent=j.servo;el.querySelector('.detail').textContent=j.detail;el.querySelector('.joint-number').textContent=`0${index+1}`;
  const c={el};for(const key of ['angle','slider','minus','plus','move','current','min','max','dial'])c[key]=el.querySelector(`.${key}`);c.readout=el.querySelector('.target-readout');
  c.angle.setAttribute('aria-label',`${j.name} target degrees`);c.slider.setAttribute('aria-label',`${j.name} angle slider`);c.minus.setAttribute('aria-label',`Decrease ${j.name.toLowerCase()} by 1 degree`);c.plus.setAttribute('aria-label',`Increase ${j.name.toLowerCase()} by 1 degree`);c.move.setAttribute('aria-label',`Move ${j.name.toLowerCase()}`);
  c.slider.addEventListener('input',()=>setTarget(c,c.slider.value));c.angle.addEventListener('input',()=>setTarget(c,c.angle.value,{writeAngle:false}));
  for(const [button,delta] of [[c.minus,-1],[c.plus,1]])button.addEventListener('click',()=>setTarget(c,Math.min(Number(c.angle.max),Math.max(Number(c.angle.min),Number(c.angle.value)+delta)).toFixed(1)));
  c.move.addEventListener('click',()=>{const value=c.angle.value,mode=state?.mode,editRevision=c.editRevision??0;void perform(async(post,check)=>{
    let latest=await refresh();check();if(latest.mode!==mode)throw Error('Connection changed. Select your target again.');
    if(latest.mode!=='simulator'){
      if(document.hidden||restartOnly)throw Error('Open the manual page before requesting a move.');
      const reason=blockedReason(latest,Date.now(),true);if(reason)throw Error(reason);
      if(!latest.ownership?.active)await post('/api/owner',{owner});
      latest=await refresh();check();
    }
    const request=moveRequest(latest,j.key,value);
    if(latest.mode!=='simulator'){
      // Admission and execution both check the path from fresh feedback. A
      // discarded preview adds another full calculation without displaying it.
      const begun=await post('/api/movement/session',{owner:request.owner,moves:[request.move],seconds:300,controlMode:'direct-manual'});
      if(document.hidden)throw Error('Manual page was hidden.');
      message(`${j.name}: observing the requested move�`);
      const row=await post('/api/movement/execute',{owner:request.owner,sessionId:begun.session.id,index:0,commandId:crypto.randomUUID()});
      if(row.state!=='complete'||row.result?.cleanupVerified!==true){manualEnabled=false;throw Error(row.result?.error||'Move incomplete. Inspect the recorded result before another move.');}
      if((c.editRevision??0)===editRevision)c.dirty=false;
      if(row.result.acceptedEndpoint){message(`Gripper: position accepted at measured ${degrees('gripper',row.result.observed.gripper).toFixed(2)}°. Current position accepted; ready for the next move.`);return;}
      message(`${j.name}: ${row.result.movementDetected===false?'within tolerance; no measurable joint motion. ':''}measured ${degrees(j.key,row.result.observed[j.key]).toFixed(2)}°; target difference ${row.result.residualDegrees.toFixed(2)}°. Settled response, not precision positioning.`,row.state!=='complete');return;
    }
    const result=await post('/api/move',request);
    if((c.editRevision??0)===editRevision)c.dirty=false;
    message(result.simulated?`${j.name}: simulated move sent to ${Number(value).toFixed(1)}°. No robot motion.`:`${j.name}: command sent. Check the robot and current feedback; delivery alone does not verify movement.`);
  });});
  cards.set(j.key,c);$('joints').append(el);
}
$('open-repair')?.addEventListener('click',()=>{window.parent.postMessage({studioRepair:true},'http://127.0.0.1:8790');});
$('setup-toggle').addEventListener('click',()=>{$('setup').hidden=!$('setup').hidden;$('setup-toggle').setAttribute('aria-expanded',String(!$('setup').hidden));});
$('supervision').addEventListener('change',()=>{if(!$('supervision').checked&&busy&&!stopping)$('stop').click();render();});
$('recovery-inspection').addEventListener('change',()=>{if(!$('recovery-inspection').checked&&busy&&!stopping)$('stop').click();render();});
$('recover').addEventListener('click',()=>void perform(async(post,check)=>{
  const recovery=state?.manual?.recovery,latest=await refresh();check();
  if(!recovery||JSON.stringify(latest.manual?.recovery)!==JSON.stringify(recovery)||!$('supervision').checked||!$('recovery-inspection').checked)throw Error('Confirm the current stationary inspection before recovering.');
  manualEnabled=false;if(!latest.ownership?.ownedByThisDevice)await post('/api/owner',{owner});
  if(!$('supervision').checked||!$('recovery-inspection').checked)throw Error('Inspection was withdrawn.');
  message('Checking the stationary arm for 30 seconds. No movement is being sent.');
  await post('/api/movement/rebaseline',{owner:latest.ownership?.ownedByThisDevice?latest.owner:owner,commandId:recovery.commandId,originalRowSHA256:recovery.originalRowSHA256,inspection:{baseSecured:true,tabletop600mmClear:true,stockArmEmptyClamp:true,cablesSlack:true,powerSwitchReady:true,stationary:true,noContact:true,...(recovery.powerCycle?{operatorAssertedPowerCycle:true}:{noUnusualNoise:true,noTouchResetPowerChange:true})},note:recovery.powerCycle?'Operator inspected the stationary arm after a reported power cycle; qualify this reviewed pose for the exact prepared small-wave session. The prior timeout outcome remains unknown.':'Operator inspected the stationary arm and unchanged setup; accept the measured position for a new manual target. Prior displacement cause remains unknown.'});
  restartOnly=Boolean(recovery.powerCycle);manualEnabled=!recovery.powerCycle;message(recovery.powerCycle?'Restarted position verified. Only the prepared small-wave session is available; no movement was sent. The earlier timeout remains recorded.':'Current position verified. Choose your next target and press Move. The previous move remains recorded.');
}));
$('demo').addEventListener('click',()=>void perform(async(post)=>{
  await post('/api/connect',{mode:'simulator'});
  await post('/api/commission',{variant:'simulator',firmware:'simulator',fixtureConfirmed:true,clearanceConfirmed:true,limitsConfirmed:true});
  message('Simulator connected. Press Enable moves to try the controls. No robot motion.');
}));
$('enable').addEventListener('click',()=>void perform(async(post,check)=>{
  const latest=await refresh();check();
  if(latest.mode!=='simulator'){
    const owns=latest.ownership?.active&&latest.ownership?.ownedByThisDevice;
    if(latest.ownership?.active&&!owns)throw Error('Another control session owns these controls.');
    if(manualEnabled&&owns){manualEnabled=false;await post('/api/stop',{});message('Manual requests disabled.');return;}
    manualEnabled=false;
    if(!$('supervision').checked)throw Error('Confirm current supervision before enabling manual requests.');
    if(latest.armed||latest.commissioned)throw Error('Disable legacy controls first.');
    if(!owns)await post('/api/owner',{owner});
    manualEnabled=true;message('Requests enabled. Each target must pass the installed calibration checks before it can move.');return;
  }
  if(latest.armed){await post('/api/arm',{armed:false,owner:latest.owner});message('Moves disabled.');return;}
  if(latest.mode!=='simulator'&&!$('supervision').checked)throw Error('Confirm current supervision before enabling robot moves.');
  if(!latest.connected||!latest.commissioned)throw Error('Complete setup first.');
  if(!latest.ownership?.ownedByThisDevice)await post('/api/owner',{owner});
  await post('/api/arm',{armed:true,owner:latest.ownership?.ownedByThisDevice?latest.owner:owner});
  message(latest.mode==='simulator'?'Simulator enabled. Select an angle, then press Move.':'Moves enabled. Select a small step, then press Move.');
}));
$('disconnect').addEventListener('click',()=>void perform(async(post)=>{await post('/api/disconnect',{});message('Disconnected. Moves disabled.');}));
$('stop').addEventListener('click',async()=>{
  if(stopping)return;manualEnabled=false;epoch++;stopping=true;$('supervision').checked=false;$('recovery-inspection').checked=false;render();
  try{const result=await api('/api/stop',{});message(result.message||'Software stop requested. Verify the robot has stopped.');}
  catch(error){message(`Stop not confirmed: ${error.message}. Use physical power cutoff if needed.`,true);}
  finally{stopping=false;try{await refresh();}catch{online=false;render();}}
});
for(const event of ['pointermove','wheel','pointerdown','keydown','input'])document.addEventListener(event,()=>{lastInput=Date.now();},{passive:true});
async function tick(){
  if(polling)return;polling=true;
  try{
    if(!session)session=await api('/api/session');
    await refresh();
    // Simulator keeps its existing enable flow. Physical Move clicks acquire on demand.
    // Renewal extends only an existing finite lease; never claim or move here.
    const activeUse=state?.mode==='simulator'&&Date.now()-lastInput<15000;
    if(!document.hidden&&!stopping&&activeUse&&Date.now()-lastRenew>10000&&state?.ownership?.ownedByThisDevice&&state.ownership.active){lastRenew=Date.now();await api('/api/renew',{owner:state.owner});}
  }catch(error){online=false;render();message(`Controller unavailable: ${error.message}`,true);}finally{polling=false;}
}
// Unedited targets follow live feedback. Hiding an active request still stops it.
document.addEventListener('visibilitychange',()=>{if(document.hidden&&busy&&!stopping)$('stop').click();render();});
void tick();setInterval(()=>void tick(),1000);
