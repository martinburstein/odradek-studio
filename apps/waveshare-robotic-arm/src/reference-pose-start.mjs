import {createHash} from 'node:crypto';
import {observedTicks,assertLiftHealth} from './z-lift-actuators.mjs';
import {assertCurrentWavePredecessor} from './current-wave-start.mjs';

export const REFERENCE_START_REVISION='reference-current-start-v1';
const JOINTS=Object.freeze(['base','shoulder','elbow','gripper']);
const START_TICK_REGION=Object.freeze({base:Object.freeze([2022,2054]),shoulder:Object.freeze([2052,2060]),elbow:Object.freeze([2048,2056]),gripper:Object.freeze([2045,2049])});
const MIN_SAMPLES=100,MAX_SAMPLES=300,MIN_DURATION_MS=30000,MAX_GAP_MS=500,MAX_FINAL_AGE_MS=60000,MAX_JOINT_DELTA_TICKS=16,MAX_FULL_SPAN_TICKS=1;
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const isUUID=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
const isoMs=value=>{if(typeof value!=='string')return NaN;const ms=Date.parse(value);return Number.isFinite(ms)&&new Date(ms).toISOString()===value?ms:NaN;};
function exactPose(value){return isObject(value)&&Object.keys(value).length===JOINTS.length&&JOINTS.every(key=>Object.hasOwn(value,key)&&Number.isFinite(value[key]));}
function validSourceVector(value){return isObject(value)&&Object.keys(value).length>0&&Object.values(value).every(isHash);}
function equalPose(a,b){return exactPose(a)&&exactPose(b)&&JOINTS.every(key=>a[key]===b[key]);}

/**
 * Validate a read-only, no-motion current-start proof against the latest
 * expired clean horizontal-wave predecessor. Returns a copy of the final
 * observed pose; it grants no movement or geometry authority.
 */
export function validateReferenceStart({proof,history,sourceHashes,consentId,configDigest,now=Date.now()}={}){
  if(!Number.isFinite(now)||!validSourceVector(sourceHashes)||!isUUID(consentId)||!isHash(configDigest))throw new Error('Current-start validation inputs are incomplete or malformed');
  const prior=assertCurrentWavePredecessor(history,now),priorFinishedAt=isoMs(prior.finishedAt),priorAuthorizationUntil=isoMs(prior.finiteElbowGesture.authorizationUntil);
  if(!Number.isFinite(priorFinishedAt)||!Number.isFinite(priorAuthorizationUntil)||priorAuthorizationUntil>=now)throw new Error('Latest horizontal-wave predecessor is not clean and strictly expired');
  if(!isObject(proof)||proof.revision!==REFERENCE_START_REVISION||proof.cause!=='unknown'||proof.noMotionCommandIssued!==true||!isUUID(proof.id)||!isUUID(proof.consentId)||proof.consentId!==consentId||proof.configDigest!==configDigest||!isHash(proof.configDigest)||proof.predecessorId!==prior.id||proof.predecessorRowSHA256!==sha(prior)||proof.historySHA256!==sha(history)||proof.sourceHashesSHA256!==sha(sourceHashes))throw new Error('Current-start proof does not bind the exact consent, source, config, history and predecessor');
  const samples=proof.observations;
  if(!Array.isArray(samples)||samples.length<MIN_SAMPLES||samples.length>MAX_SAMPLES||proof.observationCount!==samples.length)throw new Error('Current-start proof requires 100-300 distinct hardware observations');
  const times=[];let minTicks={base:Infinity,shoulder:Infinity,elbow:Infinity,gripper:Infinity},maxTicks={base:-Infinity,shoulder:-Infinity,elbow:-Infinity,gripper:-Infinity};
  for(let i=0;i<samples.length;i++){
    const sample=samples[i],at=isoMs(sample?.observedAt);
    if(sample?.source!=='hardware'||!Number.isFinite(at)||at>now||at<=priorFinishedAt||at<=priorAuthorizationUntil||!exactPose(sample.joints))throw new Error('Current-start observation is malformed, future, non-hardware or predates the expired predecessor');
    if(i&&(at<=times[i-1]||at-times[i-1]>MAX_GAP_MS))throw new Error('Current-start observations are not distinct and chronological within the 500 ms gap limit');
    let ticks;try{ticks=observedTicks(sample.joints);assertLiftHealth(sample.health);}catch{throw new Error('Current-start feedback is not exact integer telemetry or motor health is missing/unhealthy');}
    for(const joint of JOINTS){minTicks[joint]=Math.min(minTicks[joint],ticks[joint]);maxTicks[joint]=Math.max(maxTicks[joint],ticks[joint]);}
    times.push(at);
  }
  const firstAt=times[0],lastAt=times.at(-1),durationMs=lastAt-firstAt,last=samples.at(-1).joints;
  if(durationMs<MIN_DURATION_MS||proof.observationDurationMs!==durationMs||proof.issuedAt!==samples.at(-1).observedAt||lastAt>now||now-lastAt>MAX_FINAL_AGE_MS)throw new Error('Current-start proof duration, collection-end issue time or freshness is invalid');
  if(!equalPose(proof.expectedStart,last))throw new Error('Current-start expected pose does not exactly match the final observation');
  if(!isObject(proof.inspection)||!['stationary','noContact','cablesSlack','noUnusualNoise'].every(key=>proof.inspection[key]===true))throw new Error('Current-start inspection must affirm all four required observations');
  const currentTicks=observedTicks(last),priorTicks=observedTicks(prior.result.observed);
  for(const joint of JOINTS){
    const [lo,hi]=START_TICK_REGION[joint];
    if(currentTicks[joint]<lo||currentTicks[joint]>hi||Math.abs(currentTicks[joint]-priorTicks[joint])>MAX_JOINT_DELTA_TICKS)throw new Error(`Current-start ${joint} tick is outside the bounded start region or 16-tick predecessor delta`);
    if(maxTicks[joint]-minTicks[joint]>MAX_FULL_SPAN_TICKS)throw new Error(`Current-start ${joint} full-span drift exceeds one tick`);
  }
  return {...last};
}
