import {validateDesk,DEFAULT_DESK} from '../state.js';
import {AXES,DEG,DEFAULT_TOOL,JOINT_LIMITS,clamp,validateTool,requirePose,toolGeometry,trackpadFrame,padPoint,padCoordinates,referenceIK,distance,geometryContacts} from './geometry.js';
import {makeTasks,taskTarget} from './tasks.js';
import {resolvePlant} from './plant.js';
import {FITNESS_V1,FITNESS_V2,validateFitnessVersion} from './fitness-version.js';

export const LEARNING_VERSION='odradek-stylus-evolution-v1';
export const POLICY_SIZE=33;
export const FEATURES=Object.freeze(['constant','x','height','z','x²','height²','z²','x·height','x·z','height·z']);
const square=x=>x*x;
export function createExperiment(input={}){
 const desk=validateDesk(input.desk??DEFAULT_DESK),tool=validateTool({...DEFAULT_TOOL,frontReach:desk.toolLength,...input.tool});
 const frame=trackpadFrame(desk),gripper=input.gripper??154*DEG;
 if(!Number.isFinite(gripper)||gripper<61.9*DEG||gripper>179.9*DEG)throw Error('Use a fixed, valid gripper angle.');
 const seedPose=input.seedPose?{...requirePose(input.seedPose)}:referenceIK(padPoint(frame,.5,.5,12),tool,gripper)[0];
 if(!seedPose)throw Error('This desk/tool setup has no nominal hovering seed pose. Adjust the simulator dimensions.');
 seedPose.gripper=gripper;
 if(AXES.some(key=>seedPose[key]<JOINT_LIMITS[key][0]||seedPose[key]>JOINT_LIMITS[key][1]))throw Error('Seed pose is outside simulator joint travel.');
 const result={version:LEARNING_VERSION,previewOnly:true,desk,tool,frame,gripper,seedPose,dt:1/30,maxSpeed:60*DEG,maxAcceleration:180*DEG,penetration:.2,contactStiffness:.5,contactDamping:.002,maxPenetration:.8,tiltTolerance:3};
 // These are simulator assumptions, never fitted physical mass/servo/force data.
 return result;
}
export function validatePolicy(policy){if(!Array.isArray(policy)||policy.length!==POLICY_SIZE||policy.some(x=>!Number.isFinite(x)||Math.abs(x)>100))throw Error('Invalid learned policy.');return policy;}
export function policyFeatures(point,experiment){
 const f=experiment.frame,p=padCoordinates(f,point),x=(p.u-.5)*2,y=(point.y-f.center.y)/12,z=(p.v-.5)*2;
 return[1,x,y,z,x*x,y*y,z*z,x*y,x*z,y*z];
}
export function policyCommand(policy,point,experiment){
 const features=policyFeatures(point,experiment),pose={gripper:experiment.gripper};let saturation=0;
 for(let j=0;j<3;j++){const key=AXES[j],raw=experiment.seedPose[key]+features.reduce((sum,f,k)=>sum+policy[j*10+k]*f*.15,0),[lo,hi]=JOINT_LIMITS[key];pose[key]=clamp(raw,lo,hi);saturation+=Math.abs(raw-pose[key]);}
 return{pose,saturation,omega:clamp(18*Math.exp(policy[30]*.25),5,32),damping:clamp(Math.exp(policy[31]*.2),.55,1.8),lead:clamp(.06+policy[32]*.04,0,.18)};
}
export function referenceCommand(point,experiment){
 const pose=referenceIK(point,experiment.tool,experiment.gripper)[0];return{pose:pose??{...experiment.seedPose},saturation:pose?0:10,omega:18,damping:1,lead:.06};
}
function losses(geometry,target,contact,experiment){
 const error=distance(geometry.tip,target.point),planar=Math.hypot(geometry.tip.x-target.point.x,geometry.tip.z-target.point.z),height=geometry.tip.y-target.point.y,tiltError=geometry.tilt-experiment.tool.targetTilt;
 const penetration=Math.max(0,-contact.gap),dig=Math.max(0,penetration-experiment.maxPenetration),outside=target.contact&&!contact.inside?1:0;
 const loss=square(planar/12)+square(height/2)*2+square(Math.max(0,Math.abs(tiltError)-experiment.tiltTolerance)/10)*.15+square(dig/2)*12+(contact.collision?60:0)+outside*20;
 return{loss,error,planar,height,tiltError,penetration,dig};
}
export function staticFitness(policy,experiment){
 let loss=0,n=0,maxError=0,maxTilt=0;
 for(const u of [.2,.5,.8])for(const v of [.2,.5,.8])for(const height of [-.2,6,12]){
  const target={point:padPoint(experiment.frame,u,v,height),contact:height<0},command=policyCommand(policy,target.point,experiment),geometry=toolGeometry(command.pose,experiment.tool),contact=geometryContacts(geometry,experiment.desk,experiment.frame,experiment.tool),m=losses(geometry,target,contact,experiment);
  loss+=m.loss+command.saturation*100;n++;maxError=Math.max(maxError,m.error);maxTilt=Math.max(maxTilt,Math.abs(m.tiltError));
 }
 return{loss:loss/n,maxError,maxTilt};
}
export function simulateTask(policy,task,experiment,{trace=false,reference=false,dt=experiment.dt,plant:plantOverrides}={}){
 if(!Number.isFinite(dt)||dt<1/240||dt>1/15)throw Error('Unsupported simulation time step.');
 const plant=plantOverrides===undefined?experiment:resolvePlant(experiment,plantOverrides);
 let pose={...experiment.seedPose},velocity={base:0,shoulder:0,elbow:0},lastGeometry=toolGeometry(pose,plant.tool),lastTipVelocity={x:0,y:0,z:0},lastAcceleration={x:0,y:0,z:0};
 let count=0,totalLoss=0,sumError2=0,sumTilt2=0,sumVelocityError2=0,sumAcceleration2=0,sumJerk2=0,contactSamples=0,successfulContact=0,contactError2=0,successfulError2=0,contactPlanar2=0,contactHeight2=0,contactTilt2=0,contactVelocityError2=0,contactSpeedError2=0,contactSpeedSum=0,contactSpeedSquared=0,desiredContactSpeedSum=0,contactSpeedSamples=0,collisionSamples=0,digSamples=0,maxPenetration=0,maxSpeed=0,maxForce=0,forceSum=0,forceSquared=0,forceSamples=0,successfulForceSum=0,successfulForceSquared=0,successfulForceSamples=0,maxError=0;const frames=[];
 const commandFor=(point)=>reference?referenceCommand(point,experiment):policyCommand(policy,point,experiment);
 for(let n=0;n<=Math.round(task.duration/dt);n++){
  const time=Math.min(task.duration,n*dt),target=taskTarget(task,time,experiment.frame,experiment),controls=commandFor(target.point),ahead=taskTarget(task,time+controls.lead,experiment.frame,experiment),command=commandFor(ahead.point);
  for(const key of AXES){const acceleration=clamp(controls.omega**2*(command.pose[key]-pose[key])-2*controls.damping*controls.omega*velocity[key],-plant.maxAcceleration,plant.maxAcceleration);velocity[key]=clamp(velocity[key]+acceleration*dt,-plant.maxSpeed,plant.maxSpeed);const next=pose[key]+velocity[key]*dt,[lo,hi]=JOINT_LIMITS[key];pose[key]=clamp(next,lo,hi);if(pose[key]!==next)velocity[key]=0;}
  const geometry=toolGeometry(pose,plant.tool),contact=geometryContacts(geometry,plant.desk,plant.frame,plant.tool),m=losses(geometry,target,contact,experiment),tipVelocity={},acceleration={},jerk={};
  for(const key of ['x','y','z']){tipVelocity[key]=(geometry.tip[key]-lastGeometry.tip[key])/dt;acceleration[key]=(tipVelocity[key]-lastTipVelocity[key])/dt;jerk[key]=(acceleration[key]-lastAcceleration[key])/dt;}
  const nextTarget=taskTarget(task,time+dt,experiment.frame,experiment),desiredVelocity={x:(nextTarget.point.x-target.point.x)/dt,y:(nextTarget.point.y-target.point.y)/dt,z:(nextTarget.point.z-target.point.z)/dt};
  const speed=Math.hypot(...Object.values(tipVelocity)),a2=Object.values(acceleration).reduce((s,x)=>s+x*x,0),j2=Object.values(jerk).reduce((s,x)=>s+x*x,0),velocityError2=['x','y','z'].reduce((s,k)=>s+square(tipVelocity[k]-desiredVelocity[k]),0);
  const force=contact.inside&&contact.gap<=0?experiment.contactStiffness*m.penetration+experiment.contactDamping*Math.max(0,-tipVelocity.y):0;
  const touching=target.contact&&contact.inside&&contact.gap<=.15&&contact.gap>=-experiment.maxPenetration&&m.planar<=4&&!contact.collision;
  // Fixed-duration paths prevent a "win" obtained by stopping or moving forever.
  const smoothLoss=(n>1?a2/1e6+j2/4e8:0)*.015+velocityError2/2500*.025;
  totalLoss+=m.loss+smoothLoss+command.saturation*100;count++;sumError2+=m.error*m.error;sumTilt2+=m.tiltError*m.tiltError;sumVelocityError2+=velocityError2;sumAcceleration2+=n>1?a2:0;sumJerk2+=n>2?j2:0;maxError=Math.max(maxError,m.error);maxPenetration=Math.max(maxPenetration,m.penetration);maxSpeed=Math.max(maxSpeed,speed);maxForce=Math.max(maxForce,force);
  if(contact.collision)collisionSamples++;if(m.dig>0)digSamples++;
  if(target.contact){const desiredSpeed=Math.hypot(...Object.values(desiredVelocity));contactSamples++;contactError2+=m.error*m.error;contactPlanar2+=m.planar*m.planar;contactHeight2+=m.height*m.height;contactTilt2+=m.tiltError*m.tiltError;contactVelocityError2+=velocityError2;contactSpeedError2+=square(speed-desiredSpeed);desiredContactSpeedSum+=desiredSpeed;contactSpeedSum+=speed;contactSpeedSquared+=speed*speed;contactSpeedSamples++;forceSum+=force;forceSquared+=force*force;forceSamples++;if(touching){successfulContact++;successfulError2+=m.error*m.error;successfulForceSum+=force;successfulForceSquared+=force*force;successfulForceSamples++;}}
  if(trace&&(n%2===0||time===task.duration))frames.push({time,pose:{...pose},tip:{...geometry.tip},front:{...geometry.front},rear:{...geometry.rear},target:target.point,tilt:geometry.tilt,gap:contact.gap,force,contact:touching,desiredContact:target.contact,collision:contact.collision,dig:m.dig>0,phase:target.phase,error:m.error,speed});
  lastGeometry=geometry;lastTipVelocity=tipVelocity;lastAcceleration=acceleration;
 }
 const forceMean=forceSamples?forceSum/forceSamples:0,successfulForceMean=successfulForceSamples?successfulForceSum/successfulForceSamples:0,contactSpeedMean=contactSpeedSamples?contactSpeedSum/contactSpeedSamples:0;
 const forceSD=Math.sqrt(Math.max(0,forceSquared/Math.max(1,forceSamples)-forceMean**2)),successfulForceSD=Math.sqrt(Math.max(0,successfulForceSquared/Math.max(1,successfulForceSamples)-successfulForceMean**2));
 return{taskId:task.id,kind:task.kind,duration:task.duration,loss:totalLoss/count,metrics:{rmsError:Math.sqrt(sumError2/count),wholeEpisodeRmsError:Math.sqrt(sumError2/count),maxError,rmsTiltError:Math.sqrt(sumTilt2/count),wholeEpisodeRmsTiltError:Math.sqrt(sumTilt2/count),contactFraction:contactSamples?successfulContact/contactSamples:null,contactRmsError:contactSamples?Math.sqrt(contactError2/contactSamples):null,successfulContactRmsError:successfulContact?Math.sqrt(successfulError2/successfulContact):null,contactRmsPlanarError:contactSamples?Math.sqrt(contactPlanar2/contactSamples):null,contactRmsHeightError:contactSamples?Math.sqrt(contactHeight2/contactSamples):null,contactRmsTiltError:contactSamples?Math.sqrt(contactTilt2/contactSamples):null,collisionFraction:collisionSamples/count,digFraction:digSamples/count,maxPenetration,rmsVelocityError:Math.sqrt(sumVelocityError2/count),wholeEpisodeRmsVelocityError:Math.sqrt(sumVelocityError2/count),contactRmsVelocityError:contactSamples?Math.sqrt(contactVelocityError2/contactSamples):null,contactRmsSpeedError:contactSpeedSamples?Math.sqrt(contactSpeedError2/contactSpeedSamples):null,rmsAcceleration:Math.sqrt(sumAcceleration2/count),rmsJerk:Math.sqrt(sumJerk2/count),contactSpeedMean,desiredContactSpeedMean:contactSpeedSamples?desiredContactSpeedSum/contactSpeedSamples:0,contactSpeedSD:Math.sqrt(Math.max(0,contactSpeedSquared/Math.max(1,contactSpeedSamples)-contactSpeedMean**2)),forceMean,forceSD,maxForce,forceProxyMean:forceMean,forceProxySD:forceSD,successfulContactForceProxyMean:successfulForceMean,successfulContactForceProxySD:successfulForceSD},frames};
}
export function trainingFitness(policy,experiment){
 const staticResult=staticFitness(policy,experiment),tasks=makeTasks('train'),dynamicTasks=[tasks[4],tasks[9],tasks[10]],rollouts=dynamicTasks.map(task=>simulateTask(policy,task,experiment));
 const dynamicLoss=rollouts.reduce((sum,r)=>sum+r.loss,0)/rollouts.length;
 return{loss:staticResult.loss*.55+dynamicLoss*.45,staticLoss:staticResult.loss,dynamicLoss};
}
export const trainingFitnessV1=trainingFitness;
export function trainingFitnessV2(policy,experiment){
 const staticResult=staticFitness(policy,experiment),tasks=makeTasks('train'),dynamicIds=['train-poke-0.2-0.2','train-poke-0.2-0.8','train-poke-0.5-0.5','train-poke-0.8-0.2','train-poke-0.8-0.8','train-horizontal','train-vertical'],dynamicTasks=dynamicIds.map(id=>tasks.find(task=>task.id===id));
 if(dynamicTasks.some(task=>!task))throw Error('The version 2 training paths are unavailable.');
 const rollouts=dynamicTasks.map(task=>simulateTask(policy,task,experiment));
 const dynamicLoss=rollouts.reduce((sum,r)=>sum+r.loss,0)/rollouts.length;
 return{loss:staticResult.loss*.55+dynamicLoss*.45,staticLoss:staticResult.loss,dynamicLoss};
}
export function trainingFitnessForVersion(version){
 const selected=validateFitnessVersion(version);
 return selected===FITNESS_V1?trainingFitnessV1:trainingFitnessV2;
}
export function evaluatePolicy(policy,experiment,{split='test',trace=false,reference=false}={}){
 if(!reference)validatePolicy(policy);const episodes=makeTasks(split).map(task=>simulateTask(policy,task,experiment,{trace,reference}));
 const mean=key=>episodes.reduce((sum,e)=>sum+e.metrics[key],0)/episodes.length;
 const optionalMean=key=>{const values=episodes.map(e=>e.metrics[key]).filter(Number.isFinite);return values.length?values.reduce((a,b)=>a+b,0)/values.length:null;};
 return{split,reference,previewOnly:true,episodes,metrics:{loss:episodes.reduce((sum,e)=>sum+e.loss,0)/episodes.length,rmsError:mean('rmsError'),wholeEpisodeRmsError:mean('wholeEpisodeRmsError'),maxError:Math.max(...episodes.map(e=>e.metrics.maxError)),rmsTiltError:mean('rmsTiltError'),wholeEpisodeRmsTiltError:mean('wholeEpisodeRmsTiltError'),contactFraction:mean('contactFraction'),contactRmsError:optionalMean('contactRmsError'),successfulContactRmsError:optionalMean('successfulContactRmsError'),contactRmsPlanarError:optionalMean('contactRmsPlanarError'),contactRmsHeightError:optionalMean('contactRmsHeightError'),contactRmsTiltError:optionalMean('contactRmsTiltError'),collisionFraction:mean('collisionFraction'),digFraction:mean('digFraction'),maxPenetration:Math.max(...episodes.map(e=>e.metrics.maxPenetration)),rmsVelocityError:mean('rmsVelocityError'),wholeEpisodeRmsVelocityError:mean('wholeEpisodeRmsVelocityError'),contactRmsVelocityError:optionalMean('contactRmsVelocityError'),contactRmsSpeedError:optionalMean('contactRmsSpeedError'),contactSpeedMean:mean('contactSpeedMean'),desiredContactSpeedMean:mean('desiredContactSpeedMean'),contactSpeedSD:mean('contactSpeedSD'),rmsAcceleration:mean('rmsAcceleration'),rmsJerk:mean('rmsJerk'),forceMean:mean('forceMean'),forceSD:mean('forceSD'),forceProxyMean:mean('forceProxyMean'),forceProxySD:mean('forceProxySD'),successfulContactForceProxyMean:mean('successfulContactForceProxyMean'),successfulContactForceProxySD:mean('successfulContactForceProxySD')}};
}
