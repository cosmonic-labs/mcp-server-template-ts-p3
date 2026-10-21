import { decodeWaveString } from '../test/wave.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
mkdirSync('gen/boundary-wit', { recursive: true });
cpSync('wit/deps', 'gen/boundary-wit/deps', { recursive: true });
cpSync('test/boundary/world.wit', 'gen/boundary-wit/world.wit');
execFileSync('cargo', ['build', '--locked', '--release', '--target', 'wasm32-wasip2',
  '--manifest-path', 'test/boundary/Cargo.toml', '--target-dir', 'gen/boundary-target'], { stdio: 'inherit' });
execFileSync('wac', ['plug', '--plug', 'dist/mcp.wasm',
  'gen/boundary-target/wasm32-wasip2/release/mcp_p3_driver.wasm',
  '-o', 'dist/boundary-test.wasm'], { stdio: 'inherit' });
const output = execFileSync('wasmtime', ['run', '-Shttp', '-Sp3', '--invoke', 'run()',
  'dist/boundary-test.wasm'], { encoding: 'utf8', timeout: 15000 });
assert.ok(JSON.parse(decodeWaveString(output)).body.includes('"sum":5'));
console.log('Production p3 export and response stream passed under Wasmtime.');
