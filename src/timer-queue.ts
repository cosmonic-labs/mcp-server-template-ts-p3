type Timer = { ref(): Timer; unref(): Timer; hasRef(): boolean };
type Callback = (...args: unknown[]) => unknown;
type Entry = { callback: Callback; args: unknown[]; due: number; interval?: number };
type Clock = { now(): number; wait(ms: number): Promise<void>; onError(error: unknown): unknown };

export function createTimerQueue(clock: Clock) {
  const timers = new Map<Timer, Entry>();
  let running = false;
  function report(error: unknown) {
    try { void Promise.resolve(clock.onError(error)).catch(() => {}); } catch { /* Error reporting must not stop timers. */ }
  }
  async function run() {
    if (running) return;
    running = true;
    try {
      while (timers.size) {
        let remaining = 10;
        const now = clock.now();
        for (const entry of timers.values()) remaining = Math.min(remaining, entry.due - now);
        await clock.wait(Math.max(0, remaining));
        for (const [timer, entry] of [...timers]) {
          if (timers.get(timer) !== entry || entry.due > clock.now()) continue;
          if (entry.interval === undefined) timers.delete(timer);
          else entry.due = clock.now() + entry.interval;
          try { void Promise.resolve(entry.callback(...entry.args)).catch(report); }
          catch (error) { report(error); }
        }
      }
    } finally { running = false; }
  }
  function schedule(callback: Callback, delay = 0, repeat = false, args: unknown[]): Timer {
    if (typeof callback !== 'function') throw new TypeError('Timer callback must be a function');
    const timer: Timer = { ref() { return this; }, unref() { return this; }, hasRef() { return false; } };
    const ms = Math.min(2_147_483_647, Math.max(repeat ? 1 : 0, Number(delay) || 0));
    timers.set(timer, { callback, args, due: clock.now() + ms, ...(repeat ? { interval: ms } : {}) });
    void run().catch(report);
    return timer;
  }
  function clear(timer?: Timer) { if (timer) timers.delete(timer); }
  return {
    setTimeout: (callback: Callback, delay?: number, ...args: unknown[]) => schedule(callback, delay, false, args),
    setInterval: (callback: Callback, delay?: number, ...args: unknown[]) => schedule(callback, delay, true, args),
    clearTimeout: clear,
    clearInterval: clear,
  };
}
