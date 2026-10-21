import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';

test('Desktop manifests bind the p3 export and deny outbound access by default', () => {
  for (const name of ['workload.yaml', 'deploy/workload.yaml']) {
    const doc = parse(readFileSync(name, 'utf8'));
    const ingress = doc.spec.hostInterfaces[0];
    const component = doc.spec.components[0];
    assert.equal(ingress.namespace, 'wasi');
    assert.equal(ingress.package, 'http');
    assert.deepEqual(ingress.interfaces, ['handler']);
    assert.equal(component.localResources.environment.config.MCP_ALLOWED_HOSTS, ingress.config.host);
    assert.deepEqual(component.localResources.allowedHosts, []);
    assert.equal(doc.metadata.labels['mcp.ai/skills'], 'true');
    assert.equal(doc.metadata.labels['mcp.ai/spec-version'], '2026-07-28');
    assert.equal(doc.metadata.labels['mcp.ai/auth-type'], 'none');
    assert.equal(doc.metadata.annotations['desktop.cosmonic.com/source'], 'mcp');
  }
  const wash = parse(readFileSync('.wash/config.yaml', 'utf8'));
  assert.equal(wash.build.command, 'npm run build');
  assert.equal(wash.dev.command, 'node scripts/build.mjs --desktop');
  assert.equal(wash.dev.component_path, 'gen/desktop/mcp.wasm');
  assert.ok(existsSync(wash.build.component_path));
  assert.deepEqual(wash.workload.allowedHosts, []);
  for (const name of ['workload.yaml', 'deploy/workload.yaml']) {
    const doc = parse(readFileSync(name, 'utf8'));
    assert.deepEqual(wash.workload.labels, doc.metadata.labels);
  }
  const ingress = wash.workload.hostInterfaces[0];
  assert.equal(ingress.namespace, 'wasi');
  assert.equal(ingress.package, 'http');
  assert.deepEqual(ingress.interfaces, ['handler']);
  assert.equal(ingress.config.host, wash.workload.environment.config.MCP_ALLOWED_HOSTS);
});
