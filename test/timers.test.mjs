import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createTimerQueue } from '../src/timer-queue.ts';

function harness(onError) {
  let now = 0;
  let waiting;
  const errors = [];
  const timers = createTimerQueue({
    now: () => now,
    wait: delay => new Promise(resolve => { waiting = { at: now + delay, resolve }; }),
    onError: onError ?? (error => errors.push(error)),
  });
  return { timers, errors, async advance(ms) {
    const end = now + ms;
    while (waiting && waiting.at <= end) {
      now = waiting.at;
      const wake = waiting.resolve;
      waiting = undefined;
      wake();
      await setImmediate();
    }
    now = end;
    await setImmediate();
  } };
}

test('throwing and rejecting callbacks do not stop queued timers or future deadlines', async () => {
  const { timers, errors, advance } = harness();
  const fired = [];
  timers.setTimeout(() => { throw new Error('synchronous failure'); }, 0);
  timers.setTimeout(async () => { throw new Error('asynchronous failure'); }, 0);
  timers.setTimeout(value => fired.push(value), 0, 'first');
  timers.setTimeout(() => fired.push('deadline'), 5);
  await advance(10);
  assert.deepEqual(fired, ['first', 'deadline']);
  assert.deepEqual(errors.map(error => error.message), ['synchronous failure', 'asynchronous failure']);
  timers.setTimeout(() => fired.push('later'), 1);
  await advance(10);
  assert.equal(fired.at(-1), 'later');
});

test('an interval can throw, fire again, and cancel itself', async () => {
  const { timers, errors, advance } = harness();
  let calls = 0;
  const interval = timers.setInterval(() => {
    if (++calls === 3) timers.clearInterval(interval);
    throw new Error('interval failure');
  }, 2);
  await advance(20);
  assert.equal(calls, 3);
  assert.equal(errors.length, 3);
});

test('a failing error reporter cannot stop timers', async () => {
  for (const reporter of [() => { throw new Error('reporter failure'); }, async () => { throw new Error('reporter rejection'); }]) {
    const { timers, advance } = harness(reporter);
    let fired = false;
    timers.setTimeout(() => { throw new Error('callback failure'); }, 0);
    timers.setTimeout(() => { fired = true; }, 0);
    await advance(10);
    assert.equal(fired, true);
  }
});

test('callbacks can clear queued callbacks and schedule another timer', async () => {
  const { timers, advance } = harness();
  const fired = [];
  timers.setTimeout(() => {
    timers.clearTimeout(canceled);
    timers.setTimeout(() => fired.push('nested'), 0);
  }, 0);
  const canceled = timers.setTimeout(() => fired.push('canceled'), 0);
  await advance(10);
  assert.deepEqual(fired, ['nested']);
});
