import {SERVO_STEP,feedbackAtTicks} from './z-lift-actuators.mjs';
export const HARDWARE_BRIDGE_PROTOCOL='roarm-hardware-bridge-v1';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const replyTypes=new Map([[0,1],[101,1011],[105,1051],[116,1161],[117,1171],[118,1181]]);
export function validateBridgeRequest(command,expectedBuildId){
 if(!hash(expectedBuildId)||!command||!replyTypes.has(command.T)||!uuid(command.requestId))throw Error('Reviewed bridge build and exact request UUID required');
 const keys=command.T===117?['T','requestId','programId','expectedBuildId','ttlMs','steps']:command.T===101?['T','requestId','joint','rad','spd','acc']:['T','requestId'];
 if(!exact(command,keys))throw Error('Unexpected bridge request fields');
 if(command.T===101){
  const ranges={1:[1920,2160],2:[2052,2060],3:[2000,2389],4:[1900,2049]};
  const origins={1:2047,2:2047,3:1024,4:0};
  const offset=(command.joint===1?-1:1)*command.rad/SERVO_STEP;
  const tick=origins[command.joint]+Math.sign(offset)*Math.floor(Math.abs(offset)+0.5);
  if(!ranges[command.joint]||typeof command.rad!=='number'||!Number.isFinite(command.rad)||!integer(tick,...ranges[command.joint])||command.spd!==20||command.acc!==1)throw Error('Bridge position command exceeds the proposed fixed envelope');
 }
 if(command.T===117){
  if(command.expectedBuildId!==expectedBuildId||!uuid(command.programId)||!integer(command.ttlMs,1,300000)||!Array.isArray(command.steps)||command.steps.length<1||command.steps.length>10)throw Error('Invalid finite bridge program permit');
  const ranges={1:[1920,2160],2:[2052,2060],3:[2000,2389],4:[1900,2049]};
  for(const step of command.steps)if(!exact(step,['joint','tick'])||!ranges[step.joint]||!integer(step.tick,...ranges[step.joint]))throw Error('Bridge step exceeds the proposed device envelope');
 }
 return replyTypes.get(command.T);
}

export function parseBridgeResponse(raw,{expectedType,expectedBuildId,requestId,receivedAt=Date.now()}={}){
 let value=raw;
 if(typeof raw==='string'){if(raw.length>16384)return null;try{value=JSON.parse(raw);}catch{return null;}}
 if(!value||typeof value!=='object'||Array.isArray(value)||value.requestId!==requestId||value.protocol!==HARDWARE_BRIDGE_PROTOCOL)return null;
 if(value.T===1199)throw Error('Hardware bridge refused the requested operation');
 if(value.T!==expectedType||!hash(expectedBuildId)||value.buildId!==expectedBuildId||!/^[a-f0-9]{32}$/i.test(value.bootId??'')||!integer(value.sequence,1,0xffffffff)||!Number.isFinite(receivedAt))throw Error('Bridge identity or response binding is invalid');
 const result={...value,raw:structuredClone(value),source:'hardware',observedAt:new Date(receivedAt).toISOString()};
 if(expectedType===1171&&(!uuid(value.programId)||value.status!=='armed'||!integer(value.stepCount,1,10)||!integer(value.ttlMs,1,300000)))throw Error('Malformed finite permit acknowledgment');
 if(expectedType===1011&&(!uuid(value.programId)||value.status!=='dispatched'||!integer(value.index,0,9)))throw Error('Malformed position dispatch acknowledgment');
 if(expectedType===1181&&value.status!=='ok'||expectedType===1&&value.status!=='revoked')throw Error('Malformed bridge identity or revocation acknowledgment');
 if([1051,1161].includes(expectedType)){
  const ids=expectedType===1051?[11,12,13,14,15]:[12,13];
  if(value.sampleLabel!=='sequential-not-atomic'||!integer(value.observedAtMs,0,0xffffffff)||!Array.isArray(value.servos)||value.servos.length!==ids.length)throw Error('Malformed sequential bridge feedback');
  result.servos=value.servos.map((s,i)=>{
   if(s?.id!==ids[i]||typeof s.readOk!=='boolean')throw Error('Independent servo ID read is missing');
   if(!s.readOk){if(!exact(s,['id','readOk']))throw Error('Failed servo read contains stale numeric fields');return {...s};}
   const fields=['id','readOk','encoderCount','speedRaw','loadRaw','voltageDeciV','temperatureC','currentRaw','moving','mode','torqueEnabled'];
   if(!exact(s,fields)||!integer(s.encoderCount,0,4095)||!integer(s.speedRaw,-32768,32767)||!integer(s.loadRaw,-32768,32767)||!integer(s.voltageDeciV,0,255)||!integer(s.temperatureC,0,255)||!integer(s.currentRaw,-32768,32767)||!integer(s.moving,0,1)||!integer(s.mode,0,3)||!integer(s.torqueEnabled,0,1))throw Error('Invalid raw servo fields');
   return {...s};
  });
  const successes=result.servos.filter(s=>s.readOk).length;
  const status=successes===ids.length?'ok':successes?'partial':'error';
  if(value.status!==status)throw Error('Servo status contradicts independent reads');
  if(expectedType===1051&&status==='ok'){
   const ticks=Object.fromEntries([['base',11],['shoulder',12],['elbow',14],['gripper',15]].map(([joint,id])=>[joint,result.servos.find(s=>s.id===id).encoderCount]));
   result.joints=feedbackAtTicks(ticks);result.ticks=ticks;
   for(const [joint,key]of Object.entries({base:'b',shoulder:'s',elbow:'e',gripper:'t'}))if(typeof value[key]!=='number'||Math.abs(value[key]-result.joints[joint])>1e-6)throw Error('Bridge angle does not match its independent encoder read');
   const v=Math.min(...result.servos.map(s=>s.voltageDeciV))*10;
   if(value.v!==v)throw Error('Derived motor voltage does not match servo readings');
   result.health={v,torswitchB:result.servos[0].torqueEnabled,torswitchS:result.servos[1].torqueEnabled,torswitchE:result.servos[3].torqueEnabled,torswitchH:result.servos[4].torqueEnabled};
  }
 }
 return result;
}

export function assertHealthyBridgeSample(sample,{expectedBuildId,now=Date.now(),previous,stationary=false}={}){
 const at=Date.parse(sample?.observedAt);
 if(sample?.T!==1051||sample.protocol!==HARDWARE_BRIDGE_PROTOCOL||sample.source!=='hardware'||sample.buildId!==expectedBuildId||sample.status!=='ok'||!sample.joints||!sample.health||!sample.ticks||!Array.isArray(sample.servos)||sample.servos.length!==5||!Number.isFinite(at)||at>now||now-at>500)throw Error('Fresh five-servo hardware bridge sample required');
 if(previous&&(sample.bootId!==previous.bootId||sample.sequence<=previous.sequence||at<=Date.parse(previous.observedAt)||at-Date.parse(previous.observedAt)>500))throw Error('Bridge rebooted or feedback was repeated/interrupted');
 for(const [i,id]of [11,12,13,14,15].entries()){
  const s=sample.servos[i];
  if(s.id!==id||s.readOk!==true||s.mode!==0||s.torqueEnabled!==1||s.voltageDeciV<70||s.voltageDeciV>126||s.temperatureC>60||stationary&&s.moving!==0)throw Error('Servo position mode, torque, voltage, temperature or stationary check failed');
 }
 if(Math.abs(sample.servos[1].encoderCount+sample.servos[2].encoderCount-4094)>2)throw Error('Independent paired shoulder positions do not match the source complement');
 return sample;
}
