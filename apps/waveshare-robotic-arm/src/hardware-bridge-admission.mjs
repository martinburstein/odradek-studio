import {tabletopGeometryPolicy,TABLETOP_CLEARANCE_REVISION} from './training-envelope.mjs';
// Local review/installation/consent records admit hardware; API assertions do not.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DRAMATIC_WAVE_REQUIRED_SOURCE_HASHES} from './dramatic-wave.mjs';
import {dynamicMoves} from './dynamic-moves.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const physicalKeys=['baseSecured','sweep300mmClear','cablesSlack','jawsClear','powerSwitchReady','noUnusualNoise','supervised'];
export const hardwareBridgeSourceFiles=()=>[...new Set([...DRAMATIC_WAVE_REQUIRED_SOURCE_HASHES,
 'src/hardware-bridge-feedback.mjs','src/hardware-bridge-admission.mjs','src/dynamic-physical-program.mjs',
 'src/dynamic-physical-executor.mjs','src/shoulder-clearance.mjs',
 'src/hardware-physical-program.mjs','src/hardware-pilot-control.mjs',
 'src/dynamic-moves.mjs','src/session-authority.mjs','src/server.mjs','src/pilot-commands.mjs','tools/movement.mjs',
 'firmware-candidates/roarm_hardware_bridge_v1/roarm_hardware_bridge_v1.ino',
 'firmware-candidates/roarm_hardware_bridge_v1/bridge_policy.h','tools/build-hardware-firmware.py'])];
async function containedRead(base,relative){
 if(typeof relative!=='string'||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Hardware evidence path must be contained');
 const parent=await fs.realpath(base),file=await fs.realpath(path.resolve(base,relative));
 if(!file.startsWith(parent+path.sep)||(await fs.lstat(path.resolve(base,relative))).isSymbolicLink())throw Error('Hardware evidence is redirected');
 return fs.readFile(file);
}
async function evidence(directory,pin){
 if(!pin||!hash(pin.sha256)||!/^evidence\/[\w-]+\.json$/.test(pin.file??''))throw Error('Reviewed hardware evidence missing');
 const bytes=await containedRead(directory,pin.file);
 if(sha(bytes)!==pin.sha256)throw Error('Hardware review evidence changed');
 return JSON.parse(bytes);
}
export async function readDynamicHardwareAdmission({controller,name,now=Date.now()}={}){
 if(!controller||!Number.isSafeInteger(now)||name!=='reference-return'&&!dynamicMoves().some(m=>m.name===name))throw Error('Known named physical program and Controller required');
 const directory=path.join(controller.directory,'commissioning');
 const bytes=await containedRead(directory,'hardware-bridge-motion.json'),record=JSON.parse(bytes);
 if(record.schema!=='roarm-reviewed-hardware-bridge-motion-v1'||record.enabled!==true||!uuid(record.reviewId)||!Number.isFinite(Date.parse(record.reviewedAt))||Date.parse(record.reviewedAt)>now||now-Date.parse(record.reviewedAt)>3600000)throw Error('Current reviewed hardware bridge motion configuration required');
 const source=await evidence(directory,record.sourceReview),geometry=await evidence(directory,record.geometryReview);
 if(source.schema!=='roarm-independent-hardware-source-review-v1'||source.approved!==true||typeof source.reviewedBy!=='string'||typeof source.independentReviewer!=='string'||!source.independentReviewer||source.independentReviewer===source.reviewedBy)throw Error('Independent hardware source review required');
 const actual={};
 for(const relative of hardwareBridgeSourceFiles()){
  actual[relative]=sha(await fs.readFile(path.resolve(root,relative)));
  if(source.sourceHashes?.[relative]!==actual[relative])throw Error('Hardware source changed since review: '+relative);
 }
 if(geometry.schema!=='roarm-installed-geometry-review-v2'||geometry.tabletopClearanceRevision!==TABLETOP_CLEARANCE_REVISION||geometry.approved!==true||geometry.requiredBodyHeightMm!==0||geometry.requiredSelfSeparationMm!==24||geometry.shoulderPolicy!=='pinned-vendor-adjacent-link1-link2-v1'||geometry.installedGeometryConfirmed!==true||typeof geometry.operatorInstruction!=='string'||geometry.operatorInstruction.trim().length<12)throw Error('Reviewed installed geometry and fixed margins required');
 const geometryAt=Date.parse(geometry.reviewedAt);
 if(typeof geometry.reviewedBy!=='string'||!geometry.reviewedBy.trim()||typeof geometry.independentReviewer!=='string'||!geometry.independentReviewer.trim()||geometry.independentReviewer===geometry.reviewedBy||!Number.isFinite(geometryAt)||geometryAt>now||now-geometryAt>3600000)throw Error('Current independently attributed geometry review required');
 for(const f of ['src/shoulder-clearance.mjs','src/hardware-physical-program.mjs','src/reference-pose-return.mjs','src/training-envelope.mjs','src/z-lift-actuators.mjs','src/other-joint-plan.mjs'])if(geometry.sourceHashes?.[f]!==actual[f])throw Error('Geometry source changed since independent review: '+f);
 const installedBytes=await containedRead(root,record.installedReceipt?.file),installed=JSON.parse(installedBytes);
 if(!hash(record.installedReceipt?.sha256)||sha(installedBytes)!==record.installedReceipt.sha256||installed.state!=='install-verified'||installed.readbackSHA256!==installed.candidateSHA256||!hash(installed.buildId)||!hash(installed.candidateSHA256)||installed.firmwareWriteAuthorized!==true||installed.applicationOffset!==0x10000||installed.positionCommands!==0)throw Error('Exact authorized app-only installation and readback verification required');
 const consentBytes=await containedRead(controller.directory,'hardware-motion-consent.json'),consent=JSON.parse(consentBytes);
 const issued=Date.parse(consent.issuedAt),until=Date.parse(consent.until);
 if(consent.schema!=='roarm-explicit-named-hardware-consent-v1'||!uuid(consent.id)||consent.revoked!==false||consent.executionAuthorized!==true||!Array.isArray(consent.allowedRoutines)||!consent.allowedRoutines.includes(name)||!Number.isFinite(issued)||!Number.isFinite(until)||issued>now||until<=now||until-issued>3600000||physicalKeys.some(k=>consent.physical?.[k]!==true)||typeof consent.sourceInstruction!=='string'||consent.sourceInstruction.trim().length<12)throw Error('Current actual human consent for this named routine required');
 if(source.buildId!==installed.buildId||source.candidateSHA256!==installed.candidateSHA256||consent.reviewId!==record.reviewId)throw Error('Source, installed firmware and consent do not share the same review');
 return {buildId:installed.buildId,reviewId:record.reviewId,consentId:consent.id,until,
  sourceHashes:actual,configDigest:sha(bytes),admissionDigest:sha(Buffer.concat([bytes,consentBytes,installedBytes])),
  physicalInspection:{...consent.physical},geometryReview:geometry};
}
