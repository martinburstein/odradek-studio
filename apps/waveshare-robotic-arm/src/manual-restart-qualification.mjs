import {SERVO_STEP,observedTicks} from './z-lift-actuators.mjs';
import {MANUAL_NAMES,MANUAL_CONFIRMATIONS,manualMoveForTick} from './manual-joints.mjs';
import {coordinatedWaveRequest} from '../tools/movement-actions.mjs';

export const MANUAL_RESTART_REVISION='completed-manual-restarted-pose-v1';
export const MANUAL_TIMEOUT_RESTART_REVISION='manual-timeout-restarted-pose-v1';
export const MANUAL_RESTART_INSPECTIONS=[...MANUAL_CONFIRMATIONS,'stationary','noContact','operatorAssertedPowerCycle'];
export const isManualTimeoutRestartAuthorization=a=>a?.revision===MANUAL_TIMEOUT_RESTART_REVISION;
export const MANUAL_SETTLED_RESTART_INSPECTIONS=[...MANUAL_CONFIRMATIONS,'stationary','noContact','operatorAssertedSetupChange'];
export const isManualSettledRestartAuthorization=a=>a?.revision==='settled-manual-endpoint-qualification-v1'&&a.operatorAssertedSetupChange===true;
export const isManualRestartAuthorization=a=>a?.revision===MANUAL_RESTART_REVISION||isManualTimeoutRestartAuthorization(a)||isManualSettledRestartAuthorization(a);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const manualRestartAuthorization=config=>{
 const completed=config.manualReview?.completedPoseRecovery,timeout=config.manualReview?.timeoutRecovery,settled=config.manualReview?.settledEndpointRecovery;
 const active=[completed,timeout,settled].filter(isManualRestartAuthorization);
 if(active.length>1)throw Error('Only one restarted-pose program may be installed');
 return active[0]??completed;
};

// This is an explicitly inspected new baseline after an operator-reported
// restart, not a drift reconciliation or proof that an automatic reset occurred.
// Existing completed/timeout cases retain their base sway. A fully delivered
// paired endpoint miss uses the existing named wave after a reported setup change.
export function validateManualRestartAuthorization(row,a,now=Date.now()){
 const at=Date.parse(a?.cameraObservation?.observedAt),c=a?.cameraObservation;
 const paired=isManualSettledRestartAuthorization(a),assertion=paired?a.setupChangeAssertion:a.powerCycleAssertion;
 if(!isManualRestartAuthorization(a)||(!paired&&a.operatorAssertedPowerCycle!==true)||typeof assertion!=='string'||assertion.length<20||a.noAutomaticRetry!==true||a.sessionSeconds!==(paired?90:120))throw Error('Explicit restarted-pose assertion and exact finite wave required');
 if(paired&&(row.plan?.movementJoint!=='coordinated'||a.inspectionScope!=='normal-tabletop'))throw Error('Setup-change restart requires the fully delivered paired endpoint inspection');
 if(!a.confirmations||Object.keys(a.confirmations).sort().join(',')!==MANUAL_CONFIRMATIONS.slice().sort().join(',')||MANUAL_CONFIRMATIONS.some(k=>a.confirmations[k]!==true))throw Error('Current restarted-pose setup and supervision required');
 if(!c||c.inspectedBy!=='root'||c.commandId!==row.id||c.frameSaved!==false||c.confirmedShowsArm!==true||c.fullSweepVisible!==true||c.visibleObstacles!==false||typeof c.cameraSessionId!=='string'||!c.cameraSessionId||!Number.isSafeInteger(c.sequence)||c.sequence<1||!Number.isFinite(at)||at<Date.parse(a.issuedAt)||at>now||now-at>60000)throw Error('Fresh root camera inspection of the restarted pose required');
 const ticks=observedTicks(a.expectedObserved),expected=paired?coordinatedWaveRequest(a.expectedObserved).moves:[ticks.base+57,ticks.base-57,ticks.base].map(t=>manualMoveForTick('base',t));
 if((!paired&&expected.some(m=>m.targetDegrees<=-180||m.targetDegrees>=180))||!same(a.authorizedMoves,expected))throw Error('Restart qualification permits only its exact three-target small wave');
 return a;
}

export function assertManualRestartSession(config,moves,history,seconds,now=Date.now()){
 const a=manualRestartAuthorization(config);if(!isManualRestartAuthorization(a))return;
 const timeout=isManualTimeoutRestartAuthorization(a),paired=isManualSettledRestartAuthorization(a),revision=timeout?'observed-manual-timeout-v1':paired?'observed-manual-settled-endpoint-v1':'observed-manual-completed-v1';
 const row=history.commands.at(-1),proof=row?.manualRecovery,at=Date.parse(proof?.inspectedAt);
 if(row?.id!==a.commandId||proof?.revision!==revision||!same(timeout?proof.timeoutAuthorization:paired?proof.settledEndpointAuthorization:proof.completedAuthorization,a)||!Number.isFinite(at)||at>now||now-at>60000||now>=Date.parse(a.expiresAt)||seconds!==a.sessionSeconds||!same(moves,a.authorizedMoves))throw Error('Fresh unconsumed restarted-pose qualification and its exact wave session required');
 validateManualRestartAuthorization(row,a,at);
}

export function assertManualRestartStart(config,history,start){
 if(!isManualRestartAuthorization(manualRestartAuthorization(config)))return;
 const pose=history.commands.at(-1)?.manualRecovery?.observed;
 if(!pose||MANUAL_NAMES.some(k=>Math.abs(start[k]-pose[k])>SERVO_STEP+1e-9))throw Error('Restarted pose changed after stationary qualification');
}
