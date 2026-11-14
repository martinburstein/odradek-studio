import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {SERVO_STEP,observedTicks} from './z-lift-actuators.mjs';
import {FACTORY_GRIPPER_CALIBRATION_EXPERIMENT,planOtherJoint} from './other-joint-plan.mjs';
export const FACTORY_CALIBRATION_SCOPE=FACTORY_GRIPPER_CALIBRATION_EXPERIMENT;
export const FACTORY_APP_SHA256='b5284e62892e88601445602917765c89cf5b015ffce17f5ea2134392943060f2';
export const FACTORY_CALIBRATION_SOURCES=Object.freeze(['src/movement-history-snapshot.mjs','src/factory-manual-calibration.mjs','src/movement.mjs','src/motion-config.mjs','src/other-joint-plan.mjs','src/controller.mjs','src/transport.mjs','src/z-lift-actuators.mjs','src/z-lift-plan.mjs','src/kinematics.mjs','src/training-envelope.mjs','src/feedback-completion.mjs','src/server.mjs','src/session-authority.mjs','src/operating-envelope.mjs']);
export const calibrationDigest=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
export async function factoryCalibrationSources(){return Object.fromEntries(await Promise.all(FACTORY_CALIBRATION_SOURCES.map(async file=>[file,calibrationDigest(await fs.readFile(new URL('../'+file,import.meta.url)))])));}
const uuid=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const names=['base','shoulder','elbow','gripper'];
export function validateFactoryCalibrationReview(review,profile,sources,now=Date.now()){
 if(!review||review.revision!==FACTORY_CALIBRATION_SCOPE||!uuid(review.id)||review.joint!=='gripper'||review.disposition!=='one-opening-observation-only'||review.noAutomaticRetry!==true||review.noAutomaticReturn!==true)throw Error('Exact one-shot factory calibration review required');
 if(typeof review.reviewedBy!=='string'||!review.reviewedBy.trim()||!Number.isFinite(Date.parse(review.reviewedAt))||Date.parse(review.reviewedAt)>now||now-Date.parse(review.reviewedAt)>3600000)throw Error('Current independent factory calibration review required');
 if(!hash(review.historySHA256)||Object.keys(sources).length!==FACTORY_CALIBRATION_SOURCES.length||FACTORY_CALIBRATION_SOURCES.some(file=>!hash(sources[file])||review.sourceHashes?.[file]!==sources[file])||Object.keys(review.sourceHashes??{}).length!==FACTORY_CALIBRATION_SOURCES.length)throw Error('Factory calibration source/history binding changed');
 const receipt=review.firmwareRestoration;
 if(receipt?.schema!=='roarm-original-app-restore-receipt-v1'||receipt.state!=='install-verified'||receipt.candidateSHA256!==FACTORY_APP_SHA256||receipt.readbackSHA256!==FACTORY_APP_SHA256||receipt.applicationOffset!==65536||receipt.bytes!==1310720||review.firmwareSHA256!==FACTORY_APP_SHA256||profile.installedFirmware!==`original-app0-sha256:${FACTORY_APP_SHA256}`)throw Error('Exact restored factory application evidence required');
 if(!review.start||Object.keys(review.start).sort().join(',')!==names.slice().sort().join(','))throw Error('Exact four-joint starting pose required');
 const ticks=observedTicks(review.start);
 if(!Number.isInteger(review.targetTick)||review.targetTick!==ticks.gripper-23||Math.abs(review.degrees-(-23*360/4096))>1e-12)throw Error('Only the reviewed 23-tick gripper opening is admitted');
 const expected={T:101,joint:4,rad:review.targetTick*SERVO_STEP,spd:20,acc:1};
 if(JSON.stringify(review.command)!==JSON.stringify(expected))throw Error('Exact encoded factory calibration command changed');
 const consent=profile.factoryCalibrationAuthorization,a=Date.parse(consent?.issuedAt),b=Date.parse(profile.physicalDeadlineAt);
 if(!uuid(consent?.id)||consent?.scope!==FACTORY_CALIBRATION_SCOPE||typeof consent?.sourceInstruction!=='string'||consent.sourceInstruction.length<10||!Number.isFinite(a)||!Number.isFinite(b)||a>now||a<Date.parse(review.reviewedAt)||b<=now||b<=a||b-a>300000)throw Error('Fresh finite five-minute factory calibration authorization required');
 if(profile.completionMode!=='shadow'||profile.factoryManualCalibration!==FACTORY_CALIBRATION_SCOPE)throw Error('Factory calibration requires full shadow observation');
 return review;
}
export function assertFactoryCalibrationHistory(review,history,acceptedRecovery=()=>false){
 if(!history||!Array.isArray(history.commands)||history.commands.some(row=>row.factoryCalibration?.reviewId===review.id)||calibrationDigest(history)!==review.historySHA256)throw Error('Factory calibration review was consumed or movement history changed');
 const recovered=history.commands.flatMap(row=>['poseRecovery','resetRecovery'].filter(kind=>row[kind]).map(kind=>({row,kind})));
 const admissions=review.recoveryAdmissions;
 if(!Array.isArray(admissions)||admissions.length!==recovered.length)throw Error('Every recovery-bearing row needs an explicit factory calibration disposition');
 for(const {row,kind} of recovered){
  const matches=admissions.filter(a=>a.commandId===row.id&&a.kind===kind);
  if(matches.length!==1||!acceptedRecovery(row,kind)||matches[0].rowSHA256!==calibrationDigest(row)||matches[0].originalRowSHA256!==row[kind].originalRowSHA256||matches[0].disposition!=='preserve-recovery-and-admit-exact-factory-opening-only'||matches[0].causeOfPriorDrift!=='unknown'||row[kind].cause!=='unknown')throw Error('Recovery-bearing history was not explicitly reviewed for this one-shot scope');
 }
}
export function assertFactoryCalibrationMoves(review,moves){
 if(!Array.isArray(moves)||moves.length!==1||moves[0]?.joint!=='gripper'||moves[0].degrees!==review.degrees)throw Error('Factory calibration permits exactly one reviewed opening; no sequence or alternate target');
}
export function planFactoryCalibration(review,request,start,cartesian){
 assertFactoryCalibrationMoves(review,[request]);
 observedTicks(start);
 if(names.some(k=>Math.abs(start[k]-review.start[k])>SERVO_STEP/4))throw Error('Factory calibration starting pose changed; prepare a new review');
 const plan=planOtherJoint(start,cartesian,FACTORY_CALIBRATION_SCOPE,review.targetTick);
 if(JSON.stringify(plan.command)!==JSON.stringify(review.command))throw Error('Factory calibration encoded command differs from review');
 return {...plan,factoryCalibration:{reviewId:review.id,historySHA256:review.historySHA256,targetTick:review.targetTick,firmwareSHA256:review.firmwareSHA256}};
}
