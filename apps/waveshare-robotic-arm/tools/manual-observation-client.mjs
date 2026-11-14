import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {createManualPerception} from './manual-perception-client.mjs';
import {MANUAL_TOLERANCE,normalizeManualMove,manualEndpointToleranceRad} from '../src/manual-joints.mjs';
import {SERVO_STEP} from '../src/z-lift-actuators.mjs';

// Optional observation boundary for the fixed movement client. This does not
// grant movement authority, inspect images, or replace any Controller check.
// Input contains the lead's actual camera-inspection decision, never images.
const proofKeys=['decision','frameSequence','index','observedAt','predecessorId','viewClear'];
export async function releaseManualOwnership({api,owner}){
 try{return await api('release',{owner});}
 catch(releaseError){
  // STOP can already have drained execution and released both ownership layers.
  // Verify that terminal state instead of misreporting a second release failure.
  const state=await api('status'),execution=state?.execution;
  if(state?.armed!==false||state?.commissioned!==false||state?.owner!==null||state?.task?.active!==false||state?.ownership?.active!==false||state?.ownership?.cleanupPending!==false||state?.movement?.active!==false||state?.movement?.session!==null||execution?.busy!==false||execution?.lifecycle!==null||execution?.cleanupPending!==false||execution?.outstandingTransportOperations!==0||execution?.recoveryRequired!==false)throw releaseError;
  return {alreadyReleased:true,cleanupVerified:true,physicalStopVerified:false};
 }
}
export function validateObservationDecision(value,{index,predecessorId,after,expires,lastSequence,final=false,now=Date.now()}){
 if(!Number.isFinite(expires)||now>=expires)throw Error('Camera observation deadline expired');
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==proofKeys.join(',')||value.index!==index||value.predecessorId!==predecessorId||value.decision!==(final?'finish':'continue')||value.viewClear!==true||!Number.isSafeInteger(value.frameSequence)||value.frameSequence<=lastSequence)throw Error('Observation must match the current step and show a clear view');
 const at=Date.parse(value.observedAt);
 if(!Number.isFinite(at)||at<after||at>now||now-at>60000)throw Error('A fresh camera inspection after the last result is required');
 return {...value};
}

