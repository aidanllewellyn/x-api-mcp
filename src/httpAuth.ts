import { createHash, timingSafeEqual } from "node:crypto";

export function extractBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) {
    return undefined;
  }

  const match = authorization.match(/^\s*Bearer\s+(.+?)\s*$/i);
  return match?.[1];
}

export function isBearerAuthorized(authorization: string | undefined, expectedToken: string): boolean {
  const presentedToken = extractBearerToken(authorization);
  if (!presentedToken) {
    return false;
  }

  return constantTimeEquals(presentedToken, expectedToken);
}

function constantTimeEquals(a: string, b: string): boolean {
  const aDigest = createHash("sha256").update(a).digest();
  const bDigest = createHash("sha256").update(b).digest();
  return timingSafeEqual(aDigest, bDigest) && a.length === b.length;
}
