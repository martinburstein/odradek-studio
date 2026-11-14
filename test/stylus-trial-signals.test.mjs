import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseLearningRun,replayEpisode} from '../src/replica/learning/run.js';
import {makeTasks,taskTarget} from '../src/replica/learning/tasks.js';
import {buildTrialSignals,trialSignalMarkup,updateSignalCursor} from '../src/replica/learning/signals.js';

const run=parseLearningRun(fs.readFileSync(new URL('../assets/learning/stylus-corner-before-v1.json',import.meta.url),'utf8'));
const episode=replayEpisode(run,run.snapshots.at(-3),{split:'test',taskId:'test-poke-0.87-0.87'});

test('trial signal values preserve actual replay samples, including the known approach dig',()=>{
 const before=JSON.stringify({episode,experiment:run.experiment}),signals=buildTrialSignals(episode,run.experiment),task=makeTasks('test').find(row=>row.id===episode.taskId);
 assert.equal(signals.samples.length,episode.frames.length);
 for(let i=0;i<episode.frames.length;i++){const frame=episode.frames[i],sample=signals.samples[i],current=taskTarget(task,frame.time,run.experiment.frame,run.experiment).point,next=taskTarget(task,frame.time+run.experiment.dt,run.experiment.frame,run.experiment).point;
  assert.equal(sample.time,frame.time);assert.equal(sample.speed,frame.speed);assert.equal(sample.gap,frame.gap);assert.equal(sample.load,frame.force);assert.equal(sample.requested,frame.desiredContact);assert.equal(sample.targetSpeed,Math.hypot(next.x-current.x,next.y-current.y,next.z-current.z)/run.experiment.dt);
 }
 const dig=signals.samples.find(sample=>Math.abs(sample.time-.2)<1e-8);assert.equal(dig.state,'dig');assert.ok(dig.gap< -2);
 assert.equal(JSON.stringify({episode,experiment:run.experiment}),before);
 assert.ok(signals.windows.every(([from,to])=>from<to&&from>=0&&to<=episode.duration));
});

test('plot domains contain all samples and the displayed model contact band',()=>{
 const signals=buildTrialSignals(episode,run.experiment);
 for(const series of signals.series){assert.ok(series.high>series.low);for(const sample of signals.samples)for(const key of [series.key,...(series.targetKey?[series.targetKey]:[])])assert.ok(sample[key]>=series.low&&sample[key]<=series.high);for(const value of series.bounds)assert.ok(value>=series.low&&value<=series.high);}
 const markup=trialSignalMarkup(signals);assert.equal((markup.match(/data-signal-cursor/g)??[]).length,3);assert.match(markup,/Modeled load proxy/);assert.match(markup,/N\*/);assert.match(markup,/dig at 0.20 s/);assert.doesNotMatch(markup,/NaN|Infinity/);
});

test('cursor follows the replay time and clamps to plot endpoints without changing samples',()=>{
 const cursors=Array.from({length:3},()=>({attributes:{},setAttribute(name,value){this.attributes[name]=value;}})),container={querySelectorAll:()=>cursors};
 for(const [time,want]of [[-1,32],[2,170],[99,308]]){updateSignalCursor(container,time,4);for(const cursor of cursors)assert.deepEqual(cursor.attributes,{x1:want,x2:want});}
});

test('modeled load outside the requested contact window remains visible without a clearance claim',()=>{
 const approach=replayEpisode(run,run.snapshots.at(-3),{taskId:'train-poke-0.2-0.2'}),signals=buildTrialSignals(approach,run.experiment),sample=signals.samples.find(row=>Math.abs(row.time-1.3333333333333333)<1e-8);
 assert.equal(sample.requested,false);assert.ok(sample.load>0);assert.equal(sample.state,'unrequested-load');assert.match(trialSignalMarkup(signals),/Modeled load outside requested contact at 1.33 s/);
});

test('invalid signal samples are rejected rather than silently omitting failures',()=>{
 for(const change of [{gap:NaN},{force:-1},{speed:-1},{time:-1},{dig:undefined}]){const bad=structuredClone(episode);Object.assign(bad.frames[0],change);assert.throws(()=>buildTrialSignals(bad,run.experiment),/finite and strictly time ordered/);}
 const bad=structuredClone(episode);bad.frames[1].time=bad.frames[0].time;assert.throws(()=>buildTrialSignals(bad,run.experiment),/time ordered/);
});
