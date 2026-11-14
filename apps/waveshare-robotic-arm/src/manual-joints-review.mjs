import fs from 'node:fs/promises';
import {isCrashRecoveryAuthorization,crashRecoveryEnabled} from './manual-crash-recovery.mjs';
import path from 'node:path';
import {isInspectedManualRecovery,completedRecoveryHistoryMatches} from './manual-pose-recovery.mjs';
import {CARDBOARD_STYLUS_REVISION,assertSayAhHistoryRow,MANUAL_REVISION,MANUAL_NAMES,validateStylusTraining,validateCoordinatedDynamics,validateManualJointFeedForward,validateManualTestWindow,manualSources,qualificationMoves} from './manual-joints.mjs';
import {calibrationDigest,FACTORY_APP_SHA256} from './factory-manual-calibration.mjs';
import {assertManualRestartSession} from './manual-restart-qualification.mjs';
import {historyDigest,historyPrefix} from './movement-history-snapshot.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const MANUAL_STARTUP_ACCESS='local-direct-on-startup-v1';
export function manualStartupAccess(config){return config?.profile?.phase==='qualified'&&config.profile.manualAccess===MANUAL_STARTUP_ACCESS&&config.manualReview?.manualAccess===MANUAL_STARTUP_ACCESS;}
export function manualStartupPoseAllowed(config,row){
 return manualStartupAccess(config)&&row?.state==='complete'&&!row.manualRecovery&&row.plan?.experiment===MANUAL_REVISION&&row.result?.cleanupVerified===true&&!row.result.requiresReconciliation&&row.result.outcome==='manual-coarse-response';
}
// Successful historical proofs only. Hash contents on every lookup, including
// in-place edits; file timestamps, object identity and row counts are not proof.
// Live source, USB, authorization and pose checks remain with their callers.
const verifiedHistories=new Map();
export function manualRecoveryBoundToReview(row,config){
 const proof=row?.manualRecovery;if(!isInspectedManualRecovery(row))return false;
 if(proof.configDigest===config.digest&&proof.reviewSHA256===config.profile.review.sha256&&same(proof.sourceHashes,config.manualReview.sourceHashes))return isCrashRecoveryAuthorization(proof.intentAuthorization)?crashRecoveryEnabled(config):proof.revision==='observed-manual-timeout-v1'?same(proof.timeoutAuthorization,config.manualReview.timeoutRecovery):proof.revision==='observed-manual-intent-v1'?(isCrashRecoveryAuthorization(proof.intentAuthorization)?crashRecoveryEnabled(config):same(proof.intentAuthorization,config.manualReview.intentRecovery)):proof.revision==='observed-manual-completed-v1'?same(proof.completedAuthorization,config.manualReview.completedPoseRecovery):proof.revision==='observed-manual-settled-endpoint-v1'?same(proof.settledEndpointAuthorization,config.manualReview.settledEndpointRecovery):proof.displacementAuthorization?same(proof.displacementAuthorization,config.manualReview.displacementRecovery):true;
 // A later independent source review may explicitly preserve this exact prior
 // receipt. This does not accept a new recovery or change any movement limits.
 return Array.isArray(config.manualReview.acceptedManualRecoveries)&&config.manualReview.acceptedManualRecoveries.some(a=>a.commandId===row.id&&a.originalRowSHA256===proof.originalRowSHA256&&a.receiptSHA256===calibrationDigest(proof)&&a.configDigest===proof.configDigest&&a.reviewSHA256===proof.reviewSHA256&&a.disposition==='preserve-exact-inspected-manual-pose');
}
export async function readManualConfig(directory,p,raw){
 if(p.revision!==MANUAL_REVISION||p.enabled!==true||p.variant!=='RoArm-M2-S'||p.toolMode!=='EEMode 0'||p.completionMode!=='fixed'||!['qualification','qualified'].includes(p.phase)||Object.keys(p).some(k=>!['revision','enabled','variant','toolMode','completionMode','phase','review','authorization','physicalDeadlineAt','qualification','manualAccess'].includes(k)))throw Error('Exclusive reviewed tabletop manual profile required');
 if(!p.review)throw Error('Manual review required');
 const ref=p.review;if(!ref||!/^evidence\/[\w-]+\.json$/.test(ref.file))throw Error('Manual review reference required');
 const root=await fs.realpath(path.join(directory,'commissioning')),file=await fs.realpath(path.join(root,ref.file));if(!file.startsWith(root+path.sep))throw Error('Manual review outside evidence directory');
 const bytes=await fs.readFile(file);if(calibrationDigest(bytes)!==ref.sha256)throw Error('Manual review changed');const review=JSON.parse(bytes),now=Date.now(),sources=await manualSources();
 const startup=manualStartupAccess({profile:p,manualReview:review});
 if(review.crashRecovery!==undefined&&!crashRecoveryEnabled({profile:p,manualReview:review,manualTestWindow:review.manualTestWindow}))throw Error('Crash repair requires reviewed ordinary local Manual access');
 if((p.manualAccess!==undefined||review.manualAccess!==undefined)&&(!startup||typeof review.manualAccessInstruction!=='string'||review.manualAccessInstruction.length<20||review.stylusTraining||review.manualTestWindow))throw Error('Reviewed ordinary local Manual startup access required');
 if(review.revision!==MANUAL_REVISION||!review.id||typeof review.reviewedBy!=='string'||!review.reviewedBy.trim()||review.reviewedBy===review.preparedBy||!Number.isFinite(Date.parse(review.reviewedAt))||Date.parse(review.reviewedAt)>now||(!startup&&now-Date.parse(review.reviewedAt)>7*86400000)||!same(review.sourceHashes,sources))throw Error('Current independent source-bound manual review required');
 if(!review.connection||typeof review.connection.port!=='string'||!review.connection.serialNumber||review.connection.vendorId!=='10c4'||review.connection.productId!=='ea60')throw Error('Reviewed USB serial identity required');
 if(review.firmwareSHA256!==FACTORY_APP_SHA256||review.firmwareRestoration?.readbackSHA256!==FACTORY_APP_SHA256||review.firmwareRestoration?.state!=='install-verified'||review.boundary!=='normal-tabletop-stock-arm'||review.servo13PositionIndependentlyMonitored!==false||review.noAutomaticRetry!==true||!Number.isInteger(review.anchorCount)||review.anchorCount<0||!/^[a-f0-9]{64}$/.test(review.historySHA256??'')||!same(review.moves,qualificationMoves(review.start)))throw Error('Manual hardware, exact program and history evidence required');
 if(p.phase==='qualification'){
  const issued=Date.parse(p.authorization?.issuedAt),until=Date.parse(p.physicalDeadlineAt);if(!p.authorization?.id||p.authorization?.reviewId!==review.id||typeof p.authorization.sourceInstruction!=='string'||p.authorization.sourceInstruction.length<10||!Number.isFinite(issued)||!Number.isFinite(until)||issued>now||issued<Date.parse(review.reviewedAt)||until<=now||until-issued>900000||until<=issued)throw Error('Fresh finite calibration program authorization required');
 }else if(!p.qualification||p.physicalDeadlineAt!==undefined||p.authorization!==undefined)throw Error('Completed manual qualification proof required');
 validateCoordinatedDynamics(review.coordinatedSpeed,review.coordinatedAcceleration);
 validateStylusTraining(review.stylusTraining);
 if(review.stylusTraining&&(p.phase!=='qualified'||review.manualTestWindow))throw Error('Stylus training requires ordinary qualified manual control');
 if(p.phase!=='qualified'&&((review.coordinatedSpeed??20)!==20||(review.coordinatedAcceleration??1)!==1))throw Error('Only a qualified coordinated profile may change speed or acceleration');
 validateManualTestWindow(review.manualTestWindow);
 validateManualJointFeedForward(review.jointFeedForwardTicks);
 if(review.jointFeedForwardTicks!==undefined&&review.manualTestWindow?.jointFeedForwardTicks!==undefined)throw Error('Only one reviewed joint feed-forward table may be installed');
 if(review.guardedExit!==undefined&&review.guardedExit!=='base-shoulder-elbow-v1')throw Error('Unknown reviewed manual settling option');
 return {digest:calibrationDigest(raw),profile:p,manualReview:review,manualTestWindow:review.manualTestWindow};
}
export function assertManualHistory(config,history,acceptedRecovery){
 const r=config.manualReview,anchor=historyPrefix(history,r.anchorCount);
 if(historyDigest(anchor)!==r.historySHA256)throw Error('Manual review history anchor changed');
 const recovered=anchor.commands.flatMap(row=>['poseRecovery','resetRecovery'].filter(k=>row[k]).map(kind=>({row,kind}))),admissions=r.recoveryAdmissions;
 if(!Array.isArray(admissions)||admissions.length!==recovered.length)throw Error('Explicit manual recovery dispositions required');
 for(const {row,kind} of recovered){const a=admissions.filter(a=>a.commandId===row.id&&a.kind===kind);if(a.length!==1||!acceptedRecovery(row,kind)||a[0].rowSHA256!==calibrationDigest(row)||a[0].originalRowSHA256!==row[kind].originalRowSHA256||a[0].disposition!=='preserve-history-and-admit-supervised-tabletop-manual'||a[0].causeOfPriorDrift!=='unknown'||row[kind].cause!=='unknown')throw Error('Manual recovery-bearing history not explicitly reviewed');}
 const key=calibrationDigest({digest:config.digest,profile:config.profile,review:r})+':'+historyDigest(history),cached=verifiedHistories.get(key),now=Date.now();
 // Re-run time-sensitive historical checks if the wall clock moves backward.
 // The caller-provided legacy recovery validator above is never memoized.
 if(cached&&now>=cached.checkedAt)return cached.count;
 const rows=history.commands.slice(r.anchorCount);
 // Completed command state must not hide an unbound or altered recovery receipt.
 if(rows.some(row=>row.manualRecovery&&!manualRecoveryBoundToReview(row,config)))throw Error('Manual history is not a healthy reviewed prefix');
 if(rows.some(row=>(['observed-manual-completed-v1','observed-manual-settled-endpoint-v1','observed-manual-timeout-v1'].includes(row.manualRecovery?.revision)||row.manualRecovery?.displacementAuthorization||isCrashRecoveryAuthorization(row.manualRecovery?.intentAuthorization))&&!completedRecoveryHistoryMatches(row,history)))throw Error('Manual history is not a healthy reviewed prefix');
 for(const [i,row] of rows.entries())if(row.manual?.reviewId!==r.id||row.plan?.experiment!==MANUAL_REVISION||!((row.state==='complete'&&row.result?.cleanupVerified===true&&!row.result.requiresReconciliation&&row.result.outcome==='manual-coarse-response')||(i>=16&&config.profile.phase==='qualified'&&manualRecoveryBoundToReview(row,config))))throw Error('Manual history is not a healthy reviewed prefix');
 for(const [i,row]of rows.entries())if(row.state==='complete')assertSayAhHistoryRow(row,history.commands[r.anchorCount+i-1]);
 const qual=rows.slice(0,16);for(let i=0;i<qual.length;i++)if(qual[i].manual.phase!=='qualification'||qual[i].manual.programIndex!==i||!same(qual[i].move,r.moves[i]))throw Error('Calibration program prefix changed');
 if(config.profile.phase==='qualification'){if(rows.length>=16)throw Error('Calibration program has already been consumed');}
 else{
  const q=config.profile.qualification;
  if(qual.length!==16||!Array.isArray(q.commands)||q.commands.length!==16||q.commands.some((x,i)=>x.id!==qual[i].id||x.sha256!==calibrationDigest(qual[i]))||!Number.isFinite(Date.parse(q.inspectedAt))||Date.parse(q.inspectedAt)<Date.parse(qual.at(-1).finishedAt)||Date.parse(q.inspectedAt)>Date.now()||!MANUAL_NAMES.every(k=>q.inspection?.[k]?.correctDirection===true&&q.inspection[k].smoothNoBinding===true)||q.inspection?.allStationaryClear!==true)throw Error('All four joints require completed response records and physical inspection');
 }
 verifiedHistories.set(key,{count:rows.length,checkedAt:Date.now()});
 if(verifiedHistories.size>8)verifiedHistories.delete(verifiedHistories.keys().next().value);
 return rows.length;
}
export function assertManualMoves(config,moves,history,acceptedRecovery,seconds=300){
 const scope=config.manualReview?.stylusTraining;
 if(scope){validateStylusTraining(scope);if(scope.revision===CARDBOARD_STYLUS_REVISION&&(!Array.isArray(moves)||moves.length!==1))throw Error('Cardboard rehearsal admits one inspected step at a time');for(const move of moves){const targets=move.targets??{[move.joint]:move.targetDegrees};for(const [joint,degrees]of Object.entries(targets)){const b=scope.boundsDegrees[joint];if(joint==='gripper'||!b||degrees<b[0]||degrees>b[1])throw Error('Stylus request leaves the fixed-gripper workspace');}}}
 const n=assertManualHistory(config,history,acceptedRecovery);
 assertManualRestartSession(config,moves,history,seconds);
 if(config.profile.phase==='qualification'){if(n!==0||!same(moves,config.manualReview.moves))throw Error('Only the complete exact calibration program may begin, once');}
 else if(!Array.isArray(moves)||moves.length<1)throw Error('Qualified manual control requires an explicit nonempty joint target list');
}
