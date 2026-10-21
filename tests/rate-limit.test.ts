import assert from "node:assert/strict";
import test from "node:test";
import { rateLimitWaitMs, waitForRateLimit } from "../src/model/rate-limit";

function response(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 429, headers });
}

test("Retry-After header has priority over Groq error body hint", () => {
  assert.equal(
    rateLimitWaitMs(response({ "Retry-After": "2" }), "Please try again in 1.53s.", 0),
    2100,
  );
});

test("Groq fractional retry seconds are parsed without a header", () => {
  assert.equal(rateLimitWaitMs(response(), "Please try again in 1.529999999s.", 0), 1630);
});

test("rate limit fallback is bounded exponential backoff", () => {
  assert.equal(rateLimitWaitMs(response(), "generic rate limit", 0), 1100);
  assert.equal(rateLimitWaitMs(response(), "generic rate limit", 1), 2100);
  assert.equal(rateLimitWaitMs(response(), "generic rate limit", 9), 30000);
});

test("Retry-After zero is an immediate permitted retry", () => {
  assert.equal(rateLimitWaitMs(response({ "Retry-After": "0" }), "whatever", 0), 0);
});

test("429 wait responds to AbortSignal during timer, not only before waiting", async () => {
  const controller = new AbortController();
  const promise = waitForRateLimit(10_000, controller.signal);
  setTimeout(() => controller.abort(new Error("manual cancel")), 5);
  await assert.rejects(promise, /manual cancel/);
});
