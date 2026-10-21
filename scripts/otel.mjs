import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
export function prepareOtelWit() {
  for (const [folder, source] of [['gen/otel-wit', 'wit/world.wit']]) {
    mkdirSync(folder, { recursive: true });
    cpSync('wit/deps', `${folder}/deps`, { recursive: true });
    writeFileSync(`${folder}/world.wit`, readFileSync(source, 'utf8').replace(/(world [^{]+\{)/, '$1\n  import wasi:otel/tracing@0.2.0-rc.2;'));
  }
  mkdirSync('gen/otel-host-wit', { recursive: true });
  cpSync('wit/deps', 'gen/otel-host-wit/deps', { recursive: true });
  writeFileSync('gen/otel-host-wit/world.wit', 'package cosmonic:otel-test; world host { import wasi:otel/tracing@0.2.0-rc.2; }');
}
