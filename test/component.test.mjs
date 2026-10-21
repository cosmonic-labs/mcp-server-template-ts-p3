import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fetchComponent } from './runtime.mjs';

for (const mode of ['legacy', { pin: '2026-07-28' }]) {
  test(`upstream client through native Wasmtime: ${JSON.stringify(mode)}`, async () => {
    const client = new Client({ name: 'wasm-test', version: '0.1.0' }, { versionNegotiation: { mode } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch: fetchComponent }));
      const tools = await client.listTools();
      assert.ok(tools.tools.some(tool => tool.name === 'add'));
      const result = await client.callTool({ name: 'add', arguments: { a: 1.5, b: 2.5 } });
      assert.deepEqual(result.structuredContent, { sum: 4 });
      const echo = await client.callTool({ name: 'echo', arguments: { message: 'Hello, Wasm 👋 café' } });
      assert.equal(echo.content[0].text, 'Hello, Wasm 👋 café');
      const invalid = await client.callTool({ name: 'add', arguments: { a: 'wrong', b: 1 } });
      assert.equal(invalid.isError, true);
      const sums = await Promise.all(Array.from({ length: 4 }, (_, a) => client.callTool({ name: 'add', arguments: { a, b: 10 } })));
      assert.deepEqual(sums.map(result => result.structuredContent.sum), [10, 11, 12, 13]);
    } finally {
      await client.close();
    }
  });
}

test('the SDK rejects malformed JSON and unsupported HTTP methods', async () => {
  const malformed = await fetchComponent('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, -32700);
  const get = await fetchComponent('http://localhost/mcp', { method: 'GET' });
  assert.equal(get.status, 405);
});
