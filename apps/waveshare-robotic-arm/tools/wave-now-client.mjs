import {randomUUID} from 'node:crypto';
import {DRAMATIC_WAVE_SCOPE} from '../src/dramatic-wave.mjs';
import {SERVO_STEP} from '../src/z-lift-actuators.mjs';
const inspection={stationary:true,noContact:true,cablesSlack:true,noUnusualNoise:true};
function idle(s){if(s.mode!=='serial'||!s.connected||s.armed||s.commissioned||s.owner||s.movement?.active||s.movement?.session||s.execution?.busy||s.execution?.cleanupPending||s.execution?.recoveryRequired||s.execution?.outstandingTransportOperations||s.movement?.historyReady!==true||s.movement?.unresolved?.length)throw Error('Wave requires idle, connected, resolved, unowned serial Controller');}
function phase(cfg,ordinal,first,now){const r=cfg.finiteElbowGestureReview;if(cfg.profile?.finiteElbowGesture!==DRAMATIC_WAVE_SCOPE||r?.scope!==DRAMATIC_WAVE_SCOPE||r.ordinal!==ordinal||Date.parse(r.deadlineAt)-now<45000)throw Error('Current wave phase review and full execution reserve required');if(first&&(r.routineConsentId!==first.routineConsentId||r.authorizationId!==first.authorizationId||r.seriesId!==first.seriesId||r.actionWindowId!==first.actionWindowId||r.authorizationUntil!==first.authorizationUntil||r.authorizationIssuedAt!==first.authorizationIssuedAt||r.speedStepsPerSecond!==first.speedStepsPerSecond||JSON.stringify(r.gestureCompletion)!==JSON.stringify(first.gestureCompletion)||r.gestureCompletionSHA256!==first.gestureCompletionSHA256||JSON.stringify(r.sourceHashes)!==JSON.stringify(first.sourceHashes)))throw Error('Return review does not match first wave authorization and sources');return r;}
// One named action, two exclusive sessions. The lead supplies a new camera review
// before continuing; elapsed time never supplies the continuation signal.
export function assertStandingWaveReview(review,consent){
 if(!consent||review.routineConsentId!==consent.id||Date.parse(review.authorizationUntil)>Date.parse(consent.until))throw Error('Wave review does not bind current standing consent');
 const v=review.cameraObservation;
 if(v?.confirmedShowsArm!==true||v.fullSweepVisible!==true||v.visibleObstacles!==false)throw Error('Full sweep visible and no visible obstacles required');
}
export async function waitForStandingCameraReview({api,readConfig,readConsent,first,commandId,stopEpoch,now=Date.now,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 while(now()<Date.parse(first.deadlineAt)-45000){
  const consent=await readConsent();assertStandingWaveReview(first,consent);
  const status=await api('status');idle(status);
  if(status.execution?.stopEpoch!==stopEpoch)throw Error('Stop occurred while awaiting camera review');
  const cfg=await readConfig(),r=cfg.finiteElbowGestureReview;
  if(r?.ordinal===2){phase(cfg,2,first,now());assertStandingWaveReview(r,consent);if(r.predecessorId!==commandId)throw Error('Camera review must bind completed downstroke');return;}
  if(r?.oneShotId!==first.oneShotId)throw Error('Wave review changed while awaiting camera');
  await pause(250);
 }
 throw Error('Camera continuation window expired');
}
export async function runWaveNow({api,readConfig,confirmations,readConsent,waitForContinue,waitForCameraReview,emit=()=>{},now=Date.now}){
 const owner='movement-operator',receipts=[];let owned=false;
 try{
  const first=phase(await readConfig(),1,null,now());let stoppedAt=null;
  for(let ordinal=1;ordinal<=2;ordinal++){
   const status=await api('status');idle(status);
   if(ordinal===2&&status.execution?.stopEpoch!==stoppedAt)throw Error('Stop occurred while awaiting camera review');
   const r=phase(await readConfig(),ordinal,ordinal===2?first:null,now());
   if(readConsent){const consent=await readConsent();assertStandingWaveReview(r,consent);confirmations=consent.confirmations;}
   if(ordinal===2&&r.predecessorId!==receipts[0].id)throw Error('Return review must bind the actual completed downstroke');
   await api('owner',{owner});owned=true;
   const begun=await api('movement/session',{owner,seconds:90,moves:[{joint:'elbow',degrees:(r.desiredTick-r.startTick)*SERVO_STEP*180/Math.PI}],inspection,confirmations});
   emit({event:'wave-leg-admitted',ordinal,sessionId:begun.session.id,expiresAt:begun.session.expiresAt});
   const row=await api('movement/execute',{owner,sessionId:begun.session.id,index:0,commandId:randomUUID()});
   if(row.state!=='complete'||row.result?.outcome!=='telemetry-reached'||row.result?.cleanupVerified!==true||row.result?.requiresReconciliation!==false)throw Error('Wave leg did not complete cleanly; sequence stopped');
   receipts.push(row);emit({event:'wave-leg-complete',ordinal,id:row.id,observed:row.result.observed,physicalMovementVerified:false});
   await api('release',{owner});owned=false;
   if(ordinal===1){stoppedAt=(await api('status')).execution?.stopEpoch;emit({event:'awaiting-camera-review',commandId:row.id,authorizationId:first.authorizationId,seriesId:first.seriesId,deadlineAt:first.deadlineAt});if(readConsent)await (waitForCameraReview??waitForStandingCameraReview)({api,readConfig,readConsent,first,commandId:row.id,stopEpoch:stoppedAt,now});else await waitForContinue(first.deadlineAt);}
  }
  emit({event:'wave-complete',receiptIds:receipts.map(r=>r.id),physicalMovementVerified:false});return receipts;
 }catch(error){try{await api('stop',{});}catch{}throw error;}
 finally{if(owned)await api('release',{owner});}
}
