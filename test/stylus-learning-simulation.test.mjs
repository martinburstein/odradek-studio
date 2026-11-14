import test from 'node:test';
import assert from 'node:assert/strict';
import {createExperiment, POLICY_SIZE, simulateTask} from '../src/replica/learning/simulation.js';
import {DEG} from '../src/replica/learning/geometry.js';

const policy=()=>Array(POLICY_SIZE).fill(0);
const poke={id:'metric-poke',kind:'poke',u:.5,v:.5,duration:4};

test('contact and successful-contact metrics are separated from whole episode approach',()=>{
 const experiment=createExperiment(),result=simulateTask(policy(),poke,experiment,{trace:true,reference:true}),m=result.metrics;
 assert.ok(m.rmsError>m.contactRmsError,'approach/lift samples should not contaminate contact-only target accuracy');
 assert.ok(Number.isFinite(m.contactRmsTiltError));
 assert.ok(Number.isFinite(m.contactRmsVelocityError));
 assert.ok(Number.isFinite(m.contactRmsSpeedError));
 assert.equal(m.wholeEpisodeRmsError,m.rmsError,'legacy whole-episode name remains an alias');
 assert.ok(Number.isFinite(m.forceProxyMean)&&Number.isFinite(m.forceProxySD));
 assert.equal(m.forceMean,m.forceProxyMean,'legacy force metric remains an alias');
 assert.ok(m.successfulContactRmsError===null||m.successfulContactRmsError>=0);
 assert.ok(result.frames.every(frame=>Math.abs(frame.pose.gripper-experiment.gripper)<1e-12),'gripper remains fixed');
 // Trace keeps every other step. No pair of displayed frames can jump farther
 // than the configured servo speed permits over the omitted simulation step.
 for(let i=1;i<result.frames.length;i++)for(const axis of ['base','shoulder','elbow']){
  assert.ok(Math.abs(result.frames[i].pose[axis]-result.frames[i-1].pose[axis])<=experiment.maxSpeed*experiment.dt*2+1e-9);
 }
});

test('hovering has no contact reward and stricter penetration limits expose digging',()=>{
 const experiment=createExperiment(),hover=simulateTask(policy(),{...poke,duration:.5},experiment);
 assert.equal(hover.metrics.contactFraction,null);
 assert.equal(hover.metrics.forceProxyMean,0);
 assert.ok(hover.loss>0,'hovering is still penalized for missing the target');
 const strict={...experiment,maxPenetration:.01};
 const normal=simulateTask(policy(),poke,experiment,{reference:true}),digging=simulateTask(policy(),poke,strict,{reference:true});
 assert.ok(digging.metrics.digFraction>0,'assumed penetration beyond the configured cap is reported');
 assert.ok(digging.loss>normal.loss,'digging cannot improve the episode loss');
});

test('collision episodes carry a loss penalty instead of gaining an edge-target reward',()=>{
 const experiment=createExperiment();
 const safe=simulateTask(policy(),{...poke,u:.5,v:.5},experiment,{reference:true});
 const edge=simulateTask(policy(),{...poke,u:1,v:1},experiment,{reference:true});
 assert.ok(edge.metrics.collisionFraction>0,'edge case exercises the modeled collision penalty');
 assert.ok(edge.loss>safe.loss,'colliding edge target must not score as a better episode');
});

test('invalid gripper and timestep configurations are rejected',()=>{
 assert.throws(()=>createExperiment({gripper:180*DEG}),/fixed, valid gripper/);
 assert.throws(()=>simulateTask(policy(),poke,createExperiment(),{dt:1}),/time step/);
 assert.throws(()=>simulateTask(policy(),poke,createExperiment(),{dt:Number.NaN}),/time step/);
});
