import { now as wallNow } from 'wasi:clocks/system-clock@0.3.0';
import { waitFor } from 'wasi:clocks/monotonic-clock@0.3.0';

export function unixMilliseconds(): number {
  const now = wallNow();
  return Number(now.seconds) * 1000 + Math.floor(now.nanoseconds / 1_000_000);
}
export async function sleep(ms: number): Promise<void> {
  await waitFor((Math.max(0, ms) * 1_000_000) as unknown as bigint);
}
export async function deadline<T>(operation: PromiseLike<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer!); }
}
