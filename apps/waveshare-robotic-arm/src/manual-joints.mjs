import {SERVO_STEP,observedTicks,feedbackAtTicks,commandForTicks} from './z-lift-actuators.mjs';
import {trainingBodyBounds,tabletopGeometryPolicy} from './training-envelope.mjs';
import {adjacentLinkSeparationMm} from './other-joint-plan.mjs';
import {forwardKinematics,OFFSET_MODEL_REVISION} from './kinematics.mjs';
const forward=j=>forwardKinematics(j,OFFSET_MODEL_REVISION);
import {calibrationDigest,factoryCalibrationSources,FACTORY_APP_SHA256} from './factory-manual-calibration.mjs';
import fs from 'node:fs/promises';

export const MANUAL_REVISION='stock-tabletop-manual-v1';
export const MANUAL_NAMES=['base','shoulder','elbow','gripper'];
export const MANUAL_CONFIRMATIONS=['baseSecured','tabletop600mmClear','stockArmEmptyClamp','cablesSlack','powerSwitchReady'];
export const MANUAL_STYLUS_CONFIRMATIONS=['baseSecured','tabletop600mmClear','stylusHeldClear','cablesSlack','powerSwitchReady'];
export const CARDBOARD_STYLUS_REVISION='held-stylus-cardboard-rehearsal-v1';
export const MANUAL_CARDBOARD_CONFIRMATIONS=['baseSecured','tabletop600mmClear','stylusHeldSecure','cablesSlack','powerSwitchReady'];
export const stylusConfirmationKeys=scope=>scope?.revision===CARDBOARD_STYLUS_REVISION?MANUAL_CARDBOARD_CONFIRMATIONS:MANUAL_STYLUS_CONFIRMATIONS;
export function validateStylusTraining(scope,now=Date.now()){
 if(scope===undefined)return;
 const issued=Date.parse(scope.issuedAt),until=Date.parse(scope.expiresAt);
 if(scope.shoulderCoordination!==undefined&&scope.shoulderCoordination!==true)throw Error('Unknown stylus shoulder coordination option');
 if(scope.shoulderSpeed!==undefined&&(scope.shoulderCoordination!==true||![20,100].includes(scope.shoulderSpeed)))throw Error('Stylus shoulder speed must be reviewed as 20 or 100');
 if(scope.baseFeedForwardTicks!==undefined&&(!Number.isInteger(scope.baseFeedForwardTicks)||scope.baseFeedForwardTicks<0||scope.baseFeedForwardTicks>12))throw Error('Stylus base feed-forward must be zero through twelve ticks');
 const cardboard=scope.revision===CARDBOARD_STYLUS_REVISION;
 if(scope.coordinatedGlide!==undefined&&(!cardboard||scope.coordinatedGlide!==true))throw Error('Coordinated glide requires the explicit cardboard scope');
 if(scope.baseSwivel!==undefined&&(!cardboard||scope.baseSwivel!==true))throw Error('Base swivel requires the explicit cardboard scope');
 if((scope.revision!=='held-stylus-free-air-v1'&&!cardboard)||scope.gripperLocked!==true||scope.contactAllowed!==cardboard||!Number.isFinite(issued)||!Number.isFinite(until)||issued>now||until<=now||until<=issued||until-issued>4*3600000)throw Error('Current finite stylus scope required');
 if(cardboard&&(scope.surface!=='empty-shoebox-lid'||scope.controlMode!=='position-only'||scope.forceMeasured!==false||scope.baseLocked!==true||scope.maxNominalDownMm!==1||scope.maxSmallJointDegrees!==.25||scope.shoulderSpeed!==20))throw Error('Exact supervised cardboard position rehearsal scope required');
 if(!scope.boundsDegrees||Object.keys(scope.boundsDegrees).sort().join(',')!=='base,elbow,shoulder')throw Error('Explicit stylus workspace required');
 for(const j of ['base','shoulder','elbow']){const b=scope.boundsDegrees[j],limit=MANUAL_BOUNDS[j];if(!Array.isArray(b)||b.length!==2||!b.every(Number.isFinite)||b[0]>=b[1]||b[0]<limit[0]||b[1]>limit[1]||b[1]-b[0]>(j==='shoulder'?12:20))throw Error('Stylus workspace exceeds small training range');}
}
export function validateStylusTrainingPlan(plan,scope,now=Date.now(),record=true){
 if(scope===undefined)return;
 validateStylusTraining(scope,now);
 if(manualPlanJoints(plan).includes('shoulder')&&plan.movementJoint==='coordinated'&&plan.commands.some(c=>c.spd!==(scope.shoulderSpeed??20)||c.acc!==1))throw Error('Stylus shoulder commands differ from reviewed speed');
 if(manualPlanJoints(plan).includes('gripper')||plan.target.gripper!==plan.start.gripper||plan.commandTarget.gripper!==plan.start.gripper)throw Error('Stylus training keeps the gripper fixed');
 for(const j of ['base','shoulder','elbow']){const offset=j==='shoulder'?90:0,b=scope.boundsDegrees[j];for(const p of [plan.start,plan.target,plan.commandTarget]){const degrees=p[j]*180/Math.PI+offset;if(degrees<b[0]-1e-7||degrees>b[1]+1e-7)throw Error('Stylus path leaves the inspected workspace');}if(Math.abs(plan.target[j]-plan.start[j])*180/Math.PI>6+1e-7)throw Error('Stylus trial exceeds six degrees per joint');}
 if(scope.revision===CARDBOARD_STYLUS_REVISION){
  const selected=manualPlanJoints(plan),commandGoal=forward(plan.commandTarget);
  // A separately opted-in base-only stroke keeps the other joints fixed.
  // Its bounded yaw arc preserves modeled height; contact force is unmeasured.
  const swivel=scope.baseSwivel===true&&selected.length===1&&selected[0]==='base'&&
   ['shoulder','elbow','gripper'].every(j=>plan.target[j]===plan.start[j]&&plan.commandTarget[j]===plan.start[j])&&
   Math.abs(plan.target.base-plan.start.base)*180/Math.PI<=3+1e-7&&Math.abs(plan.commandTarget.base-plan.start.base)*180/Math.PI<=3+1e-7&&
   Math.abs(plan.goal.z-plan.from.z)<=1e-7&&Math.abs(commandGoal.z-plan.from.z)<=1e-7;
  if(!swivel&&(selected.includes('base')||plan.target.base!==plan.start.base||plan.commandTarget.base!==plan.start.base))throw Error('Cardboard rehearsal keeps the base fixed');
  // Nominal travel limits, not a force bound or calibrated stylus-tip measurement.
  // A single shoulder lift may use the existing larger escape path. Every
  // other command, including feed-forward, must remain a tiny position step.
  const retract=selected.length===1&&selected[0]==='shoulder'&&plan.target.shoulder<plan.start.shoulder&&plan.commandTarget.shoulder<plan.start.shoulder&&plan.goal.z>plan.from.z&&commandGoal.z>plan.from.z;
  // Explicit observed glide: opposite shoulder/elbow directions can exceed
  // the old tiny desired step while both modeled endpoints remain upward.
  // This retains ordinary feedback, geometry and per-joint endpoint limits.
  const glide=scope.coordinatedGlide===true&&selected.length===2&&selected.includes('shoulder')&&selected.includes('elbow')&&
   (plan.target.shoulder-plan.start.shoulder)*(plan.target.elbow-plan.start.elbow)<0&&
   Math.abs(plan.target.shoulder-plan.start.shoulder)*180/Math.PI<=3+1e-7&&Math.abs(plan.target.elbow-plan.start.elbow)*180/Math.PI<=3+1e-7&&
   plan.goal.z>=plan.from.z&&commandGoal.z>=plan.from.z&&Math.max(plan.goal.z-plan.from.z,commandGoal.z-plan.from.z)<=20+1e-7;
  if(!retract&&!glide&&!swivel){
   for(const joint of selected){
    const desired=plan.target[joint]-plan.start[joint],commanded=plan.commandTarget[joint]-plan.start[joint];
    if(Math.abs(desired)*180/Math.PI>scope.maxSmallJointDegrees+1e-7)throw Error('Cardboard step exceeds the small joint increment');
    if(Math.abs(commanded)*180/Math.PI>scope.maxSmallJointDegrees+1e-7){
     // Existing backlash compensation may add travel only on a lifting axis.
     // Desired strokes stay tiny; larger downward commands remain forbidden.
     const extra=plan.target[joint]-plan.commandTarget[joint],cap=(joint==='shoulder'?24:joint==='elbow'?12:0)*SERVO_STEP;
     const desiredAxis=forward({...plan.start,[joint]:plan.target[joint]}),commandAxis=forward({...plan.start,[joint]:plan.commandTarget[joint]});
     if(!(desired<0&&commanded<desired&&extra<=cap+1e-9&&desiredAxis.z>plan.from.z&&commandAxis.z>desiredAxis.z))throw Error('Cardboard step exceeds the small joint increment');
    }
   }
   if(Math.max(plan.from.z-plan.goal.z,plan.from.z-commandGoal.z)>scope.maxNominalDownMm+1e-7)throw Error('Cardboard step exceeds nominal downward endpoint travel');
  }
 }
 if(record)plan.stylusTraining=structuredClone(scope);
}
export const MANUAL_TEST_CONFIRMATIONS=['baseSecured','baseSectorClear','movementAuthorized'];
// Coarse endpoint acceptance, not a guarantee of actuator accuracy. The full
// path remains padded by u below; held drift does not reset between chain legs.
export const MANUAL_ENDPOINT_ERROR_DEGREES=Object.freeze({base:2.0,shoulder:2.0,elbow:1.0,gripper:1.0});
export const MANUAL_ENDPOINT_POLICY='canonical-per-joint-degrees-v2';
// Historical acceptance stays tied to its original policy after a limit change.
const MANUAL_ENDPOINT_ERROR_DEGREES_V1=Object.freeze({base:1.53,shoulder:1.24,elbow:.67,gripper:.35});
export const MANUAL_TOLERANCE=Object.freeze({heldTicks:3,settlingTicks:1});
export const MANUAL_DIRECT_HELD_POLICY='direct-manual-canonical-v2';
export const SAY_AH_COMPLETION='say-ah-loaded-gripper-v1';
// Only the closing half of the named loading sequence accepts a measured end
// position. The original requested target and residual remain in the receipt.
export function markSayAhClosing(plan,previous,now=Date.now()){
 const r=previous?.result,finished=Date.parse(previous?.finishedAt);
 if(plan.movementJoint==='gripper'&&plan.heldTolerancePolicy===MANUAL_DIRECT_HELD_POLICY&&
    previous?.state==='complete'&&!previous.manualRecovery&&previous.manual?.phase==='qualified'&&
    previous.plan?.experiment===MANUAL_REVISION&&previous.plan.movementJoint==='gripper'&&previous.plan.heldTolerancePolicy===MANUAL_DIRECT_HELD_POLICY&&
    previous.plan.start?.gripper>previous.plan.target?.gripper&&previous.move?.joint==='gripper'&&previous.move.targetDegrees===125&&
    r?.outcome==='manual-coarse-response'&&r.cleanupVerified===true&&r.requiresReconciliation===false&&
    Number.isFinite(finished)&&now-finished>=5000&&now-finished<=300000&&
    Math.abs(plan.start.gripper-r.observed?.gripper)<=manualEndpointToleranceRad('gripper')+1e-9&&
    Math.abs(plan.start.gripper-125*Math.PI/180)<=manualEndpointToleranceRad('gripper')+SERVO_STEP&&
    plan.desiredServoTargets?.gripper===Math.round(155*Math.PI/180/SERVO_STEP)&&plan.commandTarget.gripper===plan.target.gripper&&plan.target.gripper>plan.start.gripper){
  plan.completionPolicy=SAY_AH_COMPLETION;plan.loadingPredecessorId=previous.id;
 }
 return plan;
}
export function isSayAhClosingPlan(plan){
 return plan?.completionPolicy===SAY_AH_COMPLETION&&plan.movementJoint==='gripper'&&!plan.movementJoints&&
  plan.heldTolerancePolicy===MANUAL_DIRECT_HELD_POLICY&&typeof plan.loadingPredecessorId==='string'&&
  plan.desiredServoTargets?.gripper===Math.round(155*Math.PI/180/SERVO_STEP)&&
  plan.commandTarget?.gripper===plan.target?.gripper&&plan.target.gripper>plan.start.gripper&&
  Math.abs(plan.start.gripper-125*Math.PI/180)<=manualEndpointToleranceRad('gripper')+SERVO_STEP;
}
export function isAcceptedSayAhResult(row){
 const r=row?.result,p=row?.plan;
 if(!isSayAhClosingPlan(p)||r?.completionPolicy!==SAY_AH_COMPLETION||!Array.isArray(r.observations))return false;
 try{
  const expected=classifyManualSettling(r.observations,p);
  return ['acceptedEndpoint','observed','requestedTargetReached','signedEndpointErrorRad','residualDegrees','settled','requiresReconciliation','grippingForceVerified'].every(k=>JSON.stringify(r[k])===JSON.stringify(expected[k]));
 }catch{return false;}
}
export function assertSayAhHistoryRow(row,previous){
 if(row.plan?.completionPolicy===undefined&&row.result?.completionPolicy===undefined&&row.result?.acceptedEndpoint===undefined)return;
 const candidate={...row.plan};delete candidate.completionPolicy;delete candidate.loadingPredecessorId;
 markSayAhClosing(candidate,previous,Date.parse(row.createdAt));
 if(row.move?.joint!=='gripper'||row.move.targetDegrees!==155||row.plan?.loadingPredecessorId!==previous?.id||candidate.completionPolicy!==SAY_AH_COMPLETION||!isAcceptedSayAhResult(row))throw Error('Loaded gripper receipt or opening predecessor changed');
}
export function manualHeldToleranceRad(joint,plan){
 if(plan?.heldTolerancePolicy===undefined)return MANUAL_TOLERANCE.heldTicks*SERVO_STEP;
 if(plan.heldTolerancePolicy!==MANUAL_DIRECT_HELD_POLICY)throw Error('Unknown manual held-joint tolerance policy');
 return manualEndpointToleranceRad(joint,'canonical-per-joint-degrees-v2');
}