export async function runObservedManualSession({api,session,moves,owner,initialPredecessorId=null,input=process.stdin,emit=value=>console.log(JSON.stringify(value)),now=Date.now,observationTimeoutMs=60000,perceptionFactory=null,pauseForInspection=true,signal=null,beforeExecute=null}={}){
 const until=Date.parse(session?.expiresAt);
 if(typeof api!=='function'||!session?.id||!Array.isArray(moves)||!moves.length||typeof owner!=='string'||!Number.isFinite(until)||until<=now()||!Number.isInteger(observationTimeoutMs)||observationTimeoutMs<1||observationTimeoutMs>60000)throw Error('Finite admitted manual session required');
 if(typeof pauseForInspection!=='boolean'||(!pauseForInspection&&typeof perceptionFactory!=='function'))throw Error('Local perception requires a camera measurement client');
 const reader=createInterface({input,crlfDelay:Infinity});
 let finished=false,cancelled=false,pending=null,stopPromise=null,lastSequence=0,predecessorId=initialPredecessorId;
 const receipts=[],observations=[],cameraComparisons=[];let perception=null,previousComparison=null,previousComparisonAt=null;
 function requestStop(reason){
  cancelled=true;
  if(pending){const waiting=pending;pending=null;clearTimeout(waiting.timer);waiting.reject(Error(reason));}
  if(!stopPromise)stopPromise=Promise.resolve().then(()=>api('stop',{})).then(result=>emit({event:'observation-stop',reason,result}),error=>{emit({event:'observation-stop-error',error:error.message});throw error;});
  // Keep the rejection observed while a pending execute returns; finally awaits it.
  void stopPromise.catch(()=>{});
  return stopPromise;
 }
 reader.on('line',line=>{
  if(finished)return;
  if(line.trim().toUpperCase()==='STOP'){void requestStop('Lead requested stop');return;}
  if(!pending){emit({event:'observation-input-discarded',reason:'No observation is awaiting input; decisions are never queued'});return;}
  const waiting=pending;let value;
  try{value=validateObservationDecision(JSON.parse(line),{...waiting.context,now:now()});}
  catch(error){void requestStop(error.message);return;}
  pending=null;clearTimeout(waiting.timer);waiting.resolve({value,expires:waiting.context.expires});
 });
 reader.on('close',()=>{if(!finished)void requestStop('Observation input closed');});
 const deadline=setTimeout(()=>{if(!finished)void requestStop('Observed session deadline expired');},Math.max(1,until-now()));
 const onAbort=()=>{void requestStop('Observed session cancelled');};
 if(signal){signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();}
 function inspect(index,final=false){
  if(cancelled)throw Error('Observed session was cancelled');
  const after=now(),expires=Math.min(after+observationTimeoutMs,until-(final?0:21000));
  if(expires<=after)throw Error('Insufficient session time for another observed step');
  return new Promise((resolve,reject)=>{
   const context={index,predecessorId,after,expires,lastSequence,final};
   const timer=setTimeout(()=>{void requestStop('Camera observation deadline expired');},expires-after);
   pending={resolve,reject,timer,context};
   emit({event:'awaiting-observation',phase:final?'after-final-action':'before-action',index,predecessorId,nextMove:final?null:moves[index],deadlineAt:new Date(expires).toISOString(),requiredDecision:final?'finish':'continue',cameraImagesSaved:false});
  });
 }
 try{
  if(cancelled)throw Error('Observed session cancelled before camera startup');
  if(perceptionFactory)perception=await perceptionFactory({expiresAt:session.expiresAt});
  for(let index=0;index<moves.length;index++){
   const {value:observation,expires}=pauseForInspection?await inspect(index):{value:null,expires:until};
   if(cancelled||now()>=until-21000||now()>=expires)throw Error('Observed session cancelled or expired before dispatch');
   if(observation){observations.push(observation);lastSequence=observation.frameSequence;}
   else emit({event:'perception-action-start',index,move:moves[index],leadInspectionRequested:false});
   const previousFrameAt=Date.parse(previousComparison?.current?.frameReceivedAt),reuseEndpoint=!pauseForInspection&&previousComparison?.referenceAdvanced===true&&Number.isFinite(previousFrameAt)&&now()>=previousFrameAt&&now()-previousFrameAt<=1000;
   const cameraReference=perception?(reuseEndpoint?{imagesSaved:false,reference:previousComparison.current}:await perception.reference()):null;
   if(cancelled||now()>=until-21000||now()>=expires)throw Error('Observed session cancelled or expired during camera reference');
   if(perception&&(cameraReference?.imagesSaved!==false||!Number.isSafeInteger(cameraReference?.reference?.sequence)||cameraReference.reference.sequence<=0||!Number.isFinite(Date.parse(cameraReference.reference.frameReceivedAt))||Date.parse(cameraReference.reference.frameReceivedAt)>now()||now()-Date.parse(cameraReference.reference.frameReceivedAt)>1000||(observation&&(cameraReference.reference.sequence<observation.frameSequence||Date.parse(cameraReference.reference.frameReceivedAt)<Date.parse(observation.observedAt)))))throw Error('Camera reference does not match the current frame sequence and time');
   if(beforeExecute)await beforeExecute({index,cameraReference});
   if(cancelled||now()>=until-21000||now()>=expires)throw Error('Observed session cancelled or expired before dispatch');
   if(cameraReference&&now()-Date.parse(cameraReference.reference.frameReceivedAt)>1000)throw Error('Camera reference aged during pre-execution work');
   const executeRequestedAt=now(),previousComparisonToExecuteRequestMs=previousComparisonAt===null?null:executeRequestedAt-previousComparisonAt;
   const row=await api('movement/execute',{owner,sessionId:session.id,index,commandId:randomUUID()});
   const executeResponseReceivedAt=now();
   if(cancelled)throw Error('Observed session stopped during execution');
   if(row?.state!=='complete'||row.result?.cleanupVerified!==true||row.result.requiresReconciliation===true||row.result.outcome!=='manual-coarse-response')throw Error('Observed sequence ended at an incomplete leg');
   if(typeof row.id!=='string'||!row.id)throw Error('Completed leg has no receipt identity');
   receipts.push(row.id);predecessorId=row.id;
   const comparisonRequestedAt=now(),cameraComparison=perception?await perception.compare():null;
   if(cancelled)throw Error('Observed session stopped during camera comparison');
   if(perception&&(cameraComparison?.imagesSaved!==false||cameraComparison?.reference?.sequence!==cameraReference.reference.sequence||cameraComparison?.reference?.frameReceivedAt!==cameraReference.reference.frameReceivedAt||!Number.isSafeInteger(cameraComparison?.current?.sequence)||cameraComparison.current.sequence<=cameraReference.reference.sequence||!Number.isFinite(Date.parse(row.finishedAt))||!Number.isFinite(Date.parse(cameraComparison.current.frameReceivedAt))||Date.parse(cameraComparison.current.frameReceivedAt)<Date.parse(row.finishedAt)||Date.parse(cameraComparison.current.frameReceivedAt)>now()||!Number.isFinite(cameraComparison.frameIntervalMs)||cameraComparison.frameIntervalMs<=0||cameraComparison.frameIntervalMs>300000))throw Error('Camera comparison is not bound to this completed action and reference');
   const comparisonReceivedAt=now(),finishedAt=Date.parse(row.finishedAt),clientTiming={executeRequestedAt:new Date(executeRequestedAt).toISOString(),executeResponseReceivedAt:new Date(executeResponseReceivedAt).toISOString(),comparisonRequestedAt:new Date(comparisonRequestedAt).toISOString(),comparisonReceivedAt:new Date(comparisonReceivedAt).toISOString(),executeRoundTripMs:executeResponseReceivedAt-executeRequestedAt,finishToResponseMs:Number.isFinite(finishedAt)?executeResponseReceivedAt-finishedAt:null,cameraComparisonMs:perception?comparisonReceivedAt-comparisonRequestedAt:null,previousComparisonToExecuteRequestMs,reusedEndpointReference:reuseEndpoint};
   if(cameraComparison)cameraComparisons.push({index,receiptId:row.id,reference:cameraReference,cameraComparison,clientTiming});
   previousComparison=cameraComparison;previousComparisonAt=comparisonReceivedAt;
   emit({event:'observed-leg-complete',index,id:row.id,move:row.move,outcome:row.result.outcome,observed:row.result.observed,residualDegrees:row.result.residualDegrees,timing:row.result.timing,clientTiming,cleanupVerified:true,cameraComparison,physicalMovementVerified:false});
  }
  if(pauseForInspection){
   const {value:finalObservation,expires}=await inspect(moves.length,true);
   if(cancelled||now()>=until||now()>=expires)throw Error('Observed session cancelled or expired before final inspection');
   observations.push(finalObservation);
  }
  if(perception)await perception.close();
  if(cancelled||now()>=until)throw Error('Observed session cancelled or expired during camera cleanup');
  finished=true;
  const result={event:pauseForInspection?'observed-sequence-complete':'perception-sequence-complete',receiptIds:receipts,observations,cameraComparisons,leadInspectionsRequested:pauseForInspection,cameraImagesSaved:false,physicalMovementVerified:false};emit(result);return result;
 }catch(error){await requestStop(error.message).catch(()=>{});throw error;}
 finally{finished=true;clearTimeout(deadline);signal?.removeEventListener('abort',onAbort);if(pending){clearTimeout(pending.timer);pending=null;}reader.close();try{if(stopPromise)await stopPromise;}finally{if(perception)await perception.close();}}
}

