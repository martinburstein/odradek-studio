#!/usr/bin/env node
import {normalizeManualMove,MANUAL_CONFIRMATIONS} from '../src/manual-joints.mjs';
// Fixed API client for the Luna movement operator. Never opens a serial transport.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {dynamicMove,dynamicMoves} from '../src/dynamic-moves.mjs';
import {rehearseDynamicMove,rehearseDynamicSuite} from './dynamic-moves-rehearsal.mjs';
import {runWaveNow} from './wave-now-client.mjs';
import {runPilotConsole} from './pilot-client.mjs';
import {runObservedManualSession,runVisualReturnSession,validateVisualReturnModel,releaseManualOwnership} from './manual-observation-client.mjs';
import {createManualPerception} from './manual-perception-client.mjs';
import {readPilotCameraProof} from './prepare-wave-now.mjs';
import {readRoutineMotionConsent,revokeRoutineMotionConsent} from '../src/routine-motion-consent.mjs';
import {createInterface} from 'node:readline';
import {normalizeMove,readMotionConfig} from '../src/motion-config.mjs';
import {namedAction,namedActions,supervisedConfirmations,coordinatedWaveRequest} from './movement-actions.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [action,file,flag,supervised]=process.argv.slice(2),url='http://127.0.0.1:8787';
const visualReturnMode=supervised==='--visual-return',perceptionMode=supervised==='--perception'||visualReturnMode,observedMode=supervised==='--observed'||perceptionMode;
let token,consentStopError,owned=false;const owner='movement-operator';
async function api(route,body){
 const response=await fetch(url+'/api/'+route,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(route==='movement/execute'?270000:60000)});
 const value=await response.json();if(!response.ok||value.error)throw Error(value.error??'API request failed');return value;
}
try{
 const dynamicNamed=dynamicMoves().some(m=>m.name===file),coordinatedNamed=file==='two-joint-wave';
 if(!['pilot','actions','rehearse','status','check','run','stop','reconcile','rebaseline','reset-recover'].includes(action)||process.argv.length>6)throw Error('Usage: node tools/movement.mjs pilot | actions | rehearse name-or-all | status | check request.json-or-name | run request.json-or-name --execute [--supervised|--observed|--perception|--visual-return] | reconcile/rebaseline/reset-recover inspection.json --confirm | stop');
 if(supervised&&!observedMode&&(action!=='run'||!(['wave','wave-now'].includes(file)||dynamicNamed||coordinatedNamed)||supervised!=='--supervised'))throw Error('--supervised is only valid for a named run');
 if(observedMode&&(action!=='run'||['wave','wave-now','reference-return'].includes(file)||dynamicNamed||coordinatedNamed))throw Error('--observed requires an explicit qualified manual request');
 if(['pilot','actions','status','stop'].includes(action)&&(file||flag))throw Error('This action takes no arguments');
 if(action==='actions'){console.log(JSON.stringify([...namedActions(),{name:'two-joint-wave',description:'Three coordinated base-and-elbow legs centered on the current measured pose; base offsets -8/+8/0 degrees, elbow -6/+6/0 degrees. Existing limits and settling apply.',requiresFreshPose:true,requiresQualifiedManualProfile:true}],null,2));process.exit(0);}
 if(action==='rehearse'){
  if(!file||flag||supervised)throw Error('Rehearse requires a routine name or all, without flags');
  console.log(JSON.stringify(file==='all'?await rehearseDynamicSuite():await rehearseDynamicMove(file),null,2));
  process.exit(0);
 }
 if(action==='stop')try{await revokeRoutineMotionConsent(path.join(root,'runtime'));}catch(error){consentStopError=error;}
 token=JSON.parse(await fs.readFile(path.join(root,'runtime/access.json'),'utf8')).token;
 if(action==='pilot')await runPilotConsole({api,readCamera:context=>readPilotCameraProof({runtime:path.join(root,'runtime'),...context})});
 else if(action==='stop'){console.log(JSON.stringify(await api('stop',{})));if(consentStopError)throw Error('Software stop requested; local consent revocation failed: '+consentStopError.message);}
 else if(action==='status'){const s=await api('status'),r=s.movement?.result;console.log(JSON.stringify({mode:s.mode,connected:s.connected,armed:s.armed,owner:s.owner,movement:{active:s.movement?.active,session:s.movement?.session,historyReady:s.movement?.historyReady,unresolved:s.movement?.unresolved,historyError:s.movement?.historyError,last:r?{id:r.id,state:r.state,outcome:r.result?.outcome,reconciled:!!r.reconciliation,recovered:!!r.poseRecovery,cleanupVerified:r.result?.cleanupVerified}:null},execution:s.execution,measured:s.measured,simulated:s.simulated},null,2));}
 else if(action==='run'&&(dynamicNamed||file==='reference-return')&&(await api('status')).mode!=='simulator'){
  if(flag!=='--execute')throw Error('Run requires --execute; hardware admission still requires actual private commissioning and human consent');
  const commandId=randomUUID();await api('pilot/command',{commandId,line:'PERFORM '+file});
  const deadline=Date.now()+360000;let lastPhase=null;
  while(Date.now()<deadline){
   const job=(await api('pilot/state')).hardwareJob;
   if(!job||job.id!==commandId)throw Error('Hardware Pilot command identity changed');
   if(job.phase!==lastPhase){console.log(JSON.stringify({event:job.phase,commandId,predecessorId:job.predecessorId??null}));lastPhase=job.phase;}
   if(job.phase==='complete'){console.log(JSON.stringify(job.result));break;}
   if(['failed','cancelled'].includes(job.phase))throw Error(job.error??'Hardware Pilot cancelled');
   await delay(500);
  }
  if(Date.now()>=deadline){await api('stop',{});throw Error('Hardware Pilot finite client deadline reached');}
 }
 else if(file==='wave-now'&&['run','check'].includes(action)){
  if(action==='check'){if(flag)throw Error('Check takes no flags');const cfg=await readMotionConfig(path.join(root,'runtime'));console.log(JSON.stringify({action:'wave-now',review:cfg.finiteElbowGestureReview,physicalMovementVerified:false}));}
  else{if(flag!=='--execute')throw Error('Run requires --execute');await runWaveNow({api,readConfig:()=>readMotionConfig(path.join(root,'runtime')),...(supervised?{confirmations:supervisedConfirmations(supervised)}:{readConsent:()=>readRoutineMotionConsent(path.join(root,'runtime'))}),emit:value=>console.log(JSON.stringify(value)),waitForContinue:deadline=>new Promise((resolve,reject)=>{let settled=false;const reader=createInterface({input:process.stdin}),timer=setTimeout(()=>{reader.close();reject(Error('Camera continuation window expired'));},Math.max(1,Date.parse(deadline)-Date.now()));reader.once('line',line=>{settled=true;clearTimeout(timer);reader.close();if(line.trim()==='continue')resolve();else reject(Error('Invalid camera continuation'));});reader.once('close',()=>{if(settled)return;clearTimeout(timer);reject(Error('Camera continuation input closed'));});})});}
 }
 else if(action==='reconcile'||action==='rebaseline'||action==='reset-recover'){
  if(flag!=='--confirm')throw Error('Recovery requires --confirm and current physical inspection');
  const request=JSON.parse(await fs.readFile(path.resolve(file),'utf8'));
  const allowed=action==='reset-recover'?['commandId','originalRowSHA256','inspection','operatorAssertedReset','note']:['commandId','originalRowSHA256','inspection','note'];
  if(!request||Object.keys(request).some(k=>!allowed.includes(k)))throw Error('Unexpected recovery fields');
  const state=await api('status');if(state.mode!=='serial'||!state.connected||state.armed||state.commissioned||state.owner||state.movement.active||state.movement.session)throw Error('Idle, connected, disarmed, uncommissioned, unowned serial setup required');
  await api('owner',{owner});owned=true;
  console.log(JSON.stringify(await api('movement/'+action,{...request,owner}),null,2));
 }
 else{
  const named=file==='wave'||dynamicNamed||coordinatedNamed;
  const rhythm=dynamicNamed?dynamicMove(file).pausesMs:null;
  const initialState=await api('status'),currentConfig=initialState.mode==='simulator'?{}:await readMotionConfig(path.join(root,'runtime'));
  if(coordinatedNamed&&(!currentConfig.manualReview||currentConfig.profile.phase!=='qualified'))throw Error('Two-joint wave requires the qualified manual Controller profile');
  const request=coordinatedNamed?coordinatedWaveRequest(initialState.measured):named?namedAction(file):JSON.parse(await fs.readFile(path.resolve(file),'utf8'));
  if(!request||!Array.isArray(request.moves)||request.moves.length<1||Object.keys(request).some(k=>!['moves','seconds','confirmations','inspection',...(visualReturnMode?['visualReturn']:[])].includes(k)))throw Error('Request needs an explicit nonempty move list, optional seconds and physical confirmations');
  const moves=request.moves.map(currentConfig.manualReview?v=>normalizeManualMove(v,{allowShoulder:currentConfig.manualReview.stylusTraining?.shoulderCoordination===true}):normalizeMove);if(!currentConfig.manualReview&&moves.length>10)throw Error('Legacy session permits at most 10 moves');if(action==='run'&&flag!=='--execute')throw Error('Run requires --execute; check is read-only planning');
  if(observedMode&&(!currentConfig.manualReview||currentConfig.profile.phase!=='qualified'))throw Error('Observed steps require the qualified manual Controller profile');
  if(visualReturnMode)validateVisualReturnModel(moves,request.visualReturn);
  if(action==='check'&&flag)throw Error('Check does not accept execution flags');
  const state=await api('status');if(!state.connected||state.armed||state.commissioned||state.owner)throw Error('Connected, disarmed, uncommissioned, unowned setup required');
  if(named&&action==='run'&&state.mode!=='simulator'){if(coordinatedNamed){if(supervised!=='--supervised')throw Error('Two-joint wave requires --supervised after current human setup confirmation');request.confirmations=Object.fromEntries(MANUAL_CONFIRMATIONS.map(k=>[k,true]));}else request.confirmations=supervisedConfirmations(supervised);}
  await api('owner',{owner});owned=true;
  if(action==='check')console.log(JSON.stringify({firstPreview:await api('movement/preview',{owner,move:moves[0]}),moves,note:'Only the first move is previewed from the current pose. Every subsequent move is planned and checked from fresh feedback before dispatch.'},null,2));
  else{
   const begun=await api('movement/session',{owner,moves,seconds:request.seconds??300,...(request.confirmations?{confirmations:request.confirmations}:{}),...(request.inspection?{inspection:request.inspection}:{})});
   console.log(JSON.stringify({event:'admitted',admittedAt:new Date().toISOString(),sessionId:begun.session.id,mode:begun.session.mode,steps:moves.length,expiresAt:begun.session.expiresAt,physicalMovementVerified:false}));
   if(visualReturnMode)await runVisualReturnSession({api,session:begun.session,moves,owner,model:request.visualReturn,confirmations:request.confirmations,inspection:request.inspection,initialPredecessorId:state.movement?.result?.id??null});
   else if(observedMode)await runObservedManualSession({api,session:begun.session,moves,owner,initialPredecessorId:state.movement?.result?.id??null,perceptionFactory:createManualPerception,pauseForInspection:!perceptionMode});
   else for(let index=0;index<moves.length;index++){
    const r=await api('movement/execute',{owner,sessionId:begun.session.id,index,commandId:randomUUID()});
    console.log(JSON.stringify({id:r.id,index:r.index,move:r.move,state:r.state,outcome:r.result.outcome,observed:r.result.observed,completion:r.result.completion??null,cleanupVerified:r.result.cleanupVerified,physicalMovementVerified:false}));
    if(r.state!=='complete'||r.result.cleanupVerified!==true)throw Error('Routine ended at an incomplete leg');
    if(index<moves.length-1&&rhythm?.[index])await delay(rhythm[index]);
   }
  }
 }
}catch(error){console.error(String(error.message).split(token??'UNSET_TOKEN').join('[redacted]'));process.exitCode=1;}
finally{if(owned)try{if(observedMode)await releaseManualOwnership({api,owner});else await api('release',{owner});}catch{process.exitCode=1;console.error('Ownership cleanup failed; stop and inspect status before continuing.');}}
