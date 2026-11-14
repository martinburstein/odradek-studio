// Immediate process-local revocation and synchronous admission capabilities.
// Disk failure is reported; no durable revocation is claimed until it succeeds.
export function createAuthGuard(auth,{now=Date.now}={}){
 const revoked=new Set(),pending=new Map();
 function assertLive(session){if(!session||!['admin','observer','control'].includes(session.role)||revoked.has(session.deviceId)||!(session.expiresAt>now()))throw Error('Session expired or revoked');return true;}
 async function authenticate(req){const session=await auth.authenticate(req);if(!session)return null;let expiresAt=Infinity;
  if(session.role!=='admin'){const devices=await auth.listDevices();const device=devices.find(d=>d.deviceId===session.deviceId);if(!device||!device.active)return null;expiresAt=Date.parse(device.expiresAt);}
  const capability={...session,expiresAt};try{assertLive(capability);return capability;}catch{return null;}
 }
 function revoke(deviceId){
  if(typeof deviceId!=='string'||!/^dev_[A-Za-z0-9_-]{20,80}$/.test(deviceId))return Promise.reject(Error('Invalid device identifier'));
  revoked.add(deviceId);if(pending.has(deviceId))return pending.get(deviceId);
  const operation=Promise.resolve().then(()=>auth.revoke(deviceId)).catch(()=>{throw Error('Revocation applied in memory but persistence failed; repair storage before restarting');});pending.set(deviceId,operation);
  operation.then(()=>pending.delete(deviceId),()=>pending.delete(deviceId));return operation;
 }
 return {...auth,authenticate,revoke,assertLive,async listDevices(){return (await auth.listDevices()).map(d=>revoked.has(d.deviceId)?{...d,active:false,revocationPending:true}:d);}};
}