// A task-specific image return. Every selected target still receives ordinary
// fresh Controller admission. This selects at most one corrective elbow move.
export function validateVisualReturnModel(moves,value){
 const keys=['acceptableImageErrorPixels','endpointBiasDegrees','pixelResponsePerDegree','targetRangeDegrees'];
 if(!Array.isArray(moves)||moves.length!==1||normalizeManualMove(moves[0]).joint!=='elbow')throw Error('Visual return begins with one explicit elbow move');
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).filter(k=>k!=='trackingMethod').sort().join(',')!==keys.join(','))throw Error('Explicit visual return response model required');
 if(value.trackingMethod!==undefined&&!['median','affine'].includes(value.trackingMethod))throw Error('Unknown visual return tracking method');
 const vector=value.pixelResponsePerDegree,range=value.targetRangeDegrees,bias=value.endpointBiasDegrees;
 if(!Array.isArray(vector)||vector.length!==2||!vector.every(Number.isFinite)||Math.hypot(...vector)<=0||!Array.isArray(range)||range.length!==2||!range.every(Number.isFinite)||range[0]>=range[1])throw Error('Finite image response and target interval required');
 for(const targetDegrees of range)normalizeManualMove({joint:'elbow',targetDegrees});
 if(moves[0].targetDegrees<range[0]||moves[0].targetDegrees>range[1])throw Error('Initial elbow target is outside the visual model interval');
 const endpointLimit=manualEndpointToleranceRad('elbow')*180/Math.PI;
 if(!bias||typeof bias!=='object'||Object.keys(bias).sort().join(',')!=='negative,positive'||!['negative','positive'].every(k=>Number.isFinite(bias[k])&&Math.abs(bias[k])<=endpointLimit))throw Error('Finite endpoint offsets within the existing elbow tolerance required');
 if(!Number.isFinite(value.acceptableImageErrorPixels)||value.acceptableImageErrorPixels<=0)throw Error('Positive image accuracy target required');
 return structuredClone(value);
}

