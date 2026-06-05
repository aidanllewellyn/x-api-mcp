import crypto from "node:crypto";
import OAuth from "oauth-1.0a";

const X_API_BASE_URL = "https://api.x.com/2";

type JsonObject = Record<string, unknown>;
type JsonPrimitive = string | number | boolean;
type JsonValue = JsonPrimitive | null | JsonValue[] | { [key: string]: JsonValue };

type AuthMode = "default" | "oauth1" | "oauth2";
type OAuth2Auth = {
  kind: "oauth2";
  accessToken: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
};
type OAuth1Auth = {
  kind: "oauth1";
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
};
type XAuth = {
  oauth2?: OAuth2Auth;
  oauth1?: OAuth1Auth;
};

export type GetPostInput = {
  id: string;
  tweetFields?: string[];
};

export type SearchOwnPostsInput = {
  query?: string;
  maxResults?: number;
  paginationToken?: string;
  tweetFields?: string[];
};

export type SearchUserPostsInput = SearchOwnPostsInput & {
  username?: string;
  userId?: string;
  exclude?: Array<"retweets" | "replies">;
  sinceId?: string;
  untilId?: string;
  startTime?: string;
  endTime?: string;
};

export type LowCostRequestInput = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  endpoint: string;
  query?: Record<string, JsonPrimitive | JsonPrimitive[] | null | undefined>;
  body?: Record<string, JsonValue>;
  authMode?: AuthMode;
};

let cachedAuthenticatedUserId: string | undefined;
const cachedUsernameIds = new Map<string, string>();

export class XClient {
  private readonly auth: XAuth;

  constructor(auth = readAuthFromEnv()) {
    this.auth = auth;
  }

  async deletePost(id: string): Promise<JsonObject> {
    return this.request("DELETE", `/tweets/${encodeURIComponent(id)}`);
  }

  async getPost(input: GetPostInput): Promise<JsonObject> {
    const query = new URLSearchParams();
    if (input.tweetFields?.length) {
      query.set("tweet.fields", input.tweetFields.join(","));
    }

    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request("GET", `/tweets/${encodeURIComponent(input.id)}${suffix}`);
  }

  async getMe(): Promise<JsonObject> {
    return this.request("GET", "/users/me?user.fields=id,name,username,verified");
  }

  async searchBookmarks(input: SearchOwnPostsInput): Promise<JsonObject> {
    this.requireOAuth2("Bookmarks require OAuth 2.0 user-context auth with bookmark.read.");
    return this.getOwnPostCollection("bookmarks", input, "oauth2");
  }

  async searchLikes(input: SearchOwnPostsInput): Promise<JsonObject> {
    return this.getOwnPostCollection("liked_tweets", input);
  }

  async searchUserPosts(input: SearchUserPostsInput): Promise<JsonObject> {
    const userId = await this.resolveRequestedUserId(input);
    const query = new URLSearchParams();
    if (input.maxResults) {
      query.set("max_results", String(input.maxResults));
    }
    if (input.paginationToken) {
      query.set("pagination_token", input.paginationToken);
    }
    if (input.exclude?.length) {
      query.set("exclude", input.exclude.join(","));
    }
    if (input.sinceId) {
      query.set("since_id", input.sinceId);
    }
    if (input.untilId) {
      query.set("until_id", input.untilId);
    }
    if (input.startTime) {
      query.set("start_time", input.startTime);
    }
    if (input.endTime) {
      query.set("end_time", input.endTime);
    }
    if (input.tweetFields?.length) {
      query.set("tweet.fields", input.tweetFields.join(","));
    }

    const suffix = query.size ? `?${query.toString()}` : "";
    const payload = await this.request("GET", `/users/${encodeURIComponent(userId)}/tweets${suffix}`);
    return filterPostPayload(payload, input.query);
  }

  async lowCostRequest(input: LowCostRequestInput): Promise<JsonObject> {
    const endpoint = normalizeEndpoint(input.endpoint);
    assertLowCostEndpoint(input.method, endpoint, input.body);
    const suffix = serializeQuery(input.query);
    return this.request(input.method, `${endpoint}${suffix}`, { body: input.body, authMode: input.authMode });
  }

