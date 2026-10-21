# Authorization on Cosmonic Desktop

The Rust template and this server ship with `mcp.ai/auth-type: none`. Neither
implements an OAuth authorization server or validates bearer tokens by default.
The Host guard prevents DNS rebinding; the outbound allowlist controls network
access. Neither identifies a caller.

Terminate OAuth at a trusted platform ingress or an authorization middleware
component in front of the p3 handler. Validate token issuer, audience, expiry,
and required scopes there. Trust identity headers only when that ingress strips
client-supplied copies and the component cannot be reached around it. Add
per-tool scope checks when the platform defines its identity-header contract.

Keep secrets in the host environment through `secretFrom`, not in the component,
source files, or workload YAML. List issuer/JWKS hosts in `allowedHosts` only if
your own tools must fetch them. Label a deployment `mcp.ai/auth-type: oauth` only
when the boundary actually enforces OAuth.

Discovery at `/` and `/health` is outside the component Host guard and exposes
server identity, tool names, and skill names. Decide at the ingress whether those
routes should also require authorization. No response grants cross-origin reads.
