import { readFuture, dropFuture } from './future.js';
import { Request, Response, Headers } from './web.js';
import { limit } from './config.js';
import { deadline } from './clock.js';
import { checkTarget } from './policy.js';
import { inSpan } from './telemetry.js';
import { type TraceContext } from './native-otel.js';
import { Exchange } from 'cosmonic:http-exchange/client';
import { Fields, Request as WasiRequest, RequestOptions } from 'wasi:http/types@0.3.0';

const forbidden = new Set([
  'connection', 'http2-settings', 'host', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'proxy-connection', 'transfer-encoding', 'upgrade', 'content-length',
]);
const redirects = new Set([301, 302, 303, 307, 308]);
const maxRequestBytes = 4 * 1024 * 1024;

export async function outboundFetch(input: RequestInfo | URL, init?: RequestInit, parent?: TraceContext): Promise<globalThis.Response> {
  const ms = limit('MCP_OUTBOUND_TIMEOUT_MS', 30_000);
  return inSpan('http.outbound', {}, parent, async span => {
    const lifetime = new AbortController();
    const signal = init?.signal ?? (typeof input === 'object' && 'signal' in input ? input.signal : undefined);
    if (signal?.aborted) throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
    let onAbort: () => void = () => {};
    const canceled = new Promise<never>((_, reject) => {
      onAbort = () => { lifetime.abort(); reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })); };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await deadline(Promise.race([perform(input, { ...init, signal: lifetime.signal }, span.traceparent), canceled]), ms, `outbound request timed out after ${ms} ms`);
    } finally { lifetime.abort(); signal?.removeEventListener('abort', onAbort); }
  });
}
async function perform(input: RequestInfo | URL, init: RequestInit | undefined, traceparent: string): Promise<globalThis.Response> {
  const maxBytes = limit('MCP_OUTBOUND_MAX_BYTES', 4 * 1024 * 1024);
  const request = new Request(input, { ...init, signal: init?.signal ?? undefined });
  if (request.signal.aborted) throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
  let url = new URL(request.url);
  const origin = url.origin;
  let method = request.method;
  let body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > maxRequestBytes) throw new RangeError('HTTP request exceeds 4 MiB');
  if ((method === 'GET' || method === 'HEAD') && body.byteLength) throw new TypeError('GET and HEAD cannot have a body');
  const headers = new Headers(request.headers);
  if (!headers.has('traceparent')) headers.set('traceparent', traceparent);
  if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'identity');
  for (let count = 0; ; count++) {
    checkTarget(url);
    if (request.signal.aborted) throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
    const fields = Fields.fromList([...headers].filter(([key]) => !forbidden.has(key.toLowerCase()))
      .map(([key, value]) => [key, new TextEncoder().encode(value)]));
    const options = new RequestOptions();
    // QuickJS represents WIT u64 inputs as numbers.
    const timeout = (limit('MCP_OUTBOUND_TIMEOUT_MS', 30_000) * 1_000_000) as unknown as bigint;
    options.setConnectTimeout(timeout);
    options.setFirstByteTimeout(timeout);
    options.setBetweenBytesTimeout(timeout);
    async function* requestBytes() { if (body.byteLength) yield body; }
    const [outgoing, finished] = WasiRequest.new(fields,
      requestBytes() as unknown as AsyncIterable<number>, Promise.resolve({ tag: 'ok', val: undefined }), options);
    outgoing.setMethod(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'CONNECT', 'TRACE'].includes(method)
      ? { tag: method.toLowerCase() } as Parameters<WasiRequest['setMethod']>[0] : { tag: 'other', val: method });
    outgoing.setScheme({ tag: url.protocol === 'https:' ? 'HTTPS' : 'HTTP' });
    outgoing.setAuthority(url.host);
    outgoing.setPathWithQuery(url.pathname + url.search);
    let finishedRead = false;
    try {
      const exchange = new Exchange(outgoing);
      const cancel = () => exchange.cancel();
      request.signal.addEventListener('abort', cancel, { once: true });
      let reply: Awaited<ReturnType<Exchange['send']>>;
      try {
        if (request.signal.aborted) exchange.cancel();
        reply = await exchange.send(maxBytes);
      } catch (error) {
        const payload = (error as { payload?: unknown })?.payload ?? error;
        if (payload && typeof payload === 'object' && 'tag' in payload && payload.tag === 'HTTP-response-body-size') {
          throw new RangeError(`HTTP response exceeds ${maxBytes} bytes (default 4 MiB)`);
        }
        throw new TypeError(`Outbound HTTP: ${typeof payload === 'object' ? JSON.stringify(payload) : String(payload)}`);
      } finally {
        request.signal.removeEventListener('abort', cancel);
        exchange[Symbol.dispose]();
      }
      finishedRead = true;
      const completed = await readFuture(finished);
      if (completed.tag === 'err') throw new TypeError(`HTTP request failed: ${JSON.stringify(completed.val)}`);
      const response = new Response(method === 'HEAD' || [204, 205, 304].includes(reply.status) ? null : new Uint8Array(reply.body), {
        status: reply.status,
        headers: reply.headers.map(([key, value]) => [key, new TextDecoder().decode(value)]),
      });
      response.url = url.href;
      response.redirected = count > 0;
      const location = response.headers.get('location');
      if (!redirects.has(reply.status) || !location || request.redirect === 'manual') return response as unknown as globalThis.Response;
      if (request.redirect === 'error') throw new TypeError('HTTP redirect rejected');
      let next: URL;
      try { next = new URL(location, url); }
      catch { return response as unknown as globalThis.Response; }
      // Headers and bodies stay on the original origin.
      if (next.origin !== origin || next.username || next.password) return response as unknown as globalThis.Response;
      if (count === 5) throw new TypeError('Too many HTTP redirects');
      if ((reply.status === 303 && method !== 'HEAD') || ([301, 302].includes(reply.status) && method === 'POST')) {
        method = 'GET';
        body = new Uint8Array();
        headers.delete('content-type');
        headers.delete('content-length');
      }
      url = next;
    } finally {
      if (!finishedRead) dropFuture(finished);
    }
  }
}
Object.assign(globalThis, { fetch: outboundFetch });