  private async getOwnPostCollection(
    collection: "bookmarks" | "liked_tweets",
    input: SearchOwnPostsInput,
    authMode?: AuthMode,
  ): Promise<JsonObject> {
    const userId = await this.getAuthenticatedUserId();
    const query = new URLSearchParams();
    if (input.maxResults) {
      query.set("max_results", String(input.maxResults));
    }
    if (input.paginationToken) {
      query.set("pagination_token", input.paginationToken);
    }
    if (input.tweetFields?.length) {
      query.set("tweet.fields", input.tweetFields.join(","));
    }

    const suffix = query.size ? `?${query.toString()}` : "";
    const payload = await this.request("GET", `/users/${encodeURIComponent(userId)}/${collection}${suffix}`, {
      authMode,
    });
    return filterPostPayload(payload, input.query);
  }

  private async getAuthenticatedUserId(): Promise<string> {
    const userId = process.env.X_USER_ID?.trim();
    if (userId) {
      return userId;
    }
    if (cachedAuthenticatedUserId) {
      return cachedAuthenticatedUserId;
    }

    const me = await this.getMe();
    const data = me.data;
    if (isJsonObject(data) && typeof data.id === "string") {
      cachedAuthenticatedUserId = data.id;
      return data.id;
    }

    throw new Error(
      "Could not determine authenticated X user ID. Set X_USER_ID or use credentials that can call /2/users/me.",
    );
  }

  private async resolveRequestedUserId(input: SearchUserPostsInput): Promise<string> {
    if (input.userId) {
      return input.userId;
    }

    const username = input.username?.trim().replace(/^@/, "");
    if (!username) {
      throw new Error("Provide either username or userId.");
    }

    const cacheKey = username.toLowerCase();
    const cached = cachedUsernameIds.get(cacheKey);
    if (cached) {
      return cached;
    }

    const query = new URLSearchParams({ "user.fields": "id,name,username,verified" });
    const payload = await this.request("GET", `/users/by/username/${encodeURIComponent(username)}?${query.toString()}`);
    const data = payload.data;
    if (isJsonObject(data) && typeof data.id === "string") {
      cachedUsernameIds.set(cacheKey, data.id);
      return data.id;
    }

    throw new Error(`Could not resolve X username: ${username}`);
  }

  private async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    pathWithQuery: string,
    options: { body?: JsonObject; authMode?: AuthMode; didRefresh?: boolean } = {},
  ): Promise<JsonObject> {
    const url = `${X_API_BASE_URL}${pathWithQuery}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.authHeaders(method, url, options.authMode),
    };

    const init: RequestInit = { method, headers };
    if (options.body) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, init);
    const text = await response.text();
    const payload = text ? parseJson(text) : {};

    if (
      response.status === 401 &&
      options.authMode === "oauth2" &&
      !options.didRefresh &&
      this.auth.oauth2?.refreshToken
    ) {
      await this.refreshOAuth2AccessToken();
      return this.request(method, pathWithQuery, { ...options, authMode: "oauth2", didRefresh: true });
    }

    if (!response.ok) {
      const detail = JSON.stringify(payload);
      throw new Error(`X API ${response.status} ${response.statusText}: ${detail}`);
    }

    return payload;
  }

  private authHeaders(method: string, url: string, authMode: AuthMode = "default"): Record<string, string> {
    const auth = this.selectAuth(authMode);
    if (auth.kind === "oauth2") {
      return { Authorization: `Bearer ${auth.accessToken}` };
    }

    const oauth = new OAuth({
      consumer: {
        key: auth.consumerKey,
        secret: auth.consumerSecret,
      },
      signature_method: "HMAC-SHA1",
      hash_function(baseString, key) {
        return crypto.createHmac("sha1", key).update(baseString).digest("base64");
      },
    });

    return oauth.toHeader(
      oauth.authorize(
        { url, method },
        {
          key: auth.accessToken,
          secret: auth.accessTokenSecret,
        },
      ),
    ) as unknown as Record<string, string>;
  }

  private requireOAuth2(message: string): void {
    if (!this.auth.oauth2) {
      throw new Error(message);
    }
  }

  private selectAuth(authMode: AuthMode): OAuth1Auth | OAuth2Auth {
    if (authMode === "oauth2") {
      if (!this.auth.oauth2) {
        throw new Error("OAuth 2.0 user-context token is not configured.");
      }

      return this.auth.oauth2;
    }

    if (authMode === "oauth1") {
      if (!this.auth.oauth1) {
        throw new Error("OAuth 1.0a user-context credentials are not configured.");
      }

      return this.auth.oauth1;
    }

    const auth = this.auth.oauth1 ?? this.auth.oauth2;
    if (!auth) {
      throw new Error("Missing X credentials.");
    }

    return auth;
  }

  private async refreshOAuth2AccessToken(): Promise<void> {
    const oauth2 = this.auth.oauth2;
    if (!oauth2?.refreshToken || !oauth2.clientId) {
      throw new Error("OAuth 2.0 token expired and refresh credentials are not configured.");
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: oauth2.refreshToken,
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };

    if (oauth2.clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(`${oauth2.clientId}:${oauth2.clientSecret}`).toString("base64")}`;
    } else {
      body.set("client_id", oauth2.clientId);
    }

    const response = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers,
      body,
    });
    const text = await response.text();
    const payload = text ? parseJson(text) : {};

    if (!response.ok) {
      throw new Error(`OAuth 2.0 token refresh failed: ${JSON.stringify(payload)}`);
    }
    if (typeof payload.access_token !== "string") {
      throw new Error(`OAuth 2.0 token refresh did not return an access token: ${JSON.stringify(payload)}`);
    }

    oauth2.accessToken = payload.access_token;
    if (typeof payload.refresh_token === "string") {
      oauth2.refreshToken = payload.refresh_token;
    }
  }
}

