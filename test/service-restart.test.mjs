import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createServiceRestart}=createRequire(import.meta.url)('../desktop/service-restart.cjs');
test('clean restart uses graceful stop then start, reloads the UI and returns to the originating workspace',async()=>{
 const calls=[],workspace={mode:'safety',reload(){calls.push('reload');}};
 const restart=createServiceRestart({supervisor:{async stop(){calls.push('stop');},async start(){calls.push('start');}},workspace,load:async route=>calls.push(route)});
 await restart();assert.deepEqual(calls,['stop','start','reload','5291/arm-manual/?workspace=safety']);
});
test('cleanup refusal prevents restarting, and overlapping requests never duplicate a shutdown',async()=>{
 const calls=[];let finish;
 const restart=createServiceRestart({supervisor:{stop(){calls.push('stop');return new Promise(resolve=>{finish=resolve;});},async start(){calls.push('start');}},workspace:{mode:'manual',reload(){}},load:async()=>{}});
 const pending=restart();await assert.rejects(restart(),/already running/);assert.deepEqual(calls,['stop']);finish();await pending;assert.deepEqual(calls,['stop','start']);
 const refused=createServiceRestart({supervisor:{async stop(){throw Error('cleanup pending');},async start(){throw Error('must not start');}},workspace:{mode:'safety'},load:async()=>{throw Error('must not load');}});
 await assert.rejects(refused(),/cleanup pending/);
});
