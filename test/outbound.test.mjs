import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fetchComponent } from './runtime.mjs';

for (const mode of ['legacy', { pin: '2026-07-28' }]) {
  test(`outbound HTTP through the upstream MCP SDK: ${JSON.stringify(mode)}`, async () => {
    const client = new Client({ name: 'outbound-test', version: '0.1.0' }, { versionNegotiation: { mode } });
    const call = async (args) => client.callTool({ name: 'http_request', arguments: args });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch: fetchComponent }));
      assert.equal(client.getProtocolEra(), mode === 'legacy' ? 'legacy' : 'modern');
      const get = await call({ url: 'https://fixture.test/echo?hello=world' });
      assert.equal(get.structuredContent.status, 200);
      assert.equal(get.structuredContent.headers['x-fixture'], 'true');
      assert.equal(JSON.parse(get.structuredContent.body).url, 'https://fixture.test/echo?hello=world');
      const post = await call({ url: 'http://fixture.test/echo', method: 'POST', headers: { authorization: 'Bearer fixture-token', 'content-type': 'text/plain' }, body: 'Hello 👋 café' });
      const echoed = JSON.parse(post.structuredContent.body);
      assert.equal(echoed.method, 'POST');
      assert.equal(echoed.body, 'Hello 👋 café');
      assert.equal(echoed.headers.authorization, 'Bearer fixture-token');
      const missing = await call({ url: 'https://fixture.test/missing' });
      assert.equal(missing.structuredContent.status, 404);
      assert.equal(missing.structuredContent.body, 'not found');
      const head = await call({ url: 'https://fixture.test/echo', method: 'HEAD' });
      assert.equal(head.structuredContent.body, '');
      const manual = await call({ url: 'https://fixture.test/redirect', redirect: 'manual' });
      assert.equal(manual.structuredContent.status, 302);
      const redirect = await call({ url: 'https://fixture.test/redirect', method: 'POST', body: 'drop on 302' });
      assert.equal(JSON.parse(redirect.structuredContent.body).method, 'GET');
      for (const status of [301, 302, 303, 307, 308]) {
        for (const location of [
          'https://other.fixture.test/echo',
          '//other.fixture.test/echo',
          'http://fixture.test/echo',
          'https://fixture.test:8443/echo',
          'https://user:password@fixture.test/echo',
          'http://127.0.0.1/internal',
          'http://[invalid',
        ]) {
          const response = await call({
            url: `https://fixture.test/redirect-to?${new URLSearchParams({ status, location })}`,
            method: 'POST', body: 'TEST_PRIVATE_BODY',
            headers: { authorization: 'Bearer TEST_TOKEN', cookie: 'session=TEST_COOKIE',
              api_key: 'TEST_API_KEY', 'x-api-key': 'TEST_CUSTOM_KEY', 'content-type': 'text/plain' },
          });
          assert.ok(!response.isError, JSON.stringify(response));
          assert.equal(response.structuredContent.status, status, location);
          assert.equal(response.structuredContent.headers.location, location);
          assert.equal(response.structuredContent.body, 'redirect response');
        }
      }
      for (const status of [307, 308]) {
        const response = await call({
          url: `https://fixture.test/redirect-to?${new URLSearchParams({ status, location: '/echo' })}`,
          method: 'POST', body: 'TEST_SAME_ORIGIN_BODY', headers: { api_key: 'TEST_SAME_ORIGIN_KEY' },
        });
        const echoed = JSON.parse(response.structuredContent.body);
        assert.equal(echoed.method, 'POST');
        assert.equal(echoed.body, 'TEST_SAME_ORIGIN_BODY');
        assert.equal(echoed.headers.api_key, 'TEST_SAME_ORIGIN_KEY');
      }
      const secondHop = `/redirect-to?${new URLSearchParams({ status: 307, location: 'https://other.fixture.test/echo' })}`;
      const chain = await call({
        url: `https://fixture.test/redirect-to?${new URLSearchParams({ status: 308, location: secondHop })}`,
        method: 'POST', headers: { api_key: 'TEST_CHAIN_KEY' }, body: 'TEST_CHAIN_BODY',
      });
      assert.equal(chain.structuredContent.status, 307);
      assert.equal(chain.structuredContent.headers.location, 'https://other.fixture.test/echo');
      for (const [args, message] of [
        [{ url: 'https://denied.test/' }, /HTTP-request-denied/],
        [{ url: 'https://fixture.test/oversized' }, /4 MiB/],
        [{ url: 'https://fixture.test/redirect-loop' }, /Too many HTTP redirects/],
        [{ url: 'https://fixture.test/redirect', redirect: 'error' }, /redirect rejected/],
        [{ url: 'file:///tmp/secret' }, /Only HTTP\(S\)/],
      ]) {
        const error = await call(args);
        assert.equal(error.isError, true, JSON.stringify(error));
        assert.match(error.content[0].text, message);
      }
      const concurrent = await Promise.all(Array.from({ length: 3 }, (_, i) => call({ url: `https://fixture.test/echo?i=${i}` })));
      assert.ok(concurrent.every(result => result.structuredContent.status === 200));
    } finally {
      await client.close();
    }
  });
}
