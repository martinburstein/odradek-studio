// Lead integration: a human owner name is bound to one authenticated device.
// The separately reviewed ownership module supplies the finite lease clock.
export function createSessionAuthority({controller,ownership,now=Date.now}) {
 let binding=null,pendingClaim=null,taskDeadline=null,transition=null;const revoked=new Set();
 const requireControl=session=>{if(!session||!['control','admin'].includes(session.role)||typeof session.deviceId!=='string'||!session.deviceId||revoked.has(session.deviceId)||(session.expiresAt!==undefined&&session.expiresAt<=now()))throw Error('Authenticated non-revoked control device required');};
 const same=(session,owner)=>Boolean(binding&&binding.deviceId===session.deviceId&&binding.owner===owner);
 async function exclusive(action) {
  if(transition)throw Error('Ownership cleanup is pending');
  const operation=Promise.resolve().then(action);transition=operation;
  try{return await operation;}finally{if(transition===operation)transition=null;}
 }
 function forget() {
  if(binding){try{ownership.release(binding.deviceId);}catch{/* Already expired. */}}
  binding=null;taskDeadline=null;
 }
 async function expire() {
  if(binding&&controller.owner!==binding.owner&&!pendingClaim){forget();return;}
  const candidate=binding??pendingClaim;if(!candidate)return;
  // Renewal during a task ends at that task's original authorized deadline.
  // Idle observation alone never renews ownership.
  if(binding&&controller.taskActive&&taskDeadline!==null&&now()<taskDeadline){
   try{ownership.assert(binding.deviceId);ownership.renew(binding.deviceId);}catch{/* Expiry below stops the task. */}
  }
  try{ownership.assert(candidate.deviceId);return;}catch{}
  // Disarm even if an administrative claim is suspended in status persistence.
  // Admission stays held until that transition and cleanup have actually ended.
  if(transition){await controller.stop('Command owner lease expired during transition');return;}
  await exclusive(async()=>{
   await controller.stop('Command owner lease expired');
   controller.assertIdle();
   controller.owner=null;forget();
  });
 }
 async function claim(session,owner) {
  const action=()=>claimIdle(session,owner);
  return controller.withForeground?controller.withForeground(action):action();
 }
 async function claimIdle(session,owner) {
  requireControl(session);
  await expire();
  return exclusive(async()=>{
   requireControl(session);
   if(binding&&!same(session,owner))throw Error('Another device owns these controls');
   controller.assertIdle();
   if(controller.armed)throw Error('Disarm before claiming ownership');
   ownership.claim(session.deviceId);
   pendingClaim={deviceId:session.deviceId,owner};
   try{await controller.claim(owner);requireControl(session);ownership.assert(session.deviceId);binding={deviceId:session.deviceId,owner};}
   catch(error){await controller.stop('Ownership claim failed').catch(()=>{});if(!binding){controller.owner=null;try{ownership.release(session.deviceId);}catch{}}throw error;}
   finally{pendingClaim=null;}
   return {owner,lease:ownership.snapshot()};
  });
 }
 async function assertDevice(session,owner,{requireOwner=true}={}) {
  requireControl(session);
  await expire();
  requireControl(session);
  if(transition)throw Error('Ownership cleanup is pending');
  if(!binding){if(requireOwner)throw Error('Claim command ownership from this device first');return;}
  if(binding.deviceId!==session.deviceId||(owner!==undefined&&binding.owner!==owner))throw Error('Command owner belongs to another device');
  ownership.assert(binding.deviceId);
 }
 function admit(session,owner,{requireOwner=true}={}){
  requireControl(session);if(transition)throw Error('Ownership cleanup is pending');
  if(!binding){if(requireOwner)throw Error('Claim command ownership from this device first');return;}
  if(binding.deviceId!==session.deviceId||(owner!==undefined&&binding.owner!==owner))throw Error('Command owner belongs to another device');
  ownership.assert(binding.deviceId);
 }
 async function renew(session,owner) {
  await assertDevice(session,owner);ownership.renew(binding.deviceId);
  return {owner:binding.owner,lease:ownership.snapshot()};
 }
 async function release(session,owner) {
  await assertDevice(session,owner);
  return exclusive(async()=>{
   await controller.stop('Command owner released');controller.assertIdle();
   controller.owner=null;forget();return {released:true,armed:false};
  });
 }
 async function revoke(deviceId) {
  revoked.add(deviceId);
  if(binding?.deviceId!==deviceId&&pendingClaim?.deviceId!==deviceId)return;
  // Revocation disarms immediately; it does not wait behind a claim/status read.
  if(transition){try{ownership.release(deviceId);}catch{}await controller.stop('Command device revoked during transition');return;}
  return exclusive(async()=>{
   await controller.stop('Command device revoked');controller.assertIdle();
   controller.owner=null;forget();
  });
 }
 function beginTask(maxDurationMs) {
  if(!Number.isInteger(maxDurationMs)||maxDurationMs<1||maxDurationMs>60000)throw Error('Bounded task duration required');
  taskDeadline=now()+maxDurationMs;
 }
 function beginManualTask(){
  const m=controller.movement.session;if(!binding||!m?.manual||m.owner!==binding.owner||controller.armed||controller.commissioned||controller.mode!=='serial')throw Error('Reviewed serial manual session required');
  ownership.assert(binding.deviceId);taskDeadline=Math.min(now()+250000,m.until);
 }
 function endTask(){taskDeadline=null;}
 function beginHardwareProgramTask(){
  if(!binding||binding.owner!=='melchior-pilot'||controller.armed||controller.commissioned||controller.mode!=='serial')throw Error('Exclusive uncommissioned serial Pilot required');
  ownership.assert(binding.deviceId);taskDeadline=now()+360000;
 }
 return {claim,assertDevice,admit,renew,release,revoke,expire,beginTask,beginManualTask,beginHardwareProgramTask,endTask,
  snapshot:()=>({owner:binding?.owner??null,lease:ownership.snapshot(),cleanupPending:Boolean(transition)})};
}
