import "dotenv/config";

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextFunction, Request, Response } from "express";
import express from "express";

// When run under systemd with LoadCredentialEncrypted=, secrets are exposed as
// files under $CREDENTIALS_DIRECTORY (tmpfs, readable only by this process).
// Load them into process.env so existing code paths don't change.
const credsDir = process.env.CREDENTIALS_DIRECTORY;
if (credsDir) {
  for (const name of [
    "X_USER_ACCESS_TOKEN",
    "X_OAUTH2_REFRESH_TOKEN",
    "X_OAUTH2_CLIENT_ID",
    "X_OAUTH2_CLIENT_SECRET",
    "X_USER_ID",
    "X_API_KEY",
    "X_API_KEY_SECRET",
    "X_ACCESS_TOKEN",
    "X_ACCESS_TOKEN_SECRET",
    "MCP_BEARER_TOKEN",
  ]) {
    try {
      process.env[name] = readFileSync(join(credsDir, name), "utf8").trim();
    } catch {
      // credential not provided — fall through to existing env (dev mode)
    }
  }
}
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isBearerAuthorized } from "./httpAuth.js";
import { XClient } from "./xClient.js";
import type { LowCostRequestInput } from "./xClient.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "127.0.0.1";
const MCP_PATH = process.env.MCP_PATH ?? "/mcp";
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN?.trim();
const SESSION_TTL_MS = parseInteger(process.env.MCP_SESSION_TTL_MS, 30 * 60 * 1000);

const allowedTweetFields = [
  "id",
  "text",
  "author_id",
  "created_at",
  "conversation_id",
  "in_reply_to_user_id",
  "public_metrics",
  "referenced_tweets",
  "edit_history_tweet_ids",
] as const;

const allowedTimelineExcludes = ["retweets", "replies"] as const;
const queryValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
  z.null(),
]);

