import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {planZLift,assertPoseNear,validateTrialFeedback,Z_LIFT_POLICY,JOINT_NAMES} from './z-lift-plan.mjs';
import {assertLiftHealth,elbowCommandForTick,Z_LIFT_COMMAND_REVISION} from './z-lift-actuators.mjs';
import {planVisibleElbow,validateVisibleElbowFeedback,VISIBLE_ELBOW_EXPERIMENT,TEN_DEGREE_ELBOW_EXPERIMENT,isVisibleElbowExperiment} from './visible-elbow-plan.mjs';
import {TRAINING_EXPERIMENT,planTrainingElbow,validateTrainingFeedback,classifyTrainingSettling} from './training-plan.mjs';
import {TRAINING_ENVELOPE_REVISION} from './training-envelope.mjs';
import {isOtherExperiment,planOtherJoint,validateOtherFeedback,classifyOtherSettling,OTHER_COMMAND_REVISION,otherExperimentPolicy} from './other-joint-plan.mjs';
import {assertOperatingEnvelope} from './operating-envelope.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const checks=['firmwareProtocol','geometryAndTool','servoHealth','powerAndMount','speedAndStop'];
const confirmations=['baseSecured','workspaceClear','gripperEmpty','powerSwitchReady','experimentalMotionAccepted'];
const stopGate=(c,input,admission)=>()=>{admission();if(input.expectedStopEpoch!==undefined&&(!Number.isInteger(input.expectedStopEpoch)||input.expectedStopEpoch!==c.stopEpoch))throw Error('Sequence cancelled by a stop or authority change');};
const exact=(input,keys)=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k)))throw Error('Unexpected commissioning request fields');};

// This is reviewed preflight evidence for an experiment, never a completed
// hardware profile. No UI/API method writes or approves it automatically.
export async function inspectZLiftPreflight(directory,plan,{currentIntentId=null}={}){
  const blockers=[];let profile,raw;
  const visible=isVisibleElbowExperiment(plan.experiment),other=isOtherExperiment(plan.experiment),bounded=other||plan.experiment===TRAINING_EXPERIMENT;
  try{raw=await fs.readFile(path.join(directory,'commissioning',other?otherExperimentPolicy(plan.experiment).profileFile:plan.experiment===TRAINING_EXPERIMENT?'training-preflight.json':visible?(plan.experiment===TEN_DEGREE_ELBOW_EXPERIMENT?'ten-degree-elbow-preflight.json':'visible-elbow-preflight.json'):'z-lift-preflight.json'));profile=JSON.parse(raw);}
  catch{return {ready:false,digest:null,blockers:['Reviewed firmware, geometry, servo, power and speed/stop evidence is not installed.']};}
  if(profile.schemaVersion!==1||profile.kind!=='supervised-z-lift-preflight'||profile.variant!=='RoArm-M2-S'||profile.modelRevision!==plan.modelRevision||profile.toolMode!=='EEMode 0')blockers.push('Preflight model, variant or tool mode does not match this lift.');
  if(profile.commandRevision!==(other?OTHER_COMMAND_REVISION:Z_LIFT_COMMAND_REVISION)||plan.commandRevision!==(other?OTHER_COMMAND_REVISION:Z_LIFT_COMMAND_REVISION))blockers.push('Reviewed integer command model does not match this lift.');
  if((profile.experiment??null)!==(plan.experiment??null))blockers.push('Reviewed experiment does not match this preview.');
  if(bounded){
    if(profile.envelopeRevision!==(other?otherExperimentPolicy(plan.experiment).envelopeRevision:TRAINING_ENVELOPE_REVISION)||profile.boundaryConfirmed!==true||profile.existingShoulderAttachmentAllowed!==true||profile.shoulderHeld!==true)blockers.push('The confirmed whole-body floor and held-shoulder policy are required.');
    if(other&&(profile.sweptWorkspaceClear!==true||profile.jawsClear!==true||!Array.isArray(profile.approvedTargets)||!profile.approvedTargets.includes(plan.servoTargets[plan.movementJoint])))blockers.push('Reviewed sweep/jaw clearance and exact target allowlist are required.');
    if(other&&otherExperimentPolicy(plan.experiment).fifteen&&(!Number.isFinite(profile.sweptClearanceMm)||profile.sweptClearanceMm<150))blockers.push('The 15 degree experiment requires 150 mm confirmed swept clearance.');
    const until=Date.parse(profile.supervisedUntil);
    if(!Number.isFinite(until)||until<Date.now()+20000||until>Date.now()+(other?5:30)*60000)blockers.push('A current bounded supervised session with time for the complete trial is required.');
    const intentRoot=path.join(directory,'commissioning','training-intents');
    for(const file of await fs.readdir(intentRoot).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e))){
      if(!/^[a-f0-9-]{36}\.json$/.test(file)){blockers.push('Unknown training intent record requires reconciliation.');continue;}
      if(currentIntentId!==null&&file===`${currentIntentId}.json`){
        try{const intent=JSON.parse(await fs.readFile(path.join(intentRoot,file)));if(intent.id!==currentIntentId||hash(JSON.stringify(intent.plan))!==hash(JSON.stringify(plan)))throw Error();}
        catch{blockers.push('Current durable intent no longer matches this exact plan.');}
        continue;
      }
      try{const previous=JSON.parse(await fs.readFile(path.join(directory,'commissioning','trials',file)));if(!['telemetry-reached','telemetry-settled-off-target'].includes(previous.outcome)||previous.cleanupVerified!==true||previous.requiresReconciliation===true)blockers.push('A prior training command requires reconciliation.');}
      catch{blockers.push('An unfinished training intent requires reconciliation.');}
    }
  }
  if(typeof profile.installedFirmware!=='string'||!profile.installedFirmware.trim()||/unknown|unverified|pending|simulator|[<>]/i.test(profile.installedFirmware))blockers.push('Installed firmware identity is not established.');
  const reviewed=Date.parse(profile.reviewedAt);
  if(typeof profile.reviewedBy!=='string'||!profile.reviewedBy.trim()||!Number.isFinite(reviewed)||reviewed>Date.now()||Date.now()-reviewed>7*86400000)blockers.push('A current preflight review (within seven days) is required.');
  const evidenceHashes=[];
  for(const name of checks){
    const item=profile.evidence?.[name];
    try{
      if(item?.accepted!==true||typeof item.file!=='string'||!/^evidence\/[\w-]+\.(md|json)$/.test(item.file)||!/^[a-f0-9]{64}$/i.test(item.sha256))throw Error();
      const root=await fs.realpath(path.join(directory,'commissioning'));
      const file=await fs.realpath(path.join(root,item.file));
      if(!file.startsWith(root+path.sep))throw Error();
      const bytes=await fs.readFile(file);if(!bytes.length||bytes.length>65536||hash(bytes)!==item.sha256.toLowerCase())throw Error();
      evidenceHashes.push(item.sha256.toLowerCase());
    }catch{blockers.push(`Reviewed ${name} evidence is missing or its hash does not match.`);}
  }
  for(const key of JOINT_NAMES){
    const range=profile.jointEnvelope?.[key];
    if(!Array.isArray(range)||range.length!==2||!range.every(Number.isFinite)||range[0]>=range[1]||[plan.start[key],plan.target[key]].some(v=>v<range[0]||v>range[1]))blockers.push(`Reviewed ${key} envelope must cover the starting and target positions.`);
  }
  if(plan.modelAgreementMm===null)blockers.push('Fresh firmware Cartesian feedback is required to compare the geometry model.');
  return {ready:!blockers.length,digest:hash(Buffer.concat([raw,Buffer.from(evidenceHashes.join(''))])),blockers,sequencePlanDigest:profile.sequencePlanDigest??null,supervisionExpiresAt:bounded?Date.parse(profile.supervisedUntil):null};
}

