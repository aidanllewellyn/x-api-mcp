# X API MCP

Streamable HTTP MCP server for low-cost X API operations, plus a local stdio proxy for Claude, Codex, and other MCP clients.

The project is built for a secure hosted shape:

```text
MCP client -> local stdio proxy -> HTTPS endpoint -> Cloudflare Tunnel -> 127.0.0.1 X API MCP service
```

No Tailscale session, local SSH port-forward, or local private SSH key is required for MCP startup.

## Tools

- `x_get_me` verifies the authenticated X user.
- `x_get_post` fetches one Post by id.
- `x_search_user_posts` fetches and locally filters a public user's recent Posts.
- `x_search_bookmarks` fetches and filters authenticated-user bookmarks.
- `x_search_likes` fetches and filters authenticated-user likes.
- `x_low_cost_request` calls allowlisted low-cost X API v2 endpoints.
- `x_delete_post` deletes an owned Post.

The generic low-cost tool rejects unallowlisted endpoints and blocks Post creation with URLs.

## Quick Start

```bash
npm install
cp .env.example .env
npm run build
npm start
```

For local development, keep `HOST=127.0.0.1`.

For public ingress, keep the service bound to `127.0.0.1` on the server and expose it through Cloudflare Tunnel or a reverse proxy. Set `MCP_BEARER_TOKEN` so the hosted endpoint requires `Authorization: Bearer <token>`.

## Client Install

Install the stdio HTTPS proxy:

```bash
scripts/install-client.sh --url https://x-api.example.com/mcp
```

Add the bearer header to your shell environment or secret manager:

```bash
export X_API_MCP_AUTHORIZATION="Bearer <token>"
export X_API_MCP_URL="https://x-api.example.com/mcp"
```

Then configure an MCP client to run:

```bash
/bin/bash -lc 'set -a; [ -f ~/.secrets.env ] && . ~/.secrets.env; set +a; exec ~/.local/bin/x-api-mcp-stdio'
```

See [INSTALL.md](INSTALL.md) for Codex, Claude Code, Claude Desktop, systemd, and Cloudflare examples.

## Security Model

- X API credentials are read from environment variables or systemd encrypted credentials.
- Hosted MCP access is protected by `MCP_BEARER_TOKEN`.
- The local stdio proxy reads `X_API_MCP_AUTHORIZATION` from environment variables and never embeds token values in config files.
- Cloudflare Tunnel can expose a hostname while the Node service stays bound to `127.0.0.1`.

See [SECURITY.md](SECURITY.md).

## Verification

```bash
npm run typecheck
npm run build
scripts/verify.sh
```

## License

MIT. See [LICENSE](LICENSE).
