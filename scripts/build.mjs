import { prepareOtelWit } from './otel.mjs';
import { buildAssets } from './assets.mjs';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleComponentSource } from '../node_modules/@bytecodealliance/jco/dist/bundle.js';
import { worldMetadataFor } from '../node_modules/@bytecodealliance/jco/dist/cmd/componentize.js';
import { nodeBuiltinPlugin, nodeGlobals } from '../node_modules/@bytecodealliance/jco/dist/node-builtins/index.js';
import { engineCompatPlugin } from '../node_modules/@bytecodealliance/jco/dist/engine-compat.js';
import config from '../bundle.config.mjs';

buildAssets();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const compiler = process.env.COMPONENTIZE_QJS ?? (existsSync('gen/componentize-qjs')
  ? resolve('gen/componentize-qjs') : 'componentize-qjs');
const outputDir = process.argv.includes('--desktop') ? 'gen/desktop' : 'dist';
mkdirSync(outputDir, { recursive: true });

async function compile(entry, wit, output, otel = false) {
  const metadata = await worldMetadataFor(wit);
  const source = await bundleComponentSource(resolve(entry), {
    config: { ...config, plugins: [...config.plugins, {
      name: 'native-otel', resolveId(source, importer) {
        if (otel && source === './native-otel.js' && !importer?.endsWith('native-otel-enabled.ts')) return resolve('src/native-otel-enabled.ts');
      },
    }] }, typescript: true, inject: nodeGlobals(),
    plugins: [nodeBuiltinPlugin(metadata, {
      wasiSocketsVersion: '0.2.12',
      onWitRequirement(requirement) {
        throw new Error(`Unexpected Node host requirement: ${requirement.witImport}`);
      },
    }), engineCompatPlugin()],
  });
  const bundled = output.replace(/\.wasm$/, '.js');
  writeFileSync(bundled, source);
  execFileSync(compiler, ['--wit', resolve(wit), '--js', resolve(bundled), '-o', output + '.guest'], { stdio: 'inherit' });
  execFileSync('wac', ['plug', '--plug', 'gen/adapter-target/wasm32-wasip2/release/mcp_http_adapter.wasm', output + '.guest', '-o', output], { stdio: 'inherit' });
  execFileSync('wasm-tools', ['validate', '--features', 'all', output], { stdio: 'inherit' });
  const contract = execFileSync('wasm-tools', ['component', 'wit', output], { encoding: 'utf8' });
  if (!contract.includes('export wasi:http/handler@0.3.0;') || !contract.includes('import wasi:http/client@0.3.0;')
      || /import (?:jco:node\/|cosmonic:|wasi:http\/[^;]*@0\.2\.)/.test(contract)
      || contract.includes('import wasi:otel/tracing@0.2.0-rc.2;') !== otel) {
    throw new Error('Invalid host contract: expected p3 HTTP and the selected OTEL feature');
  }
}

mkdirSync('gen/adapter-wit', { recursive: true });
cpSync('wit/deps', 'gen/adapter-wit/deps', { recursive: true });
cpSync('adapter/world.wit', 'gen/adapter-wit/world.wit');
execFileSync('cargo', ['build', '--locked', '--release', '--target', 'wasm32-wasip2', '--manifest-path', 'adapter/Cargo.toml', '--target-dir', 'gen/adapter-target'], { stdio: 'inherit' });

await compile('src/component.ts', 'wit', `${outputDir}/mcp.wasm`);
writeFileSync(`${outputDir}/mcp.wit`, execFileSync('wasm-tools', ['component', 'wit', `${outputDir}/mcp.wasm`]));
const world = readFileSync(`${outputDir}/mcp.wit`, 'utf8');
if (!world.includes('export wasi:http/handler@0.3.0;') || !world.includes('import wasi:http/client@0.3.0;')
    || /import (?:jco:node\/|cosmonic:|wasi:http\/[^;]*@0\.2\.)/.test(world)) {
  throw new Error('The component must use p3 HTTP in both directions and standard WASI host imports');
}

if (process.argv.includes('--test')) {
  mkdirSync('gen/boundary-wit', { recursive: true });
  cpSync('wit/deps', 'gen/boundary-wit/deps', { recursive: true });
  cpSync('test/boundary/world.wit', 'gen/boundary-wit/world.wit');
  execFileSync('cargo', ['build', '--locked', '--release', '--target', 'wasm32-wasip2',
    '--manifest-path', 'test/boundary/Cargo.toml', '--target-dir', 'gen/boundary-target'], { stdio: 'inherit' });
  execFileSync('wac', ['plug', '--plug', `${outputDir}/mcp.wasm`, 'gen/boundary-target/wasm32-wasip2/release/mcp_p3_driver.wasm', '-o', `${outputDir}/test.wasm`], { stdio: 'inherit' });
}

if (process.argv.includes('--otel')) {
  prepareOtelWit();
  await compile('src/component.ts', 'gen/otel-wit', `${outputDir}/mcp.otel.wasm`, true);
  if (process.argv.includes('--test')) execFileSync('wac', ['plug', '--plug', `${outputDir}/mcp.otel.wasm`, 'gen/boundary-target/wasm32-wasip2/release/mcp_p3_driver.wasm', '-o', `${outputDir}/test.otel.wasm`], { stdio: 'inherit' });
}
