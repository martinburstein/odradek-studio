import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {Controller} from './controller.mjs';
import {MANUAL_ENDPOINT_ERROR_DEGREES} from './manual-joints.mjs';
import {revokeRoutineMotionConsent} from './routine-motion-consent.mjs';
import {readRoutineMotionConsent} from './routine-motion-consent.mjs';
import {createPilotControl} from './pilot-control.mjs';
import {lazyPilot} from './lazy-pilot.mjs';
import {createHardwarePilotControl} from './hardware-pilot-control.mjs';
import {createPilotOwnerObserver} from './pilot-owner-observer.mjs';
import {parsePilotCommand} from './pilot-commands.mjs';
import {classifyRequest,permitSession,validatePrivateOrigin} from './request-policy.mjs';
import {createAuth} from './auth.mjs';
import {createAuthGuard} from './auth-guard.mjs';
import {createOwnership} from './ownership.mjs';
import {createSessionAuthority} from './session-authority.mjs';
import {projectStatus} from './status-view.mjs';
import {createCameraSource} from './camera-source.mjs';
import {createSyncReader} from './sync-view.mjs';
import {createSyncUsage} from './sync-usage.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PUBLIC=path.join(ROOT,'public');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
export async function createServer({directory=path.join(ROOT,'runtime'),port=8787,host='127.0.0.1',transportFactory,shutdownTimeoutMs=3500,privateOrigin,cameraConfig,ownershipOptions}={}){
 if(host!=='127.0.0.1')throw Error('Listener must stay loopback. Use authenticated private HTTPS proxy.');
 await fs.mkdir(directory,{recursive:true});
 const readConfig=async name=>{try{return JSON.parse(await fs.readFile(path.join(directory,name),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw Error('Invalid private configuration');}};
 const proxy=await readConfig('private-access.json');privateOrigin=validatePrivateOrigin(privateOrigin??proxy?.origin);
 const camera=createCameraSource(cameraConfig??await readConfig('camera.json'));
 const auth=createAuthGuard(await createAuth({directory}));await auth.initialize();
 if(!Number.isInteger(shutdownTimeoutMs)||shutdownTimeoutMs<20||shutdownTimeoutMs>10000)throw Error('Invalid shutdown deadline');
 const controller=new Controller({directory,transportFactory});let url,closing=false,closePromise;const sockets=new Set();
 const readSync=createSyncReader({controller,root:ROOT,directory}),syncUsage=createSyncUsage({root:ROOT,directory});
 const authority=createSessionAuthority({controller,ownership:createOwnership(ownershipOptions)});
 let ownerCredential=null;const pendingCredentials=new Set();
 const ownerObserver=createPilotOwnerObserver();
 const renewOwner=ownerObserver.wrap('renew',(...args)=>authority.renew(...args));
 const pilot=lazyPilot(()=>createPilotControl({controller,directory,sourceRoot:ROOT,lifecycleObserver:ownerObserver,readConsent:()=>readRoutineMotionConsent(directory),...ownerObserver.wrapCallbacks({claim:async context=>{
  const proof={req:context.req,classification:context.classification,deviceId:context.session.deviceId};pendingCredentials.add(proof);
  try{const result=await authority.claim(context.session,'melchior-pilot');ownerCredential=proof;return result;}finally{pendingCredentials.delete(proof);}
 },release:context=>authority.release(context.session,'melchior-pilot'),beginTask:duration=>authority.beginTask(duration),endTask:()=>authority.endTask()})}));
 const hardwarePilot=lazyPilot(()=>createHardwarePilotControl({controller,authority,claim:async context=>{
  const proof={req:context.req,classification:context.classification,deviceId:context.session.deviceId};pendingCredentials.add(proof);
  try{const result=await authority.claim(context.session,'melchior-pilot');ownerCredential=proof;return result;}finally{pendingCredentials.delete(proof);}
 },release:context=>authority.release(context.session,'melchior-pilot')}));
 const browserSessions=new Map();
 const cookieToken=req=>(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('robot_session='))?.slice(14);
 const authenticate=async(req,classification)=>{
  if(req.headers.authorization)return permitSession(await auth.authenticate(req),classification);
  if((req.headers.cookie??'').split(';').filter(x=>x.trim().startsWith('robot_session=')).length>1)return null;
  const token=cookieToken(req),local=browserSessions.get(token);
  if(!req.headers.authorization&&classification.local&&local&&local.expiresAt>Date.now())return local;
  // The persisted administrator bearer credential never bootstraps a cookie.
  const paired=await auth.authenticate(req);return paired?.role==='admin'?null:permitSession(paired,classification);
 };
 const setCookie=(res,token,classification)=>res.setHeader('Set-Cookie',`robot_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${classification.secure?'; Secure':''}`);
 const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
 const server=http.createServer({requestTimeout:10000,headersTimeout:5000},async(req,res)=>{
  try{
   if(closing)return send(res,503,{error:'Application is shutting down; controls are unavailable'});
   let classification;try{classification=classifyRequest(req,{localUrl:url,privateOrigin});}catch(error){return send(res,403,{error:error.message});}
   const route=new URL(req.url,url).pathname;
   if(req.method==='GET'&&route==='/api/health')return send(res,200,{ok:true,application:'waveshare-robotic-arm',syncView:true});
   if(req.method==='GET'&&route==='/camera/frame'){
    if(!await authenticate(req,classification))return send(res,401,{error:'Authentication required'});
    if(!camera.configured)return send(res,503,{error:'Camera is not configured'});
    const abort=new AbortController();res.once('close',()=>abort.abort());
    try{const frame=await camera.snapshot({signal:abort.signal});res.writeHead(200,{'Content-Type':frame.type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(frame.bytes);}catch{return send(res,503,{error:'Camera observation unavailable'});}
   }
   if(!route.startsWith('/api/')){
    if(req.method!=='GET')return send(res,405,{error:'GET required'});
    const relative=decodeURIComponent(route).replace(/^\/+/,''),file=path.resolve(PUBLIC,relative||'index.html');
    if(!file.startsWith(PUBLIC+path.sep))return send(res,403,{error:'Invalid path'});
    const content=await fs.readFile(file);
    if(file.endsWith('index.html')&&classification.local&&!await authenticate(req,classification)){
     for(const [key,value]of browserSessions)if(value.expiresAt<=Date.now())browserSessions.delete(key);
     if(browserSessions.size>=64)browserSessions.delete(browserSessions.keys().next().value);
     const token=randomBytes(32).toString('base64url');browserSessions.set(token,{role:'admin',deviceId:`local-${randomBytes(12).toString('hex')}`,expiresAt:Date.now()+28800000});setCookie(res,token,classification);
    }
    const studioView=classification.local&&['/studio/manual/index.html','/studio/automatic/index.html'].includes(route);
    const frameAncestors=studioView?'http://127.0.0.1:8790':"'none'";
    res.writeHead(200,{'Content-Type':types[path.extname(file)]??'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors ${frameAncestors}; base-uri 'none'`});return res.end(content);
   }
   let session=await authenticate(req,classification);
   const redemption=req.method==='POST'&&route==='/api/pairing/redeem';
   if(!session&&!redemption)return send(res,401,{error:'Authentication required'});
   if(req.method==='GET'&&route==='/api/session')return send(res,200,{role:session.role,deviceId:session.deviceId,...classification});
   if(req.method==='GET'&&['/api/sync','/api/sync/usage'].includes(route)){
    if(session.role!=='admin'||!classification.local)return send(res,403,{error:'Local administrator required'});
    return send(res,200,route==='/api/sync'?await readSync():await syncUsage.read());
   }
   if(req.method==='GET'&&route==='/api/pilot/state')return session.role==='admin'&&classification.local?send(res,200,{...pilot.state(),hardwareJob:hardwarePilot.state(),ownerTrace:{events:ownerObserver.events(),status:ownerObserver.status()}}):send(res,403,{error:'Local administrator required'});
   if(req.method==='GET'&&route==='/api/manual/state'){
    try{
     const c=await controller.movement.physicalConfig();if(!c.manualReview)return send(res,200,{ready:false,reason:'All-joint qualification is required.'});
     const h=await controller.movement.history({readOnly:true}),{assertManualHistory}=await import('./manual-joints-review.mjs'),{acceptedFactoryRecovery}=await import('./movement.mjs'),{eligibleManualRecovery,eligibleManualTimeout,eligibleManualCancelled,validateTimeoutRecoveryReview,manualOriginalDigest}=await import('./manual-pose-recovery.mjs'),last=h.commands.at(-1);
     const {crashRecoveryEnabled,eligibleCrashRecovery,eligibleManualShortfallRepair,eligibleManualAbortRepair}=await import('./manual-crash-recovery.mjs');
     if(crashRecoveryEnabled(c)&&(eligibleCrashRecovery(last)||eligibleManualShortfallRepair(last)||eligibleManualAbortRepair(last))&&last.manual.reviewId===c.manualReview.id){
      assertManualHistory(c,{...h,commands:h.commands.slice(0,-1)},acceptedFactoryRecovery);
      return send(res,200,{ready:false,reason:eligibleManualAbortRepair(last)?'The last Manual move was stopped. Use Review & repair position to accept its stationary position without retrying it.':eligibleManualShortfallRepair(last)?'The last joint stopped short. Use Review & repair position for a stationary check; the failed target will not be retried.':'A Manual move was interrupted. Use Review & repair position to inspect and accept the stationary position without replaying it.',recovery:{kind:eligibleManualAbortRepair(last)?'aborted':eligibleManualShortfallRepair(last)?'shortfall':'crash',commandId:last.id,originalRowSHA256:manualOriginalDigest(last)}});
     }
     if(c.profile.phase==='qualified'&&(eligibleManualRecovery(last)||eligibleManualTimeout(last))&&last.manual.reviewId===c.manualReview.id){
      if(eligibleManualTimeout(last))validateTimeoutRecoveryReview(last,c.manualReview.timeoutRecovery);
      assertManualHistory(c,{...h,commands:h.commands.slice(0,-1)},acceptedFactoryRecovery);
      if(eligibleManualCancelled(last))return send(res,200,{ready:false,reason:'Canceled gripper result preserved. Complete the prepared stationary stylus recovery in chat; no target will be retried.'});
      const {isManualTimeoutRestartAuthorization}=await import('./manual-restart-qualification.mjs'),powerCycle=eligibleManualTimeout(last)&&isManualTimeoutRestartAuthorization(c.manualReview.timeoutRecovery);
      return send(res,200,{ready:false,reason:powerCycle?'The arm was power-cycled after a timeout. Inspect its reviewed current pose before read-only qualification.':eligibleManualTimeout(last)?(last.result.error==='The operation was aborted'?'The last command was stopped. Inspect the stationary arm before read-only recovery.':'The last command timed out. Inspect the stationary arm before read-only recovery.'):'Position changed during the last move. Inspect the arm, then recover its current position.',recovery:{commandId:last.id,originalRowSHA256:manualOriginalDigest(last),...(powerCycle?{powerCycle:true}:{})}});
     }
     await controller.movement.readyHistory({readOnly:true});assertManualHistory(c,h,acceptedFactoryRecovery);return send(res,200,{ready:c.profile.phase==='qualified',phase:c.profile.phase,reason:c.profile.phase==='qualified'?'':'Calibration program is pending physical inspection.',servo13PositionIndependentlyMonitored:false,endpointToleranceDegrees:MANUAL_ENDPOINT_ERROR_DEGREES});
    }catch(error){return send(res,200,{ready:false,reason:error.message});}
   }
   if(req.method==='GET'&&route==='/api/status'){
    await authority.expire();const status=projectStatus(await controller.withForeground(()=>controller.status()),{role:session.role});
    const binding=authority.snapshot();status.ownership={expiresAt:binding.lease.expiresAt,active:binding.lease.active,ownedByThisDevice:binding.lease.owner===session.deviceId,cleanupPending:binding.cleanupPending};
    status.camera={configured:camera.configured,url:camera.configured?'/camera/frame':null};return send(res,200,status);
   }
   if(req.method==='GET'&&route==='/api/devices')return session.role==='admin'&&classification.local?send(res,200,{devices:await auth.listDevices()}):send(res,403,{error:'Local administrator required'});
   if(req.method!=='POST')return send(res,405,{error:'POST required'});
   if(req.headers['content-type']?.split(';')[0]!=='application/json')return send(res,415,{error:'JSON content type required'});
   let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>32768){send(res,413,{error:'Request too large'});req.destroy();return;}}
   let body;try{body=JSON.parse(raw||'{}');}catch{throw Error('Malformed JSON request');}if(!body||typeof body!=='object'||Array.isArray(body))throw Error('JSON object required');
   if(closing)return send(res,503,{error:'Application is shutting down; controls are unavailable'});
   if(redemption){const device=await auth.redeemPairing(body.code);setCookie(res,device.token,classification);return send(res,200,{ok:true,role:device.role,deviceId:device.deviceId});}
   session=await authenticate(req,classification);if(!session)return send(res,401,{error:'Session expired or revoked'});
   if(closing)return send(res,503,{error:'Application is shutting down; controls are unavailable'});
   if(route==='/api/shutdown'){
    if(session.role!=='admin'||!classification.local)return send(res,403,{error:'Local administrator required'});
    closing=true;syncUsage.close();pilot.cancel();hardwarePilot.cancel();void controller.stop('Application shutdown requested').catch(()=>{});res.once('finish',()=>{void close();});return send(res,200,{shutdownRequested:true,armed:false,physicalStopVerified:false});
   }
   if(route==='/api/pairing/issue'||route==='/api/devices/revoke'){
    if(session.role!=='admin'||!classification.local)return send(res,403,{error:'Local administrator required'});
    if(route==='/api/pairing/issue')return send(res,200,{ok:true,...await auth.issuePairing({role:body.role})});
    const revocation=auth.revoke(body.deviceId);revocation.catch(()=>{});
    await authority.revoke(body.deviceId);await revocation;return send(res,200,{ok:true,revoked:true});
   }
   if((route.startsWith('/api/z-lift/')||route.startsWith('/api/movement/'))&&(session.role!=='admin'||!classification.local))return send(res,403,{error:'Supervised lift requires a local administrator'});
   if(!['admin','control'].includes(session.role))return send(res,403,{error:'Observer access cannot control the robot'});
   if(route==='/api/pilot/command'){
    if(session.role!=='admin'||!classification.local)return send(res,403,{error:'Local administrator required'});
    if(Object.keys(body).some(key=>!['commandId','line','cameraObservation','inspection'].includes(key)))throw Error('Unexpected pilot command fields');
    const command=parsePilotCommand(body.line);if(command.kind==='wave')throw Error('WAVE runs in the Pilot console as two separately camera-admitted DOWN/UP legs');if(!['move','qualify','reference','hardware-program'].includes(command.kind))throw Error('Use GET pilot/state for status and POST stop for software stop');
    const context={session,classification,req:{headers:{authorization:req.headers.authorization,cookie:req.headers.cookie}},
     checkLive:()=>{if(closing)throw Error('Application is shutting down');auth.assertLive(session);},
     admit:()=>{if(closing)throw Error('Application is shutting down');auth.assertLive(session);authority.admit(session,'melchior-pilot');},
     beginTask:()=>authority.beginTask(55000),endTask:()=>authority.endTask()};
    context.checkLive();
    const oldJob=pilot.state().job,newJob=hardwarePilot.state();
    if(oldJob&&!['complete','failed','cancelled'].includes(oldJob.phase)||newJob&&!['complete','failed','cancelled'].includes(newJob.phase))throw Error('Pilot already has one outstanding operation');
    if(command.kind==='hardware-program'){
     if(Object.keys(body).some(k=>!['commandId','line'].includes(k)))throw Error('Hardware programs use private reviewed consent and camera metadata; API assertions are rejected');
     return send(res,202,await hardwarePilot.submit({commandId:body.commandId,name:command.name},context));
    }
    return send(res,202,pilot.submit({...body,command},ownerObserver.wrapContext(context)));
   }
   if(route!=='/api/stop'&&route!=='/api/owner')await authority.assertDevice(session,body.owner,{requireOwner:['/api/arm','/api/move','/api/task','/api/calibration','/api/renew','/api/release','/api/z-lift/prepare','/api/z-lift/execute','/api/z-lift/observe','/api/movement/preview','/api/movement/session','/api/movement/execute','/api/movement/reconcile','/api/movement/crash-recover','/api/movement/rebaseline','/api/movement/reset-recover'].includes(route)});
   if(!await authenticate(req,classification))return send(res,401,{error:'Session expired or revoked'});
   if(['/api/arm','/api/move','/api/task','/api/calibration','/api/z-lift/prepare','/api/z-lift/execute','/api/z-lift/observe','/api/movement/preview','/api/movement/session','/api/movement/execute','/api/movement/reconcile','/api/movement/crash-recover','/api/movement/rebaseline','/api/movement/reset-recover'].includes(route))await renewOwner(session,body.owner);
   if(closing)return send(res,503,{error:'Application is shutting down; controls are unavailable'});
   auth.assertLive(session);
   if(route!=='/api/stop'&&route!=='/api/owner')authority.admit(session,body.owner,{requireOwner:['/api/arm','/api/move','/api/task','/api/calibration','/api/renew','/api/release','/api/z-lift/prepare','/api/z-lift/execute','/api/z-lift/observe','/api/movement/preview','/api/movement/session','/api/movement/execute','/api/movement/reconcile','/api/movement/crash-recover','/api/movement/rebaseline','/api/movement/reset-recover'].includes(route)});
   const motionAdmission=()=>{if(closing)throw Error('Application is shutting down');auth.assertLive(session);authority.admit(session,body.owner);};
   let result;
   switch(route){
    case '/api/movement/preview':result=await controller.movement.preview(body,motionAdmission);break;
    case '/api/movement/reconcile':result=await controller.movement.reconcile(body,motionAdmission);break;
    case '/api/movement/crash-recover':if(!classification.local)throw Error('Crash repair is local only');authority.beginTask(50000);try{result=await controller.movement.recoverCrash(body,motionAdmission);}finally{authority.endTask();}break;
    case '/api/movement/rebaseline':authority.beginTask(50000);try{result=await controller.movement.rebaseline(body,motionAdmission);}finally{authority.endTask();}break;
    case '/api/movement/reset-recover':authority.beginTask(50000);try{result=await controller.movement.resetRecover(body,motionAdmission);}finally{authority.endTask();}break;
    case '/api/movement/session':if(body.controlMode==='direct-manual'&&!classification.local)throw Error('Direct manual control is local only');authority.beginTask(50000);try{result=await controller.movement.begin(body,motionAdmission);}finally{authority.endTask();}break;
    case '/api/movement/execute':if(controller.movement.session?.manual)authority.beginManualTask();else authority.beginTask(55000);try{result=await controller.movement.execute(body,motionAdmission);}finally{authority.endTask();}break;
    case '/api/z-lift/prepare':result=await controller.zLift.prepare(body,motionAdmission);break;
    case '/api/z-lift/execute':authority.beginTask(25000);try{result=await controller.zLift.execute(body,motionAdmission);}finally{authority.endTask();}break;
    case '/api/z-lift/observe':result=await controller.zLift.observe(body);break;
    case '/api/connect':result=await controller.connect(body);break;
    case '/api/disconnect':result=await controller.disconnect();break;
    case '/api/commission':result=await controller.commission(body);break;
    case '/api/owner':{
     const proof={req:{headers:{authorization:req.headers.authorization,cookie:req.headers.cookie}},classification,deviceId:session.deviceId};pendingCredentials.add(proof);
     try{result=await authority.claim(session,body.owner);ownerCredential=proof;}finally{pendingCredentials.delete(proof);}break;
    }
    case '/api/renew':result=await renewOwner(session,body.owner);break;
    case '/api/release':result=await authority.release(session,body.owner);break;
    case '/api/arm':result=await controller.arm(body.armed,body.owner);break;
    case '/api/move':result=await controller.move(body,false,undefined,motionAdmission);break;
    case '/api/stop':pilot.cancel();hardwarePilot.cancel();try{await revokeRoutineMotionConsent(directory);}finally{result=await controller.stop();}break;
    case '/api/poses':result=await controller.poses.save(body.name,body.joints);break;
    case '/api/calibration':result=await controller.captureCalibration(body);break;
    case '/api/task':authority.beginTask(body.maxDurationMs);try{result=await controller.runTask(body,motionAdmission);}finally{authority.endTask();}break;
    case '/api/fault':if(controller.mode!=='simulator')throw Error('Fault injection only in simulator');controller.transport.setFault(body.name,body.value);result={ok:true};break;
    default:return send(res,404,{error:'Unknown endpoint'});
   }
   send(res,200,{ok:true,...(result??{})});
  }catch(error){send(res,error.code==='ENOENT'?404:400,{error:error.message});}
 });
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});url=`http://${host}:${server.address().port}`;
 const poll=setInterval(()=>{void (async()=>{
  for(const bound of new Set([ownerCredential,...pendingCredentials]))if(bound&&!await authenticate(bound.req,bound.classification)){await authority.revoke(bound.deviceId);if(ownerCredential===bound)ownerCredential=null;}
  await authority.expire();await controller.poll();
 })().catch(()=>{});},1500);poll.unref();
 const close=()=>closePromise??=(async()=>{
  closing=true;syncUsage.close();pilot.cancel();hardwarePilot.cancel();clearInterval(poll);
  const listenerClosed=new Promise(resolve=>server.close(resolve));server.closeIdleConnections();
  let cleanupSettled=false,cleanupVerified=false,cleanupError=null;
  const cleanup=(async()=>{
   await controller.stop('Application shutdown: cancel and drain hardware Pilot').catch(error=>{cleanupError=error.message;});
   await hardwarePilot.settle();
   await controller.disconnect();
   controller.assertIdle();
   cleanupVerified=!controller.recoveryFault&&!controller.outstanding.size&&!controller.busy&&!controller.taskActive&&!controller.lifecycle&&!controller.pendingConnectionClose;
  })().then(()=>{cleanupSettled=true;},error=>{cleanupSettled=true;cleanupError=error.message;});
  let timer;await Promise.race([Promise.all([cleanup,listenerClosed]),new Promise(resolve=>{timer=setTimeout(resolve,shutdownTimeoutMs);})]);clearTimeout(timer);
  for(const socket of sockets)socket.destroy();await listenerClosed;
  return {closed:true,cleanupVerified:cleanupSettled&&cleanupVerified,cleanupPending:!cleanupSettled,error:cleanupError,physicalStopVerified:false};
 })();
 return {server,url,controller,auth,authority,pilot,hardwarePilot,close};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const app=await createServer({port:Number(process.env.ROBOT_PORT??8787)});console.log(`RoArm console: ${app.url} — starts disconnected and disarmed.`);
 const shutdown=async()=>{const result=await app.close();if(result.cleanupVerified)process.exit(0);else{console.error('Listener closed; cleanup remains unresolved. Preserve pending hardware records and verify resource closure.');process.exitCode=1;}};process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
