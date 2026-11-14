import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createExperiment,POLICY_SIZE} from '../src/replica/learning/simulation.js';
import {createEvolution,evolveGeneration} from '../src/replica/learning/evolution.js';
import {makeLearningRun,parseLearningRun,snapshotOptions,replayEpisode,frameAt,createReplayClock} from '../src/replica/learning/run.js';
const sample=()=>{const run=makeLearningRun(createExperiment());run.status='running';run.history=[{generation:1,evaluations:37,bestLoss:10,winnerLoss:10,worstLoss:50,medianLoss:25,sigma:.2}];run.snapshots.push({generation:1,kind:'best',policy:Array(POLICY_SIZE).fill(.001),loss:10});return run;};
test('portable learning runs round-trip only supported simulated state',()=>{
 const run=sample();run.authorization={armed:true};const parsed=parseLearningRun(JSON.stringify(run));assert.equal(parsed.previewOnly,true);assert.equal(parsed.authorization,undefined);assert.equal(parsed.checkpoint,null);assert.deepEqual(parsed.experiment.tool,run.experiment.tool);assert.equal(parsed.status,'paused');assert.deepEqual(parsed.snapshots,run.snapshots);
});
test('untrusted runs reject unsupported formats, excessive budgets, bad policies and fabricated history',()=>{
 for(const change of [r=>r.previewOnly=false,r=>r.version=2,r=>r.simulationVersion='other',r=>r.seed=-1,r=>r.population=1000,r=>r.experiment.desk.laptopDepth=NaN,r=>r.snapshots[0].policy[0]=1e9,r=>r.snapshots[0].kind='hardware',r=>r.snapshots[1].generation=3,r=>r.history[0].winnerLoss=100,r=>r.history.push({...r.history[0],generation:2,bestLoss:11}),r=>r.snapshots.shift()]){const run=sample();change(run);assert.throws(()=>parseLearningRun(JSON.stringify(run)));}
 assert.throws(()=>parseLearningRun('x'.repeat(8*1024*1024+1)));
});
test('legacy bundled 800-generation, 82-snapshot run remains importable without invented failures',async()=>{
 const raw=await readFile(new URL('../assets/learning/stylus-example-v1.json',import.meta.url),'utf8'),run=parseLearningRun(raw);
 assert.equal(run.history.length,800);assert.equal(run.snapshots.length,82);assert.equal(run.history.at(-1).generation,800);
 assert.equal(run.history.some(row=>Object.hasOwn(row,'failedCount')),false);
 assert.equal(run.snapshots.some(row=>Object.hasOwn(row,'failed')),false);
});
test('failure records round-trip with bounded reasons and distinguish valid worst candidate snapshots',()=>{
 const run=sample(),row=run.history[0];row.failedCount=0;row.failedCandidates=[];
 run.snapshots.push({generation:1,kind:'failure',policy:Array(POLICY_SIZE).fill(.002),loss:50,failed:false});
 let parsed=parseLearningRun(JSON.stringify(run));assert.equal(parsed.history[0].failedCount,0);assert.deepEqual(parsed.history[0].failedCandidates,[]);assert.equal(parsed.snapshots.at(-1).failed,false);
 const failed=sample(),bad=failed.history[0];bad.worstLoss=1e12;bad.failedCount=1;bad.failedCandidates=[{loss:1e12,reason:'policy-out-of-bounds'}];
 failed.snapshots.push({generation:1,kind:'failure',policy:Array(POLICY_SIZE).fill(.002),loss:1e12,failed:true});
 parsed=parseLearningRun(JSON.stringify(failed));assert.equal(parsed.history[0].failedCount,1);assert.deepEqual(parsed.history[0].failedCandidates,bad.failedCandidates);assert.equal(parsed.snapshots.at(-1).failed,true);assert.equal(parsed.snapshots.at(-1).failureReason,undefined);
 for(const mutate of [r=>r.history[0].failedCount=2,r=>r.history[0].failedCandidates[0].reason='bad\nmessage',r=>r.history[0].failedCandidates[0].reason='x'.repeat(241),r=>r.snapshots.at(-1).failed=false,r=>r.history[0].generation=801]){
  const invalid=JSON.parse(JSON.stringify(failed));mutate(invalid);assert.throws(()=>parseLearningRun(JSON.stringify(invalid)));
 }
});
test('checkpoint, history, and snapshot scores must describe the same completed generation',()=>{
 const run=sample();run.history[0].bestLoss=60;assert.throws(()=>parseLearningRun(JSON.stringify(run)));
 const run2=sample();run2.snapshots[1].loss=11;assert.throws(()=>parseLearningRun(JSON.stringify(run2)));
 const experiment=createExperiment(),state=createEvolution({seed:42,population:12,generations:1});
 const record=evolveGeneration(state,experiment,{fitness:()=>({loss:0})});
 const complete=makeLearningRun(experiment,{seed:42,population:12,generations:1});complete.status='complete';complete.checkpoint=state;
 complete.history=[{generation:1,evaluations:state.evaluations,bestLoss:record.best.loss,winnerLoss:record.winner.loss,worstLoss:record.worst.loss,medianLoss:record.medianLoss,sigma:record.sigma,failedCount:0,failedCandidates:[]}];
 complete.snapshots.push({generation:1,kind:'best',policy:record.best.policy,loss:record.best.loss});assert.equal(parseLearningRun(JSON.stringify(complete)).checkpoint.generation,1);
 const mismatch=JSON.parse(JSON.stringify(complete));mismatch.checkpoint.best.loss+=1;assert.throws(()=>parseLearningRun(JSON.stringify(mismatch)));
 const wrongMetadata=JSON.parse(JSON.stringify(complete));wrongMetadata.generationLimit=2;assert.throws(()=>parseLearningRun(JSON.stringify(wrongMetadata)));
});
test('generation choices preserve baseline and replay only a policy actually saved in the run',()=>{
 const run=sample(),options=snapshotOptions(run);assert.equal(options[0].kind,'baseline');assert.equal(options.at(-1).generation,1);const episode=replayEpisode(run,options[0]);assert.ok(episode.frames.length>50);assert.throws(()=>replayEpisode(run,{...options[0]}));for(const frame of episode.frames)assert.equal(frame.pose.gripper,run.experiment.gripper);
 assert.deepEqual(snapshotOptions(run,{kind:'failure'}),[]);
});
test('replay pause, seek, speed and end behavior select actual frames without skipping through background time',()=>{
 const episode={duration:2,frames:[{time:0,id:'a'},{time:1,id:'b'},{time:2,id:'c'}]},clock=createReplayClock();assert.equal(clock.load(episode).id,'a');clock.play();clock.update(100);assert.equal(clock.state.time,.25);clock.pause();clock.update(1);assert.equal(clock.state.time,.25);assert.equal(clock.seek(1.5).id,'b');clock.setSpeed(4);clock.play();assert.equal(clock.update(.2).id,'c');assert.equal(clock.state.playing,false);clock.play();assert.equal(clock.state.time,0);assert.equal(frameAt(episode,-1).id,'a');assert.throws(()=>clock.setSpeed(20));assert.throws(()=>clock.seek(NaN));
});
