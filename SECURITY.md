# Security

## Secret Handling

Do not commit:

- `.env` files
- X API tokens or OAuth secrets
- MCP bearer tokens
- Cloudflare tunnel credential JSON files
- systemd encrypted credential blobs
- local SQLite data, logs, caches, or generated output

Use `.env.example` for variable names only.

## Hosted MCP Auth

If this server is reachable from outside localhost, set `MCP_BEARER_TOKEN`. Every `/mcp` request must include:

```text
Authorization: Bearer <token>
```

Unauthenticated requests receive `401` with `WWW-Authenticate: Bearer`.

## Recommended Network Shape

Run the Node service on `127.0.0.1` and put Cloudflare Tunnel or a reverse proxy in front of it:

```text
public HTTPS hostname -> reverse proxy/tunnel -> 127.0.0.1:3000
```

This avoids inbound service exposure and removes the need for local SSH tunnels or Tailscale.

## Local MCP Clients

Use the stdio proxy in `scripts/x-api-mcp-stdio`. Store `X_API_MCP_AUTHORIZATION` in a local secret environment or password manager. Do not place bearer tokens in MCP config files. The proxy requires HTTPS for remote endpoints and allows plain HTTP only for localhost development.
