import {padPoint} from './geometry.js';
export const minJerk=t=>{const x=Math.max(0,Math.min(1,t));return x*x*x*(10+x*(-15+6*x));};
export function makeTasks(split='train'){
 if(!['train','validation','test'].includes(split))throw Error('Unknown task split.');
 const values=split==='train'?[.2,.5,.8]:split==='validation'?[.32,.68]:[.13,.39,.61,.87],tasks=[];
 for(const u of values)for(const v of values)tasks.push({id:`${split}-poke-${u}-${v}`,kind:'poke',u,v,duration:4});
 if(split==='train')tasks.push({id:'train-horizontal',kind:'line',from:[.15,.5],to:[.85,.5],duration:7},{id:'train-vertical',kind:'line',from:[.5,.2],to:[.5,.8],duration:7},{id:'train-circle',kind:'circle',u:.5,v:.5,radius:.22,duration:9});
 else if(split==='validation')tasks.push({id:'validation-diagonal',kind:'line',from:[.25,.25],to:[.75,.75],duration:8},{id:'validation-circle',kind:'circle',u:.52,v:.48,radius:.16,duration:8});
 else tasks.push({id:'test-reverse-diagonal',kind:'line',from:[.8,.24],to:[.2,.76],duration:8},{id:'test-figure-eight',kind:'eight',u:.5,v:.5,radius:.25,duration:10});
 return tasks;
}
const percent=value=>`${Number((value*100).toFixed(1))}%`;
const position=([u,v])=>`across ${percent(u)}, forward ${percent(v)}`;
export function taskLabel(task){
 if(!task||typeof task!=='object')throw Error('Choose a valid learning trial.');
 if(task.kind==='poke'&&Number.isFinite(task.u)&&Number.isFinite(task.v))return`Poke · ${position([task.u,task.v])}`;
 if(task.kind==='line'&&Array.isArray(task.from)&&task.from.length===2&&Array.isArray(task.to)&&task.to.length===2&&[...task.from,...task.to].every(Number.isFinite)){
  const [u0,v0]=task.from,[u1,v1]=task.to;
  const orientation=Math.abs(v1-v0)<1e-9?'Horizontal stroke':Math.abs(u1-u0)<1e-9?'Vertical stroke':'Diagonal stroke';
  return`${orientation} · from ${position(task.from)} to ${position(task.to)}`;
 }
 if((task.kind==='circle'||task.kind==='eight')&&Number.isFinite(task.u)&&Number.isFinite(task.v)&&Number.isFinite(task.radius)){
  return`${task.kind==='circle'?'Circle':'Figure eight'} · center ${position([task.u,task.v])}, radius ${percent(task.radius)}`;
 }
 throw Error('Cannot label this learning trial.');
}
export function taskTarget(task,time,frame,{penetration=.2,hover=12}={}){
 const duration=task.duration,t=Math.max(0,Math.min(duration,time));let u=task.u??task.from?.[0]??.5,v=task.v??task.from?.[1]??.5,height=hover,contact=false,phase='approach';
 if(task.kind==='poke'){
  if(t<1.4){height=hover-(hover+penetration)*minJerk(t/1.4);}
  else if(t<2.6){height=-penetration;contact=true;phase='touch';}
  else{height=-penetration+(hover+penetration)*minJerk((t-2.6)/1.4);phase='lift';}
 }else{
  const start=.8,end=duration-.8;
  if(t<start)height=hover-(hover+penetration)*minJerk(t/start);
  else if(t<=end){height=-penetration;contact=true;phase='stroke';}
  else{height=-penetration+(hover+penetration)*minJerk((t-end)/.8);phase='lift';}
  const progress=minJerk((t-start)/(end-start));
  if(task.kind==='line'){u=task.from[0]+(task.to[0]-task.from[0])*progress;v=task.from[1]+(task.to[1]-task.from[1])*progress;}
  else if(task.kind==='circle'||task.kind==='eight'){const a=2*Math.PI*progress;u=task.u+task.radius*Math.cos(a);v=task.v+task.radius*(task.kind==='eight'?Math.sin(2*a)*.65:Math.sin(a));}
  else throw Error('Unknown task kind.');
 }
 return{point:padPoint(frame,u,v,height),u,v,contact,phase,time:t};
}