type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "x-api-cheap-reads",
      version: "0.4.0",
    },
    {
      instructions:
        "Use these tools only for X API operations from the pricing table that are not Content: Create with URL. The generic low-cost request tool has an allowlist and blocks URL-bearing Post creation. Avoid streams, enterprise-only endpoints, and unpriced surfaces.",
    },
  );

  server.registerTool(
    "x_get_me",
    {
      title: "Get X Authenticated User",
      description: "Return the X user associated with the configured user-context token.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (): Promise<ToolResponse> => runTool((x) => x.getMe()),
  );

  server.registerTool(
    "x_get_post",
    {
      title: "Get X Post",
      description: "Fetch one X Post by ID. This is the only read helper exposed to keep API usage cheap.",
      inputSchema: {
        id: z.string().regex(/^\d+$/, "Post ID must be a numeric string."),
        tweetFields: z
          .array(z.enum(allowedTweetFields))
          .optional()
          .describe("Optional Post fields to request."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input): Promise<ToolResponse> => runTool((x) => x.getPost(input)),
  );

  server.registerTool(
    "x_search_bookmarks",
    {
      title: "Search X Bookmarks",
      description:
        "Fetch the authenticated user's own bookmarked Posts and optionally filter that page by text. Requires OAuth 2.0 user-context auth with bookmark.read; OAuth 1.0a tokens cannot use this endpoint. Qualifies for X Owned Reads pricing only when the authenticated user owns the developer app.",
      inputSchema: {
        query: z.string().min(1).max(200).optional().describe("Optional case-insensitive text filter applied locally to the fetched page."),
        maxResults: z.number().int().min(1).max(100).optional().describe("Maximum Posts to fetch from X, 1-100."),
        paginationToken: z.string().min(1).optional().describe("Optional X pagination token for the next page."),
        tweetFields: z
          .array(z.enum(allowedTweetFields))
          .optional()
          .describe("Optional Post fields to request."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input): Promise<ToolResponse> => runTool((x) => x.searchBookmarks(input)),
  );

  server.registerTool(
    "x_search_likes",
    {
      title: "Search X Likes",
      description:
        "Fetch Posts liked by the authenticated user and optionally filter that page by text. Qualifies for X Owned Reads pricing only when the authenticated user owns the developer app.",
      inputSchema: {
        query: z.string().min(1).max(200).optional().describe("Optional case-insensitive text filter applied locally to the fetched page."),
        maxResults: z.number().int().min(1).max(100).optional().describe("Maximum Posts to fetch from X, 1-100."),
        paginationToken: z.string().min(1).optional().describe("Optional X pagination token for the next page."),
        tweetFields: z
          .array(z.enum(allowedTweetFields))
          .optional()
          .describe("Optional Post fields to request."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input): Promise<ToolResponse> => runTool((x) => x.searchLikes(input)),
  );

  server.registerTool(
    "x_search_user_posts",
    {
      title: "Search X User Posts",
      description:
        "Fetch recent Posts from a public user's profile timeline by username or user ID and optionally filter that page by text. This uses normal X Posts: Read pricing, not Owned Reads, unless the requested user is the authenticated app owner.",
      inputSchema: {
        username: z
          .string()
          .regex(/^[A-Za-z0-9_]{1,15}$/, "Username must be 1-15 letters, numbers, or underscores.")
          .optional()
          .describe("X username without @. Provide username or userId."),
        userId: z
          .string()
          .regex(/^\d+$/, "User ID must be a numeric string.")
          .optional()
          .describe("Numeric X user ID. Provide username or userId."),
        query: z.string().min(1).max(200).optional().describe("Optional case-insensitive text filter applied locally to the fetched page."),
        maxResults: z.number().int().min(5).max(100).optional().describe("Maximum Posts to fetch from X, 5-100."),
        paginationToken: z.string().min(1).optional().describe("Optional X pagination token for the next page."),
        exclude: z
          .array(z.enum(allowedTimelineExcludes))
          .optional()
          .describe("Optional Post types to exclude from the timeline."),
        sinceId: z
          .string()
          .regex(/^\d+$/, "sinceId must be a numeric Post ID.")
          .optional()
          .describe("Return Posts after this Post ID."),
        untilId: z
          .string()
          .regex(/^\d+$/, "untilId must be a numeric Post ID.")
          .optional()
          .describe("Return Posts before this Post ID."),
        startTime: z.string().datetime().optional().describe("Oldest Post timestamp, ISO 8601."),
        endTime: z.string().datetime().optional().describe("Newest Post timestamp, ISO 8601."),
        tweetFields: z
          .array(z.enum(allowedTweetFields))
          .optional()
          .describe("Optional Post fields to request."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input): Promise<ToolResponse> => runTool((x) => x.searchUserPosts(input)),
  );

  server.registerTool(
    "x_low_cost_request",
    {
      title: "X Low-Cost API Request",
      description:
        "Call an allowlisted X API v2 endpoint from the pricing table that is not the $0.200 Content: Create with URL action. Use this for low-cost reads and low-cost writes/actions not covered by the convenience tools. Endpoint must be a /2 path such as /2/tweets/search/recent or /2/lists/123/tweets. Query parameters go in query. Post creation with URLs is blocked.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).describe("HTTP method."),
        endpoint: z
          .string()
          .regex(/^\/2?\/?[A-Za-z0-9_./{}-]+$|^\/[A-Za-z0-9_./{}-]+$/, "Endpoint must be a simple X API path.")
          .describe("X API v2 endpoint path. Use /2/... or /... without query string."),
        query: z.record(queryValueSchema).optional().describe("Optional query parameters."),
        body: z.record(z.unknown()).optional().describe("Optional JSON body for low-cost write/action endpoints."),
        authMode: z
          .enum(["default", "oauth1", "oauth2"])
          .optional()
          .describe("Optional auth mode. Use oauth2 for endpoints that require OAuth 2.0, such as bookmarks."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input): Promise<ToolResponse> => runTool((x) => x.lowCostRequest(input as LowCostRequestInput)),
  );

  server.registerTool(
    "x_delete_post",
    {
      title: "Delete X Post",
      description: "Delete a Post owned by the authenticated X user.",
      inputSchema: {
        id: z.string().regex(/^\d+$/, "Post ID must be a numeric string."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id }): Promise<ToolResponse> => runTool((x) => x.deletePost(id)),
  );

  return server;
}

async function runTool(action: (x: XClient) => Promise<Record<string, unknown>>): Promise<ToolResponse> {
  try {
    const result = await action(new XClient());
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }
}

const app = express();
app.use(MCP_PATH, (req: Request, res: Response, next: NextFunction) => {
  if (!MCP_BEARER_TOKEN) {
    next();
    return;
  }

  if (isBearerAuthorized(req.headers.authorization, MCP_BEARER_TOKEN)) {
    next();
    return;
  }

  res.setHeader("WWW-Authenticate", "Bearer");
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized" },
    id: null,
  });
});
app.use(express.json({ limit: "1mb" }));

type SessionRecord = {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
};

const transports: Record<string, SessionRecord> = {};

const cleanupTimer = setInterval(closeExpiredSessions, Math.max(60_000, Math.min(SESSION_TTL_MS, 5 * 60_000)));
cleanupTimer.unref();

app.post(MCP_PATH, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    const existingTransport = getTransport(sessionId);
    if (existingTransport) {
      await existingTransport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      let transport: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (initializedSessionId) => {
          transports[initializedSessionId] = { transport, lastSeen: Date.now() };
        },
      });

      transport.onclose = () => {
        const closedSessionId = transport.sessionId;
        if (closedSessionId) {
          delete transports[closedSessionId];
        }
      };

      const server = createServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: missing or invalid MCP session." },
      id: null,
    });
  } catch (error) {
    console.error("MCP POST failed:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error." },
        id: null,
      });
    }
  }
});

app.get(MCP_PATH, async (req: Request, res: Response) => {
  const transport = getSessionTransport(req, res);
  if (!transport) return;

  await transport.handleRequest(req, res);
});

app.delete(MCP_PATH, async (req: Request, res: Response) => {
  const transport = getSessionTransport(req, res);
  if (!transport) return;

  await transport.handleRequest(req, res);
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    name: "x-api-mcp-server",
    authRequired: Boolean(MCP_BEARER_TOKEN),
    activeSessions: Object.keys(transports).length,
    sessionTtlMs: SESSION_TTL_MS,
  });
});

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`X API MCP server listening at http://${HOST}:${PORT}${MCP_PATH}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function getSessionTransport(
  req: Request,
  res: Response,
): StreamableHTTPServerTransport | undefined {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = getTransport(sessionId);
  if (!transport) {
    res.status(400).send("Invalid or missing MCP session ID.");
    return undefined;
  }

  return transport;
}

async function shutdown(): Promise<void> {
  httpServer.close();
  clearInterval(cleanupTimer);
  await Promise.all(Object.values(transports).map(({ transport }) => transport.close()));
  process.exit(0);
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getTransport(sessionId: string | undefined): StreamableHTTPServerTransport | undefined {
  if (!sessionId) {
    return undefined;
  }

  const record = transports[sessionId];
  if (!record) {
    return undefined;
  }

  record.lastSeen = Date.now();
  return record.transport;
}

async function closeExpiredSessions(): Promise<void> {
  const cutoff = Date.now() - SESSION_TTL_MS;
  const expired = Object.entries(transports).filter(([, record]) => record.lastSeen < cutoff);

  await Promise.all(
    expired.map(async ([sessionId, record]) => {
      delete transports[sessionId];
      await record.transport.close();
    }),
  );
}
