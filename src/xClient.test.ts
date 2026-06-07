import assert from "node:assert/strict";
import test from "node:test";

import { HermesTweetClient } from "./hermesTweet.js";
import { XClient, assertLowCostEndpoint, filterPostPayload, normalizeEndpoint, serializeQuery } from "./xClient.js";

test("normalizeEndpoint accepts /2 paths and strips the API version prefix", () => {
  assert.equal(normalizeEndpoint("/2/tweets/search/recent"), "/tweets/search/recent");
  assert.equal(normalizeEndpoint("/tweets/search/recent"), "/tweets/search/recent");
});

test("normalizeEndpoint rejects query strings and path traversal", () => {
  assert.throws(() => normalizeEndpoint("tweets/search/recent"), /start with/);
  assert.throws(() => normalizeEndpoint("/2/tweets?ids=1"), /query object/);
  assert.throws(() => normalizeEndpoint("/2/users/../me"), /path traversal/);
});

test("assertLowCostEndpoint allows priced low-cost reads", () => {
  assert.doesNotThrow(() => assertLowCostEndpoint("GET", "/tweets/search/recent"));
  assert.doesNotThrow(() => assertLowCostEndpoint("GET", "/users/by/username/openai"));
});

test("assertLowCostEndpoint blocks unallowlisted endpoints and URL-bearing post creation", () => {
  assert.throws(() => assertLowCostEndpoint("GET", "/enterprise/private"), /allowlist/);
  assert.throws(
    () => assertLowCostEndpoint("POST", "/tweets", { text: "Read https://example.com" }),
    /Create with URL/,
  );
});

test("assertLowCostEndpoint allows plain Post creation and allowlisted writes", () => {
  // A Post with no URL in its text is a low-cost write, not the $0.200 URL action.
  assert.doesNotThrow(() => assertLowCostEndpoint("POST", "/tweets", { text: "no links here" }));
  assert.doesNotThrow(() => assertLowCostEndpoint("POST", "/users/123/likes"));
  assert.doesNotThrow(() => assertLowCostEndpoint("DELETE", "/users/123/likes/456"));
});

test("assertLowCostEndpoint blocks writes that are not on the write allowlist", () => {
  // A read-only path is not a valid write target.
  assert.throws(() => assertLowCostEndpoint("POST", "/tweets/search/recent"), /allowlist/);
  // www.-style bare links count as URLs for the Post-creation guard.
  assert.throws(() => assertLowCostEndpoint("POST", "/tweets", { text: "see www.example.com" }), /Create with URL/);
});

test("normalizeEndpoint rejects duplicate slashes", () => {
  assert.throws(() => normalizeEndpoint("/2//tweets"), /duplicate slashes/);
});

test("serializeQuery skips nullish values and serializes arrays as comma lists", () => {
  assert.equal(
    serializeQuery({
      "tweet.fields": ["id", "text"],
      max_results: 10,
      ignored: null,
    }),
    "?tweet.fields=id%2Ctext&max_results=10",
  );
});

test("filterPostPayload keeps original metadata and reports local filter counts", () => {
  const filtered = filterPostPayload(
    {
      data: [
        { id: "1", text: "Shipping real infrastructure" },
        { id: "2", text: "Marketing copy" },
      ],
      meta: { result_count: 2 },
    },
    "infra",
  );

  assert.deepEqual(filtered.data, [{ id: "1", text: "Shipping real infrastructure" }]);
  assert.deepEqual(filtered.meta, {
    result_count: 2,
    local_query: "infra",
    unfiltered_result_count: 2,
    filtered_result_count: 1,
  });
});

test("lowCostRequest keeps unsupported Hermes reads on the X API path", async () => {
  const client = new XClient(
    { oauth2: { kind: "oauth2", accessToken: "x-token" } },
    new HermesTweetClient({
      apiKey: "xq_test",
      fetchImpl: async () => {
        throw new Error("Hermes should not receive this endpoint.");
      },
    }),
    "hermes",
  );
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization?: string }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
    });
    return new Response(JSON.stringify({ data: { id: "me" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await client.lowCostRequest({ method: "GET", endpoint: "/2/users/me" });
    assert.deepEqual(result, { data: { id: "me" } });
    assert.deepEqual(calls, [{ url: "https://api.x.com/2/users/me", authorization: "Bearer x-token" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
