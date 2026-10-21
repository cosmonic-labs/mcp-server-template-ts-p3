export default {
  external: ['cosmonic:http-exchange/client'],
  transform: {
    inject: {
      AbortController: ['abort-controller', 'AbortController'],
      AbortSignal: ['abort-controller', 'AbortSignal'],
    },
  },
  plugins: [{
    name: 'portable-fetch-http-primitives',
    resolveId(source, importer) {
      // unenv's process object must not open a host terminal during initialization.
      if (source === 'node:tty' && importer?.includes('/unenv/')) {
        return new URL('./node_modules/unenv/dist/runtime/node/tty.mjs', import.meta.url).pathname;
      }
      // Fetch data classes need HTTP primitives, without a Node HTTP server.
      if ((source === 'node:http' || source === 'node:https') && importer?.includes('/@whatwg-node/node-fetch/')) {
        return new URL('./src/http-primitives.ts', import.meta.url).pathname;
      }
    },
  }],
  resolve: {
    conditionNames: ['browser', 'import', 'default'],
  },
};
