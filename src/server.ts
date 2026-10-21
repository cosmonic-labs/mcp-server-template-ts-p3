import { limit } from './config.js';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { identity } from '../gen/assets.js';
import { registerSkills, extension, instructions } from './skills.js';
import { inSpan } from './telemetry.js';
import { type TraceContext } from './native-otel.js';
import { unixMilliseconds } from './clock.js';
import { outboundFetch } from './fetch.js';

const definitions = {
  add: { description: 'Add two numbers', inputSchema: z.object({ a: z.number(), b: z.number() }) },
  echo: { description: 'Echo a message', inputSchema: z.object({ message: z.string() }) },
  current_time: { description: 'Get the current UTC time as Unix milliseconds', inputSchema: z.object({}) },
  http_get: { description: 'HTTP GET a URL under the host network policy; return status and up to 4 KiB of text', inputSchema: z.object({ url: z.url() }) },
  http_request: { description: 'Make an HTTP(S) request using the host network capability', inputSchema: z.object({
    url: z.url(), method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).default('GET'),
    headers: z.record(z.string(), z.string()).optional(), body: z.string().optional(),
    redirect: z.enum(['follow', 'manual', 'error']).default('follow'),
  }) },
};
export const toolNames = Object.keys(definitions);
function createServer(parent?: TraceContext, lifetime?: AbortSignal) {
  const server = new McpServer(identity, { instructions, capabilities: { extensions: { [extension]: { directoryRead: true } } } });
  server.registerTool('add', definitions.add, async ({ a, b }) => inSpan('tool.add', {}, parent, async () => {
    const sum = a + b;
    if (!Number.isFinite(sum)) throw new RangeError('The sum must be finite');
    return { content: [{ type: 'text', text: JSON.stringify({ sum }) }], structuredContent: { sum } };
  }));
  server.registerTool('echo', definitions.echo, async ({ message }) => inSpan('tool.echo', {}, parent, async () => ({ content: [{ type: 'text', text: message }] })));
  server.registerTool('current_time', definitions.current_time, async () => inSpan('tool.current_time', {}, parent, async () => ({ content: [{ type: 'text', text: String(unixMilliseconds()) }] })));
  server.registerTool('http_get', definitions.http_get, async ({ url }, ctx) => inSpan('tool.http_get', {}, parent, async span => {
    const response = await outboundFetch(url, { redirect: 'manual', signal: lifetime ?? ctx.mcpReq.signal }, span.context);
    const bytes = new TextEncoder().encode(await response.text());
    let length = Math.min(bytes.length, 4096);
    while (length < bytes.length && (bytes[length] & 0xc0) === 0x80) length--;
    const body = new TextDecoder().decode(bytes.slice(0, length)) + (bytes.length > length ? '…[truncated]' : '');
    return { content: [{ type: 'text', text: `HTTP ${response.status}\n${body}` }] };
  }));
  server.registerTool('http_request', definitions.http_request, async ({ url, method, headers, body, redirect }, ctx) => inSpan('tool.http_request', {}, parent, async span => {
    const progressToken = ctx.mcpReq._meta?.progressToken;
    if (progressToken !== undefined) await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: 0, total: 1 } });
    const response = await outboundFetch(url, { method, headers, body, redirect, signal: lifetime ?? ctx.mcpReq.signal }, span.context);
    if (progressToken !== undefined) await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: 1, total: 1 } });
    const result = { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  }));
  registerSkills(server);
  return server;
}
export function serve(request: Request, parent?: TraceContext, lifetime?: AbortSignal) {
  return createMcpHandler(() => createServer(parent, lifetime), { responseMode: 'sse', keepAliveMs: limit('MCP_KEEPALIVE_MS', 15_000) }).fetch(request);
}
