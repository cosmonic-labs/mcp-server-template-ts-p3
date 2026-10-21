export type TraceContext = { traceId: string; spanId: string; sampled: boolean; traceState: [string, string][] };
export function hostParent(): TraceContext | undefined { return undefined; }
export function startNative(_name: string, _context: TraceContext, _parent: TraceContext | undefined, _attributes: Record<string, unknown>): (error?: string) => void {
  return () => {};
}
