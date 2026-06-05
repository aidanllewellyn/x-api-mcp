#!/usr/bin/env bash
set -euo pipefail

npm run typecheck
npm test
npm run build

if [ -n "${X_API_MCP_URL:-}" ] && [ -n "${X_API_MCP_AUTHORIZATION:-}" ]; then
  headers_file="$(mktemp "${TMPDIR:-/tmp}/x-api-mcp-headers.XXXXXX")"
  body_file="$(mktemp "${TMPDIR:-/tmp}/x-api-mcp-body.XXXXXX")"
  trap 'rm -f "$headers_file" "$body_file"' EXIT

  curl -sS -D "$headers_file" -o "$body_file" \
    -H "Authorization: $X_API_MCP_AUTHORIZATION" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}' \
    "$X_API_MCP_URL" >/dev/null
  grep -qi '^mcp-session-id:' "$headers_file"
fi

echo "verification passed"
