# Install

## Server

1. Install dependencies:

```bash
npm install
```

2. Configure credentials:

```bash
cp .env.example .env
```

Use either OAuth 2.0 user-context credentials:

```text
X_USER_ACCESS_TOKEN=
X_OAUTH2_REFRESH_TOKEN=
X_OAUTH2_CLIENT_ID=
X_OAUTH2_CLIENT_SECRET=
X_USER_ID=
```

or OAuth 1.0a credentials:

```text
X_API_KEY=
X_API_KEY_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_TOKEN_SECRET=
```

3. Build and run:

```bash
npm run build
npm start
```

## Hosted Deployment

Recommended shape:

```text
Cloudflare Tunnel hostname -> http://127.0.0.1:3000
```

Keep the service local-only:

```text
HOST=127.0.0.1
PORT=3000
MCP_PATH=/mcp
MCP_BEARER_TOKEN=<generated token>
```

Generate a token without printing it into shell history by using your password manager or:

```bash
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
```

For systemd, use [deploy/x-api-mcp.service](deploy/x-api-mcp.service) and store secrets with `systemd-creds` or another secret manager. Do not commit credential files.

## Cloudflare Tunnel

Copy [deploy/cloudflared.config.example.yml](deploy/cloudflared.config.example.yml) to your server's Cloudflare config and replace placeholders:

```yaml
tunnel: REPLACE_WITH_TUNNEL_ID
credentials-file: /etc/cloudflared/REPLACE_WITH_TUNNEL_ID.json
ingress:
  - hostname: x-api.example.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

## Local MCP Client

Install the stdio proxy:

```bash
scripts/install-client.sh --url https://x-api.example.com/mcp
```

Put these in your local secret environment:

```bash
export X_API_MCP_URL="https://x-api.example.com/mcp"
export X_API_MCP_AUTHORIZATION="Bearer <token>"
```

Codex TOML example:

```toml
[mcp_servers.x-api]
command = "/bin/bash"
args = ["-lc", "set -a; [ -f ~/.secrets.env ] && . ~/.secrets.env; set +a; exec ~/.local/bin/x-api-mcp-stdio"]
```

Claude Desktop JSON example:

```json
{
  "mcpServers": {
    "x-api": {
      "command": "/bin/bash",
      "args": [
        "-lc",
        "set -a; [ -f ~/.secrets.env ] && . ~/.secrets.env; set +a; exec ~/.local/bin/x-api-mcp-stdio"
      ]
    }
  }
}
```

## Verify Hosted Endpoint

Unauthenticated requests should fail:

```bash
curl -i https://x-api.example.com/mcp
```

Authenticated initialize should return HTTP 200 and an `mcp-session-id` header:

```bash
MCP_AUTHORIZATION='Bearer <token>'
curl -i \
  -H "Authorization: ${MCP_AUTHORIZATION}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  https://x-api.example.com/mcp
```
