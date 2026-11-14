import {validateObservedJoints} from './safety.mjs';

// June 30 source: RoArm-M2_module.h lines 35-56, 299-372, 787-799;
// RoArm-M2_config.h: ARM_SERVO_POS_RANGE=4096, ARM_SERVO_MIDDLE_POS=2047.
// This adapter is scoped to the supervised experiment, not general control.
export const Z_LIFT_COMMAND_REVISION='roarm-m2-260630-t101-elbow-v1';
export const SERVO_STEP=2*Math.PI/4096;
const names=['base','shoulder','elbow','gripper'];
const round=x=>Math.sign(x)*Math.floor(Math.abs(x)+0.5); // C round: ties away from zero.
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));

// T101 joint 3 calls only RoArmM2_elbowJointCtrlRad(1, ...), which writes
// servo 14. It does not write either shoulder motor, the base, or the gripper.
export function elbowCommandForTick(tick){
 if(!Number.isInteger(tick)||tick<1024||tick>3071)throw Error('Elbow target is outside the source command range');
 const rad=(tick-1024)*SERVO_STEP;
 if(round(rad/SERVO_STEP)+1024!==tick)throw Error('Elbow command failed integer round trip');
 return {T:101,joint:3,rad,spd:20,acc:1};
}

export function commandTicks(input){
 const j=validateObservedJoints(input);
 return {base:2047+round(-clamp(j.base,-Math.PI,Math.PI)/SERVO_STEP),
  shoulder:2047+round(clamp(j.shoulder,-Math.PI/2,Math.PI/2)/SERVO_STEP),
  shoulderDriven:2047-round(clamp(j.shoulder,-Math.PI/2,Math.PI/2)/SERVO_STEP),
  elbow:clamp(round(j.elbow/SERVO_STEP)+1024,1024,3071),gripper:clamp(round(j.gripper/SERVO_STEP),700,3396)};
}
export function feedbackAtTicks(t){
 return {base:Math.PI-t.base*SERVO_STEP,shoulder:t.shoulder*SERVO_STEP-Math.PI,
  elbow:t.elbow*SERVO_STEP-Math.PI/2,gripper:t.gripper*SERVO_STEP};
}
export function observedTicks(input){
 const j=validateObservedJoints(input);
 const t={base:round((Math.PI-j.base)/SERVO_STEP),shoulder:round((Math.PI+j.shoulder)/SERVO_STEP),
  elbow:round((Math.PI/2+j.elbow)/SERVO_STEP),gripper:round(j.gripper/SERVO_STEP)};
 const reconstructed=feedbackAtTicks(t);
 if(names.some(k=>Math.abs(j[k]-reconstructed[k])>1e-6))throw Error('Feedback does not match the reviewed integer servo model');
 return t;
}
export function commandForTicks(t){
 const bounds={base:[0,4095],shoulder:[1023,3071],elbow:[1024,3071],gripper:[700,3396]};
 if(names.some(k=>!Number.isInteger(t[k])||t[k]<bounds[k][0]||t[k]>bounds[k][1]))throw Error('Servo target is outside the source command range');
 const j={base:(2047-t.base)*SERVO_STEP,shoulder:(t.shoulder-2047)*SERVO_STEP,
  elbow:(t.elbow-1024)*SERVO_STEP,gripper:t.gripper*SERVO_STEP};
 const encoded=commandTicks(j);
 if(names.some(k=>encoded[k]!==t[k]))throw Error('Servo command failed integer round trip');
 return j;
}

export function assertLiftHealth(raw){
 if(!raw||typeof raw.v!=='number'||!Number.isFinite(raw.v)||raw.v<700||raw.v>1260)throw Error('Fresh motor supply feedback within 7-12.6 V is required');
 if(['torswitchB','torswitchS','torswitchE','torswitchH'].some(k=>raw[k]!==1))throw Error('All four reported motor torque-enable fields must be on');
 if(['Stalltor','Stalltep','Stallvol'].some(k=>raw[k]!==undefined&&raw[k]!==0&&raw[k]!==false))throw Error('Firmware reports a stall, temperature or voltage fault');
}
