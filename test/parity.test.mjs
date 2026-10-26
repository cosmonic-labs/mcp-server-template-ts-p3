import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import * as z from 'zod';
import { fetchComponent } from './runtime.mjs';
const exec = promisify(execFile);
const host = process.env.MCP_HTTP_TEST_HOST;
const cache = 'gen/outbound-fixture.cwasm';

async function raw(method, url, body = '', headers = {}) {
  return fetchComponent(url, { method, headers, ...(body ? { body } : {}) });
}
async function withEnv(env, work) {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try { return await work(); } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
}
for (const mode of ['legacy', { pin: '2026-07-28' }]) {
  test(`Rust template parity through official client: ${JSON.stringify(mode)}`, async () => {
    const client = new Client({ name: 'parity-test', version: '0.1.0' }, { versionNegotiation: { mode } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch: fetchComponent }));
      assert.equal(client.getServerCapabilities().extensions['io.modelcontextprotocol/skills'].directoryRead, true);
      const custom = (method, params = {}) => client.request({ method, params }, z.object({}).passthrough());
      const listed = await custom('skills/list');
      assert.equal(listed.ttlMs, 3600000);
      assert.equal(listed.cacheScope, 'public');
      assert.equal(listed.skills.length, 1);
      const skill = listed.skills[0];
      assert.equal(skill.uri, 'skill://mcp-off-shelf/SKILL.md');
      assert.equal(skill.frontmatter.metadata.version, '0.1.0');
      assert.deepEqual((await custom('skills/get', { uri: skill.uri })).skill, skill);
      const resources = await client.listResources();
      assert.ok(resources.resources.some(file => file.uri === skill.uri));
      assert.ok(resources.resources.some(file => file.uri === 'skill://index.json'));
      for (const file of skill.resources) {
        const read = await client.readResource({ uri: file.uri });
        const bytes = Buffer.from(read.contents[0].text);
        assert.equal(bytes.length, file.size);
        assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, file.digest);
      }
      const index = JSON.parse((await client.readResource({ uri: 'skill://index.json' })).contents[0].text);
      assert.deepEqual(index.skills, listed.skills);
      const root = await custom('resources/directory/read', { uri: 'skill://mcp-off-shelf' });
      assert.ok(root.resources.some(file => file.mimeType === 'inode/directory' && file.name === 'references'));
      const refs = await custom('resources/directory/read', { uri: 'skill://mcp-off-shelf/references' });
      assert.equal(refs.resources[0].uri, 'skill://mcp-off-shelf/references/TOOLS.md');
      for (const uri of ['skill://mcp-off-shelf/', 'skill://mcp-off-shelf/../server', 'skill://unknown', skill.uri]) {
        await assert.rejects(custom('resources/directory/read', { uri }), error => error.code === -32602);
      }
      await assert.rejects(custom('skills/get', { uri: 'skill://mcp-off-shelf/nope' }), error => error.code === -32602);
      for (const uri of ['skill://mcp-off-shelf/../secret', 'skill://mcp-off-shelf/references/../SKILL.md', 'skill://mcp-off-shelf/references/%2e%2e/SKILL.md']) {
        await assert.rejects(client.readResource({ uri }), error => error.code === -32602);
      }
      const privateRedirect = await client.callTool({ name: 'http_request', arguments: { url: 'https://fixture.test/private-redirect' } });
      assert.equal(privateRedirect.structuredContent.status, 302);
      assert.equal(privateRedirect.structuredContent.headers.location, 'http://127.0.0.1/internal');
      const templates = await client.listResourceTemplates();
      assert.equal(templates.resourceTemplates.length, 2);
      const now = await client.callTool({ name: 'current_time', arguments: {} });
      assert.ok(Math.abs(Number(now.content[0].text) - Date.now()) < 5000);
      const preview = await client.callTool({ name: 'http_get', arguments: { url: 'https://fixture.test/multibyte' } });
      assert.equal(preview.isError, undefined);
      assert.equal(preview.content[0].text, 'HTTP 200\n' + 'é'.repeat(2048) + '…[truncated]');
      for (const url of ['http://127.0.0.1/', 'http://10.1.2.3/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/', 'http://x.localhost/', 'http://0x7f000001/']) {
        const result = await client.callTool({ name: 'http_request', arguments: { url } });
        assert.equal(result.isError, true, url);
        assert.match(result.content[0].text, /local\/private/);
      }
      await withEnv({ MCP_OUTBOUND_MAX_BYTES: '20' }, async () => {
        const result = await client.callTool({ name: 'http_get', arguments: { url: 'https://fixture.test/echo' } });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /20 bytes/);
      });
      await withEnv({ MCP_OUTBOUND_TIMEOUT_MS: '80' }, async () => {
        const start = Date.now();
        for (const path of ['stalled', 'stalled-body']) {
          const result = await client.callTool({ name: 'http_request', arguments: { url: `https://fixture.test/${path}` } });
          assert.equal(result.isError, true);
          assert.match(result.content[0].text, /timed out after 80 ms/);
        }
        assert.ok(Date.now() - start < 2000);
      });
    } finally { await client.close(); }
  });
}

