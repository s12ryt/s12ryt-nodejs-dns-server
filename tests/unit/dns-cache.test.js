"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { DnsCache } = require("../../src/dns/cache");

test("DnsCache expires by TTL and evicts the least recently used entry", () => {
  let now = 1_000;
  const cache = new DnsCache({ maxEntries: 2, now: () => now });
  cache.set("a", Buffer.from("a"), 2);
  cache.set("b", Buffer.from("b"), 10);
  assert.equal(cache.get("a").toString(), "a");

  cache.set("c", Buffer.from("c"), 10);
  assert.equal(cache.get("b"), null);
  assert.equal(cache.get("a").toString(), "a");

  now = 3_001;
  assert.equal(cache.get("a"), null);
  assert.equal(cache.size, 1);
});

test("DnsCache never stores zero-TTL or unsuccessful responses", () => {
  const cache = new DnsCache({ maxEntries: 2 });

  cache.set("empty", Buffer.from("x"), 0);
  cache.set("error", Buffer.from("x"), 30, { successful: false });

  assert.equal(cache.size, 0);
});

test("DnsCache clamps successful response lifetimes to configured TTL bounds", () => {
  let now = 1_000;
  const cache = new DnsCache({ maxEntries: 2, minTtl: 5, maxTtl: 10, now: () => now });

  cache.set("short", Buffer.from("short"), 1);
  now = 5_999;
  assert.equal(cache.get("short").toString(), "short");
  now = 6_001;
  assert.equal(cache.get("short"), null);

  cache.set("long", Buffer.from("long"), 60);
  now = 16_000;
  assert.equal(cache.get("long").toString(), "long");
  now = 16_002;
  assert.equal(cache.get("long"), null);
});
