import { prepareOtelWit } from './otel.mjs';
import { buildAssets } from './assets.mjs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

buildAssets();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [resolve(root, 'node_modules/@bytecodealliance/jco/dist/jco.js'),
  'guest-types', resolve(root, 'wit'), '-o', resolve(root, 'gen/types')], { stdio: 'inherit' });

prepareOtelWit();
execFileSync(process.execPath, [resolve(root, 'node_modules/@bytecodealliance/jco/dist/jco.js'),
  'guest-types', resolve(root, 'gen/otel-wit'), '-o', resolve(root, 'gen/otel-types')], { stdio: 'inherit' });
