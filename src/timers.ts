import { waitFor, now } from 'wasi:clocks/monotonic-clock@0.3.0';

type Timer = { ref(): Timer; unref(): Timer; hasRef(): boolean };
type Entry = { callback: (...args: unknown[]) => void; args: unknown[]; due: number; interval?: number };
const timers = new Map<Timer, Entry>();
let running = false;
const milliseconds = () => Number(now()) / 1_000_000;
async function run() {
  if (running) return;
  running = true;
  try {
    while (timers.size) {
      const remaining = Math.min(...[...timers.values()].map(entry => entry.due - milliseconds()));
      // A short shared wait bounds canceled timer retention and native subtasks.
      await waitFor((Math.max(0, Math.min(10, remaining)) * 1_000_000) as unknown as bigint);
      for (const [timer, entry] of [...timers]) {
        if (timers.get(timer) !== entry || entry.due > milliseconds()) continue;
        if (entry.interval === undefined) timers.delete(timer);
        else entry.due = milliseconds() + entry.interval;
        entry.callback(...entry.args);
      }
    }
  } finally { running = false; }
}
function schedule(callback: (...args: unknown[]) => void, delay = 0, repeat = false, args: unknown[]): Timer {
  const timer: Timer = { ref() { return this; }, unref() { return this; }, hasRef() { return false; } };
  const ms = Math.min(2_147_483_647, Math.max(repeat ? 1 : 0, Number(delay) || 0));
  timers.set(timer, { callback, args, due: milliseconds() + ms, ...(repeat ? { interval: ms } : {}) });
  void run();
  return timer;
}
Object.assign(globalThis, {
  setTimeout: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => schedule(callback, delay, false, args),
  setInterval: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => schedule(callback, delay, true, args),
  clearTimeout: (timer?: Timer) => { if (timer) timers.delete(timer); },
  clearInterval: (timer?: Timer) => { if (timer) timers.delete(timer); },
});
