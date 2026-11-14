'use strict';

const { randomUUID } = require('node:crypto');

const PREPARE_CHANNEL = 'odradek:prepare-learning-close';
const RESULT_CHANNEL = 'odradek:learning-close-result';
const EXPECTED_ORIGIN = 'http://127.0.0.1:5291';
const MAX_ERROR_LENGTH = 500;

function createLearningSave({ window, ipcMain, timeoutMs = 8000 }) {
  if (!window?.webContents || !ipcMain?.on || !ipcMain?.removeListener) {
    throw new TypeError('window and ipcMain are required');
  }

  const requestedTimeout = Number(timeoutMs);
  const boundedTimeout = Number.isFinite(requestedTimeout)
    ? Math.min(15000, Math.max(1, requestedTimeout))
    : 8000;
  const webContents = window.webContents;
  let pending = null;
  let disposed = false;

  const clearPending = () => {
    if (!pending) return null;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    return current;
  };

  const onResult = (event, result) => {
    if (!pending || event?.sender !== webContents) return;
    const frame = event.senderFrame;
    if (!frame || frame !== webContents.mainFrame || frame.origin !== EXPECTED_ORIGIN) return;
    if (!result || result.id !== pending.id) return;

    const current = clearPending();
    if (result.ok === true) {
      current.resolve();
    } else if (result.ok === false) {
      const message = typeof result.error === 'string' && result.error.trim()
        ? result.error.slice(0, MAX_ERROR_LENGTH)
        : 'Learning checkpoint could not be saved';
      current.reject(new Error(message));
    } else {
      current.reject(new Error('Invalid learning close response'));
    }
  };

  ipcMain.on(RESULT_CHANNEL, onResult);

  function prepare() {
    if (pending) return pending.promise;
    if (disposed) return Promise.reject(new Error('Learning save coordinator is disposed'));

    if (window.isDestroyed?.() || webContents.isDestroyed?.()) return Promise.resolve();

    const url = webContents.getURL?.() || '';
    if (!url || url === 'about:blank') return Promise.resolve();
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      return Promise.reject(new Error('Learning page has an invalid origin'));
    }
    if (origin !== EXPECTED_ORIGIN) {
      return Promise.reject(new Error(`Unexpected learning page origin: ${origin}`));
    }

    const id = randomUUID();
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const timer = setTimeout(() => {
      const current = clearPending();
      if (current) current.reject(new Error('Timed out preparing the learning checkpoint'));
    }, boundedTimeout);
    pending = { id, promise, resolve, reject, timer };

    try {
      webContents.send(PREPARE_CHANNEL, { id });
    } catch (error) {
      const current = clearPending();
      if (current) current.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    ipcMain.removeListener(RESULT_CHANNEL, onResult);
    const current = clearPending();
    if (current) current.reject(new Error('Learning save coordinator disposed before checkpoint completed'));
  }

  return { prepare, dispose };
}

module.exports = { createLearningSave };
