const DEFAULT_BASE_URL = "https://xquik.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const SEARCH_PATH = "/api/v1/x/tweets/search";
const USERS_PATH = "/api/v1/x/users";
const TWEETS_PATH = "/api/v1/x/tweets";

type JsonObject = Record<string, unknown>;
type JsonPrimitive = string | number | boolean;
type QueryValue = JsonPrimitive | JsonPrimitive[] | null | undefined;

export type HermesTweetReadBackend = "auto" | "x" | "hermes" | "xquik";

export type HermesTweetConfig = {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type HermesGetPostInput = {
  id: string;
};

export type HermesSearchUserPostsInput = {
  username?: string;
  userId?: string;
  query?: string;
  maxResults?: number;
  paginationToken?: string;
  exclude?: Array<"retweets" | "replies">;
  startTime?: string;
  endTime?: string;
};

export type HermesLowCostReadInput = {
  endpoint: string;
  query?: Record<string, QueryValue>;
};

export class HermesTweetClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HermesTweetConfig = readHermesTweetConfigFromEnv()) {
    this.apiKey = config.apiKey;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async getPost(input: HermesGetPostInput): Promise<JsonObject> {
    const payload = await this.request(`${TWEETS_PATH}/${encodeURIComponent(input.id)}`);
    return normalizeSinglePostPayload(payload);
  }

  async searchUserPosts(input: HermesSearchUserPostsInput): Promise<JsonObject> {
    if (input.username && input.query) {
      const payload = await this.request(SEARCH_PATH, {
        q: `from:${stripHandle(input.username)} ${input.query}`,
        queryType: "Latest",
        ...(input.maxResults ? { limit: String(input.maxResults) } : {}),
        ...(input.paginationToken ? { cursor: input.paginationToken } : {}),
        ...(input.startTime ? { sinceTime: input.startTime } : {}),
        ...(input.endTime ? { untilTime: input.endTime } : {}),
      });
      return normalizePostListPayload(payload, input.maxResults);
    }

    const target = stripHandle(input.username ?? input.userId ?? "");
    if (!target) {
      throw new Error("Provide either username or userId.");
    }

    const payload = await this.request(`${USERS_PATH}/${encodeURIComponent(target)}/tweets`, {
      ...(input.paginationToken ? { cursor: input.paginationToken } : {}),
      ...(input.exclude?.includes("replies") ? { includeReplies: "false" } : {}),
    });
    return filterPostPayload(normalizePostListPayload(payload, input.maxResults), input.query);
  }

  async lowCostRequest(input: HermesLowCostReadInput): Promise<JsonObject> {
    if (input.endpoint === "/tweets/search/recent" || input.endpoint === "/tweets/search/all") {
      const rawQuery = input.query?.query;
      if (typeof rawQuery !== "string" || rawQuery.trim() === "") {
        throw new Error("Hermes Tweet search requires a string query parameter.");
      }

      const payload = await this.request(SEARCH_PATH, {
        q: rawQuery,
        queryType: input.endpoint.endsWith("/all") ? "Top" : "Latest",
        ...renameQueryParam(input.query, "max_results", "limit"),
        ...renameQueryParam(input.query, "pagination_token", "cursor"),
        ...renameQueryParam(input.query, "start_time", "sinceTime"),
        ...renameQueryParam(input.query, "end_time", "untilTime"),
      });
      return normalizePostListPayload(payload, numberFromQuery(input.query?.max_results));
    }

    const tweetMatch = input.endpoint.match(/^\/tweets\/(\d+)$/);
    if (tweetMatch?.[1]) {
      return this.getPost({ id: tweetMatch[1] });
    }

    const usernameMatch = input.endpoint.match(/^\/users\/by\/username\/([A-Za-z0-9_]{1,15})$/);
    if (usernameMatch?.[1]) {
      const payload = await this.request(`${USERS_PATH}/${encodeURIComponent(usernameMatch[1])}`);
      return normalizeUserPayload(payload);
    }

    const userMatch = input.endpoint.match(/^\/users\/(\d+)$/);
    if (userMatch?.[1]) {
      const payload = await this.request(`${USERS_PATH}/${encodeURIComponent(userMatch[1])}`);
      return normalizeUserPayload(payload);
    }

    const userTweetsMatch = input.endpoint.match(/^\/users\/(\d+)\/tweets$/);
    if (userTweetsMatch?.[1]) {
      return this.searchUserPosts({
        userId: userTweetsMatch[1],
        maxResults: numberFromQuery(input.query?.max_results),
        paginationToken: stringFromQuery(input.query?.pagination_token),
      });
    }

    throw new Error(`Hermes Tweet read backend does not support ${input.endpoint}.`);
  }

