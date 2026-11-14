import test from 'node:test';
import assert from 'node:assert/strict';
import {lazyPilot} from '../apps/waveshare-robotic-arm/src/lazy-pilot.mjs';
test('optional pilot code is not initialized by startup, status, stop or shutdown',async()=>{
 let constructed=0,cancelled=0,settled=0;const pilot=lazyPilot(()=>{constructed++;return{state:()=>({job:'active'}),submit:input=>input,cancel(){cancelled++;},settle(){settled++;return Promise.resolve('clean');}};});
 assert.deepEqual(pilot.state(),{job:null,initialized:false});pilot.cancel();await pilot.settle();assert.equal(constructed,0);
 assert.equal(pilot.submit('request'),'request');assert.equal(pilot.submit('next'),'next');assert.equal(constructed,1);assert.deepEqual(pilot.state(),{job:'active'});pilot.cancel();assert.equal(await pilot.settle(),'clean');assert.equal(cancelled,1);assert.equal(settled,1);
});
test('an optional pilot qualification failure is preserved instead of accepted or retried',()=>{
 let attempts=0;const pilot=lazyPilot(()=>{attempts++;throw Error('Missing reviewed source');});assert.throws(()=>pilot.submit({}),/Missing reviewed source/);assert.equal(attempts,1);assert.deepEqual(pilot.state(),{job:null,initialized:false});
});
