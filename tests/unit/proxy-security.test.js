"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MemoryRateLimiter,
  isClientAllowed,
  isIpInCidrs,
  resolveClientIp,
} = require("../../src/services/proxy-security");

test("trusted proxy CIDRs control whether forwarded client addresses are accepted", () => {
  const trusted = ["127.0.0.1/32", "::1/128", "10.0.0.0/8"];
  assert.equal(resolveClientIp("203.0.113.7", "198.51.100.9", trusted), "203.0.113.7");
  assert.equal(resolveClientIp("127.0.0.1", "198.51.100.9, 10.0.0.2", trusted), "198.51.100.9");
  assert.equal(resolveClientIp("::ffff:127.0.0.1", "198.51.100.10", trusted), "198.51.100.10");
  assert.equal(isIpInCidrs("10.12.3.4", ["10.0.0.0/8"]), true);
  assert.equal(isIpInCidrs("2001:db8::5", ["2001:db8::/32"]), true);
  assert.equal(isIpInCidrs("2001:db9::5", ["2001:db8::/32"]), false);
});

test("access rules apply deny before allow and rate limits reset deterministically", () => {
  assert.equal(isClientAllowed("192.0.2.4", { allow: ["192.0.2.0/24"], deny: [] }), true);
  assert.equal(isClientAllowed("198.51.100.4", { allow: ["192.0.2.0/24"], deny: [] }), false);
  assert.equal(isClientAllowed("192.0.2.4", { allow: ["192.0.2.0/24"], deny: ["192.0.2.4/32"] }), false);

  let now = 1000;
  const limiter = new MemoryRateLimiter({ now: () => now });
  assert.deepEqual(limiter.consume("site:client", { requests: 2, windowMs: 1000 }), { allowed: true, retryAfterMs: 0 });
  assert.equal(limiter.consume("site:client", { requests: 2, windowMs: 1000 }).allowed, true);
  assert.deepEqual(limiter.consume("site:client", { requests: 2, windowMs: 1000 }), { allowed: false, retryAfterMs: 1000 });
  now = 2001;
  assert.equal(limiter.consume("site:client", { requests: 2, windowMs: 1000 }).allowed, true);
});