function initialImageError(comparison,reference,now,trackingMethod='median'){
 const tracking=comparison?.initialTipTracking,currentAt=Date.parse(comparison?.current?.frameReceivedAt);
 if(comparison?.imagesSaved!==false||comparison?.initialReference?.sequence!==reference?.sequence||comparison.initialReference.frameReceivedAt!==reference.frameReceivedAt||!Number.isFinite(currentAt)||currentAt>now||now-currentAt>1000||tracking?.trackingValid!==true||!Number.isSafeInteger(tracking.armTracks)||tracking.armTracks<5||!Number.isSafeInteger(tracking.outsideTracks)||tracking.outsideTracks<5)throw Error('Fresh tracked image of the original visual reference required');
 let vector=[tracking.armResidualMedianDxPixels,tracking.armResidualMedianDyPixels];
 if(trackingMethod==='affine'){
  const fit=tracking.fixedAnchorTracking;
  if(fit?.valid!==true||fit.estimator!=='fixed-anchor-affine-v1'||!Number.isSafeInteger(fit.inliers)||fit.inliers<Math.max(6,Math.ceil(.65*tracking.armTracks))||fit.inliers>tracking.armTracks||!Number.isFinite(fit.fitRmsPixels)||fit.fitRmsPixels<0||fit.fitRmsPixels>.35||!Number.isFinite(fit.inlierSpatialCondition)||fit.inlierSpatialCondition<1||fit.inlierSpatialCondition>50||!Number.isFinite(fit.anchorOutsideHullPixels)||fit.anchorOutsideHullPixels<0||!Array.isArray(fit.displacementPixels)||fit.displacementPixels.length!==2)throw Error('Supported fixed-anchor image estimate required');
  vector=fit.displacementPixels;
 }
 if(!vector.every(Number.isFinite))throw Error('Visual return displacement is unknown');
 return {pixels:vector,magnitudePixels:Math.hypot(...vector),currentSequence:comparison.current.sequence,...(trackingMethod==='affine'?{trackingMethod,anchorKind:'virtual-reference-image-coordinate'}:{})};
}

export function selectVisualReturnTarget(model,currentDegrees,error){
 if(!Number.isFinite(currentDegrees)||!error?.pixels?.every(Number.isFinite)||error.pixels.length!==2||!Number.isFinite(error.magnitudePixels))throw Error('Finite measured pose and image displacement required');
 if(currentDegrees<model.targetRangeDegrees[0]||currentDegrees>model.targetRangeDegrees[1])throw Error('Measured elbow pose is outside the visual model interval');
 if(error.magnitudePixels<=model.acceptableImageErrorPixels)return {move:null,reason:'visual-reference-reached',imageError:error};
 const [x,y]=model.pixelResponsePerDegree,correctionDegrees=-(error.pixels[0]*x+error.pixels[1]*y)/(x*x+y*y);
 const desiredPhysicalDegrees=currentDegrees+correctionDegrees,bias=model.endpointBiasDegrees[correctionDegrees>=0?'positive':'negative'];
 const unconstrainedTargetDegrees=desiredPhysicalDegrees-bias,targetDegrees=Math.max(model.targetRangeDegrees[0],Math.min(model.targetRangeDegrees[1],unconstrainedTargetDegrees));
 const selection={move:null,imageError:error,estimatedCorrectionDegrees:correctionDegrees,desiredPhysicalDegrees,endpointBiasDegrees:bias,unconstrainedTargetDegrees,selectedTargetDegrees:targetDegrees,clamped:targetDegrees!==unconstrainedTargetDegrees};
 if((targetDegrees-currentDegrees)*correctionDegrees<=0||Math.abs(targetDegrees-currentDegrees)<2*SERVO_STEP*180/Math.PI)return {...selection,reason:'no-resolvable-return-within-requested-interval'};
 return {...selection,move:normalizeManualMove({joint:'elbow',targetDegrees}),reason:'image-error-selected-return'};
}

