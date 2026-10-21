# Tools and errors

| Tool | Result |
| --- | --- |
| add | `structuredContent.sum` plus a text fallback |
| echo | Exact supplied text, including Unicode |
| current_time | UTC Unix timestamp in milliseconds as text |
| http_get | HTTP status line and at most 4096 UTF-8 bytes, then a truncation marker |
| http_request | Structured status, response headers, and text body |

Local/private IP literals and localhost names are denied by default, including
redirect destinations. DNS resolution and the workload's authoritative outbound
allowlist belong to the host. The development-only override is
`MCP_HTTP_GET_ALLOW_LOCAL=true`.

`HTTP-request-denied` means the host refused network access. Timeouts bound the
entire exchange, including reading the body. `MCP_OUTBOUND_TIMEOUT_MS` defaults
to 30000 and `MCP_OUTBOUND_MAX_BYTES` to 4194304. HTTP errors such as 404 retain
their status and body; transport, policy, and limit errors return `isError`.

Incoming protocol messages are capped at 4 MiB. The server is stateless, supports
MCP 2026-07-28 and legacy clients, and does not allocate sessions. Use the
platform's trusted ingress for authorization.
