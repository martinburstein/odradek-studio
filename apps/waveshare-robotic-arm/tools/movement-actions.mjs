// Named requests only. These never connect, change limits, or authorize motion.
import {dynamicMove,dynamicMoves} from '../src/dynamic-moves.mjs';
import {normalizeManualMove,MANUAL_NAMES} from '../src/manual-joints.mjs';
// A reusable request builder only. Admission still checks the current physical
// pose and every leg through the shared Controller; no confirmation is supplied.
export function coordinatedWaveRequest(pose){
 if(!pose||MANUAL_NAMES.some(j=>typeof pose[j]!=='number'||!Number.isFinite(pose[j])))throw Error('Two-joint wave requires a finite current four-joint pose');
 const center={base:pose.base*180/Math.PI,elbow:pose.elbow*180/Math.PI};
 const moves=[[-8,-6],[8,6],[0,0]].map(([base,elbow])=>normalizeManualMove({targets:{base:center.base+base,elbow:center.elbow+elbow}}));
 return {moves,seconds:90};
}
export function namedAction(name) {
 if(name!=='wave'){const routine=dynamicMove(name);return {moves:routine.moves,seconds:routine.seconds};}
 return {moves:[{joint:'base',degrees:-5},{joint:'base',degrees:10},{joint:'base',degrees:-5}],seconds:120};
}
export const namedActions=()=>[{name:'wave',description:'Small three-step base sway; shoulder, elbow and grabber held. Relative steps total zero; actual return is not guaranteed.',request:namedAction('wave'),physicalQualification:'Requires installed held-pose base-wave review, resolved movement history and current supervision; naming the action does not qualify hardware.'},...dynamicMoves().map(m=>({...m,request:namedAction(m.name)}))];
export function supervisedConfirmations(flag){
 if(flag!=='--supervised')throw Error('Named physical actions require --supervised after current human setup confirmation');
 return {baseSecured:true,sweep300mmClear:true,cablesSlack:true,jawsClear:true,powerSwitchReady:true};
}
