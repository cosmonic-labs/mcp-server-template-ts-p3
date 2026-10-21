---
name: mcp-off-shelf
description: Use when checking MCP connectivity, performing arithmetic, reading UTC time, or fetching an HTTP document through the workload's network policy.
license: Apache-2.0
metadata:
  version: "0.1.0"
---

# MCP server operating guide

Use `echo` to check text fidelity and `add` for arithmetic. `current_time` reads
the host wall clock as Unix milliseconds; it does not measure elapsed time.

Use `http_get` for a short document preview. Its output stops at a UTF-8 boundary
after 4 KiB and marks truncation. Use `http_request` when you need headers,
methods, redirects, or a structured status and text body. A 404 is a completed
HTTP exchange, not a transport failure.

A denied local/private target is a policy decision: do not retry it under a
new spelling. Host network denial requires an administrator to update the
workload allowlist. Never use these tools to probe internal services.

A timeout can be retried if the operation is safe to repeat. Do not automatically
retry a POST: the upstream might have accepted it before the timeout. Reduce
requested content or ask an administrator about the byte limit after a size
error. Do not put credentials in URL userinfo; use authorization headers.
Cross-origin redirects remove authorization and cookies.

See [tool behavior and errors](references/TOOLS.md) for the detailed contract.
