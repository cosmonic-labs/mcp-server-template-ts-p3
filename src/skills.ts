import { McpServer, ProtocolError } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { identity, skill } from '../gen/assets.js';

export const extension = 'io.modelcontextprotocol/skills';
export const skillEntry = { uri: skill.uri, frontmatter: skill.frontmatter,
  resources: skill.files.map(({ uri, digest, size }) => ({ uri, digest, size })) };
export const instructions = `Stateless MCP tools for connectivity, arithmetic, host time, and policy-controlled outbound HTTP.\n\nSkills this server publishes (${extension}; skills/list, skills/get, and skill://index.json):\n- ${skill.frontmatter.name}: ${skill.frontmatter.description}`;
const root = `skill://${identity.name}`;
const hint = { ttlMs: 3_600_000, cacheScope: 'public' as const };
const entries = skill.files.map(file => ({ uri: file.uri, name: file.path.split('/').at(-1)!, mimeType: file.mimeType, size: file.size }));

function directory(uri: string) {
  if (uri !== root && (!uri.startsWith(root + '/') || uri.endsWith('/'))) throw new ProtocolError(-32602, 'Unknown skill directory');
  const prefix = uri + '/';
  const found = new Map<string, { uri: string; name: string; mimeType: string; size?: number }>();
  for (const file of entries) {
    if (!file.uri.startsWith(prefix)) continue;
    const rest = file.uri.slice(prefix.length);
    const child = rest.split('/')[0];
    found.set(child, rest.includes('/') ? { uri: prefix + child, name: child, mimeType: 'inode/directory' } : file);
  }
  if (!found.size) throw new ProtocolError(-32602, 'Unknown skill directory');
  return [...found.values()];
}
export function registerSkills(server: McpServer) {
  const resource = { name: identity.name, description: skill.frontmatter.description, mimeType: 'text/markdown',
    size: skill.files.find(file => file.uri === skill.uri)!.size,
    _meta: Object.fromEntries(Object.entries(skill.frontmatter).filter(([key]) => !['name', 'description'].includes(key))
      .map(([key, value]) => [`io.modelcontextprotocol.skills/${key}`, value])) };
  server.server.registerCapabilities({ resources: {} });
  server.server.setRequestHandler('resources/list', async () => ({ resources: [
    { uri: 'skill://index.json', name: 'skill-index', mimeType: 'application/json' },
    { uri: skill.uri, ...resource },
  ], ...hint }));
  server.server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [
    { uriTemplate: 'skill://{skill}/SKILL.md', name: 'skill-playbook', mimeType: 'text/markdown' },
    { uriTemplate: 'skill://{skill}/{+path}', name: 'skill-file' },
  ], ...hint }));
  server.server.setRequestHandler('resources/read', async request => {
    const uri = request.params.uri;
    if (uri === 'skill://index.json') return { contents: [{ uri, mimeType: 'application/json',
      text: JSON.stringify({ schemaVersion: '2', extension, server: identity, skills: [skillEntry] }) }], ...hint };
    // Match the raw URI against the embedded manifest before any URL normalization.
    const file = skill.files.find(file => file.uri === uri);
    if (!file) throw new ProtocolError(-32602, 'Unknown skill file');
    return { contents: [{ uri, mimeType: file.mimeType, text: file.text }], ...hint };
  });
  server.server.setRequestHandler('skills/list', { params: z.object({ cursor: z.string().optional() }).default({}) }, async () => ({
    resultType: 'complete', skills: [skillEntry], ...hint,
  }));
  server.server.setRequestHandler('skills/get', { params: z.object({ uri: z.string() }) }, async ({ uri }) => {
    if (uri !== skill.uri) throw new ProtocolError(-32602, 'Unknown skill');
    return { resultType: 'complete', skill: skillEntry, ...hint };
  });
  server.server.setRequestHandler('resources/directory/read', { params: z.object({ uri: z.string() }) }, async ({ uri }) => ({
    resultType: 'complete', resources: directory(uri),
  }));
}
