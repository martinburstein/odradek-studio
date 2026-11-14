import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Supervisor } = require('../desktop/supervisor.cjs');

function makeSupervisor(child) {
  const supervisor = new Supervisor({ resources: '.', dataRoot: '.', packaged: false });
  supervisor.child = child;
  supervisor.ready = true;
  return supervisor;
}

function fakeChild({ connected = true, sendBehavior } = {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.connected = connected;
  child.sends = 0;
  child.send = (message, callback) => {
    child.sends++;
    assert.deepEqual(message, { type: 'shutdown' });
    if (sendBehavior) return sendBehavior(child, callback);
    callback?.(null);
  };
  child.finish = (code = 0, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
  };
  return child;
}

test('overlapping stop calls share one shutdown IPC and both await exit', async () => {
  const child = fakeChild();
  const supervisor = makeSupervisor(child);
  const first = supervisor.stop();
  const second = supervisor.stop();
  assert.equal(first, second);
  assert.equal(supervisor.ready, false);
  await Promise.resolve();
  assert.equal(child.sends, 1);
  child.finish(0);
  await Promise.all([first, second]);
  assert.equal(supervisor.child, null);
});

test('clean exit resolves after the shutdown request', async () => {
  const child = fakeChild();
  const supervisor = makeSupervisor(child);
  const pending = supervisor.stop();
  await Promise.resolve();
  child.finish(0);
  await pending;
});

test('nonzero exit rejects and is not reported as clean', async () => {
  const child = fakeChild();
  const supervisor = makeSupervisor(child);
  const pending = supervisor.stop();
  await Promise.resolve();
  child.finish(2);
  await assert.rejects(pending, /incomplete cleanup/);
  assert.equal(supervisor.child, null);
});

test('an already exited child is not sent shutdown again and nonzero status rejects', async () => {
  const clean = fakeChild();
  clean.exitCode = 0;
  const cleanSupervisor = makeSupervisor(clean);
  await cleanSupervisor.stop();
  assert.equal(clean.sends, 0);
  assert.equal(cleanSupervisor.child, null);

  const failed = fakeChild();
  failed.exitCode = 1;
  const failedSupervisor = makeSupervisor(failed);
  await assert.rejects(failedSupervisor.stop(), /incomplete cleanup/);
  assert.equal(failed.sends, 0);
});

test('IPC closing before send waits for the authoritative exit', async () => {
  const child = fakeChild({ connected: false });
  const supervisor = makeSupervisor(child);
  const pending = supervisor.stop();
  await Promise.resolve();
  assert.equal(child.sends, 0);
  child.finish(0);
  await pending;
  assert.equal(supervisor.child, null);
});

test('a send callback error does not substitute for the child exit result', async () => {
  const child = fakeChild({ sendBehavior: (_child, callback) => callback(new Error('channel closed')) });
  const supervisor = makeSupervisor(child);
  const pending = supervisor.stop();
  await Promise.resolve();
  child.finish(1);
  await assert.rejects(pending, /incomplete cleanup/);
});

test('a synchronous send throw still waits for authoritative exit', async () => {
  const child = fakeChild({ sendBehavior: () => { throw new Error('channel closed'); } });
  const supervisor = makeSupervisor(child);
  const pending = supervisor.stop();
  await Promise.resolve();
  child.finish(0);
  await pending;
});