test('health discovery, DNS rebinding guard, request limits, and trace logs', async () => {
  for (const path of ['/', '/health', '/health?probe=1']) {
    const response = await raw('GET', `http://probe.invalid${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    const document = await response.json();
    assert.equal(document.protocol.specVersion, '2026-07-28');
    assert.ok(document.capabilities.tools.includes('current_time'));
    assert.equal(document.skills[0].uri, 'skill://mcp-off-shelf/SKILL.md');
  }
  assert.equal((await raw('HEAD', 'http://probe.invalid/health')).status, 200);
  assert.equal((await raw('POST', 'http://evil.test/mcp', '{}')).status, 403);
  await withEnv({ MCP_ALLOWED_HOSTS: 'service.test:9090' }, async () => {
    assert.equal((await raw('POST', 'http://service.test:9091/mcp', '{}')).status, 403);
    assert.notEqual((await raw('POST', 'http://service.test:9090/mcp', '{}')).status, 403);
  });
  await withEnv({ MCP_ALLOWED_HOSTS: 'service.test:80' }, async () => {
    assert.equal((await raw('POST', 'http://service.test/mcp', '{}')).status, 403);
    const pending = exec(host, [cache], { timeout: 5000 });
    pending.child.stdin.end(JSON.stringify(['POST', 'http://service.test:80/mcp', '[]', '{}']));
    const { stdout } = await pending;
    assert.notEqual(JSON.parse(JSON.parse(stdout)).status, 403);
  });
  await withEnv({ MCP_ALLOWED_HOSTS: 'service.test' }, async () => {
    assert.notEqual((await raw('POST', 'http://service.test:9091/mcp', '{}')).status, 403);
  });
  assert.equal((await raw('POST', 'http://localhost/mcp', 'x'.repeat(4 * 1024 * 1024 + 1))).status, 413);
  const traceparent = '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01';
  const pending = exec(host, [cache], { timeout: 5000 });
  pending.child.stdin.end(JSON.stringify(['GET', 'http://localhost/', JSON.stringify([['traceparent', traceparent]]), '']));
  const { stderr } = await pending;
  const logs = stderr.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(logs.some(log => log.message === 'mcp.request' && log.trace_id === '1234567890abcdef1234567890abcdef' && log.parent_span_id === '1234567890abcdef'));
});

test('overlapping invocations on one native instance', async () => {
  const call = i => ['POST', 'http://localhost/mcp', JSON.stringify([['content-type', 'application/json'], ['accept', 'application/json, text/event-stream']]),
    JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'http_get', arguments: { url: 'https://fixture.test/delayed' } } })];
  const pending = exec(host, [cache, '--batch'], { timeout: 5000 });
  pending.child.stdin.end(JSON.stringify([call(1), call(2)]));
  const { stdout } = await pending;
  for (const response of JSON.parse(stdout).map(JSON.parse)) {
    assert.equal(response.status, 200);
    assert.match(response.body, /HTTP 200/);
  }
});

test('overlapping clients with the same JSON-RPC id keep credentials and results isolated', async () => {
  for (const protocol of ['2025-11-25', '2026-07-28']) {
    const markers = ['TEST_CLIENT_A_SECRET', 'TEST_CLIENT_B_SECRET'];
    const calls = markers.map(marker => ['POST', 'http://localhost/mcp', JSON.stringify([
      ['content-type', 'application/json'], ['accept', 'application/json, text/event-stream'], ['mcp-protocol-version', protocol], ['mcp-method', 'tools/call'], ['mcp-name', 'http_request'],
    ]), JSON.stringify({ jsonrpc: '2.0', id: 17, method: 'tools/call', params: {
      ...(protocol === '2026-07-28' ? { _meta: {
        'io.modelcontextprotocol/protocolVersion': protocol,
        'io.modelcontextprotocol/clientInfo': { name: 'isolation-test', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } : {}),
      name: 'http_request', arguments: { url: `https://fixture.test/delayed?client=${marker}`, method: 'POST',
        headers: { api_key: marker }, body: marker },
    } })]);
    const pending = exec(host, [cache, '--batch'], { timeout: 5000 });
    pending.child.stdin.end(JSON.stringify(calls));
    const { stdout } = await pending;
    const responses = JSON.parse(stdout).map(JSON.parse);
    for (let i = 0; i < responses.length; i++) {
      assert.equal(responses[i].status, 200, responses[i].body);
      assert.ok(responses[i].body.includes(markers[i]), responses[i].body);
      assert.ok(!responses[i].body.includes(markers[1 - i]), responses[i].body);
    }
  }
});

