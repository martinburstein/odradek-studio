import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {DRAMATIC_WAVE_SCOPE} from './dramatic-wave.mjs';

export const ROUTINE_MOTION_CONSENT_MODE='supervised-standing-wave-consent-v1';
export const ROUTINE_MOTION_CONSENT_MAX_MS=60*60*1000;
export const ROUTINE_MOTION_CONSENT_FILENAME='routine-motion-consent.json';
export const ROUTINE_MOTION_CONFIRMATION_KEYS=Object.freeze(['baseSecured','sweep300mmClear','cablesSlack','jawsClear','powerSwitchReady']);
export const ROUTINE_MOTION_SCOPE_POLICY=Object.freeze({scope:DRAMATIC_WAVE_SCOPE,joint:'elbow',speedStepsPerSecond:Object.freeze([20,40]),acceleration:1,maxLegsPerReview:2,maxReviewWindowMs:300000,maxConsentMs:ROUTINE_MOTION_CONSENT_MAX_MS});
const policy=x=>!!x&&x.mode===ROUTINE_MOTION_CONSENT_MODE&&x.scope===DRAMATIC_WAVE_SCOPE&&x.userExplicitConsent===true&&x.joint==='elbow'&&Array.isArray(x.speedStepsPerSecond)&&x.speedStepsPerSecond.length===2&&x.speedStepsPerSecond[0]===20&&x.speedStepsPerSecond[1]===40&&x.acceleration===1&&x.maxLegsPerReview===2&&x.maxReviewWindowMs===300000&&x.maxConsentMs===ROUTINE_MOTION_CONSENT_MAX_MS;
const isUuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const validConfirmations=x=>!!x&&Object.keys(x).length===ROUTINE_MOTION_CONFIRMATION_KEYS.length&&ROUTINE_MOTION_CONFIRMATION_KEYS.every(k=>x[k]===true);
const millis=x=>Number.isFinite(Date.parse(x))?Date.parse(x):NaN;
const consentPath=directory=>path.join(directory,ROUTINE_MOTION_CONSENT_FILENAME);

export function createRoutineMotionConsent({now=Date.now(),sourceInstruction,confirmations,operatorAssertedReset=false,guardedElbowTrajectory=false}){
 if(typeof guardedElbowTrajectory!=='boolean')throw Error('Guarded trajectory opt-in must be explicit');
 if(typeof operatorAssertedReset!=='boolean')throw Error('Reset assertion must be an explicit boolean');
 if(!Number.isFinite(now)||typeof sourceInstruction!=='string'||sourceInstruction.trim().length<12||sourceInstruction.length>2000||!validConfirmations(confirmations))throw Error('Explicit user instruction and all five current physical setup confirmations are required');
 const consent={mode:ROUTINE_MOTION_CONSENT_MODE,scope:DRAMATIC_WAVE_SCOPE,userExplicitConsent:true,sourceInstruction:sourceInstruction.trim(),id:randomUUID(),issuedAt:new Date(now).toISOString(),until:new Date(now+ROUTINE_MOTION_CONSENT_MAX_MS).toISOString(),revokedAt:null,joint:ROUTINE_MOTION_SCOPE_POLICY.joint,speedStepsPerSecond:[...ROUTINE_MOTION_SCOPE_POLICY.speedStepsPerSecond],acceleration:ROUTINE_MOTION_SCOPE_POLICY.acceleration,maxLegsPerReview:ROUTINE_MOTION_SCOPE_POLICY.maxLegsPerReview,maxReviewWindowMs:ROUTINE_MOTION_SCOPE_POLICY.maxReviewWindowMs,maxConsentMs:ROUTINE_MOTION_SCOPE_POLICY.maxConsentMs,confirmations:{...confirmations}};
 if(operatorAssertedReset)consent.resetAssertion={operatorAssertedReset:true,sourceInstruction:consent.sourceInstruction,issuedAt:consent.issuedAt,consentId:consent.id};
 if(guardedElbowTrajectory)consent.guardedElbowTrajectory='guarded-elbow-quintic-v1';
 return consent;
}

export function validateRoutineMotionConsent(consent,{now=Date.now()}={}){
 const issued=millis(consent?.issuedAt),until=millis(consent?.until);
 if(!Number.isFinite(now)||!policy(consent)||!isUuid(consent.id)||typeof consent.sourceInstruction!=='string'||consent.sourceInstruction.trim().length<12||!validConfirmations(consent.confirmations)||!Number.isFinite(issued)||!Number.isFinite(until)||issued>now||until<=now||until-issued>ROUTINE_MOTION_CONSENT_MAX_MS||now-issued>ROUTINE_MOTION_CONSENT_MAX_MS||consent.revokedAt!==null)throw Error('Standing consent is invalid, expired, revoked or outside its explicit wave-only scope');
 if(consent.resetAssertion&&(Object.keys(consent.resetAssertion).length!==4||consent.resetAssertion.operatorAssertedReset!==true||consent.resetAssertion.consentId!==consent.id||consent.resetAssertion.issuedAt!==consent.issuedAt||consent.resetAssertion.sourceInstruction!==consent.sourceInstruction))throw Error('Reset assertion must bind the current explicit consent');
 if(consent.guardedElbowTrajectory!==undefined&&consent.guardedElbowTrajectory!=='guarded-elbow-quintic-v1')throw Error('Unknown guarded trajectory consent scope');
 return true;
}

export async function readRoutineMotionConsent(directory,{now=Date.now()}={}){
 const consent=JSON.parse(await readFile(consentPath(directory),'utf8'));validateRoutineMotionConsent(consent,{now});
 return {id:consent.id,until:consent.until,confirmations:{...consent.confirmations},...(consent.guardedElbowTrajectory?{guardedElbowTrajectory:consent.guardedElbowTrajectory}:{}),...(consent.resetAssertion?{resetAssertion:{...consent.resetAssertion}}:{})};
}

export async function revokeRoutineMotionConsent(directory,{now=Date.now()}={}){
 if(!Number.isFinite(now))throw Error('Finite revocation time required');const file=consentPath(directory);let consent;try{consent=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error?.code==='ENOENT')return null;throw error;}
 if(consent.revokedAt!==null)return {id:consent.id,revokedAt:consent.revokedAt};consent.revokedAt=new Date(now).toISOString();const temp=`${file}.${randomUUID()}.tmp`;
 try{await writeFile(temp,`${JSON.stringify(consent,null,2)}\n`,{encoding:'utf8',flag:'wx'});await rename(temp,file);}catch(error){try{await unlink(temp);}catch{}throw error;}
 return {id:consent.id,revokedAt:consent.revokedAt};
}
