import { isIP } from '../node_modules/@bytecodealliance/jco-std/dist/wasi/0.2.x/node/24.x.x/net/ip.js';
import { env } from './config.js';

export function allowedHost(authority: string): boolean {
  const configured = env('MCP_ALLOWED_HOSTS');
  if (configured?.trim() === '*') return true;
  const allowed = configured === undefined ? ['localhost', '127.0.0.1', '[::1]'] : configured.split(',').map(s => s.trim()).filter(Boolean);
  try {
    const actual = new URL(`http://${authority}`);
    const actualPort = /(?:\]|[^:]):(\d+)$/.exec(authority)?.[1];
    if (actual.username || actual.password || !/^\[[a-fA-F0-9:]+\](?::\d+)?$|^[^\s/@?#:]+(?::\d+)?$/.test(authority) || actual.pathname !== '/') return false;
    return allowed.some(entry => {
      const expected = new URL(`http://${entry}`);
      const expectedPort = /(?:\]|[^:]):(\d+)$/.exec(entry)?.[1];
      return expected.hostname === actual.hostname && (expectedPort === undefined || expectedPort === actualPort);
    });
  } catch { return false; }
}

export function checkTarget(url: URL): void {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('Only HTTP(S) URLs without embedded credentials are supported');
  }
  if (['true', '1'].includes(env('MCP_HTTP_GET_ALLOW_LOCAL') ?? '')) return;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  let local = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.localhost.');
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    local ||= a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254) || host === '255.255.255.255';
  } else if (isIP(host) === 6) {
    local ||= host === '::' || host === '::1' || /^(fc|fd|fe[89ab])/.test(host);
    // URL canonicalization writes IPv4-mapped addresses as two hexadecimal groups.
    if (host.startsWith('::ffff:')) {
      const groups = host.slice(7).split(':');
      if (groups.length === 2) {
        const n = parseInt(groups[0], 16) * 65536 + parseInt(groups[1], 16);
        checkTarget(new URL(`${url.protocol}//${[n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')}`));
      }
    }
  }
  if (local) throw new TypeError(`denied: ${host} is a local/private target (set MCP_HTTP_GET_ALLOW_LOCAL=true for development)`);
}
