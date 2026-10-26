import { waitFor, now } from 'wasi:clocks/monotonic-clock@0.3.0';
import { createTimerQueue } from './timer-queue.js';

Object.assign(globalThis, createTimerQueue({
  now: () => Number(now()) / 1_000_000,
  wait: ms => waitFor((Math.round(ms * 1_000_000)) as unknown as bigint),
  onError: error => console.error('Timer callback failed', error),
}));
