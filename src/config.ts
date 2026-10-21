import { getEnvironment } from 'wasi:cli/environment@0.3.0';

export function env(name: string): string | undefined {
  return getEnvironment().find(([key]) => key === name)?.[1];
}
export function limit(name: string, fallback: number): number {
  const text = env(name);
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RangeError(`${name} must be an integer from 1 to 2147483647`);
  }
  return value;
}
