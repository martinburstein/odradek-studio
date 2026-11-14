// Exact serial-bridge programs; no transport access or public geometry overrides.
import {compileDynamicPhysicalProgram} from './dynamic-physical-program.mjs';
import {REFERENCE_RETURN_POLICY,REFERENCE_JOINT_ORDER,REFERENCE_TARGET_TICKS,planReferenceLeg} from './reference-pose-return.mjs';
import {feedbackAtTicks} from './z-lift-actuators.mjs';
import {evaluateProposedReferenceRecoveryPath,PROPOSED_REFERENCE_SHOULDER_SOURCE_HASHES} from './shoulder-clearance.mjs';

export function reviewedReferenceGeometry(){
 const result=evaluateProposedReferenceRecoveryPath({
  sourceHashes:PROPOSED_REFERENCE_SHOULDER_SOURCE_HASHES,
  urdfJoint:{name:'link1_to_link2',type:'revolute',parent:'link1',child:'link2',originXyzMm:[0,0,0],originRpyRad:[-1.5707963267949,-1.5707963267949,0],axis:[0,0,-1]},
  srdfPair:{link1:'link1',link2:'link2',reason:'Adjacent'},route:REFERENCE_JOINT_ORDER,
  startTickRanges:REFERENCE_RETURN_POLICY.startAndTargetTicks,targetTicks:REFERENCE_TARGET_TICKS
 });
 if(result.status!=='candidate-clear-for-independent-review')throw Error('Source-pinned four-joint recovery geometry failed');
 return result;
}

export function compileHardwarePhysicalProgram(input){
 if(input?.name!=='reference-return')return compileDynamicPhysicalProgram(input);
 if(!input||Object.keys(input).length!==4||!['name','start','sourceHashes','now'].every(k=>Object.hasOwn(input,k)))throw Error('Exact fixed hardware program input required');
 const {start,sourceHashes,now}=input;
 if(!Number.isSafeInteger(now)||start?.source!=='T:1051'||!Number.isSafeInteger(start.observedAt)||now<start.observedAt||now-start.observedAt>500||typeof start.commandId!=='string'||!/^[a-f0-9]{64}$/.test(start.historyRowSHA256??''))throw Error('Fresh history-bound reference baseline required');
 if(!sourceHashes||Object.values(sourceHashes).some(h=>!/^[a-f0-9]{64}$/.test(h)))throw Error('Reviewed recovery source hashes required');
 const baseline={...start.ticks};
 if(Object.keys(baseline).length!==4||REFERENCE_JOINT_ORDER.some(j=>!Number.isInteger(baseline[j])))throw Error('Four exact encoder ticks required');
 const geometry=reviewedReferenceGeometry(),legs=[];let expected={...baseline};
 for(const joint of REFERENCE_JOINT_ORDER){
  const plan=planReferenceLeg({start:feedbackAtTicks(expected),joint});
  if(plan.skip)continue;
  if(plan.status==='BLOCKED'&&joint!=='shoulder')throw Error(plan.blockedReason);
  const targetTicks={...expected,[joint]:REFERENCE_TARGET_TICKS[joint]};
  const command={T:101,joint:REFERENCE_JOINT_ORDER.indexOf(joint)+1,rad:plan.commandSnapshot[joint],spd:20,acc:1};
  legs.push({index:legs.length,move:{joint},fromTicks:{...expected},targetTicks,targetJoints:feedbackAtTicks(targetTicks),command,pauseAfterMs:0,geometry});
  expected=targetTicks;
 }
 return {schema:'roarm-dynamic-physical-program-v1',name:'reference-return',title:'Four-joint fixed reference correction',start,baseline,sourceHashes,
  revision:'source-pinned-srdf-reference-return-bridge-v1',status:'proposal-only',dispatchAuthorized:false,physicalMovementVerified:false,
  policy:{...REFERENCE_RETURN_POLICY},finiteSession:{seconds:300,legCount:legs.length,maximumLegCount:4,automaticReturn:false,retry:false},legs,geometry};
}
