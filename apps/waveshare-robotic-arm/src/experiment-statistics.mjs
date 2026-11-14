import {analyzeElbowTrace} from './experiment-analysis.mjs';
import {observedTicks} from './z-lift-actuators.mjs';
const mean=a=>a.reduce((sum,v)=>sum+v,0)/a.length;
const describe=a=>({trials:a.length,meanDegrees:mean(a),sampleStandardDeviationDegrees:a.length>1?Math.sqrt(a.reduce((sum,v)=>sum+(v-mean(a))**2,0)/(a.length-1)):null,rangeDegrees:Math.max(...a)-Math.min(...a)});
// The independent observation unit is a COMMAND/TRIAL, never a telemetry row.
// Matching is deliberately exact in encoder ticks and conservative settings.
export function summarizeExperiments(trials){
 if(!Array.isArray(trials))throw Error('Trials must be an array');
 const ids=new Set(),matched=new Map(),directions=new Map(),excluded=[];let included=0;
 for(const trial of trials){
  if(typeof trial.id!=='string'||!trial.id||ids.has(trial.id))throw Error('Each trial requires a unique nonempty id');ids.add(trial.id);
  let analysis,start,target;
  try{
   if(trial.localDeliveryConfirmed!==true)throw Error('Local command delivery not confirmed');
   if(trial.command?.T!==101||trial.command?.joint!==3||trial.command?.spd!==20||trial.command?.acc!==1)throw Error('Different or missing actuator/settings');
   analysis=analyzeElbowTrace(trial);if(!analysis.retrospectiveSettling.supported)throw Error('Final encoder settling not supported');
   start=observedTicks(trial.start);target=observedTicks(trial.target);
   if(['base','shoulder','gripper'].some(k=>start[k]!==target[k]))throw Error('Other joints were commanded');
   if(target.elbow===start.elbow)throw Error('No commanded elbow displacement');
  }catch(error){excluded.push({id:trial.id,reason:error.message});continue;}
  included++;
  const key=JSON.stringify({start,target,spd:20,acc:1});
  if(!matched.has(key))matched.set(key,{condition:JSON.parse(key),ids:[],errors:[]});
  const group=matched.get(key);group.ids.push(trial.id);group.errors.push(analysis.signedEndpointErrorDegrees);
  // Opposite directions are compared only at the SAME target and displacement
  // magnitude with held-joint encoder settings matched. The result is an
  // association, not a diagnosis of backlash or mechanical hysteresis.
  const directionKey=JSON.stringify({target,displacementTicks:Math.abs(target.elbow-start.elbow),spd:20,acc:1});
  if(!directions.has(directionKey))directions.set(directionKey,{condition:JSON.parse(directionKey),increasing:[],decreasing:[],ids:[]});
  const pair=directions.get(directionKey);pair[target.elbow>start.elbow?'increasing':'decreasing'].push(analysis.signedEndpointErrorDegrees);pair.ids.push(trial.id);
 }
 return {independentUnit:'one identified command/trial',includedTrials:included,excluded,
  repeatabilityGroups:[...matched.values()].map(g=>({condition:g.condition,trialIds:g.ids,endpointError:describe(g.errors),repeatabilityEstimated:g.errors.length>=2,confidence:g.errors.length>=2?'Small-sample descriptive estimate; no external metrology':'Insufficient repeated trials'})),
  directionComparisons:[...directions.values()].filter(g=>g.increasing.length>=2&&g.decreasing.length>=2).map(g=>({condition:g.condition,trialIds:g.ids,increasing:describe(g.increasing),decreasing:describe(g.decreasing),directionAssociatedEndpointDifferenceDegrees:mean(g.increasing)-mean(g.decreasing),mechanicalCauseEstablished:false})),
  physicalAccuracyDegrees:null,compensationEnabled:false,
  limitations:['Telemetry rows within one command are not independent trials','Exact matched conditions are required; unmatched poses are not pooled','Encoder errors are not external physical accuracy','No compensation is fitted or enabled by this analysis']};
}
