"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createQuery } = require("../../src/dns/message");
const { createDohUpstream } = require("../../src/dns/upstream-doh");
const { UpstreamError } = require("../../src/dns/resolver");

test("DoH upstream posts DNS wire data and returns the response", async () => {
  const query = createQuery("example.com", "A", { id: 41 });
  const upstream = createDohUpstream({
    name: "test",
    url: "https://resolver.test/dns-query",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://resolver.test/dns-query");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.accept, "application/dns-message");
      assert.equal(options.headers["content-type"], "application/dns-message");
      assert.deepEqual(Buffer.from(options.body), query);
      return new Response(query, { headers: { "content-type": "application/dns-message" } });
    },
  });

  assert.deepEqual(await upstream.resolve(query), query);
  assert.equal(upstream.status().healthy, true);
  assert.equal(typeof upstream.status().latencyMs, "number");
});

test("DoH upstream classifies 5xx as retryable and 4xx as terminal", async () => {
  const query = createQuery("example.com", "A", { id: 42 });
  for (const [status, retryable] of [[503, true], [400, false]]) {
    const upstream = createDohUpstream({
      url: "https://resolver.test/dns-query",
      fetchImpl: async () => new Response("failure", { status }),
    });
    await assert.rejects(upstream.resolve(query), (error) => {
      assert.ok(error instanceof UpstreamError);
      assert.equal(error.retryable, retryable);
      return true;
    });
  }
});

test("DoH upstream rejects an invalid response media type", async () => {
  const upstream = createDohUpstream({
    url: "https://resolver.test/dns-query",
    fetchImpl: async () => new Response("not dns", { headers: { "content-type": "text/plain" } }),
  });
  await assert.rejects(upstream.resolve(createQuery("example.com")), UpstreamError);
});