export function filterPostPayload(payload: JsonObject, query?: string): JsonObject {
  const normalizedQuery = query?.trim().toLowerCase();
  if (!normalizedQuery) {
    return payload;
  }

  const data = Array.isArray(payload.data) ? payload.data : [];
  const filtered = data.filter((item) => {
    if (!isJsonObject(item) || typeof item.text !== "string") {
      return false;
    }

    return item.text.toLowerCase().includes(normalizedQuery);
  });

  return {
    ...payload,
    data: filtered,
    meta: {
      ...(isJsonObject(payload.meta) ? payload.meta : {}),
      local_query: query,
      unfiltered_result_count: data.length,
      filtered_result_count: filtered.length,
    },
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed.startsWith("/")) {
    throw new Error("Endpoint must start with /.");
  }
  if (trimmed.includes("?")) {
    throw new Error("Pass query parameters with the query object, not in endpoint.");
  }
  if (trimmed.includes("..") || trimmed.includes("//")) {
    throw new Error("Endpoint contains invalid path traversal or duplicate slashes.");
  }

  return trimmed.startsWith("/2/") ? trimmed.slice(2) : trimmed;
}

export function serializeQuery(query?: LowCostRequestInput["query"]): string {
  if (!query) {
    return "";
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      params.set(key, value.join(","));
    } else {
      params.set(key, String(value));
    }
  }

  return params.size ? `?${params.toString()}` : "";
}

export function assertLowCostEndpoint(
  method: LowCostRequestInput["method"],
  endpoint: string,
  body?: Record<string, JsonValue>,
): void {
  if (method === "GET" && endpointMatches(endpoint, LOW_COST_GET_PATTERNS)) {
    return;
  }
  if (method === "POST" && endpoint === "/tweets") {
    assertPostDoesNotCreateUrl(body);
    return;
  }
  if (method !== "GET" && endpointMatches(endpoint, LOW_COST_WRITE_PATTERNS)) {
    return;
  }

  throw new Error(`Endpoint is not in the low-cost allowlist: ${method} ${endpoint}`);
}

function endpointMatches(endpoint: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(endpoint));
}

function assertPostDoesNotCreateUrl(body?: Record<string, JsonValue>): void {
  const text = body?.text;
  if (typeof text !== "string") {
    return;
  }
  if (/(https?:\/\/|www\.)\S+/i.test(text)) {
    throw new Error("Blocked: Content: Create with URL is priced at $0.200/request.");
  }
}

