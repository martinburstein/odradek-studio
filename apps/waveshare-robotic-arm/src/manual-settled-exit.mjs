import {classifyManualSettling,manualPlanJoints} from './manual-joints.mjs';
import {SERVO_STEP} from './z-lift-actuators.mjs';

// Observation-only monitor. The shared Controller still owns every command,
// source/deadline check, sample, final classifier, durable result and cleanup.
export function createManualSettledExit(plan,dispatchedAt,{allowBase=false}={}){
 if(!manualPlanJoints(plan).every(j=>(allowBase?['base','shoulder','elbow']:['shoulder','elbow']).includes(j))||!Number.isFinite(Date.parse(dispatchedAt)))throw Error('Guarded manual exit supports reviewed base/shoulder/elbow with a recorded dispatch time');
 const began=Date.parse(dispatchedAt);let candidate=null,ready=false,guardResets=0;
 const snapshot=()=>({mode:allowBase?'manual-guarded-settling-base-v1':'manual-guarded-settling-v1',minimumObservationMs:2000,postCandidateGuardMs:1000,candidate:candidate?structuredClone(candidate):null,guardResets,ready});
 return {snapshot,observe(samples){
  if(ready)return snapshot();
  const last=samples.at(-1),at=Date.parse(last?.observedAt);if(!Number.isFinite(at)||at-began<2000)return snapshot();
  let result;try{result=classifyManualSettling(samples,plan);}catch{if(candidate)guardResets++;candidate=null;return snapshot();}
  // Tiny no-response requests retain their full observation window.
  if(!result.movementDetected){if(candidate)guardResets++;candidate=null;return snapshot();}
  if(candidate&&Object.keys(last.joints).some(k=>Math.abs(last.joints[k]-candidate.observed[k])>SERVO_STEP+1e-9)){guardResets++;candidate=null;}
  if(!candidate)candidate={elapsedMs:at-began,sampleIndex:samples.length-1,observed:{...last.joints},residualDegrees:result.residualDegrees};
  if(at-began-candidate.elapsedMs>=1000)ready=true;
  return snapshot();
 }};
}