export async function runVisualReturnSession({api,session,moves,owner,model,confirmations,inspection,initialPredecessorId=null,input=process.stdin,emit=value=>console.log(JSON.stringify(value)),now=Date.now,perceptionFactory=createManualPerception}={}){
 model=validateVisualReturnModel(moves,model);
 const until=Date.parse(session?.expiresAt);
 if(!Number.isFinite(until)||until<=now()||typeof api!=='function'||typeof owner!=='string')throw Error('Finite admitted visual return session required');
 const abort=new AbortController(),reader=createInterface({input,crlfDelay:Infinity});
 let cancelled=false,finished=false,stopPromise=null,perception=null;
 function stop(reason){
  cancelled=true;
  if(!stopPromise)stopPromise=Promise.resolve().then(()=>api('stop',{})).then(result=>{emit({event:'visual-return-stop',reason,result});return result;});
  void stopPromise.catch(()=>{});abort.abort();return stopPromise;
 }
 reader.on('line',line=>{if(!finished&&line.trim().toUpperCase()==='STOP')void stop('Lead requested stop');});
 reader.on('close',()=>{if(!finished)void stop('Visual return input closed');});
 const timer=setTimeout(()=>{if(!finished)void stop('Visual return deadline expired');},Math.max(1,until-now()));
 const active=()=>{if(cancelled||now()>=until)throw Error('Visual return cancelled or expired');};
 const guardedApi=async(route,body)=>{if(route==='stop')return stop('Observed action stopped');active();return api(route,body);};
 async function phase(admitted,phaseMoves,predecessor,beforeExecute=null){
  const phaseInput=new PassThrough();
  try{return await runObservedManualSession({api:guardedApi,session:admitted,moves:phaseMoves,owner,initialPredecessorId:predecessor,input:phaseInput,emit,now,pauseForInspection:false,signal:abort.signal,beforeExecute,
   perceptionFactory:async()=>({reference:()=>perception.reference(),compare:()=>perception.compare(),close:async()=>{}})});}
  finally{phaseInput.destroy();}
 }
 function checkedState(state,receipt,heldStart,admittedSessionId=null){
  active();
  if(state?.owner!==owner||state?.armed!==false||state?.movement?.active!==false||(admittedSessionId?state?.movement?.session?.id!==admittedSessionId:state?.movement?.session!==null)||state?.movement?.result?.id!==receipt||state.execution?.busy!==false||state.execution?.cleanupPending!==false||state.execution?.recoveryRequired!==false||state.execution?.outstandingTransportOperations!==0)throw Error('Completed idle predecessor required for visual return');
  const row=state.movement.result,pose=state.measured,at=Date.parse(pose?.observedAt);
  if(row.state!=='complete'||row.result?.cleanupVerified!==true||row.result?.requiresReconciliation!==false||pose?.source!=='hardware'||!Number.isFinite(at)||at>now()||now()-at>1000)throw Error('Fresh completed measured elbow state required');
  for(const joint of ['base','shoulder','elbow','gripper']){
   if(!Number.isFinite(pose[joint])||!Number.isFinite(row.result.observed?.[joint])||Math.abs(pose[joint]-row.result.observed[joint])>MANUAL_TOLERANCE.settlingTicks*SERVO_STEP+1e-9)throw Error('Pose changed after visual measurement');
   if(joint!=='elbow'&&(!Number.isFinite(heldStart[joint])||Math.abs(pose[joint]-heldStart[joint])>MANUAL_TOLERANCE.heldTicks*SERVO_STEP+1e-9))throw Error('Held joints changed across visual return sessions');
  }
  return row;
 }
 try{
  const beginning=await guardedApi('status'),beginAt=Date.parse(beginning?.measured?.observedAt),beginDegrees=beginning?.measured?.elbow*180/Math.PI;
  if(beginning?.owner!==owner||beginning?.movement?.session?.id!==session.id||beginning?.measured?.source!=='hardware'||!Number.isFinite(beginAt)||beginAt>now()||now()-beginAt>1000||!Number.isFinite(beginDegrees)||beginDegrees<model.targetRangeDegrees[0]||beginDegrees>model.targetRangeDegrees[1])throw Error('Fresh starting elbow pose inside the visual model interval required');
  perception=await perceptionFactory({expiresAt:session.expiresAt,trackingMethod:model.trackingMethod??'median'});active();
  const first=await phase(session,moves,initialPredecessorId);active();
  const firstComparison=first.cameraComparisons.at(-1),reference=first.cameraComparisons[0]?.reference?.reference;
  const state=await guardedApi('status'),heldStart=state?.movement?.result?.plan?.start;
  if(!heldStart)throw Error('Original held-joint baseline required');
  const firstRow=checkedState(state,first.receiptIds.at(-1),heldStart);
  const error=initialImageError(firstComparison.cameraComparison,reference,now(),model.trackingMethod??'median');
  const selection=selectVisualReturnTarget(model,state.measured.elbow*180/Math.PI,error);
  emit({event:'visual-return-selection',predecessorId:firstRow.id,reference,selection});
  const receiptIds=[...first.receiptIds];let finalError=error;
  if(selection.move){
   active();const seconds=30;
   if(until-now()<seconds*1000)throw Error('Insufficient original session time for one visual return');
   const begun=await guardedApi('movement/session',{owner,moves:[selection.move],seconds,...(confirmations?{confirmations}:{}),...(inspection?{inspection}:{})});
   active();if(Date.parse(begun.session.expiresAt)>until)throw Error('Return admission exceeded the original deadline');
   emit({event:'visual-return-admitted',sessionId:begun.session.id,expiresAt:begun.session.expiresAt,move:selection.move});
   const returned=await phase(begun.session,[selection.move],firstRow.id,async({cameraReference})=>{
    const live=await guardedApi('status');checkedState(live,firstRow.id,heldStart,begun.session.id);
    const refreshedError=initialImageError({...cameraReference,current:cameraReference.reference},reference,now(),model.trackingMethod??'median');
    const refreshedSelection=selectVisualReturnTarget(model,live.measured.elbow*180/Math.PI,refreshedError);
    if(!refreshedSelection.move||Math.abs(refreshedSelection.move.targetDegrees-selection.move.targetDegrees)>SERVO_STEP*180/Math.PI+1e-9)throw Error('Fresh image no longer supports the admitted return target');
    emit({event:'visual-return-rechecked',reference,current:cameraReference.reference,imageError:refreshedError,admittedMove:selection.move,refreshedSelection});
   });active();receiptIds.push(...returned.receiptIds);
   const finalComparison=returned.cameraComparisons.at(-1);finalError=initialImageError(finalComparison.cameraComparison,reference,now(),model.trackingMethod??'median');
   checkedState(await guardedApi('status'),returned.receiptIds.at(-1),heldStart);
  }
  await perception.close();active();finished=true;
  const result={event:'visual-return-finished',receiptIds,selection,initialError:error,finalError,visualReferenceReached:finalError.magnitudePixels<=model.acceptableImageErrorPixels,acceptableImageErrorPixels:model.acceptableImageErrorPixels,correctionCount:selection.move?1:0,imagesSaved:false,physicalMovementVerified:false};
  emit(result);return result;
 }catch(error){const failure=error instanceof Error?error:Error('Visual return failed');await stop(failure.message).catch(()=>{});throw failure;}
 finally{finished=true;clearTimeout(timer);reader.close();try{if(stopPromise)await stopPromise;}finally{if(perception)await perception.close();}}
}