export function manualEndpointToleranceRad(joint,policy=MANUAL_ENDPOINT_POLICY){
 if(!MANUAL_NAMES.includes(joint))throw Error('Unknown manual joint for endpoint tolerance');
 const limits=policy===MANUAL_ENDPOINT_POLICY?MANUAL_ENDPOINT_ERROR_DEGREES:policy==='canonical-per-joint-degrees-v1'?MANUAL_ENDPOINT_ERROR_DEGREES_V1:null;
 if(!limits)throw Error('Unknown manual endpoint tolerance policy');
 return limits[joint]*Math.PI/180;
}
// Direct operator input may start inside the latest completed target's original
// acceptance band. This never clears a failed/recovered row or rebases history.
export function directManualStartWithinAcceptedEndpoint(row,pose){
 if(row?.state!=='complete'||row.manualRecovery||row.plan?.experiment!==MANUAL_REVISION||row.result?.cleanupVerified!==true||row.result?.requiresReconciliation||row.result?.outcome!=='manual-coarse-response')return false;
 const selected=manualPlanJoints(row.plan);
 if(!selected.length||selected.some(j=>!MANUAL_NAMES.includes(j)))return false;
 try{return MANUAL_NAMES.every(j=>{
  const moving=selected.includes(j),loaded=j==='gripper'&&isAcceptedSayAhResult(row),reference=loaded?row.result.observed.gripper:moving?row.plan.target?.[j]:(row.plan.heldTolerancePolicy?(row.plan.heldReference?.[j]??row.plan.start?.[j]):row.result.observed?.[j]),limit=moving?manualEndpointToleranceRad(j,row.plan.endpointTolerancePolicy===undefined?'canonical-per-joint-degrees-v1':row.plan.endpointTolerancePolicy):manualHeldToleranceRad(j,row.plan);
  return Number.isFinite(pose?.[j])&&Number.isFinite(reference)&&Math.abs(pose[j]-reference)<=limit+1e-9;
 });}catch{return false;}
}
export function validateManualTestWindow(window,now=Date.now()){
 if(window===undefined)return;
 const issued=Date.parse(window.issuedAt),expires=Date.parse(window.expiresAt);
 if(window.revision!=='finite-manual-combo-session-v1'||!Number.isFinite(issued)||!Number.isFinite(expires)||issued>now||expires<=now||expires-issued>2*3600000||typeof window.sourceInstruction!=='string'||window.sourceInstruction.length<30||JSON.stringify(window.baseDegrees)!=='[90,270]')throw Error('Current finite manual combo authority and base sector required');
 if(window.baseFeedForwardTicks!==undefined&&(!Number.isInteger(window.baseFeedForwardTicks)||window.baseFeedForwardTicks<0||window.baseFeedForwardTicks>12))throw Error('Reviewed base feed-forward is limited to zero through twelve ticks');
 validateManualJointFeedForward(window.jointFeedForwardTicks);
 if(window.guardedExit!==undefined&&window.guardedExit!=='shoulder-elbow-v1')throw Error('Unknown guarded manual exit policy');
}
export function validateManualJointFeedForward(table){
 if(table===undefined)return;
 if(!table||typeof table!=='object'||Array.isArray(table))throw Error('Reviewed joint feed-forward table required');
 for(const [joint,directions]of Object.entries(table)){
  const cap=joint==='shoulder'?24:joint==='elbow'?12:0;
  if(!cap||!directions||typeof directions!=='object'||Array.isArray(directions))throw Error('Feed-forward table supports shoulder and elbow only');
  for(const [direction,ticks]of Object.entries(directions))if(!['positive','negative'].includes(direction)||!Number.isInteger(ticks)||Math.abs(ticks)>cap)throw Error('Joint feed-forward exceeds its reviewed direction or tick bound');
 }
}
export function validateManualBaseSector(pose,window,padding=0){
 if(!window)return;
 const degrees=pose.base*180/Math.PI,heading=((degrees%360)+360)%360;
 if(!Number.isFinite(heading)||heading-padding<window.baseDegrees[0]-1e-7||heading+padding>window.baseDegrees[1]+1e-7)throw Error('Manual combo base must remain within the authorized 90–270 degree sector');
}
export function validateManualTestPlan(plan,window){
 if(!window)return;
 validateManualTestWindow(window);
 validateManualBaseSector(plan.start,window,MANUAL_ENDPOINT_ERROR_DEGREES.base);
 validateManualBaseSector(plan.target,window,MANUAL_ENDPOINT_ERROR_DEGREES.base);
 if(plan.commandTarget)validateManualBaseSector(plan.commandTarget,window,MANUAL_ENDPOINT_ERROR_DEGREES.base);
 // The signed raw path must stay on one side of zero; no wrap or full turn.
 if(Math.sign(plan.start.base)!==Math.sign(plan.target.base))throw Error('Manual combo cannot cross the forbidden base sector');
 plan.manualTestWindow=structuredClone(window);
}
export const MANUAL_BOUNDS={base:[-180,180],shoulder:[0,180],elbow:[0,180],gripper:[61.9,179.912109375]};
const tickBounds={base:[1,4095],shoulder:[1024,3071],elbow:[1024,3071],gripper:[705,2047]};
const u=.0465+SERVO_STEP;
const sourceFiles=['public/studio/manual/index.html','src/studio-repair.mjs','src/preset-server.mjs','public/presets/app.js','public/presets/index.html','tools/studio.mjs','tools/studio-connection.mjs','src/manual-crash-recovery.mjs','src/safety.mjs','src/ownership.mjs','src/base-feedforward-hypothesis.mjs','src/manual-joints.mjs','src/manual-joints-review.mjs','src/manual-pose-recovery.mjs','src/manual-restart-qualification.mjs','src/manual-settled-exit.mjs','public/manual/index.html','public/manual/model.js','public/manual/app.js','tools/movement.mjs','tools/movement-actions.mjs','tools/manual-observation-client.mjs','tools/manual-perception-client.mjs','tools/perception/compare-camera-frames.py','tools/perception/live-perception-observer.py'];
export async function manualSources(){return {...await factoryCalibrationSources(),...Object.fromEntries(await Promise.all(sourceFiles.map(async f=>[f,calibrationDigest(await fs.readFile(new URL('../'+f,import.meta.url)))])))};}
export function normalizeManualMove(value,{allowShoulder=false}={}){
 if(value&&Object.keys(value).join(',')==='targets'){
  const keys=value.targets&&Object.keys(value.targets).sort();
  if(!value.targets||Array.isArray(value.targets)||!(keys.join(',')==='base,elbow'||allowShoulder===true&&keys.length>=2&&keys.length<=3&&keys.every(j=>['base','shoulder','elbow'].includes(j))))throw Error('Coordinated manual movement requires explicit reviewed arm-joint targets');
  const targets={};for(const joint of ['base','shoulder','elbow'].filter(j=>keys.includes(j)))targets[joint]=normalizeManualMove({joint,targetDegrees:value.targets[joint]}).targetDegrees;
  return {targets};
 }
 if(!value||Object.keys(value).sort().join(',')!=='joint,targetDegrees'||!MANUAL_NAMES.includes(value.joint)||!Number.isFinite(value.targetDegrees))throw Error('Manual movement requires one joint and a finite absolute targetDegrees');
 const [lo,hi]=MANUAL_BOUNDS[value.joint];if(value.targetDegrees<lo||value.targetDegrees>hi)throw Error('Target exceeds the stock manual joint range');
 return {joint:value.joint,targetDegrees:value.targetDegrees};
}
export const manualMoveJoints=move=>move.targets?Object.keys(move.targets):[move.joint];
export const manualPlanJoints=plan=>plan.movementJoints??[plan.movementJoint];
export function manualMoveForTick(joint,tick){const p=feedbackAtTicks({base:2048,shoulder:2048,elbow:2048,gripper:2047,[joint]:tick});return {joint,targetDegrees:p[joint]*180/Math.PI+(joint==='shoulder'?90:0)};}
const range=(a,b)=>{const n=Math.max(1,Math.ceil((b-a)/.004));return Array.from({length:n+1},(_,i)=>a+(b-a)*i/n);};
const gap=(a,b)=>Math.max(...[0,1,2].map(k=>Math.max(a.min[k]-b.max[k],b.min[k]-a.max[k])));
// Pinned vendor URDF/SRDF f06b2ed6c1ddc5b7690975fdbba84aab626a2229.
// Exact pair exclusions: base_link/link1, base_link/link2, link1/link2,
// gripper_link/link3. Upper/distal retains the stricter 60mm collar rule.
// Cylinder AABB contains every fixed-base mesh vertex for every base yaw.
const verifiedEnvelopes=new Map();
export function manualEnvelope(start,target){
 if(MANUAL_NAMES.some(k=>!Number.isFinite(start?.[k])||!Number.isFinite(target?.[k])))throw Error('Finite joint poses required for manual geometry');
 // Exact poses only: no rounding or nearby-pose reuse. Return copies so callers
 // cannot mutate a previously checked geometry result. Failures are not cached.
 const floorPolicy=tabletopGeometryPolicy({alreadyTabletop:true}),key=JSON.stringify(MANUAL_NAMES.flatMap(k=>[start[k],target[k]])),cached=verifiedEnvelopes.get(key);
 if(cached)return structuredClone(cached);
 const base={min:[-69.4,-69.4,-123.1],max:[69.4,69.4,-39.4]},minimumBodyHeightMm={mount:Infinity,upper:Infinity,distal:Infinity,finger:Infinity};let minimumSelfSeparationMm=Infinity,count=0;
 const rs=range(Math.min(start.shoulder,target.shoulder)-u,Math.max(start.shoulder,target.shoulder)+u),re=range(Math.min(start.elbow,target.elbow)-u,Math.max(start.elbow,target.elbow)+u),rg=range(Math.min(start.gripper,target.gripper)-u,Math.max(start.gripper,target.gripper)+u);
 for(const shoulder of rs)for(const elbow of re)for(const gripper of rg){
  const b=trainingBodyBounds({...start,shoulder,elbow,gripper});count++;
  for(const k of Object.keys(minimumBodyHeightMm)){const h=b[k].min[2]+123.059270461-2;minimumBodyHeightMm[k]=Math.min(minimumBodyHeightMm[k],h);if(h<floorPolicy.requiredBodyHeightMm)throw Error('Requested path crosses the tabletop plane: '+k);}
  const d=Math.min(adjacentLinkSeparationMm(elbow),gap(b.upper,b.finger),gap(b.mount,b.distal),gap(b.mount,b.finger),gap(base,b.distal),gap(base,b.finger))-2;
  minimumSelfSeparationMm=Math.min(minimumSelfSeparationMm,d);if(d<24)throw Error('Requested path brings arm parts too close together');
 }
 const result={revision:MANUAL_REVISION,plane:'tabletop',...floorPolicy.fields,wholeIntervalChecked:true,uncertaintyRad:u,maximumGridStepRad:.004,interpolationRemainderMm:2,requiredBodyHeightMm:floorPolicy.requiredBodyHeightMm,requiredSelfSeparationMm:24,minimumBodyHeightMm,minimumSelfSeparationMm,gridConfigurations:count,externalObjectsVerified:false};
 verifiedEnvelopes.set(key,structuredClone(result));if(verifiedEnvelopes.size>16)verifiedEnvelopes.delete(verifiedEnvelopes.keys().next().value);
 return result;
}
export function validateCoordinatedDynamics(speed=20,acceleration=1){
 if(!((speed===20||speed===100)&&acceleration===1||speed===819&&acceleration===51))throw Error('Reviewed coordinated speed/acceleration pair must be 20/1, 100/1 or 819/51');
}
export function planManual(request,start,cartesian,baseFeedForwardTicks=0,jointFeedForwardTicks,coordinatedSpeed=20,coordinatedAcceleration=1,allowShoulderCoordination=false){
 validateCoordinatedDynamics(coordinatedSpeed,coordinatedAcceleration);
 if(request?.targets){
  const move=normalizeManualMove(request,{allowShoulder:allowShoulderCoordination}),movementJoints=manualMoveJoints(move),withShoulder=movementJoints.includes('shoulder');
  if(withShoulder&&(![20,100].includes(coordinatedSpeed)||coordinatedAcceleration!==1))throw Error('Stylus shoulder coordination requires speed 20 or 100 and acceleration 1');
  const components=movementJoints.map(joint=>planManual({joint,targetDegrees:move.targets[joint]},start,cartesian,baseFeedForwardTicks,jointFeedForwardTicks));
  const target={...start},commandTarget={...start},servoTargets={},desiredServoTargets={},commandOffsetTicks={};
  for(const component of components){const joint=component.movementJoint;target[joint]=component.target[joint];commandTarget[joint]=component.commandTarget[joint];servoTargets[joint]=component.servoTargets[joint];desiredServoTargets[joint]=component.desiredServoTargets[joint];commandOffsetTicks[joint]=component.commandOffsetTicks;}
  // Base+elbow can reuse its exact elbow interval; shoulder coordination must
  // check the entire combined shoulder/elbow box, including asynchronous onset.
  // Component checks remain required as well.
  const observationWindowMs=Math.max(...components.map(p=>p.observationWindowMs));
  return {experiment:MANUAL_REVISION,envelopeRevision:MANUAL_REVISION,movementJoint:'coordinated',movementJoints,start,target,commandTarget,command:null,commands:components.map(p=>({...p.command,spd:coordinatedSpeed,acc:coordinatedAcceleration})),dispatchMode:withShoulder?'back-to-back-stylus-arm-v1':'back-to-back-base-elbow-v1',servoTargets,desiredServoTargets,commandOffsetTicks,from:forward(start),goal:forward(target),modelAgreementMm:components[0].modelAgreementMm,envelope:withShoulder?manualEnvelope(start,commandTarget):structuredClone(components.find(component=>component.movementJoint==='elbow').envelope),observationWindowMs,durationMs:observationWindowMs+8000,endpointTolerancePolicy:MANUAL_ENDPOINT_POLICY,endpointToleranceDegrees:Object.fromEntries(movementJoints.map(j=>[j,MANUAL_ENDPOINT_ERROR_DEGREES[j]])),pairedPositionVerified:false,servo13PositionIndependentlyMonitored:false,physicalPathVerified:false};
 }
 if(coordinatedSpeed!==20||coordinatedAcceleration!==1)throw Error('Reviewed dynamics override applies only to coordinated base-and-elbow replay');
 if(!Number.isInteger(baseFeedForwardTicks)||baseFeedForwardTicks<0||baseFeedForwardTicks>12)throw Error('Reviewed base feed-forward is limited to zero through twelve ticks');
 validateManualJointFeedForward(jointFeedForwardTicks);
 const move=normalizeManualMove(request),joint=move.joint,ticks=observedTicks(start),raw=(move.targetDegrees-(joint==='shoulder'?90:0))*Math.PI/180;
 let tick=Math.round(joint==='base'?(Math.PI-raw)/SERVO_STEP:joint==='shoulder'?(Math.PI+raw)/SERVO_STEP:joint==='elbow'?(Math.PI/2+raw)/SERVO_STEP:raw/SERVO_STEP);
 tick=Math.max(tickBounds[joint][0],Math.min(tickBounds[joint][1],tick));
 if(Math.abs(tick-ticks[joint])<2)throw Error('Choose a target at least two encoder ticks away');
 const next={...ticks,[joint]:tick},target={...start,[joint]:feedbackAtTicks(next)[joint]},direction=Math.sign(target[joint]-start[joint]),signedOffset=joint==='base'?direction*baseFeedForwardTicks:jointFeedForwardTicks?.[joint]?.[direction>0?'positive':'negative']??0,commandTick=tick+signedOffset*(joint==='base'?-1:1);
 if(commandTick<tickBounds[joint][0]||commandTick>tickBounds[joint][1])throw Error('Feed-forward command exceeds the stock manual joint range');
 const commandTicks={...next,[joint]:commandTick},commandTarget={...target,[joint]:feedbackAtTicks(commandTicks)[joint]},command={T:101,joint:MANUAL_NAMES.indexOf(joint)+1,rad:commandForTicks(commandTicks)[joint],spd:20,acc:1};
 if(Math.sign(commandTarget[joint]-start[joint])!==direction||Math.abs(commandTick-ticks[joint])<2)throw Error('Feed-forward cannot reverse or erase the requested movement');
 const from=forward(start),modelAgreementMm=cartesian?Math.hypot(...['x','y','z'].map(k=>from[k]-cartesian[k])):Infinity;
 if(!Number.isFinite(modelAgreementMm)||modelAgreementMm>1)throw Error('Fresh firmware coordinates must agree with the source geometry');
 const envelope=manualEnvelope(start,commandTarget),observationWindowMs=Math.max(12000,Math.ceil(Math.abs(commandTick-ticks[joint])/20*1000)+5000);
 return {experiment:MANUAL_REVISION,envelopeRevision:MANUAL_REVISION,movementJoint:joint,start,target,commandTarget,command,servoTargets:{[joint]:commandTick},desiredServoTargets:{[joint]:tick},commandOffsetTicks:signedOffset,from,goal:forward(target),modelAgreementMm,envelope,observationWindowMs,durationMs:observationWindowMs+8000,endpointTolerancePolicy:MANUAL_ENDPOINT_POLICY,endpointToleranceDegrees:MANUAL_ENDPOINT_ERROR_DEGREES[joint],pairedPositionVerified:false,servo13PositionIndependentlyMonitored:false,physicalPathVerified:false};
}
export function validateManualFeedback(joints,plan,endpointPolicy=MANUAL_ENDPOINT_POLICY){
 validateManualBaseSector(joints,plan.manualTestWindow);
 observedTicks(joints);const selected=manualPlanJoints(plan);
 for(const a of selected){const sign=Math.sign(plan.target[a]-plan.start[a]);if((joints[a]-plan.start[a])*sign< -MANUAL_TOLERANCE.heldTicks*SERVO_STEP-1e-9)throw Error('Wrong-direction manual movement');}
 for(const k of MANUAL_NAMES){const moving=selected.includes(k),tolerance=(moving?manualEndpointToleranceRad(k,endpointPolicy):manualHeldToleranceRad(k,plan))+1e-9,lo=moving?Math.min(plan.start[k],plan.target[k],plan.commandTarget?.[k]??plan.target[k]):(plan.heldReference?.[k]??plan.start[k]),hi=moving?Math.max(plan.start[k],plan.target[k],plan.commandTarget?.[k]??plan.target[k]):lo;if(joints[k]<lo-tolerance||joints[k]>hi+tolerance)throw Error('Unexpected manual joint displacement');}
}
export function classifyManualSettling(samples,plan){
 const loaded=isSayAhClosingPlan(plan);
 if(plan.completionPolicy!==undefined&&!loaded)throw Error('Invalid loaded gripper completion plan');
 if(samples.length<10)throw Error('Insufficient manual observations');
 let previous=null;for(const s of samples){validateManualFeedback(s.joints,plan);const at=Date.parse(s.observedAt);if(!Number.isFinite(at)||(previous!==null&&(at<=previous||at-previous>500)))throw Error('Manual feedback was stale or interrupted');previous=at;}
 const last=samples.at(-1),end=Date.parse(last.observedAt),i=samples.findIndex(s=>end-Date.parse(s.observedAt)<=1600),dwell=samples.slice(Math.max(0,i-1));
 if(end-Date.parse(dwell[0].observedAt)<1600||dwell.length<9)throw Error('Insufficient manual settling dwell');
 for(const k of MANUAL_NAMES)if(dwell.some(s=>Math.abs(s.joints[k]-last.joints[k])>SERVO_STEP+1e-9))throw Error('Manual joint has not settled');
 const selected=manualPlanJoints(plan),residualByJointDegrees={},movementByJointTicks={};
 for(const joint of selected){const error=last.joints[joint]-plan.target[joint];if(!loaded&&Math.abs(error)>manualEndpointToleranceRad(joint)+1e-9)throw Error('Manual command did not produce a sufficient settled response within the '+joint+' endpoint limit');residualByJointDegrees[joint]=error*180/Math.PI;movementByJointTicks[joint]=Math.abs(last.joints[joint]-plan.start[joint])/SERVO_STEP;}
 if(plan.movementJoints&&selected.some(j=>movementByJointTicks[j]<=1))throw Error('Each coordinated joint must produce a measured response');
 const a=selected.reduce((worst,j)=>Math.abs(residualByJointDegrees[j])/MANUAL_ENDPOINT_ERROR_DEGREES[j]>Math.abs(residualByJointDegrees[worst])/MANUAL_ENDPOINT_ERROR_DEGREES[worst]?j:worst,selected[0]),error=last.joints[a]-plan.target[a],moved=Math.min(...Object.values(movementByJointTicks));
 const tolerance=manualEndpointToleranceRad(a);
 if(!loaded&&Math.abs(error)>tolerance+1e-9)throw Error('Manual command did not produce a sufficient settled response within the '+a+' endpoint limit');
 return {outcome:'manual-coarse-response',...(loaded?{completionPolicy:SAY_AH_COMPLETION,acceptedEndpoint:{...last.joints},requestedTargetReached:Math.abs(error)<=tolerance+1e-9,grippingForceVerified:false}:{}),preciseArrival:false,movementDetected:moved>1,settled:true,settlingToleranceTicks:1,settlingDwellMs:end-Date.parse(dwell[0].observedAt),signedEndpointErrorRad:error,residualDegrees:error*180/Math.PI,...(plan.movementJoints?{residualJoint:a,residualByJointDegrees,movementByJointTicks,endpointToleranceByJointDegrees:Object.fromEntries(selected.map(j=>[j,MANUAL_ENDPOINT_ERROR_DEGREES[j]]))}:{}),observed:{...last.joints},requiresReconciliation:false,endpointTolerancePolicy:MANUAL_ENDPOINT_POLICY,endpointToleranceDegrees:MANUAL_ENDPOINT_ERROR_DEGREES[a],endpointToleranceTicks:tolerance/SERVO_STEP,...(plan.heldTolerancePolicy?{heldTolerancePolicy:plan.heldTolerancePolicy,heldToleranceDegrees:Object.fromEntries(MANUAL_NAMES.filter(j=>!selected.includes(j)).map(j=>[j,manualHeldToleranceRad(j,plan)*180/Math.PI]))}:{heldToleranceTicks:MANUAL_TOLERANCE.heldTicks})};
}
export function qualificationMoves(start){
 const t=observedTicks(start),moves=[];
 for(const joint of MANUAL_NAMES){const n=joint==='base'?57:34,offsets=joint==='gripper'?[-n,0,-n,0]:[-n,0,n,0];for(const delta of offsets)moves.push(manualMoveForTick(joint,t[joint]+delta));}
 return moves;
}
