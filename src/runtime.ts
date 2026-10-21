import { log as emitLog } from './telemetry.js';
import './timers.js';
import { URL, URLSearchParams } from 'node:url';
import { Buffer } from 'node:buffer';
import { ReadableStream, WritableStream, TransformStream } from 'web-streams-polyfill/ponyfill/es2018';
import { AbortController, AbortSignal } from 'abort-controller';
import { PonyfillTextEncoder, PonyfillTextDecoder } from '../node_modules/@whatwg-node/node-fetch/esm/TextEncoderDecoder.js';
import { getRandomBytes } from 'wasi:random/random@0.3.0';

Object.assign(globalThis, {
  URL, URLSearchParams, Buffer, ReadableStream, WritableStream, TransformStream,
  AbortController, AbortSignal, TextEncoder: PonyfillTextEncoder, TextDecoder: PonyfillTextDecoder,
  queueMicrotask: (callback: () => void) => Promise.resolve().then(callback),
  crypto: {
    randomUUID() {
      // QuickJS represents WIT u64 inputs as numbers.
      const bytes = (getRandomBytes as unknown as (size: number) => Uint8Array)(16);
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = [...bytes].map((byte: number) => byte.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  },
});

function consoleMessage(level: string, values: unknown[]) {
  void emitLog(level, values.map(String).join(' '));
}
// AbortController's EventTarget requires console.assert during dispatch.
Object.assign(globalThis, { console: {
  log: (...values: unknown[]) => consoleMessage('info', values),
  info: (...values: unknown[]) => consoleMessage('info', values),
  debug: (...values: unknown[]) => consoleMessage('debug', values),
  warn: (...values: unknown[]) => consoleMessage('warn', values),
  error: (...values: unknown[]) => consoleMessage('error', values),
  assert: (condition: unknown, ...values: unknown[]) => { if (!condition) consoleMessage('error', values); },
} });
