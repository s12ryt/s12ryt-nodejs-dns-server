"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ProxyCache } = require("../../src/services/proxy-cache");

function request(overrides = {}) {
  return {
    method: "GET",
    host: "cache.example.test",
    url: "/asset",
    headers: {},
    ...overrides,
  };
}

function response(body, headers = {}) {
  return {
    status: 200,
    headers: { "cache-control": "public, max-age=60", ...headers },
    body: Buffer.from(body),
  };
}

test("proxy cache persists variants and reloads verified entries", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-proxy-cache-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = 1000;
  const policy = { enabled: true, ttlSeconds: 120, maxBytes: 1024 };
  const first = new ProxyCache({ directory, maxBytes: 4096, now: () => now });
  await first.start();
  assert.equal(await first.put({
    site: "cache.example.test",
    location: "/",
    request: request({ headers: { "accept-language": "zh-TW" } }),
    response: response("zh", { vary: "accept-language" }),
    policy,
  }), true);
  assert.equal((await first.get({
    site: "cache.example.test",
    location: "/",
    request: request({ headers: { "accept-language": "zh-TW" } }),
  })).body.toString(), "zh");
  assert.equal(await first.get({
    site: "cache.example.test",
    location: "/",
    request: request({ headers: { "accept-language": "en" } }),
  }), null);
  await first.close();

  const reloaded = new ProxyCache({ directory, maxBytes: 4096, now: () => now });
  await reloaded.start();
  assert.equal((await reloaded.get({
    site: "cache.example.test",
    location: "/",
    request: request({ headers: { "accept-language": "zh-TW" } }),
  })).body.toString(), "zh");
  now = 61001;
  assert.equal(await reloaded.get({
    site: "cache.example.test",
    location: "/",
    request: request({ headers: { "accept-language": "zh-TW" } }),
  }), null);
  await reloaded.close();
});

test("proxy cache skips private traffic and evicts least recently used entries within bounds", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-proxy-cache-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = 1000;
  const cache = new ProxyCache({ directory, maxBytes: 8, now: () => now });
  await cache.start();
  const policy = { enabled: true, ttlSeconds: 60, maxBytes: 6 };
  assert.equal(await cache.put({ site: "site", location: "/", request: request({ url: "/a" }), response: response("aaaa"), policy }), true);
  now += 1;
  assert.equal(await cache.put({ site: "site", location: "/", request: request({ url: "/b" }), response: response("bbbb"), policy }), true);
  assert.equal(await cache.get({ site: "site", location: "/", request: request({ url: "/a" }) }), null);
  assert.equal((await cache.get({ site: "site", location: "/", request: request({ url: "/b" }) })).body.toString(), "bbbb");
  assert.equal(cache.status().bytes <= 8, true);

  assert.equal(await cache.put({ site: "site", location: "/", request: request({ headers: { authorization: "Bearer secret" } }), response: response("auth"), policy }), false);
  assert.equal(await cache.put({ site: "site", location: "/", request: request(), response: response("cookie", { "set-cookie": ["sid=secret"] }), policy }), false);
  assert.equal(await cache.put({ site: "site", location: "/", request: request(), response: response("private", { "cache-control": "private, max-age=60" }), policy }), false);
  assert.equal(await cache.put({ site: "site", location: "/", request: request(), response: response("vary", { vary: "*" }), policy }), false);

  assert.equal((await cache.clear({ site: "site" })).entries, 0);
  await cache.close();
});
