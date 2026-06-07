# X API MCP

[![CI](https://github.com/aidanllewellyn/x-api-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/aidanllewellyn/x-api-mcp/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D20-339933)
![MCP](https://img.shields.io/badge/MCP-Streamable_HTTP-2f6fed)
![Auth](https://img.shields.io/badge/hosted_auth-Bearer_required-success)
![License](https://img.shields.io/badge/license-MIT-green)

Production-oriented MCP server for X (Twitter) API workflows that need cheap, controlled, authenticated access from Claude, Codex, and other MCP clients.

The repo is built around a simple operating principle: local agents should not depend on Tailscale sessions, SSH port-forwards, browser logins, or private keys just to keep an MCP available. Clients run a small stdio proxy, the proxy calls a stable HTTPS endpoint, and the hosted MCP endpoint enforces bearer auth.

```text
MCP client
  -> local stdio HTTPS proxy
  -> stable HTTPS endpoint
  -> Cloudflare Tunnel or reverse proxy
  -> 127.0.0.1 X API MCP service
```

## What This Demonstrates

- Secure hosted MCP design with bearer-auth public ingress.
- Local stdio compatibility without a localhost listener or SSH tunnel.
- OAuth 2.0 user-context support for owned reads such as bookmarks.
- OAuth 1.0a support for endpoints that still require classic user-context credentials.
- Optional Hermes Tweet/Xquik read backend for public Post lookup, user timelines, and generic search reads.
- Cost guardrails: an allowlisted generic request tool blocks unpriced or expensive surfaces.
- Timing-safe bearer-token comparison for hosted MCP auth.
- Bounded Streamable HTTP session tracking with idle-session cleanup.
- Unit-tested endpoint normalization, URL-create blocking, local filtering, and bearer parsing.

## Design Notes

The non-obvious decisions, and why they were made:

- **Stdio proxy → hosted HTTPS, not a local listener.** Agents on a laptop should not need a long-lived localhost daemon, an SSH tunnel, or a VPN session to reach the MCP. The client runs a thin stdio↔HTTPS shim and the real server lives behind one stable URL, so the same endpoint works from Claude Desktop, Claude Code, Codex, or CI without per-machine plumbing.
- **An allowlist is the cost model.** X bills per surface, and `Content: Create with URL` is the expensive one. Rather than trust the model to avoid it, `x_low_cost_request` rejects any endpoint not on an explicit allowlist and blocks Post creation whose body contains a URL — the guardrail is code, not a prompt.
- **Timing-safe auth.** Bearer comparison hashes both sides and uses `timingSafeEqual`, so a wrong token can't be recovered byte-by-byte from response timing.
- **Stateless client, module-scoped caches.** A fresh `XClient` is built per tool call (no shared request state to leak between calls), while user-ID and username→ID lookups are cached at module scope to avoid re-resolving on every request.
- **Honest tool annotations.** Each tool ships `readOnlyHint` / `destructiveHint` so MCP clients can surface or gate the one destructive tool (`x_delete_post`) instead of treating every call alike.
- **Localhost binding by default.** The Node process binds `127.0.0.1`; public HTTPS is terminated by Cloudflare Tunnel or a reverse proxy, so the app is never directly exposed.

## One-Command Verification

```bash
git clone https://github.com/aidanllewellyn/x-api-mcp.git
cd x-api-mcp
npm ci
npm run verify
```

`npm run verify` runs TypeScript typechecking, unit tests, and a production build.

## Quick Start

```bash
npm ci
cp .env.example .env
npm run build
npm start
```

For local development, keep the server bound to localhost:

```text
HOST=127.0.0.1
PORT=3000
MCP_PATH=/mcp
```

For hosted use, keep the Node process on `127.0.0.1` and expose it through Cloudflare Tunnel or a reverse proxy. Set `MCP_BEARER_TOKEN` so `/mcp` requires:

```text
Authorization: Bearer <token>
```

## Client Install

Install the local stdio proxy:

```bash
scripts/install-client.sh --url https://x-api.example.com/mcp
```

Store local client auth in a secret environment or password manager:

```bash
export X_API_MCP_URL="https://x-api.example.com/mcp"
export X_API_MCP_AUTHORIZATION="Bearer <token>"
export X_API_MCP_TIMEOUT_SECONDS=300
```

Configure an MCP client to run:

```bash
/bin/bash -lc 'set -a; [ -f ~/.secrets.env ] && . ~/.secrets.env; set +a; exec ~/.local/bin/x-api-mcp-stdio'
```

See [INSTALL.md](INSTALL.md) for Codex, Claude Code, Claude Desktop, systemd, Caddy, and Cloudflare examples.

## MCP Tools

| Tool | Purpose | Cost posture |
| --- | --- | --- |
| `x_get_me` | Verify the authenticated X user. | Small read |
| `x_get_post` | Fetch one Post by ID with optional Post fields. | Small read |
| `x_search_user_posts` | Fetch one page from a public user's timeline and locally filter it. | Bounded read |
| `x_search_bookmarks` | Fetch and locally filter authenticated-user bookmarks. | Owned read when app/user qualify |
| `x_search_likes` | Fetch and locally filter authenticated-user likes. | Owned read when app/user qualify |
| `x_low_cost_request` | Call allowlisted low-cost X API v2 endpoints. | Guarded generic access |
| `x_delete_post` | Delete an owned Post. | Explicit destructive tool |

The generic low-cost tool rejects endpoints outside the allowlist and blocks Post creation when the body contains URLs.
When `X_API_MCP_READ_BACKEND` is `auto`, X API credentials stay the default. If no X credentials are configured and `HERMES_TWEET_API_KEY` or `XQUIK_API_KEY` exists, supported public read helpers use Hermes Tweet/Xquik instead. Set `X_API_MCP_READ_BACKEND=x`, `hermes`, or `xquik` to force a backend.

## Example Tool Calls

Fetch a single Post:

```json
{
  "tool": "x_get_post",
  "arguments": {
    "id": "1234567890123456789",
    "tweetFields": ["id", "text", "created_at", "public_metrics"]
  }
}
```

Search one page of a user's recent Posts locally:

```json
{
  "tool": "x_search_user_posts",
  "arguments": {
    "username": "openai",
    "query": "agents",
    "maxResults": 20,
    "exclude": ["retweets", "replies"]
  }
}
```

Use the guarded generic endpoint:

```json
{
  "tool": "x_low_cost_request",
  "arguments": {
    "method": "GET",
    "endpoint": "/2/tweets/search/recent",
    "query": {
      "query": "from:openai MCP",
      "max_results": 10,
      "tweet.fields": ["id", "text", "created_at"]
    }
  }
}
```

## Configuration

Use either OAuth 2.0:

```text
X_USER_ACCESS_TOKEN=
X_OAUTH2_REFRESH_TOKEN=
X_OAUTH2_CLIENT_ID=
X_OAUTH2_CLIENT_SECRET=
X_USER_ID=
```

or OAuth 1.0a:

```text
X_API_KEY=
X_API_KEY_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_TOKEN_SECRET=
```

Optional Hermes Tweet/Xquik read backend:

```text
X_API_MCP_READ_BACKEND=auto
HERMES_TWEET_API_KEY=
HERMES_TWEET_BASE_URL=https://xquik.com
HERMES_TWEET_TIMEOUT_MS=30000
XQUIK_API_KEY=
XQUIK_BASE_URL=https://xquik.com
```

The Hermes Tweet backend supports `x_get_post`, `x_search_user_posts`, and GET reads through `x_low_cost_request` for Post lookup, recent/all search, user lookup, and user timelines. Owned reads such as bookmarks, likes, `x_get_me`, writes, and deletes still require X credentials.

Hosted MCP settings:

```text
HOST=127.0.0.1
PORT=3000
MCP_PATH=/mcp
MCP_BEARER_TOKEN=<generated token>
MCP_SESSION_TTL_MS=1800000
```

## Security Model

- No credentials are committed. `.env.example` contains variable names only.
- Hosted `/mcp` access is protected by `MCP_BEARER_TOKEN`.
- Bearer-token checks use constant-length digest comparison via `timingSafeEqual`.
- The local stdio proxy reads `X_API_MCP_AUTHORIZATION` from the environment and never stores token values in MCP config files.
- The stdio proxy requires HTTPS for remote endpoints and only allows plain HTTP for localhost development.
- The service can stay bound to `127.0.0.1` while Cloudflare Tunnel exposes a public hostname.
- MCP sessions are tracked in memory and closed after an idle TTL to prevent unbounded session growth.

See [SECURITY.md](SECURITY.md).

## Testing And Audit

```bash
npm run lint        # Biome lint + format check
npm run typecheck
npm test
npm run build
scripts/verify.sh   # all of the above, plus an optional live endpoint handshake
```

Useful public-release checks:

```bash
gitleaks protect --staged --redact --no-banner --source .
git ls-files
```

## Deployment Shape

The deployment examples in [deploy/](deploy/) assume:

- Node service installed on a Linux host.
- `HOST=127.0.0.1` so the service is not directly exposed.
- Cloudflare Tunnel or Caddy terminates public HTTPS.
- Server credentials are stored through environment variables, `systemd-creds`, or another secret manager.
- Local MCP clients use the stdio proxy and only store auth in local secret storage.

## Repository Layout

```text
src/
  server.ts        Express + Streamable HTTP transport, tool registration, session lifecycle
  xClient.ts       X API client: OAuth 1.0a/2.0, cost allowlist, local filtering
  httpAuth.ts      Timing-safe bearer-token verification
  *.test.ts        Unit tests (node:test) for auth, allowlist, normalization, filtering
scripts/
  install-client.sh  Install the local stdio proxy for an MCP client
  x-api-mcp-stdio    The stdio↔HTTPS proxy itself
  verify.sh          lint → typecheck → test → build (+ optional live handshake)
deploy/            Caddy, systemd unit, and Cloudflare Tunnel examples
.github/workflows/ CI: lint, typecheck, test, build on Node 20 and 22
```

## License

MIT. See [LICENSE](LICENSE).
