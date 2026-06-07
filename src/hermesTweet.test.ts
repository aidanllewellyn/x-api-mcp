import assert from "node:assert/strict";
import test from "node:test";

import { HermesTweetClient, hermesTweetHeaders, shouldUseHermesTweetReadBackend } from "./hermesTweet.js";

type FetchCall = {
  url: string;
  headers?: HeadersInit;
};

function createJsonFetch(payload: unknown, calls: FetchCall[] = []): typeof fetch {
  return async (input, init) => {
    calls.push({ url: String(input), headers: init?.headers });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

test("hermesTweetHeaders sends xq keys with x-api-key", () => {
  assert.deepEqual(hermesTweetHeaders("xq_test"), {
    Accept: "application/json",
    "x-api-key": "xq_test",
  });
  assert.deepEqual(hermesTweetHeaders("plain-token"), {
    Accept: "application/json",
    Authorization: "Bearer plain-token",
  });
});

test("shouldUseHermesTweetReadBackend respects explicit backend choices", () => {
  assert.equal(shouldUseHermesTweetReadBackend("x", false), false);
  assert.equal(shouldUseHermesTweetReadBackend("hermes", true), true);
  assert.equal(shouldUseHermesTweetReadBackend("xquik", true), true);
});

test("HermesTweetClient fetches and normalizes a single post", async () => {
  const calls: FetchCall[] = [];
  const client = new HermesTweetClient({
    apiKey: "xq_test",
    baseUrl: "https://example.test/",
    fetchImpl: createJsonFetch(
      {
        tweet: {
          id: "123",
          full_text: "Hello from Hermes Tweet",
          author: { id: "42" },
          metrics: { likes: "5", retweets: 2 },
        },
      },
      calls,
    ),
  });

  const result = await client.getPost({ id: "123" });

  assert.equal(calls[0]?.url, "https://example.test/api/v1/x/tweets/123");
  assert.deepEqual(result.data, {
    id: "123",
    text: "Hello from Hermes Tweet",
    author_id: "42",
    created_at: undefined,
    public_metrics: {
      retweet_count: 2,
      reply_count: undefined,
      like_count: 5,
      quote_count: undefined,
      bookmark_count: undefined,
      impression_count: undefined,
    },
  });
});

test("HermesTweetClient maps username query searches to the tweet search endpoint", async () => {
  const calls: FetchCall[] = [];
  const client = new HermesTweetClient({
    apiKey: "xq_test",
    baseUrl: "https://example.test",
    fetchImpl: createJsonFetch(
      {
        tweets: [
          { id: "1", text: "agents on x", author: { id: "7" }, metrics: { like_count: 3 } },
          { id: "2", text: "other post", author: { id: "7" } },
        ],
        nextCursor: "next-page",
      },
      calls,
    ),
  });

  const result = await client.searchUserPosts({ username: "openai", query: "agents", maxResults: 1 });
  const url = new URL(calls[0]?.url ?? "");

  assert.equal(url.pathname, "/api/v1/x/tweets/search");
  assert.equal(url.searchParams.get("q"), "from:openai agents");
  assert.equal(url.searchParams.get("limit"), "1");
  assert.deepEqual(result.meta, { result_count: 1, next_token: "next-page" });
});

test("HermesTweetClient maps generic low-cost search reads", async () => {
  const calls: FetchCall[] = [];
  const client = new HermesTweetClient({
    apiKey: "xq_test",
    baseUrl: "https://example.test",
    fetchImpl: createJsonFetch({ data: [{ id: "1", text: "mcp" }] }, calls),
  });

  const result = await client.lowCostRequest({
    endpoint: "/tweets/search/recent",
    query: { query: "mcp", max_results: 5 },
  });
  const url = new URL(calls[0]?.url ?? "");

  assert.equal(url.pathname, "/api/v1/x/tweets/search");
  assert.equal(url.searchParams.get("q"), "mcp");
  assert.equal(url.searchParams.get("limit"), "5");
  assert.deepEqual(result.meta, { result_count: 1 });
});
