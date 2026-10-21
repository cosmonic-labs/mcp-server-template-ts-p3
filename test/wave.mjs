export function decodeWaveString(text) {
  const value = text.trim();
  if (value[0] !== '"' || value.at(-1) !== '"') throw new Error('Expected a WAVE string');
  let out = '';
  for (let i = 1; i < value.length - 1; i++) {
    if (value[i] !== '\\') { out += value[i]; continue; }
    const escaped = value[++i];
    if (escaped === 'u' && value[i + 1] === '{') {
      const end = value.indexOf('}', i + 2);
      out += String.fromCodePoint(parseInt(value.slice(i + 2, end), 16));
      i = end;
    } else {
      const escapes = { n: '\n', r: '\r', t: '\t', '0': '\0', "'": "'", '"': '"', '\\': '\\' };
      if (!(escaped in escapes)) throw new Error(`Invalid WAVE escape: ${escaped}`);
      out += escapes[escaped];
    }
  }
  return out;
}
