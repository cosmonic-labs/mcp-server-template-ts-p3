import './runtime.js';
import { PonyfillRequest } from '../node_modules/@whatwg-node/node-fetch/esm/Request.js';
import { PonyfillResponse } from '../node_modules/@whatwg-node/node-fetch/esm/Response.js';
import { PonyfillHeaders } from '../node_modules/@whatwg-node/node-fetch/esm/Headers.js';

class RuntimeResponse extends PonyfillResponse {
  // Normalize mixed-case header names before the ponyfill adds defaults.
  static json<T>(data: T, init?: ResponseInit) {
    return super.json<T>(data, { ...init, headers: new PonyfillHeaders(init?.headers) });
  }
}
Object.assign(globalThis, { Request: PonyfillRequest, Response: RuntimeResponse, Headers: PonyfillHeaders });
export { PonyfillRequest as Request, RuntimeResponse as Response, PonyfillHeaders as Headers };
