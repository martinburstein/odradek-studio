const MAX_STEPS = 20;
const MAX_DURATION_MS = 60_000;

function validate(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) throw Error('Task must be an object');
  if (!Array.isArray(task.steps) || task.steps.length < 1 || task.steps.length > MAX_STEPS) throw Error(`Task must contain 1..${MAX_STEPS} steps`);
  if (!Number.isInteger(task.maxDurationMs) || task.maxDurationMs < 1 || task.maxDurationMs > MAX_DURATION_MS) throw Error(`maxDurationMs must be an integer from 1 to ${MAX_DURATION_MS}`);
  if (task.name !== undefined && (typeof task.name !== 'string' || !task.name.trim() || task.name.length > 100)) throw Error('Task name must be 1..100 characters');
  for (const [i, step] of task.steps.entries()) {
    if (!step || typeof step !== 'object' || !['joints', 'cartesian'].includes(step.kind) || !step.target || typeof step.target !== 'object' || Array.isArray(step.target)) throw Error(`Invalid task step ${i + 1}`);
    if (step.dwellMs !== undefined && (!Number.isInteger(step.dwellMs) || step.dwellMs < 0 || step.dwellMs > 5000)) throw Error(`Invalid dwellMs in step ${i + 1}`);
  }
}

export function createTaskRunner({ execute, stop, now = Date.now } = {}) {
  if (typeof execute !== 'function' || typeof stop !== 'function') throw Error('execute and stop callbacks are required');
  let active = null;
  let view = { active: false, name: null, progress: 0, total: 0, lastError: null, owner: null };

  const stopOnce = async (run, reason) => {
    if (run.stopPromise) return run.stopPromise;
    run.stopCalled = true;
    try {
      run.stopSettled = false;
      run.stopPromise = Promise.resolve(stop(reason)).catch(error => {
        run.stopError = error instanceof Error ? error.message : String(error);
        if (active === run) view.stopError = run.stopError;
      }).finally(() => {
        run.stopSettled = true;
        maybeRelease(run);
      });
    } catch (error) {
      run.stopError = error instanceof Error ? error.message : String(error);
      if (active === run) view.stopError = run.stopError;
      run.stopPromise = Promise.resolve();
      run.stopSettled = true;
    }
    return run.stopPromise;
  };

  const maybeRelease = run => {
    if (run.releaseRequested && run.inFlightSettled && run.stopSettled && active === run) {
      active = null;
      view.active = false;
    }
  };
  const releaseWhenSafe = run => {
    // Keep admission reserved until execute and asynchronous stop cleanup both
    // settle. Either callback can remain uncertain after the caller gets an error.
    run.releaseRequested = true;
    maybeRelease(run);
  };

  async function run(task, context = {}) {
    validate(task);
    if (active) throw Error('A task is already active');
    const controller = new AbortController();
    const started = now();
    let cancelReject;
    const cancelled = new Promise((_, reject) => { cancelReject = reject; });
    // Promise.race attaches a rejection handler to this promise even if cancellation
    // happens between steps, preventing unhandled rejection warnings.
    const current = {
      controller, cancelReject, stopCalled: false, stopError: null, stopPromise: null,
      inFlight: null, inFlightSettled: true, stopSettled: true, releaseRequested: false,
      deadline: started + task.maxDurationMs, timer: null, timerReject: null
    };
    active = current;
    view = { active: true, name: task.name || null, progress: 0, total: task.steps.length, lastError: null, owner: context.owner ?? null };
    const timedOut = new Promise((_, reject) => {
      current.timerReject = reject;
      current.timer = setTimeout(() => {
        const error = Error(`Task exceeded ${task.maxDurationMs}ms deadline`);
        view.lastError = error.message;
        controller.abort(error);
        cancelReject(error);
        void stopOnce(current, error.message);
        reject(error);
      }, task.maxDurationMs);
    });
    // Attach the timeout rejection handler immediately for normal early completion.
    timedOut.catch(() => {});
    const check = () => {
      if (controller.signal.aborted) throw Error('Task cancelled');
      if (now() >= current.deadline) {
        const error = Error(`Task exceeded ${task.maxDurationMs}ms deadline`);
        controller.abort(error); cancelReject(error); void stopOnce(current, error.message); throw error;
      }
    };
    const taskContext = { ...context, signal: controller.signal };
    try {
      for (let i = 0; i < task.steps.length; i++) {
        check();
        current.inFlightSettled = false;
        current.inFlight = Promise.resolve().then(() => execute(task.steps[i], taskContext));
        current.inFlight.then(
          () => { current.inFlightSettled = true; maybeRelease(current); },
          () => { current.inFlightSettled = true; maybeRelease(current); }
        );
        await Promise.race([current.inFlight, cancelled, timedOut]);
        current.inFlight = null;
        current.inFlightSettled = true;
        check();
        view.progress = i + 1;
        const dwell = task.steps[i].dwellMs || 0;
        if (dwell) {
          await Promise.race([new Promise(resolve => setTimeout(resolve, dwell)), cancelled, timedOut]);
          check();
        }
      }
      return { completed: true, progress: view.progress, total: view.total, owner: view.owner };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      view.lastError = view.lastError || message;
      if (!controller.signal.aborted) controller.abort(error);
      cancelReject(error);
      void stopOnce(current, view.lastError);
      if (current.stopError) view.stopError = current.stopError;
      throw error;
    } finally {
      clearTimeout(current.timer);
      releaseWhenSafe(current);
    }
  }

  async function stopTask(reason = 'Task stopped') {
    if (!active) return status();
    const current = active;
    const message = String(reason || 'Task stopped');
    current.controller.abort(Error(message));
    current.cancelReject(Error(message));
    current.timerReject?.(Error(message));
    await stopOnce(current, message);
    view.lastError = view.lastError || message;
    if (current.stopError) view.stopError = current.stopError;
    return status();
  }

  function status() { return { ...view }; }
  return { run, stop: stopTask, status };
}
