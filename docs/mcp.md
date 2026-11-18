# MCP

Adapted from [PR #15](https://github.com/arkts-dev/deus/pull/15). Pi and MCP share current handlers; [API/trust contracts](../README.md#dexter-cli) remain unchanged.

## Setup

```sh
npm ci --ignore-scripts
npm run build
npm pack
npm install --prefix /opt/deus-mcp --ignore-scripts ./deus-ex-machina-0.3.0.tgz
```

Codex:

```toml
[mcp_servers.deus]
command = "/opt/deus-mcp/node_modules/.bin/deus-mcp"
args = ["--workspace", "/absolute/existing/workspace"]
tool_timeout_sec = 3600
```

For SSH, replace command/args with:

```toml
command = "ssh"
args = ["-T", "-o", "BatchMode=yes", "dexter-host", "/opt/deus-mcp/start"]
```

The operator-owned launcher configures server-side PATH, Dexter/signing trust, then `exec`s the command above. Verify SSH host keys. Stdio only; no workspace initialization or drain.

## Tools and boundaries

MCP exposes exactly the same 17 Dexter tools as Pi: seven mutations and ten inspection tools. No workspace discovery, skill-reading, generic filesystem or design APIs. The initialization instructions identify the canonical server workspace; workspace arguments must match it exactly. Extra properties are rejected; dedicated readers retain their path guards.

Install skills on the client separately. Use the host agent's filesystem tools for source inspection, design documents, reports and handoffs. Remote clients need a separate authorized filesystem channel for those operations; Deus does not supply one.

Calls serialize per connection. Cancellation/disconnect abort foreground processes; interrupted mutations may have happened—inspect, never replay. No durable jobs or cross-process locking; cursors expire with the server. Trusted workspace owner/OS account required, not a hostile-filesystem sandbox.

## Checks

Normal [development checks](../README.md#development) include MCP schema/trust/path tests, cancellation/disconnect fixtures and installed stdio smoke. SSH, interactive Codex, paid models and live remote mutations remain unverified; PR #15's historical results are not evidence here.
