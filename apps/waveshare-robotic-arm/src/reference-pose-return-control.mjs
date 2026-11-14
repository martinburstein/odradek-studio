// The recovery namespace is intentionally separate from ordinary joint limits.
// Source-only planning is available now; physical admission is not commissioned.
import {createHash} from 'node:crypto';
import {planReferenceLeg,REFERENCE_JOINT_ORDER,REFERENCE_TARGET_TICKS,REFERENCE_RETURN_SCOPE} from './reference-pose-return.mjs';
import {observedTicks} from './z-lift-actuators.mjs';
import {collectReferencePoseStart as collectBoundedStart,executeReferencePoseLeg as executeBoundedLeg} from './reference-pose-return-executor.mjs';

export const REFERENCE_PHYSICAL_BLOCKERS=Object.freeze([
  'Installed firmware identity and paired-shoulder commissioning are not verified',
  'T105 refreshes shoulder servo12 only; independent servo13 position and health are unavailable',
  'The moving shoulder attachment clearance has no accepted physical/model qualification'
]);
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const keys=['stationary','noContact','cablesSlack','noUnusualNoise'];

// Preflight ALL four legs before permitting the first position write. Geometry
// previews do not create receipts, qualify hardware, or resolve old commands.
export function planReferenceSequence({start}={}){
  observedTicks(start);let expected={...start};const legs=[];
  for(const joint of REFERENCE_JOINT_ORDER){
    const plan=planReferenceLeg({start:expected,joint});legs.push(plan);
    // A skipped leg retains the observed pose, not an invented exact target.
    if(!plan.noSend)expected={...expected,[joint]:plan.target[joint]};
  }
  const blockers=legs.filter(p=>p.status==='BLOCKED').map(p=>({joint:p.joint,reason:p.blockedReason}));
  return {scope:REFERENCE_RETURN_SCOPE,referenceTargetTicks:{...REFERENCE_TARGET_TICKS},legs,
    status:blockers.length?'BLOCKED':'planned',blockers,
    noMotionCommandIssued:true,physicalMovementVerified:false,simulatedEndpoint:expected};
}

export function referencePhysicalReadiness(){
  return {scope:REFERENCE_RETURN_SCOPE,physicalAdmission:false,
    blockers:[...REFERENCE_PHYSICAL_BLOCKERS],noMotionCommandIssued:true,
    requiresFirmwareOrCommissioningChange:true,ordinaryWaveLimitsUnchanged:true};
}

export function assertReferencePhysicalAdmission(){
  const error=new Error(`Four-joint reference correction is not admitted: ${REFERENCE_PHYSICAL_BLOCKERS.join('; ')}`);
  error.code='REFERENCE_SHOULDER_NOT_COMMISSIONED';
  error.readiness=referencePhysicalReadiness();throw error;
}

// Fixed Controller/Pilot entry points. There is deliberately no caller-provided
// "servo13 verified" boolean, raw command, transport override, or bypass flag.
// A genuine read-only protocol and accepted shoulder geometry must be added and
// independently reviewed before these entries may produce a physical proof.
export async function collectReferencePoseStart(input={}){
  if(Object.hasOwn(input,'assertHardwareReady'))throw Error('Public recovery cannot override hardware commissioning');
  return collectBoundedStart(input);
}
export async function executeReferencePoseLeg(input={}){
  if(Object.hasOwn(input,'assertHardwareReady'))throw Error('Public recovery cannot override hardware commissioning');
  return executeBoundedLeg(input);
}

// A deterministic offline player for the four-joint protocol, with no Controller
// or transport argument. Its events are simulator evidence, never serial receipts.
export function simulateReferenceSequence({start,dtMs=150}={}){
  if(!Number.isInteger(dtMs)||dtMs<1||dtMs>500)throw Error('Simulation cadence must be 1..500ms');
  const sequence=planReferenceSequence({start});
  if(sequence.status==='BLOCKED')throw Error(`Whole-sequence preflight blocked: ${sequence.blockers.map(b=>b.reason).join('; ')}`);
  let pose={...start},timeMs=0;const events=[];
  for(const leg of sequence.legs){
    const ticks=observedTicks(pose),delta=leg.targetTicks[leg.joint]-ticks[leg.joint];
    const duration=Math.max(12000,Math.abs(delta)/20*1000+1600);
    for(let t=0;t<=duration+dtMs;t+=dtMs){
      const progress=leg.skip?0:Math.min(1,t/Math.max(1,Math.abs(delta)/20*1000));
      const current={...pose,[leg.joint]:pose[leg.joint]+(leg.target[leg.joint]-pose[leg.joint])*progress};
      events.push({source:'reference-simulator',timeMs:timeMs+t,joint:leg.joint,joints:current,
        noMotionCommandIssued:true,physicalMovementVerified:false});
    }
    if(!leg.skip)pose={...pose,[leg.joint]:leg.target[leg.joint]};timeMs+=duration+2*dtMs;
  }
  return {scope:REFERENCE_RETURN_SCOPE,source:'reference-simulator',sequence,
    simulatedEndpoint:pose,events,eventSHA256:digest(events),noMotionCommandIssued:true,
    physicalMovementVerified:false,waveAdmission:false};
}