  private async request(path: string, params?: Record<string, string>): Promise<unknown> {
    if (!this.apiKey) {
      throw new Error("Hermes Tweet API key is required. Set HERMES_TWEET_API_KEY or XQUIK_API_KEY.");
    }

    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params ?? {})) {
      url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        headers: hermesTweetHeaders(this.apiKey),
        signal: controller.signal,
      });
      const text = await response.text();
      const payload = text ? parseJson(text) : {};
      if (!response.ok) {
        throw new Error(`Hermes Tweet ${response.status} ${response.statusText}: ${JSON.stringify(payload)}`);
      }

      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function readHermesTweetConfigFromEnv(): HermesTweetConfig {
  return {
    apiKey: process.env.HERMES_TWEET_API_KEY?.trim() || process.env.XQUIK_API_KEY?.trim(),
    baseUrl: process.env.HERMES_TWEET_BASE_URL?.trim() || process.env.XQUIK_BASE_URL?.trim(),
    timeoutMs: parsePositiveInteger(process.env.HERMES_TWEET_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

export function readHermesTweetReadBackendFromEnv(): HermesTweetReadBackend {
  const value = process.env.X_API_MCP_READ_BACKEND?.trim().toLowerCase();
  if (value === "x" || value === "hermes" || value === "xquik") {
    return value;
  }

  return "auto";
}

export function shouldUseHermesTweetReadBackend(backend: HermesTweetReadBackend, hasXCredentials: boolean): boolean {
  if (backend === "x") {
    return false;
  }
  if (backend === "hermes" || backend === "xquik") {
    return true;
  }

  return !hasXCredentials && Boolean(readHermesTweetConfigFromEnv().apiKey);
}

export function hermesTweetHeaders(apiKey: string): Record<string, string> {
  if (apiKey.startsWith("xq_")) {
    return { Accept: "application/json", "x-api-key": apiKey };
  }

  return { Accept: "application/json", Authorization: `Bearer ${apiKey}` };
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function normalizeSinglePostPayload(payload: unknown): JsonObject {
  return { data: normalizePostRecord(findFirstObject(payload, ["tweet", "post", "data"]) ?? {}, 0), raw: payload };
}

function normalizePostListPayload(payload: unknown, maxResults?: number): JsonObject {
  const records = extractRecords(payload, ["tweets", "posts", "data", "results", "items"]);
  const data = records.map(normalizePostRecord);
  const limited = maxResults ? data.slice(0, maxResults) : data;
  const cursor = extractCursor(payload);
  return {
    data: limited,
    meta: {
      result_count: limited.length,
      ...(cursor ? { next_token: cursor } : {}),
    },
    raw: payload,
  };
}

function normalizeUserPayload(payload: unknown): JsonObject {
  const record = findFirstObject(payload, ["user", "profile", "data"]) ?? {};
  const username = firstString(record.username, record.handle, record.screen_name);
  return {
    data: {
      id: firstString(record.id, record.user_id, record.userId, record.rest_id) ?? username,
      name: firstString(record.name, record.display_name, username),
      username,
      verified: Boolean(record.verified ?? record.is_blue_verified),
    },
    raw: payload,
  };
}

function normalizePostRecord(record: JsonObject, index: number): JsonObject {
  const author = asObject(record.author) ?? asObject(record.user) ?? {};
  const metrics = asObject(record.public_metrics) ?? asObject(record.metrics) ?? {};
  const id = firstString(record.id, record.tweet_id, record.tweetId, record.rest_id) ?? `hermes-${index + 1}`;
  return {
    id,
    text: firstString(record.text, record.full_text, record.fullText) ?? "",
    author_id: firstString(record.author_id, record.authorId, author.id, author.rest_id),
    created_at: firstString(record.created_at, record.createdAt, record.created),
    public_metrics: normalizeMetrics(metrics, record),
  };
}

function normalizeMetrics(metrics: JsonObject, record: JsonObject): JsonObject {
  return {
    retweet_count: numberFromUnknown(metrics.retweet_count ?? metrics.retweets ?? record.retweet_count),
    reply_count: numberFromUnknown(metrics.reply_count ?? metrics.replies ?? record.reply_count),
    like_count: numberFromUnknown(metrics.like_count ?? metrics.likes ?? record.favorite_count),
    quote_count: numberFromUnknown(metrics.quote_count ?? metrics.quotes ?? record.quote_count),
    bookmark_count: numberFromUnknown(metrics.bookmark_count ?? metrics.bookmarks ?? record.bookmark_count),
    impression_count: numberFromUnknown(metrics.impression_count ?? metrics.views ?? record.views),
  };
}

function filterPostPayload(payload: JsonObject, query?: string): JsonObject {
  const normalizedQuery = query?.trim().toLowerCase();
  if (!normalizedQuery) {
    return payload;
  }

  const data = Array.isArray(payload.data) ? payload.data : [];
  const filtered = data.filter((item) => {
    if (!asObject(item) || typeof item.text !== "string") {
      return false;
    }

    return item.text.toLowerCase().includes(normalizedQuery);
  });

  return {
    ...payload,
    data: filtered,
    meta: {
      ...(asObject(payload.meta) ?? {}),
      local_query: query,
      unfiltered_result_count: data.length,
      filtered_result_count: filtered.length,
    },
  };
}

function extractRecords(payload: unknown, keys: string[]): JsonObject[] {
  if (Array.isArray(payload)) {
    return payload.filter(isJsonObject);
  }
  if (!isJsonObject(payload)) {
    return [];
  }
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value.filter(isJsonObject);
    }
  }
  for (const key of ["data", "result"]) {
    const records = extractRecords(payload[key], keys);
    if (records.length > 0) {
      return records;
    }
  }

  return [];
}

function findFirstObject(payload: unknown, keys: string[]): JsonObject | undefined {
  if (!isJsonObject(payload)) {
    return undefined;
  }
  for (const key of keys) {
    const value = payload[key];
    if (isJsonObject(value)) {
      return value;
    }
  }
  for (const key of ["data", "result"]) {
    const found = findFirstObject(payload[key], keys);
    if (found) {
      return found;
    }
  }

  return payload;
}

function extractCursor(payload: unknown): string | undefined {
  if (!isJsonObject(payload)) {
    return undefined;
  }

  return firstString(
    payload.nextCursor,
    payload.next_cursor,
    payload.cursor,
    asObject(payload.meta)?.next_token,
    asObject(payload.data)?.nextCursor,
    asObject(payload.result)?.nextCursor,
  );
}

function renameQueryParam(
  query: Record<string, QueryValue> | undefined,
  source: string,
  target: string,
): Record<string, string> {
  const value = stringFromQuery(query?.[source]);
  return value ? { [target]: value } : {};
}

function numberFromQuery(value: QueryValue): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    return numberFromUnknown(value);
  }

  return undefined;
}

function stringFromQuery(value: QueryValue): string | undefined {
  if (value === null || value === undefined || Array.isArray(value)) {
    return undefined;
  }

  const stringValue = String(value).trim();
  return stringValue || undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }
    const stringValue = String(value).trim();
    if (stringValue) {
      return stringValue;
    }
  }

  return undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.replaceAll(",", ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function stripHandle(value: string): string {
  return value
    .trim()
    .replace(/^@/, "")
    .replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//, "");
}

function asObject(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}
