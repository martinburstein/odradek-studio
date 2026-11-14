import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { createLearningSave } = require('../desktop/learning-save.cjs');
const RESULT = 'odradek:learning-close-result';
const PREPARE = 'odradek:prepare-learning-close';
const ORIGIN = 'http://127.0.0.1:5291';

function harness(url = `${ORIGIN}/arm-manual/`) {
  const ipcMain = new EventEmitter();
  const frame = { origin: ORIGIN };
  const sent = [];
  let destroyed = false;
  const webContents = {
    mainFrame: frame,
    getURL: () => url,
    isDestroyed: () => destroyed,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  const window = { webContents, isDestroyed: () => destroyed };
  return {
    ipcMain, frame, sent, window, webContents,
    destroy() { destroyed = true; },
    respond(payload, overrides = {}) {
      ipcMain.emit(RESULT, { sender: webContents, senderFrame: frame, ...overrides }, payload);
    },
  };
}

test('prepare sends a nonce and resolves only for the trusted main frame and matching id', async () => {
  const h = harness();
  const save = createLearningSave(h);
  const first = save.prepare();
  const second = save.prepare();
  assert.equal(first, second);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].channel, PREPARE);
  const { id } = h.sent[0].payload;

  h.respond({ id: 'wrong', ok: true });
  h.respond({ id, ok: true }, { sender: {} });
  h.respond({ id, ok: true }, { senderFrame: { origin: ORIGIN } });
  h.respond({ id, ok: true }, { senderFrame: { origin: 'http://localhost:5291' } });
  let settled = false;
  first.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);

  h.respond({ id, ok: true });
  await first;
  save.dispose();
});

test('renderer save errors reject with a bounded message', async () => {
  const h = harness();
  const save = createLearningSave(h);
  const pending = save.prepare();
  h.respond({ id: h.sent[0].payload.id, ok: false, error: 'x'.repeat(900) });
  await assert.rejects(pending, error => error.message.length === 500);
  save.dispose();
});

test('timeout is bounded and clears the pending request', async () => {
  const h = harness();
  const save = createLearningSave({ ...h, timeoutMs: 0 });
  const pending = save.prepare();
  await assert.rejects(pending, /Timed out/);
  save.dispose();
});

test('prepare skips destroyed or unloaded contents and rejects unexpected origins', async () => {
  const dead = harness();
  dead.destroy();
  const deadSave = createLearningSave(dead);
  await deadSave.prepare();
  deadSave.dispose();

  const unloaded = harness('about:blank');
  const unloadedSave = createLearningSave(unloaded);
  await unloadedSave.prepare();
  assert.equal(unloaded.sent.length, 0);
  unloadedSave.dispose();

  const foreign = harness('http://127.0.0.1:5274/');
  const foreignSave = createLearningSave(foreign);
  await assert.rejects(foreignSave.prepare(), /Unexpected learning page origin/);
  assert.equal(foreign.sent.length, 0);
  foreignSave.dispose();
});

test('dispose unregisters the listener and rejects pending work', async () => {
  const h = harness();
  const save = createLearningSave(h);
  const pending = save.prepare();
  assert.equal(h.ipcMain.listenerCount(RESULT), 1);
  save.dispose();
  assert.equal(h.ipcMain.listenerCount(RESULT), 0);
  await assert.rejects(pending, /disposed before checkpoint/);
  await assert.rejects(save.prepare(), /is disposed/);
});

test('an unexpected error response shape rejects without waiting for timeout', async () => {
  const h = harness();
  const save = createLearningSave(h);
  const pending = save.prepare();
  h.respond({ id: h.sent[0].payload.id, ok: 'yes' });
  await assert.rejects(pending, /Invalid learning close response/);
  save.dispose();
});