const LOW_COST_GET_PATTERNS = [
  /^\/tweets$/,
  /^\/tweets\/\d+$/,
  /^\/tweets\/search\/(recent|all)$/,
  /^\/tweets\/counts\/(recent|all)$/,
  /^\/tweets\/analytics$/,
  /^\/tweets\/\d+\/(liking_users|quote_tweets|retweeted_by|retweets)$/,
  /^\/users$/,
  /^\/users\/by$/,
  /^\/users\/by\/username\/[A-Za-z0-9_]{1,15}$/,
  /^\/users\/me$/,
  /^\/users\/search$/,
  /^\/users\/personalized_trends$/,
  /^\/users\/\d+$/,
  /^\/users\/\d+\/(tweets|mentions|liked_tweets|bookmarks|followers|following|blocking|muting|owned_lists|followed_lists|list_memberships|pinned_lists|affiliates|retweets|reposts_of_me|timelines\/reverse_chronological)$/,
  /^\/users\/\d+\/bookmarks\/folders$/,
  /^\/users\/\d+\/bookmarks\/folders\/[^/]+$/,
  /^\/lists$/,
  /^\/lists\/\d+$/,
  /^\/lists\/\d+\/(tweets|followers|members)$/,
  /^\/spaces$/,
  /^\/spaces\/search$/,
  /^\/spaces\/by\/creator_ids$/,
  /^\/spaces\/[^/]+$/,
  /^\/spaces\/[^/]+\/(tweets|buyers)$/,
  /^\/communities\/search$/,
  /^\/communities\/[^/]+$/,
  /^\/notes$/,
  /^\/notes\/search\/(notes_written|posts_eligible_for_notes)$/,
  /^\/notes\/[^/]+$/,
  /^\/media$/,
  /^\/media\/analytics$/,
  /^\/media\/[^/]+$/,
  /^\/trends\/by\/woeid\/\d+$/,
  /^\/dm_events$/,
  /^\/dm_conversations\/with\/\d+\/dm_events$/,
  /^\/usage\/tweets$/,
];

const LOW_COST_WRITE_PATTERNS = [
  /^\/tweets\/\d+$/,
  /^\/tweets\/\d+\/hidden$/,
  /^\/users\/\d+\/likes$/,
  /^\/users\/\d+\/likes\/\d+$/,
  /^\/users\/\d+\/retweets$/,
  /^\/users\/\d+\/retweets\/\d+$/,
  /^\/users\/\d+\/bookmarks$/,
  /^\/users\/\d+\/bookmarks\/\d+$/,
  /^\/users\/\d+\/following\/\d+$/,
  /^\/users\/\d+\/muting\/\d+$/,
  /^\/users\/\d+\/dm\/(block|unblock)$/,
  /^\/lists$/,
  /^\/lists\/\d+$/,
  /^\/lists\/\d+\/members\/\d+$/,
  /^\/users\/\d+\/followed_lists\/\d+$/,
  /^\/users\/\d+\/pinned_lists\/\d+$/,
  /^\/media\/metadata$/,
  /^\/media\/subtitles$/,
  /^\/dm_conversations$/,
  /^\/dm_conversations\/[^/]+\/dm_events$/,
  /^\/dm_conversations\/with\/\d+\/dm_events$/,
  /^\/notes$/,
  /^\/notes\/[^/]+$/,
];

function readAuthFromEnv(): XAuth {
  const oauth2Token = process.env.X_USER_ACCESS_TOKEN?.trim();
  const oauth2RefreshToken = process.env.X_OAUTH2_REFRESH_TOKEN?.trim();
  const oauth2ClientId = process.env.X_OAUTH2_CLIENT_ID?.trim();
  const oauth2ClientSecret = process.env.X_OAUTH2_CLIENT_SECRET?.trim();
  const consumerKey = process.env.X_API_KEY?.trim();
  const consumerSecret = process.env.X_API_KEY_SECRET?.trim();
  const accessToken = process.env.X_ACCESS_TOKEN?.trim();
  const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET?.trim();
  const auth: XAuth = {};

  if (oauth2Token) {
    auth.oauth2 = {
      kind: "oauth2",
      accessToken: oauth2Token,
      refreshToken: oauth2RefreshToken,
      clientId: oauth2ClientId,
      clientSecret: oauth2ClientSecret,
    };
  }

  if (consumerKey && consumerSecret && accessToken && accessTokenSecret) {
    auth.oauth1 = {
      kind: "oauth1",
      consumerKey,
      consumerSecret,
      accessToken,
      accessTokenSecret,
    };
  }

  if (auth.oauth1 || auth.oauth2) {
    return auth;
  }

  throw new Error(
    "Missing X credentials. Set X_USER_ACCESS_TOKEN or X_API_KEY, X_API_KEY_SECRET, X_ACCESS_TOKEN, and X_ACCESS_TOKEN_SECRET.",
  );
}

function parseJson(text: string): JsonObject {
  try {
    return JSON.parse(text) as JsonObject;
  } catch {
    return { raw: text };
  }
}
