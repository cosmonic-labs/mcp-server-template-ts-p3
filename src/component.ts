import { readFuture, dropFuture } from './future.js';
import './fetch.js';
import { Request as PonyfillRequest, Response } from './web.js';
import { serve, toolNames } from './server.js';
import { discovery } from './discovery.js';
import { allowedHost } from './policy.js';
import { log, parseTraceparent, startSpan, type Span } from './telemetry.js';
import { deadline } from './clock.js';
import { limit } from './config.js';
import { Fields, Request as WasiRequest, Response as WasiResponse, type ErrorCode, type Trailers, type Result } from 'wasi:http/types@0.3.0';

const maxRequestBytes = 4 * 1024 * 1024;
export const handler = {
  async handle(request: WasiRequest) {
    let span: Span | undefined;
    try {
      const incomingFields = request.getHeaders();
      const headers = incomingFields.copyAll().map(([key, value]) => [key, new TextDecoder().decode(value)] as [string, string]);
      incomingFields[Symbol.dispose]();
      const method = request.getMethod();
      const verb = method.tag === 'other' ? method.val : method.tag.toUpperCase();
      const authority = request.getAuthority() ?? '';
      const protocol = request.getScheme()?.tag === 'HTTPS' ? 'https' : 'http';
      const path = request.getPathWithQuery() ?? '/';
      const url = `${protocol}://${authority}${path}`;
      span = startSpan('mcp.request', { 'http.method': verb, 'http.path': path.split('?')[0],
        'mcp.method': headers.find(([key]) => key.toLowerCase() === 'mcp-method')?.[1] ?? '' },
      parseTraceparent(headers.find(([key]) => key.toLowerCase() === 'traceparent')?.[1] ?? null));
      if (['GET', 'HEAD'].includes(verb) && ['/', '/health'].includes(path.split('?')[0])) {
        request[Symbol.dispose]();
        return toWasi(new Response(verb === 'HEAD' ? null : JSON.stringify(discovery(toolNames)), { headers: { 'content-type': 'application/json' } }), span);
      }
      if (!allowedHost(authority)) {
        request[Symbol.dispose]();
        return toWasi(new Response('Forbidden Host', { status: 403 }), span);
      }
      const length = headers.find(([key]) => key.toLowerCase() === 'content-length')?.[1];
      if (length && Number(length) > maxRequestBytes) {
        request[Symbol.dispose]();
        return toWasi(new Response('Payload Too Large', { status: 413 }), span);
      }
      const bytes = await requestBytes(request);
      if (bytes === undefined) return toWasi(new Response('Payload Too Large', { status: 413 }), span);
      const lifetime = new AbortController();
      const response = await serve(new PonyfillRequest(url, {
        method: verb, headers, body: !['GET', 'HEAD'].includes(verb) && bytes.length ? bytes : undefined,
      }) as unknown as globalThis.Request, span.context, lifetime.signal);
      return toWasi(response, span, () => lifetime.abort());
    } catch (error) {
      await span?.finish(error);
      throw { tag: 'internal-error', val: String(error) };
    }
  },
};
async function requestBytes(request: WasiRequest): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const [body, trailers] = WasiRequest.consumeBody(request, Promise.resolve({ tag: 'ok', val: undefined }));
  let readingTrailers = false;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > maxRequestBytes) return undefined;
      chunks.push(chunk);
    }
    readingTrailers = true;
    const end = await readFuture(trailers);
    if (end.tag === 'err') throw new Error(`Request body failed: ${JSON.stringify(end.val)}`);
    end.val?.[Symbol.dispose]();
    return Buffer.concat(chunks);
  } finally { if (!readingTrailers) dropFuture(trailers); }
}
function toWasi(response: globalThis.Response | InstanceType<typeof Response>, span: Span, cancel: () => void = () => {}) {
  const fields = Fields.fromList([...response.headers]
    .filter(([key]) => !['connection', 'keep-alive', 'transfer-encoding', 'content-length'].includes(key.toLowerCase()))
    .map(([key, value]) => [key, new TextEncoder().encode(value)]));
  const body = responseBody(response as unknown as globalThis.Response, span, cancel);
  // QuickJS represents stream<u8> as Uint8Array chunks.
  const [result, transmitted] = WasiResponse.new(fields, body.bytes as unknown as AsyncIterable<number>, body.trailers);
  void readFuture(transmitted).then(async completion => {
    await log('debug', 'response.completion', { completion });
    if (completion.tag === 'err') return body.abort(new Error(`Response transmission failed: ${JSON.stringify(completion.val)}`), completion.val);
  }).catch(error => body.abort(error, { tag: 'connection-terminated' }));
  result.setStatusCode(response.status);
  return result;
}
function responseBody(response: globalThis.Response, span: Span, cancel: () => void) {
  const ms = limit('MCP_RESPONSE_TIMEOUT_MS', 60_000);
  const reader = response.body?.getReader();
  let complete!: (result: Result<Trailers | undefined, ErrorCode>) => void;
  const trailers = new Promise<Result<Trailers | undefined, ErrorCode>>(resolve => { complete = resolve; });
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function close(error?: unknown, code: ErrorCode = { tag: 'connection-write-timeout' }) {
    if (closed) return;
    closed = true;
    cancel();
    clearTimeout(timer);
    complete(error === undefined ? { tag: 'ok', val: undefined } : { tag: 'err', val: code });
    try { await reader?.cancel(); } finally {
      reader?.releaseLock();
      await span.finish(error);
    }
  }
  function arm() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void close(new Error(`Response stream stalled for ${ms} ms`));
      void bytes.return(undefined);
    }, ms);
  }
  const bytes = (async function* (): AsyncGenerator<Uint8Array> {
    let drained = !reader;
    try {
      if (!reader) return;
      while (!closed) {
        const { done, value } = await deadline(reader.read(), ms, `Response stream stalled for ${ms} ms`);
        if (done) drained = true;
        if (done || closed) return;
        arm();
        yield value;
        clearTimeout(timer);
      }
    } catch (error) { await close(error); throw error; }
    finally { await close(drained ? undefined : new Error('Response consumer disconnected'), { tag: 'connection-terminated' }); }
  })();
  arm();
  return { bytes, trailers, async abort(error: unknown, code: ErrorCode) {
    await close(error, code);
    await bytes.return(undefined);
  } };
}
