import { readFuture } from './future.js';
import { writeViaStream } from 'wasi:cli/stderr@0.3.0';
import { env } from './config.js';
import { unixMilliseconds } from './clock.js';
import { hostParent, startNative, type TraceContext } from './native-otel.js';

const levels = ['trace', 'debug', 'info', 'warn', 'error', 'off'];
export type Span = ReturnType<typeof startSpan>;
export function parseTraceparent(value: string | null): TraceContext | undefined {
  const m = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/.exec(value ?? '');
  if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return undefined;
  return { traceId: m[1], spanId: m[2], sampled: !!(parseInt(m[3], 16) & 1), traceState: [] };
}
export async function log(level: string, message: string, fields: Record<string, unknown> = {}) {
  const configured = (env('MCP_LOG_LEVEL') ?? env('RUST_LOG') ?? 'info').toLowerCase();
  const threshold = levels.includes(configured) ? configured : 'info';
  if (levels.indexOf(level) < levels.indexOf(threshold)) return;
  const bytes = new TextEncoder().encode(JSON.stringify({ timestamp: unixMilliseconds(), level, message, ...fields }) + '\n');
  try { await readFuture(writeViaStream([bytes] as unknown as AsyncIterable<number>)); } catch { /* Logging must not fail a request. */ }
}
export function startSpan(name: string, fields: Record<string, unknown>, parent?: TraceContext) {
  parent ??= hostParent();
  const started = unixMilliseconds();
  const context: TraceContext = { traceId: parent?.traceId ?? crypto.randomUUID().replaceAll('-', ''),
    spanId: crypto.randomUUID().replaceAll('-', '').slice(0, 16), sampled: parent?.sampled ?? true, traceState: parent?.traceState ?? [] };
  const traceparent = `00-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;
  const finishNative = startNative(name, context, parent, fields);
  let ended = false;
  return { context, traceparent,
    async finish(error?: unknown) {
      if (ended) return;
      ended = true;
      finishNative(error === undefined ? undefined : String(error));
      await log(error === undefined ? 'info' : 'error', name, { ...fields, traceparent, trace_id: context.traceId,
        span_id: context.spanId, parent_span_id: parent?.spanId, duration_ms: unixMilliseconds() - started,
        ...(error === undefined ? {} : { error: String(error) }) });
    },
  };
}
export async function inSpan<T>(name: string, fields: Record<string, unknown>, parent: TraceContext | undefined, work: (span: Span) => Promise<T>): Promise<T> {
  const span = startSpan(name, fields, parent);
  try { const value = await work(span); await span.finish(); return value; }
  catch (error) { await span.finish(error); throw error; }
}
