import test from 'node:test'
import assert from 'node:assert/strict'
import {BOUNDS,DEFAULT_POSE,JOINTS,POINTS,degrees,radians,pullTarget,freshObservation} from '../src/arm-manual/model.js'

test('a pull changes only its selected joint and longer pulls produce larger bounded angles',()=>{
 for(const joint of JOINTS){const small=pullTarget(DEFAULT_POSE,joint,44,5),large=pullTarget(DEFAULT_POSE,joint,220,5);assert.ok(Math.abs(large.deltaDegrees)>Math.abs(small.deltaDegrees));assert.ok(Math.abs(large.deltaDegrees)<=5+1e-9);for(const held of JOINTS.filter(j=>j!==joint))assert.equal(large.pose[held],DEFAULT_POSE[held])}
})
test('opposite pulls reverse direction and a click deadzone produces no position change',()=>{
 for(const joint of JOINTS){assert.deepEqual(pullTarget(DEFAULT_POSE,joint,5).pose,DEFAULT_POSE);assert.ok(pullTarget(DEFAULT_POSE,joint,100).deltaDegrees>0);assert.ok(pullTarget(DEFAULT_POSE,joint,-100).deltaDegrees<0)}
})
test('motor ranges clamp at both endpoints rather than wrapping or continuously rotating',()=>{
 for(const joint of JOINTS){for(const [end,sign]of [[0,-1],[1,1]]){const pose={...DEFAULT_POSE,[joint]:radians(joint,BOUNDS[joint][end])},result=pullTarget(pose,joint,sign*10000,15);assert.ok(Math.abs(degrees(joint,result.pose[joint])-BOUNDS[joint][end])<1e-8);assert.equal(result.limited,true)}}
})
test('all four display conventions round trip and invalid pulls fail before changing state',()=>{
 for(const j of JOINTS)assert.ok(Math.abs(radians(j,degrees(j,DEFAULT_POSE[j]))-DEFAULT_POSE[j])<1e-12)
 for(const args of [[DEFAULT_POSE,'wrist',20],[DEFAULT_POSE,'base',NaN],[DEFAULT_POSE,'base',20,999],[{...DEFAULT_POSE,elbow:NaN},'base',20]])assert.throws(()=>pullTarget(...args))
})
test('live outline requires timestamped valid measurements and never upgrades stale data',()=>{
 const now=Date.now(),o={state:'live',source:'hardware',pose:DEFAULT_POSE,observedAt:new Date(now-100).toISOString()};assert.equal(freshObservation(o,now),true)
 for(const changed of [{state:'stale'},{source:'simulation-preview'},{observedAt:new Date(now-6000).toISOString()},{observedAt:new Date(now+1).toISOString()},{pose:{...DEFAULT_POSE,base:99}}])assert.equal(Boolean(freshObservation({...o,...changed},now)),false)
})
test('the original eight directions and two click points remain separate',()=>{
 assert.equal(POINTS.length,10);assert.equal(new Set(POINTS.map(p=>p.id)).size,10);assert.deepEqual(POINTS.filter(p=>p.id.endsWith('_CLICK')).map(p=>[p.id,p.u,p.v]),[['LEFT_CLICK',.25,.9],['RIGHT_CLICK',.75,.9]])
})
