import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import * as z from 'zod';

const endpoint = new URL(process.env.MCP_DESKTOP_URL ?? 'http://127.0.0.1:8200/mcp');
const authority = process.env.MCP_DESKTOP_HOST ?? 'mcp-off-shelf.localhost';
const allowedUrl = process.env.MCP_DESKTOP_ALLOWED_URL;
const deniedUrl = process.env.MCP_DESKTOP_DENIED_URL ?? 'https://example.org/';

if (allowedUrl) {
  assert.equal(new URL(allowedUrl).protocol, 'https:', 'The allowed probe must exercise TLS');
  assert.notEqual(new URL(allowedUrl).host, new URL(deniedUrl).host, 'Use distinct allowed and denied hosts');
}

async function desktopFetch(input, init) {
  const request = new Request(input, init);
  const headers = new Headers(request.headers);
  headers.set('host', authority);
  return fetch(request, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]),
  });
}

const health = await desktopFetch(new URL('/health', endpoint));
if (health.status !== 200) {
  const detail = (await health.text()).slice(0, 1000);
  const hint = health.status === 404
    ? 'Desktop is reachable, but this request did not reach the MCP server. '
      + 'Start this project in another terminal with `cosmonic dev --path .` and wait for the workload to be running. '
      + 'If it is already deployed, match MCP_DESKTOP_HOST to its ingress binding and MCP_DESKTOP_URL to its ingress address.'
    : 'Check the workload state and logs in Desktop.';
  throw new Error(`Desktop health returned HTTP ${health.status} at ${new URL('/health', endpoint)} `
    + `(Host: ${authority}). ${hint}${detail ? ` Response: ${detail}` : ''}`);
}
assert.equal((await health.json()).protocol.specVersion, '2026-07-28');
console.log('Desktop ingress and discovery passed.');

for (const mode of ['legacy', { pin: '2026-07-28' }]) {
  const client = new Client({ name: 'desktop-smoke', version: '0.1.0' }, { versionNegotiation: { mode } });
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint, { fetch: desktopFetch }));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['add', 'current_time', 'echo', 'http_get', 'http_request']);
    const sums = await Promise.all(Array.from({ length: 4 }, (_, a) => client.callTool({ name: 'add', arguments: { a, b: 10 } })));
    assert.deepEqual(sums.map(result => result.structuredContent.sum), [10, 11, 12, 13]);
    const echo = await client.callTool({ name: 'echo', arguments: { message: 'Desktop 👋 café' } });
    assert.equal(echo.content[0].text, 'Desktop 👋 café');
    const invalid = await client.callTool({ name: 'add', arguments: { a: 'wrong', b: 1 } });
    assert.equal(invalid.isError, true);
    const now = await client.callTool({ name: 'current_time', arguments: {} });
    assert.ok(Math.abs(Number(now.content[0].text) - Date.now()) < 10_000);

    const custom = (method, params = {}) => client.request({ method, params }, z.object({}).passthrough());
    const listed = await custom('skills/list');
    assert.equal(listed.skills.length, 1);
    for (const skill of listed.skills) {
      assert.deepEqual((await custom('skills/get', { uri: skill.uri })).skill, skill);
      for (const file of skill.resources) {
        const read = await client.readResource({ uri: file.uri });
        const bytes = Buffer.from(read.contents[0].text);
        assert.equal(bytes.length, file.size);
        assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, file.digest);
      }
    }
    const directory = await custom('resources/directory/read', { uri: 'skill://mcp-off-shelf' });
    assert.ok(directory.resources.some(resource => resource.name === 'SKILL.md'));
    await assert.rejects(client.readResource({ uri: 'skill://mcp-off-shelf/references/../SKILL.md' }), error => error.code === -32602);

    const privateTarget = await client.callTool({ name: 'http_get', arguments: { url: 'http://127.0.0.1/' } });
    assert.equal(privateTarget.isError, true);
    assert.match(privateTarget.content[0].text, /local\/private/);
    const denied = await client.callTool({ name: 'http_get', arguments: { url: deniedUrl } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /HTTP-request-denied/i, 'Expected host policy denial, rather than DNS/TLS failure');

    if (allowedUrl) {
      const progress = [];
      const result = await client.callTool({ name: 'http_request', arguments: { url: allowedUrl } }, {
        onprogress: update => progress.push(update.progress),
      });
      assert.ok(!result.isError, JSON.stringify(result));
      assert.equal(result.structuredContent.status, 200);
      assert.ok(result.structuredContent.body.length > 0);
      assert.deepEqual(progress, [0, 1]);
      console.log(`Live HTTPS and SSE progress passed: ${JSON.stringify(mode)}`);
    }
    console.log(`Protocol, tools, skills, concurrency, and denied egress passed: ${JSON.stringify(mode)}`);
  } finally {
    await client.close();
  }
}

if (!allowedUrl) console.log('Live HTTPS probe not run. Set MCP_DESKTOP_ALLOWED_URL and grant only that host in Desktop.');
console.log('Desktop smoke test passed.');
