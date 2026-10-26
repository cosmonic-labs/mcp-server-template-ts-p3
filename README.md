# TypeScript MCP server template for WASI p3

The unmodified official `@modelcontextprotocol/server` 2.0.0 SDK runs in a
self-contained WebAssembly component. `dist/mcp.wasm` exports
`wasi:http/handler@0.3.0` and imports `wasi:http/client@0.3.0`. HTTP is p3 in both
directions. The component uses JCO's Node compatibility adapters and a patched
QuickJS compiler. The MCP protocol core stays upstream. A small Rust p3 HTTP adapter handles
native request cancellation; there is no Hono dependency.

The server supports MCP **2026-07-28** and legacy clients. Its default tools are
`add`, `echo`, `current_time`, `http_get`, and `http_request`. It serves discovery,
health, and embedded skills, and includes policy guards, deadlines, structured
logs, optional native OTEL, and Cosmonic Desktop manifests.

## Use this template

Create a repository from this GitHub template, clone it, and follow the build
steps below. This is the TypeScript counterpart to
[the Rust template](https://github.com/cosmonic-labs/mcp-server-template-rs).

Customize the `mcp-off-shelf` application name consistently in `package.json`,
`package-lock.json`, the skill frontmatter and URIs, workload manifests,
`.wash/config.yaml`, and tests. Update the image registry, ingress hosts, and
MCP domain labels for your server. Implement tools in `src/server.ts` and
update the embedded playbook under `skills/server/`. Keep outbound destinations
explicit in `allowedHosts`.

## Parity with the Rust template

Compared against `cosmonic-labs/mcp-server-template-rs` at
`bbb0cc315c504a226eb23857d4bd6dcc3d0a5042`:

| Rust template feature | TypeScript implementation |
| --- | --- |
| Stateless official SDK, current MCP revision | Official SDK 2.0.0; modern and legacy official-client tests |
| Async p3 HTTP inbound and outbound | Both interfaces use 0.3.0; build rejects p2 HTTP imports |
| `add`, `echo`, `current_time`, `http_get` | All included; `http_request` adds methods, headers, redirect policies, and structured HTTP output |
| Discovery and health | GET/HEAD `/` and `/health`, outside the Host guard and body read |
| Skills extension | `skills/list`, `skills/get`, `resources/directory/read`, resource files, templates, instructions, and `skill://index.json` |
| Immutable skill manifest | Embedded YAML frontmatter, SHA-256 digests, UTF-8 byte sizes, public one-hour cache hints |
| DNS rebinding defense | Safe localhost default, configurable `MCP_ALLOWED_HOSTS`, exact-port and any-port entries; no CORS headers |
| SSRF defense for client URLs | Local/private IP literals, IPv4-mapped IPv6, and localhost names denied; redirects checked too |
| Incoming body cap | 4 MiB, enforced while reading p3 chunks |
| Bounded outbound HTTP | Configurable full-exchange deadline and response cap, plus 4 MiB request cap |
| Streaming SSE | SDK SSE mode, progress notifications, 15-second keepalives, bounded response inactivity, peer cancellation |
| Concurrent native invocations | Tested overlapping outbound requests on one shared native instance, plus independent instances |
| Structured request/tool logs | JSON on stderr, level filtering, W3C trace correlation and outbound propagation |
| Optional host-joined native tracing | Separate `mcp.otel.wasm` importing `wasi:otel/tracing@0.2.0-rc.2` |
| Desktop integration | `.wash/config.yaml`, local and published Workload manifests, MCP catalog metadata, deny-all outbound defaults |
| Authorization guidance | [docs/auth.md](docs/auth.md); both templates default to platform-boundary authorization and `auth-type: none` |
| Automated verification | Native protocol/parity fixtures, actual-production p3 boundary tests, native OTEL checks, and CI workflow |

The remaining differences are runtime/toolchain and deployment validation:
QuickJS needs the included compiler patch and Web API glue, the component still
has standard non-HTTP p2 runtime imports, and live Cosmonic deployment and
external DNS/TLS have not been tested in this sandbox. The optional OTEL build
requires matching host WIT signatures, as does the Rust feature. This is feature
parity for the tested template paths, not a conformance claim for every optional
MCP feature or an assertion that the new CI workflow has run remotely.

## Build

Prerequisites: Node.js 22.15+, npm, `wasm-tools`, and the patched QuickJS compiler.
Composition also requires Rust 1.96+, `wasm32-wasip2`, and `wac` 0.12.0.
Tests require Wasmtime 49.0.2.
Production compilation uses JCO 1.37.0's bundler and a standalone patched
`componentize-qjs` CLI. npm dependencies are locked.

```sh
npm ci
npm run build:compiler
npm run check
npm run build
npm run test:all
```

`build:compiler` checks out upstream componentize-qjs revision
`eee19a60b144321b2535a50cc58e05b73d9f5242`, applies
[patches/componentize-qjs.patch](patches/componentize-qjs.patch), and builds it.
This needs network access on first use. The compiler also downloads wasi-sdk 33
and Binaryen 130 unless cached or supplied through `WASI_SDK_PATH` and
`WASM_OPT`. The patch comes from the local `sandboxed-agents/harnesses/pi`
project; it supplies correctly typed async initialization stubs and real p2
HTTP resources during initialization. It does not add p2 HTTP imports here.
The upstream MCP SDK is unmodified.

The compiler selection order is `COMPONENTIZE_QJS`, `gen/componentize-qjs`,
then `componentize-qjs` on PATH. This workspace has a cached patched binary in
`gen/`, which is excluded from source control. The release compiler's
async-import initializer fails without the patch. JCO's default StarlingMonkey
backend also fails to compile this p3 handler.

```sh
npm run build:otel       # also emits dist/mcp.otel.wasm
npm test                # production component + composed Rust test driver
npm run test:outbound   # outbound and parity fixtures, including streaming
npm run test:boundary   # independent production p3 invocation
npm run serve           # local Wasmtime verification listener
```

`stat` reports the exact size of `dist/mcp.wasm`; it is approximately 16.6 MB
uncompressed, including the engine, SDK, polyfills, and embedded skills. Snapshot
sizes vary slightly between builds. The optional OTEL component is separate.

## Customize tools and skills

Edit [src/server.ts](src/server.ts) using upstream `McpServer`, Zod, and tool
callbacks. Its registration table also supplies discovery tool names. The SDK
owns protocol validation, negotiation/discovery, routing, errors, schemas, and
SSE framing. Keep requests stateless; durable state belongs in a host capability
or an upstream service.

`http_get` performs one GET without following redirects, returning an HTTP status
line and up to 4096 UTF-8 bytes, with a truncation marker. `http_request` supports
methods, headers, text bodies, and follow/manual/error redirect policies. HTTP
404 and other non-2xx responses retain their status and body. Network, policy,
size, and timeout failures become tool errors. Automatic redirects stay on the
original scheme, host, and port.
Cross-origin or credential-bearing redirects are returned without contacting the
destination, preserving custom API keys, cookies, and request bodies on the
original origin. CDN redirects require an explicit request to that destination.
Progress is emitted when a caller supplies a progress token.

Write the operating playbook in [skills/server/SKILL.md](skills/server/SKILL.md),
with supporting files under that directory. Build-time YAML parsing preserves
frontmatter in the manifest; `name` must equal `package.json`'s name. Every UTF-8
file is embedded with its URI, digest, and byte size. No runtime filesystem
lookup is performed. Rename the frontmatter and package together when forking.

The server advertises `io.modelcontextprotocol/skills` with `directoryRead: true`.
Clients can use `skills/list`, `skills/get`, `resources/directory/read`, and
`resources/read` under `skill://mcp-off-shelf`. The index resource and server
instructions provide fallback discovery for clients without the extension.
Supporting files are in the manifest and directory listings; only the playbook
and index appear in `resources/list`. Unknown and traversal-shaped URIs fail.

## Configuration and policy

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `MCP_ALLOWED_HOSTS` | localhost, 127.0.0.1, ::1 | Comma-separated incoming authorities; `host` accepts any port, `host:port` is exact, `*` disables the guard |
| `MCP_HTTP_GET_ALLOW_LOCAL` | unset | `true` or `1` permits local/private outbound targets for development; applies to both HTTP tools and redirects |
| `MCP_REQUEST_TIMEOUT_MS` | 30000 | Whole incoming-body deadline, including trailers; expires with HTTP 408 |
| `MCP_OUTBOUND_TIMEOUT_MS` | 30000 | Whole outbound exchange deadline, including body read |
| `MCP_OUTBOUND_MAX_BYTES` | 4194304 | Buffered outbound response limit |
| `MCP_KEEPALIVE_MS` | 15000 | SSE keepalive interval |
| `MCP_RESPONSE_TIMEOUT_MS` | 60000 | Response-stream inactivity deadline, including a peer that stops reading |
| `MCP_LOG_LEVEL` | info | trace/debug/info/warn/error/off stderr threshold |
| `RUST_LOG` | info | Compatibility fallback for a single global log level |

The incoming protocol cap and outbound request cap are 4 MiB. Numeric settings
must be positive safe integers no greater than 2147483647. Invalid configuration
fails closed. `RUST_LOG` module-specific filter expressions are not interpreted;
use `MCP_LOG_LEVEL` for this TypeScript server.

The in-guest SSRF check covers literal addresses and localhost spellings. The
host must enforce DNS-resolved destinations and `allowedHosts`; a public-looking
hostname can resolve to a private address. Both supplied manifests explicitly
set `allowedHosts: []`, meaning deny-all. Add each required upstream there and in
`.wash/config.yaml`. Neither network policy nor the Host guard authenticates a
caller. See [authorization guidance](docs/auth.md).

Discovery contains public server/tool/skill metadata, works under probe Host
values, and does not read a request body. An ingress can gate it separately if
that inventory is sensitive. No response enables cross-origin browser access.

## Deploy on Cosmonic Desktop

Register this project using [.wash/config.yaml](.wash/config.yaml), promote its
build, then put the returned digest-pinned image into [workload.yaml](workload.yaml)
and apply through Desktop. Before applying, select an unused workload name,
namespace, and ingress host so an existing deployment is not replaced. The local
host is `mcp-off-shelf.localhost`; `MCP_ALLOWED_HOSTS` matches it.

For a public image, update the registry placeholder and host in
[deploy/workload.yaml](deploy/workload.yaml). Both manifests bind the p3
`handler`, advertise current MCP/skills/stateless/streamable-HTTP metadata, and
start with no outbound destinations. The same MCP catalog labels are declared
in `.wash/config.yaml` so dev workloads and promoted drafts carry them too.
The explicit manifests include `desktop.cosmonic.com/source: mcp`, matching
the Rust template. Use host `secretFrom` references for API
keys. The manifests describe deployment configuration; no workload is applied
by a build or test command.

Desktop dev builds use `node scripts/build.mjs --desktop` and serve
`gen/desktop/mcp.wasm`. All generated assets, WIT, Rust targets, and dev bundle
outputs live under `gen/`, which Desktop's watcher ignores. The watcher does
not read `.gitignore`; writing these files under `generated/` or writing dev
bundles under `dist/` causes continuous rebuilds. Release builds still emit
`dist/mcp.wasm`. Restart an existing dev session after this configuration change.

Run the local dev session in one terminal, then run the smoke test in another:

```sh
cosmonic dev --path .
npm run test:desktop
```

The smoke test connects to `127.0.0.1:8200` with the configured
`mcp-off-shelf.localhost` Host header, avoiding wildcard localhost DNS. Override
`MCP_DESKTOP_URL` and `MCP_DESKTOP_HOST` for another ingress address or binding.
It checks both MCP versions, tools, skills and hashes, concurrent calls, local
address rejection, and host-enforced denied egress to `https://example.org/`.
Keep that destination outside the workload's allowlist; change the probe with
`MCP_DESKTOP_DENIED_URL` if needed. A DNS or TLS failure does not count as a
successful policy-denial check.

To also verify live DNS/TLS and SSE progress, grant only `example.com` in this
project's `workload.allowedHosts` in `.wash/config.yaml`, restart its dev session,
and run:

```sh
MCP_DESKTOP_ALLOWED_URL=https://example.com/ npm run test:desktop
```

Restore `allowedHosts: []` after testing. The smoke script neither deploys nor
changes Desktop policy. Native I/O cancellation and OTEL parentage are covered
by the fixture suite; this smoke test does not verify Desktop cancellation or
collected OTLP spans. This sandbox denies both the Desktop Unix socket and
loopback ingress (`EPERM`), so the smoke test has not completed against Desktop.

## CI

[The CI workflow](.github/workflows/ci.yaml) builds both component variants,
checks TypeScript, runs protocol/parity/native-boundary/OTEL tests, checks Rust
formatting, and lints the runtime adapter with Clippy. It caches npm downloads,
Cargo dependencies and all three Rust build targets, plus the pinned component
tools and patched compiler binary. Tool caches include OS, architecture, Rust
version, tool versions, and compiler patch/build-script hashes. Rust and tool
caches are saved only after successful pushes to `main`.

[The zizmor workflow](.github/workflows/zizmor.yaml) runs a blocking pedantic
security audit. Actions are pinned to commit hashes, checkout credentials are
not persisted, and workflows have read-only repository permissions. Locally:

```sh
zizmor --offline --pedantic --strict-collection .github/workflows
actionlint .github/workflows/*.yaml
npm run test:all
```

The workflows have passed local static checks; a clean hosted GitHub Actions
run and cache restore remain to be verified after pushing this repository.

## Observability

Request, tool, and outbound spans emit structured JSON to stderr. They carry
trace/span IDs, parent IDs, durations, and request method/path without bodies,
credentials, or query values. Valid W3C `traceparent` is accepted on ingress and
propagated on outbound requests unless a tool explicitly provides that header.
The platform owns collection and OTLP export.

`npm run build:otel` additionally emits a component using native
`wasi:otel/tracing@0.2.0-rc.2`. It creates request/tool/client spans under the
host's active context when no incoming parent is supplied. The native fixture
checks span delivery and parentage. Ordinary Wasmtime serving has no OTEL host
provider; use the standard artifact there. Hosts must match the vendored WIT
signatures, especially `tracing.on-start`; the same nominal rc.2 version has
had incompatible definitions in different host builds.

## Verification and runtime notes

The test harness composes an independent Rust driver with the **actual
production artifact**. The official TypeScript client drives its HTTP entry
through native Wasmtime. Creating and consuming WASI resources on opposite
component boundaries also exercises structured future payloads correctly.
The test driver is separate from the Rust cancellation adapter included in the
production component. Neither implements MCP.

Tests cover both MCP eras, skills manifests and directory traversal, discovery,
Host policy, SSRF including redirects and mapped addresses, body limits,
configurable timeouts and size caps, stalled uploads and trailers, status codes,
Unicode, streaming progress
before completion, peer cancellation, response backpressure, and overlapping
outbound calls on one native instance. The fixture uses p3 HTTP hooks with no
p2 HTTP linker and no sockets. Native OTEL uses a separate composed artifact.
CI installs the pinned compiler patch and runs the same checks.

[src/runtime.ts](src/runtime.ts) and [src/web.ts](src/web.ts) supply upstream Web
Streams, AbortController, Fetch data classes, Buffer, URL, and secure UUIDs.
[src/timers.ts](src/timers.ts) schedules SDK timers on p3 monotonic-clock waits;
one shared short wait bounds retention after timers are cleared. Callback
exceptions and promise rejections are reported without stopping queued timers
or intervals. The queue also isolates failures in error reporting.
[src/future.ts](src/future.ts) handles QuickJS's explicit WIT future resources.
[The HTTP bridge](src/component.ts) buffers incoming messages within the cap and
streams responses; [outbound Fetch](src/fetch.ts) is buffered and policy checked.
[The composed HTTP adapter](adapter/src/lib.rs) races each p3 exchange against
an explicit cancellation signal, buffers the response within the limit, and
drops native I/O when a deadline or disconnect cancels the operation. This is
needed because QuickJS import promises cannot cancel their native subtask.
The final component exposes only standard WASI host imports; the adapter's
control interface is linked internally.
JCO and ponyfill internal paths are pinned and need review during upgrades.

Incoming request bodies have a 4 MiB byte cap and a full receive deadline,
including trailers. Deadline expiry returns HTTP 408 and drops the native input
stream and trailer future. The composed adapter owns this read so a timeout
cancels native work. Host-level header and connection limits remain useful at
the ingress.

This is not a complete browser/Node runtime: automatic HTTP decompression and
full Web Crypto are absent. Persistent subscriptions, sampling/elicitation,
OAuth flows, and other optional MCP features beyond the Rust template's tested
surface remain unverified. JCO-transpiled JavaScript hosts previously trapped
on overlapping invocations; native Wasmtime shared-instance tests now pass.
Live socket serving, external networking, and Desktop OTLP collection were not
available for verification in this sandbox.

## Sources

- [Rust template](https://github.com/cosmonic-labs/mcp-server-template-rs)
- [Current MCP revision](https://modelcontextprotocol.io/specification/versioning)
- [Official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [JCO Node compatibility](https://bytecodealliance.github.io/jco/interop/nodejs-builtins.html)
- [componentize-qjs](https://github.com/andreiltd/componentize-qjs)

WASI p3 WIT comes from JCO 1.37.0. Optional OTEL and its p2 type dependencies
come from `opentelemetry-wasi` revision
`2962a286aa66188314bcafd79c800c4e39ce41e1`, matching the Rust template's feature.
