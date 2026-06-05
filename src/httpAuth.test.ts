import assert from "node:assert/strict";
import test from "node:test";

import { extractBearerToken, isBearerAuthorized } from "./httpAuth.js";

test("extractBearerToken accepts normal bearer headers", () => {
  assert.equal(extractBearerToken("Bearer test-token"), "test-token");
  assert.equal(extractBearerToken(" bearer   test-token "), "test-token");
});

test("extractBearerToken rejects missing or malformed auth", () => {
  assert.equal(extractBearerToken(undefined), undefined);
  assert.equal(extractBearerToken("Basic test-token"), undefined);
});

test("isBearerAuthorized compares bearer tokens exactly", () => {
  assert.equal(isBearerAuthorized("Bearer expected", "expected"), true);
  assert.equal(isBearerAuthorized("Bearer expected ", "expected"), true);
  assert.equal(isBearerAuthorized("Bearer expected-extra", "expected"), false);
  assert.equal(isBearerAuthorized("Bearer EXPECTED", "expected"), false);
});
