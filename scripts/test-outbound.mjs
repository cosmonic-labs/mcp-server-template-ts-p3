import { prepareOtelWit } from './otel.mjs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
prepareOtelWit();
execFileSync('cargo', ['build', '--locked', '--manifest-path', 'test/http-host/Cargo.toml',
  '--target-dir', 'gen/http-host-target'], { stdio: 'inherit' });
execFileSync('gen/http-host-target/debug/mcp-http-test-host', ['dist/test.wasm', '--precompile', 'gen/outbound-fixture.cwasm'], { stdio: 'inherit' });
execFileSync(process.execPath, ['--test', 'test/outbound.test.mjs', 'test/parity.test.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, MCP_HTTP_TEST_HOST: resolve('gen/http-host-target/debug/mcp-http-test-host') },
});
