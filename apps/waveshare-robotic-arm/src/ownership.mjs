// Process-local timed ownership. Expiry invalidates authority but never transfers it.
export function createOwnership({now=Date.now,ttlMs=30000}={}) {
 if(typeof now!=='function')throw Error('now must be a function');
 if(!Number.isFinite(ttlMs)||ttlMs<=0)throw Error('ttlMs must be a positive finite number');
 let owner=null,expiresAt=null;
 const validOwner=id=>typeof id==='string'&&/^[-\w]{1,64}$/.test(id);
 function requireOwner(id){if(!validOwner(id))throw Error('Valid owner identifier required');}
 function active(){return owner!==null&&now()<expiresAt;}
 function claim(id){
  requireOwner(id);
  // Even an expired lease remains assigned until its lead disarms and releases it.
  if(owner!==null)throw Error(owner===id?'Ownership lease must be renewed or released':'Another owner holds this setup; disarm and release before takeover');
  owner=id;expiresAt=now()+ttlMs;return snapshot();
 }
 function assert(id){
  requireOwner(id);
  if(owner!==id)throw Error('Command owner mismatch');
  if(!active())throw Error('Command ownership lease expired; disarm and release before takeover');
  return true;
 }
 function renew(id){assert(id);expiresAt=now()+ttlMs;return snapshot();}
 function release(id){requireOwner(id);if(owner!==id)throw Error('Command owner mismatch');owner=null;expiresAt=null;return snapshot();}
 function snapshot(){const live=active();return {owner,expiresAt,active:live,remainingMs:live?Math.max(0,expiresAt-now()):0};}
 return {claim,renew,assert,release,snapshot};
}
