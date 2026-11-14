// Parser for an UNINSTALLED firmware candidate. It is deliberately not wired
// into the serial transport or any physical admission gate.
export const SHOULDER_PAIR_PROTOCOL='shoulder-pair-position-raw-v1';
const fields=['encoderCount'];
export function parseShoulderPairFeedback(raw,{receivedAt=Date.now()}={}){
  let v=raw;if(typeof v==='string'){if(v.length>4096)return null;try{v=JSON.parse(v);}catch{return null;}}
  if(typeof receivedAt!=='number'||!Number.isFinite(receivedAt))return null;
  const date=new Date(receivedAt),allowedRoot=['T','protocol','units','sampling','servos','status'];
  if(!Number.isFinite(receivedAt)||!Number.isFinite(date.getTime())||!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==allowedRoot.length||Object.keys(v).some(k=>!allowedRoot.includes(k))||v.T!==1161||v.protocol!==SHOULDER_PAIR_PROTOCOL||v.units!=='raw-ReadPos-encoder-count'||v.sampling!=='sequential-not-atomic'||!Array.isArray(v.servos)||v.servos.length!==2)return null;
  const servos=[];
  for(const [i,id] of [12,13].entries()){
    const s=v.servos[i];if(!s||s.id!==id||typeof s.readOk!=='boolean')return null;
    const allowed=s.readOk?['id','readOk',...fields]:['id','readOk'];
    if(Object.keys(s).length!==allowed.length||Object.keys(s).some(k=>!allowed.includes(k)))return null;
    if(s.readOk&&(!fields.every(k=>Number.isInteger(s[k]))||s.encoderCount<0||s.encoderCount>4095))return null;
    servos.push({...s});
  }
  const n=servos.filter(s=>s.readOk).length,status=n===2?'ok':n===1?'partial':'error';
  if(v.status!==status)return null;
  return {protocol:SHOULDER_PAIR_PROTOCOL,status,servos,units:v.units,sampling:v.sampling,
    receivedAt:date.toISOString(),source:'uninstalled-firmware-candidate',
    freshnessVerified:false,installedFirmwareVerified:false,pairedHealthQualified:false,
    physicalAdmission:false};
}
