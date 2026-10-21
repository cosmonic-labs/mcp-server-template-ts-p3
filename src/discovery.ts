import { identity, skill } from '../gen/assets.js';
import { extension } from './skills.js';

export function discovery(tools: string[]) {
  return { status: 'ok', server: identity,
    protocol: { name: 'Model Context Protocol', specVersion: '2026-07-28', transport: 'streamable-http', stateless: true },
    endpoints: { mcp: '/mcp', discovery: '/', health: '/health' },
    capabilities: { tools, extensions: { [extension]: { directoryRead: true, methods: ['skills/list', 'skills/get', 'resources/directory/read'] } }, resources: { skillIndex: 'skill://index.json' } },
    skills: [{ name: skill.frontmatter.name, description: skill.frontmatter.description, uri: skill.uri }],
    documentation: 'https://cosmonic.com/docs/desktop' };
}