export class ZLiftCommissioning {
  constructor(controller){this.c=controller;this.preview=null;this.result=null;this.active=false;}
  invalidate(){this.preview=null;}
  snapshot(){return {active:this.active,preview:this.preview?structuredClone(this.preview.public):null,result:this.result?structuredClone(this.result):null};}
  assertSetup(owner){const c=this.c;c.assertOwner(owner);c.assertIdle();if(c.mode!=='serial'||!c.connected||c.armed||c.commissioned)throw Error('Lift commissioning requires a connected USB arm with ordinary controls disarmed and uncommissioned');}
  async prepare(input,admission=()=>{}){
    return this.c.withForeground(()=>this.prepareIdle(input,stopGate(this.c,input,admission)));
  }
  async prepareIdle(input,admission=()=>{}){
    exact(input,['owner','experiment','targetTick','expectedStopEpoch']);
    if(input.experiment!==undefined&&!isVisibleElbowExperiment(input.experiment)&&input.experiment!==TRAINING_EXPERIMENT&&!isOtherExperiment(input.experiment))throw Error('Unsupported commissioning experiment');
    if(input.targetTick!==undefined&&input.experiment!==TRAINING_EXPERIMENT&&!isOtherExperiment(input.experiment))throw Error('Target ticks require the bounded training experiment');
    this.assertSetup(input.owner);const c=this.c,generation=c.generation;
    this.preview=null;c.busy=true;
    try{
      admission();await assertOperatingEnvelope(c.directory,input.experiment);let start;
      for(let i=0;i<3;i++){await c.refresh();c.requireFresh();assertLiftHealth(c.liftHealth);if(start)assertPoseNear(c.measured,start);else start={...c.measured};if(i<2)await delay(60);}
      const plan=isOtherExperiment(input.experiment)?planOtherJoint(c.measured,c.firmwareCartesian,input.experiment,input.targetTick):input.experiment===TRAINING_EXPERIMENT?planTrainingElbow(c.measured,c.firmwareCartesian,input.targetTick):isVisibleElbowExperiment(input.experiment)?planVisibleElbow(c.measured,c.firmwareCartesian,input.experiment):planZLift(c.measured,c.firmwareCartesian);const review=await inspectZLiftPreflight(c.directory,plan);
      admission();if(c.generation!==generation)throw Error('Lift preview cancelled');
      const publicPreview={sequencePlanDigest:review.sequencePlanDigest??null,stopEpoch:c.stopEpoch,id:randomUUID(),expiresAt:new Date(Date.now()+Z_LIFT_POLICY.previewLifetimeMs).toISOString(),observedAt:c.telemetryUpdatedAt,baselineHealth:{...c.liftHealth},plan,ready:review.ready,blockers:review.blockers};
      this.preview={public:publicPreview,owner:input.owner,generation,digest:review.digest};
      return structuredClone(publicPreview);
    }finally{c.busy=false;}
  }
  async execute(input,admission=()=>{}){
    return this.c.withForeground(()=>this.executeIdle(input,stopGate(this.c,input,admission)));
  }
  async executeIdle(input,admission=()=>{}){
    exact(input,['owner','previewId','confirmations','expectedStopEpoch']);this.assertSetup(input.owner);
    const c=this.c,prepared=this.preview;
    if(!prepared||input.previewId!==prepared.public.id||input.owner!==prepared.owner)throw Error('Prepare a lift preview from this owner first');
    if(Date.now()>Date.parse(prepared.public.expiresAt)||prepared.generation!==c.generation){this.invalidate();throw Error('Lift preview expired or was cancelled');}
    exact(input.confirmations,confirmations);if(confirmations.some(k=>input.confirmations[k]!==true))throw Error('All five physical setup confirmations are required for this one lift');
    if(!prepared.public.ready)throw Error('Lift is blocked pending reviewed preflight evidence');
    // Consume before any asynchronous work: no double-click, retry or replay.
    this.invalidate();this.active=true;c.busy=true;c.taskActive=true;c.lifecycle='z-lift-trial';
    const abort=new AbortController();c.abort=abort;const generation=c.generation,plan=prepared.public.plan;
    let dispatchAttempted=false,sent=false,result,failure,cleanup;
    const observations=[];let phase='preflight';
    const other=isOtherExperiment(plan.experiment),training=other||plan.experiment===TRAINING_EXPERIMENT;
    let deadlineExpired=false;
    let timer=setTimeout(()=>{deadlineExpired=true;abort.abort();},training?8000:Z_LIFT_POLICY.durationMs);
    let dispatchAt=null,baselineAt=null,baselineHealth=null;
    try{
      const review=await inspectZLiftPreflight(c.directory,plan);
      if(!review.ready||review.digest!==prepared.digest)throw Error('Preflight evidence changed; prepare a new lift preview');
      await c.refresh(abort.signal);c.requireFresh();assertLiftHealth(c.liftHealth);assertPoseNear(c.measured,plan.start);
      await c.record({kind:'z-lift-trial',outcome:'intent',trialId:prepared.public.id,liftMm:plan.liftMm,experiment:plan.experiment??'2mm-lift'});
      await c.refresh(abort.signal);c.requireFresh();assertLiftHealth(c.liftHealth);assertPoseNear(c.measured,plan.start);
      baselineAt=c.telemetryUpdatedAt;baselineHealth={...c.liftHealth};
      if(training){
        const intentRoot=path.join(c.directory,'commissioning','training-intents');await fs.mkdir(intentRoot,{recursive:true});
        await fs.writeFile(path.join(intentRoot,`${prepared.public.id}.json`),JSON.stringify({id:prepared.public.id,createdAt:new Date().toISOString(),plan,authorization:'bounded supervised session; no restart replay'},null,2)+'\n',{flag:'wx'});
      }
      const receipt=await c.bounded(async()=>{
        await assertOperatingEnvelope(c.directory,plan.experiment);
        const finalReview=training?await inspectZLiftPreflight(c.directory,plan,{currentIntentId:prepared.public.id}):review;
        if(!finalReview.ready||finalReview.digest!==prepared.digest)throw Error('Preflight evidence changed before the final send gate');
        admission();c.assertOwner(input.owner);c.requireFresh();assertLiftHealth(c.liftHealth);assertPoseNear(c.measured,plan.start);
        if(abort.signal.aborted||c.generation!==generation||Date.now()>Date.parse(prepared.public.expiresAt)||!c.connected||c.armed||c.commissioned)throw Error('Lift authority cancelled before dispatch');
        if(training){
          if(!Number.isFinite(finalReview.supervisionExpiresAt)||Date.now()+plan.durationMs+1000>finalReview.supervisionExpiresAt)throw Error('Supervision expires before this trial can finish');
          // Preparation has its own bounded deadline. Physical observation gets
          // a complete fresh budget beginning at the actual send attempt.
          clearTimeout(timer);timer=setTimeout(()=>{deadlineExpired=true;abort.abort();},plan.durationMs);
        }
        dispatchAttempted=true;phase='dispatch';dispatchAt=new Date().toISOString();
        return c.transport.send(other?plan.command:elbowCommandForTick(plan.servoTargets.elbow),{signal:abort.signal});
      },abort.signal);
      sent=true;if(receipt?.sent!==true&&receipt?.acknowledged!==true)throw Error('Local delivery was not confirmed');
      phase='observation';
      let stable=0,samples=0,observation;const observationStarted=Date.now();
      while(training?Date.now()-observationStarted<plan.observationWindowMs:stable<3){
        await delay(150,undefined,{signal:abort.signal});admission();
        if(c.generation!==generation)throw Error('Lift cancelled during observation');
        await c.refresh(abort.signal);c.requireFresh();
        observations.push({observedAt:c.telemetryUpdatedAt,joints:{...c.measured},health:{...c.liftHealth}});
        assertLiftHealth(c.liftHealth);observation=other?validateOtherFeedback(c.measured,plan):training?validateTrainingFeedback(c.measured,plan):isVisibleElbowExperiment(plan.experiment)?validateVisibleElbowFeedback(c.measured,plan):validateTrialFeedback(c.measured,plan);samples++;
        stable=observation.withinTarget?stable+1:0;
      }
      result={id:prepared.public.id,outcome:'telemetry-reached',sent:true,acknowledged:receipt.acknowledged===true,samples,estimatedRiseMm:observation.estimatedRiseMm,start:plan.start,target:plan.target,observed:{...c.measured},physicalMovementVerified:false,operatorObservation:null};
      if(training)Object.assign(result,other?classifyOtherSettling(observations,plan):classifyTrainingSettling(observations,plan));
    }catch(error){failure=error;result={id:prepared.public.id,outcome:dispatchAttempted?'uncertain':'not-sent',sent,dispatchAttempted,physicalMovementVerified:false,operatorObservation:null};}
    finally{
      clearTimeout(timer);this.active=false;c.busy=false;c.taskActive=false;
      try{cleanup=await c.stop('Supervised lift finished; no automatic return',false,{trialCleanup:true});}catch{cleanup={cleanupVerified:false};}
      if(c.abort===abort)c.abort=null;
    }
    result.cleanupVerified=cleanup?.cleanupVerified===true;result.physicalStopVerified=false;this.result=result;
    if(other)result.movementJoint=plan.movementJoint;
    result.experiment=plan.experiment??'2mm-lift';result.command=plan.command;result.start=plan.start;result.target=plan.target;result.observations=observations;
    result.failurePhase=failure?phase:null;result.deadlineExpired=deadlineExpired;
    if(training){result.dispatchAt=dispatchAt;result.baselineAt=baselineAt;result.baselineHealth=baselineHealth;result.envelope=plan.envelope;result.envelopeRevision=plan.envelopeRevision;}
    try{
      await fs.mkdir(path.join(c.directory,'commissioning','trials'),{recursive:true});
      await fs.writeFile(path.join(c.directory,'commissioning','trials',`${result.id}.json`),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
      await c.record({kind:'z-lift-trial',outcome:failure?'unknown':'observed',trialId:result.id,physicalMovementVerified:false});
      if(failure)throw Error('Lift did not complete with verified feedback; inspect the arm before any new attempt');
      if(!result.cleanupVerified)throw Error('Lift feedback received but transport cleanup remains unverified');
      return structuredClone(result);
    }finally{c.lifecycle=null;}
  }
  async observe(input){
    return this.c.withForeground(()=>this.observeIdle(input));
  }
  async observeIdle(input){
    exact(input,['owner','trialId','outcome']);this.c.assertOwner(input.owner);this.c.assertIdle();
    if(this.c.armed||this.active||!this.result||input.trialId!==this.result.id)throw Error('A completed trial is required before recording an observation');
    if(!['upward-motion-seen','no-motion-seen','unexpected-motion','uncertain'].includes(input.outcome))throw Error('Choose a supported observation');
    if(this.result.operatorObservation)throw Error('Observation already recorded');
    const report={trialId:this.result.id,outcome:input.outcome,reportedAt:new Date().toISOString(),source:'operator-report',physicalMovementVerified:false};
    await fs.writeFile(path.join(this.c.directory,'commissioning','trials',`${this.result.id}-observation.json`),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    this.result.operatorObservation=report;return structuredClone(report);
  }
}
