#!/usr/bin/env bash
set -euo pipefail

npm run typecheck
npm run build

if [ -n "${X_API_MCP_URL:-}" ] && [ -n "${X_API_MCP_AUTHORIZATION:-}" ]; then
  curl -sS -D /tmp/x-api-mcp-headers.$$ -o /tmp/x-api-mcp-body.$$ \
    -H "Authorization: $X_API_MCP_AUTHORIZATION" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}' \
    "$X_API_MCP_URL" >/dev/null
  grep -qi '^mcp-session-id:' /tmp/x-api-mcp-headers.$$
  rm -f /tmp/x-api-mcp-headers.$$ /tmp/x-api-mcp-body.$$
fi

echo "verification passed"