test('p3 headers and progress frames arrive before a delayed tool result', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'http_request', arguments: { url: 'https://fixture.test/delayed' }, _meta: { progressToken: 'stream-probe' },
  } });
  const pending = exec(host, [cache, '--probe'], { timeout: 5000 });
  pending.child.stdin.end(JSON.stringify(['POST', 'http://localhost/mcp', JSON.stringify([['content-type', 'application/json'], ['accept', 'application/json, text/event-stream']]), body]));
  const { stdout } = await pending;
  const response = JSON.parse(JSON.parse(stdout));
  const progress = response.frames.find(frame => frame.text.includes('notifications/progress'));
  const result = response.frames.find(frame => frame.text.includes('structuredContent'));
  assert.ok(progress, response.body);
  assert.ok(result, response.body);
  assert.ok(result.ms - progress.ms >= 40, JSON.stringify(response.frames));
  assert.ok(result.ms - response.headersMs >= 40, JSON.stringify(response));
});

test('a canceled streaming tool releases native I/O before the next request', async () => withEnv({ MCP_KEEPALIVE_MS: '10' }, async () => {
  for (const [path, marker] of [['stalled', 'stalled-canceled'], ['stalled-body', 'body-canceled']]) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'http_request', arguments: { url: `https://fixture.test/${path}` }, _meta: { progressToken: 'cancel-probe' },
    } });
    const pending = exec(host, [cache, '--cancel'], { timeout: 2000 });
    pending.child.stdin.end(JSON.stringify(['POST', 'http://localhost/mcp', JSON.stringify([['content-type', 'application/json'], ['accept', 'application/json, text/event-stream']]), body]));
    const { stdout, stderr } = await pending;
    assert.equal(JSON.parse(JSON.parse(stdout)).status, 200);
    assert.match(stderr, new RegExp(marker));
    assert.ok(stderr.indexOf(marker) < stderr.indexOf('http.path":"/health'), stderr);
  }
}));

test('a peer that stops reading triggers the response deadline', async () => {
  await withEnv({ MCP_RESPONSE_TIMEOUT_MS: '50' }, async () => {
    const pending = exec(host, [cache, '--backpressure'], { timeout: 2000 });
    pending.child.stdin.end(JSON.stringify(['GET', 'http://localhost/health', '[]', '']));
    const { stdout, stderr } = await pending;
    const outcome = JSON.parse(JSON.parse(stdout));
    assert.equal(outcome.tag, 'err');
    assert.equal(outcome.val.tag, 'connection-write-timeout');
    assert.match(stderr, /Response stream stalled for 50 ms/);
  });
});

test('incoming body and trailer deadlines release native input before reuse', async () => withEnv({ MCP_REQUEST_TIMEOUT_MS: '40' }, async () => {
  for (const mode of ['body', 'trickle', 'trailers']) {
    const pending = exec(host, [cache, '--upload'], { timeout: 3000 });
    pending.child.stdin.end(JSON.stringify(['POST', 'http://localhost/mcp', '[]', mode]));
    const { stdout } = await pending;
    const result = JSON.parse(JSON.parse(stdout));
    assert.equal(result.upload.status, 408);
    assert.equal(result.upload.body, 'Request Timeout');
    assert.ok(result.upload.headersMs < 1000, JSON.stringify(result));
    assert.deepEqual(result.released, [mode === 'trailers' ? 'trailers-closed' : 'body-closed']);
    assert.equal(result.health.status, 200);
  }
}));
