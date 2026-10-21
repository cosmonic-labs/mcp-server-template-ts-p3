import { onStart, onEnd, outerSpanContext } from 'wasi:otel/tracing@0.2.0-rc.2';
import { type TraceContext } from './native-otel.js';
import { unixMilliseconds } from './clock.js';
import { identity } from '../gen/assets.js';

export function hostParent(): TraceContext | undefined {
  const parent = outerSpanContext();
  if (!/^[a-f0-9]{32}$/.test(parent.traceId) || /^0+$/.test(parent.traceId)) return undefined;
  return { traceId: parent.traceId, spanId: parent.spanId, sampled: !!parent.traceFlags.sampled, traceState: parent.traceState };
}
function instant() {
  const ms = unixMilliseconds();
  return { seconds: Math.floor(ms / 1000) as unknown as bigint, nanoseconds: (ms % 1000) * 1_000_000 };
}
export function startNative(name: string, context: TraceContext, parent: TraceContext | undefined, attributes: Record<string, unknown>) {
  const spanContext = { traceId: context.traceId, spanId: context.spanId, traceFlags: { sampled: context.sampled }, isRemote: false, traceState: context.traceState };
  const startTime = instant();
  onStart(spanContext);
  return (error?: string) => onEnd({ spanContext, parentSpanId: parent?.spanId ?? '', spanKind: name === 'mcp.request' ? 'server' : name === 'http.outbound' ? 'client' : 'internal',
    name, startTime, endTime: instant(), attributes: Object.entries(attributes).map(([key, value]) => ({ key, value: JSON.stringify(value) })),
    events: [], links: [], status: error === undefined ? { tag: 'ok' } : { tag: 'error', val: error },
    instrumentationScope: { name: identity.name, version: identity.version, schemaUrl: undefined, attributes: [] },
    droppedAttributes: 0, droppedEvents: 0, droppedLinks: 0 });
}
