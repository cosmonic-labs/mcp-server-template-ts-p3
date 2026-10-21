import { decodeWaveString } from './wave.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function fetchComponent(input, init) {
  const request = new Request(input, init);
  const args = [request.method, request.url, JSON.stringify([...request.headers]), await request.text()];
  let pending;
  if (process.env.MCP_HTTP_TEST_HOST) {
    pending = exec(process.env.MCP_HTTP_TEST_HOST, ['gen/outbound-fixture.cwasm'], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    pending.child.stdin.end(JSON.stringify(args));
  } else {
    const invocation = `exchange(${args.map(value => JSON.stringify(value)).join(',')})`;
    pending = exec('wasmtime', ['run', '-Shttp', '-Sp3', '--invoke', invocation, 'dist/test.wasm'], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  }
  const { stdout } = await pending;
  const response = JSON.parse(process.env.MCP_HTTP_TEST_HOST ? JSON.parse(stdout) : decodeWaveString(stdout));
  return new Response(response.body || null, { status: response.status, headers: response.headers });
}
