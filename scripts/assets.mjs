import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { parse } from 'yaml';

export function buildAssets() {
  const info = JSON.parse(readFileSync('package.json', 'utf8'));
  const base = resolve('skills/server');
  const names = readdirSync(base, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => relative(base, resolve(entry.parentPath, entry.name)).replaceAll('\\', '/')).sort();
  const text = readFileSync(resolve(base, 'SKILL.md'), 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error('The served skill requires YAML frontmatter');
  const frontmatter = parse(match[1]);
  if (frontmatter?.name !== info.name || typeof frontmatter.description !== 'string' || !frontmatter.description) {
    throw new Error('Skill frontmatter must name the package and describe its trigger');
  }
  const files = names.map(path => {
    const bytes = readFileSync(resolve(base, path));
    if (!bytes.equals(Buffer.from(bytes.toString('utf8')))) throw new Error(`Skill files must be UTF-8: ${path}`);
    return { path, uri: `skill://${info.name}/${path}`, text: bytes.toString('utf8'),
      mimeType: path.endsWith('.md') ? 'text/markdown' : 'text/plain', size: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  });
  mkdirSync('gen', { recursive: true });
  writeFileSync('gen/assets.ts', `export const identity = ${JSON.stringify({ name: info.name, version: info.version, description: info.description })};\nexport const skill = ${JSON.stringify({ frontmatter, files, uri: `skill://${info.name}/SKILL.md` })};\n`);
}
