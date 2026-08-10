"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { RecordStore } = require("../../src/dns/records");
const { ProxyRoutes, migrateRoute } = require("../../src/services/proxy-routes");

test("ProxyRoutes matches normalized hosts and ignores disabled routes", () => {
  const routes = new ProxyRoutes([
    { host: "App.Example.test", target: "http://127.0.0.1:9000", enabled: true },
    { host: "off.example.test", target: "http://127.0.0.1:9001", enabled: false },
  ]);
  assert.equal(routes.resolve("app.example.test:8080").url.origin, "http://127.0.0.1:9000");
  assert.equal(routes.resolve("off.example.test"), null);
  assert.equal(routes.resolve("missing.example.test"), null);
});

test("ProxyRoutes derives an IP target only for an explicit route", () => {
  const records = new RecordStore([
    { name: "service.internal", type: "A", value: "192.0.2.55", ttl: 60 },
  ]);
  const routes = new ProxyRoutes([
    { host: "public.example.test", dnsName: "service.internal", scheme: "http", port: 3000 },
  ], { records });

  const route = routes.resolve("public.example.test");
  assert.equal(route.url.href, "http://192.0.2.55:3000/");
  assert.equal(route.upstreamHost, "service.internal");
  assert.equal(routes.resolve("service.internal"), null);
});

test("ProxyRoutes rejects unsupported targets and self-referential routes", () => {
  assert.throws(() => new ProxyRoutes([{ host: "a.test", target: "file:///tmp/a" }]), /HTTP or HTTPS/);
  assert.throws(() => new ProxyRoutes([{ host: "a.test", target: "http://a.test" }]), /loop/i);
});

test("legacy proxy routes migrate to a root prefix location", () => {
  const migrated = migrateRoute({
    host: "legacy.example.test",
    target: "http://127.0.0.1:3000/base",
    timeoutMs: 4000,
    enabled: false,
  });

  assert.equal(migrated.host, "legacy.example.test");
  assert.equal(migrated.enabled, false);
  assert.equal(migrated.locations[0].path, "/");
  assert.equal(migrated.locations[0].match, "prefix");
  assert.equal(migrated.locations[0].action, "proxy");
  assert.equal(migrated.locations[0].upstreams[0].target, "http://127.0.0.1:3000/base");
  assert.equal(migrated.locations[0].timeoutMs, 4000);
});

test("ProxyRoutes matches aliases, locations and healthy upstreams deterministically", () => {
  const routes = new ProxyRoutes([{
    host: "app.example.test",
    aliases: ["alias.example.test", "*.apps.example.test"],
    locations: [
      { path: "/", match: "prefix", action: "proxy", upstreams: [{ target: "http://127.0.0.1:3000" }] },
      { path: "/api", match: "prefix", action: "proxy", upstreams: [
        { target: "http://127.0.0.1:3001" },
        { target: "http://127.0.0.1:3002" },
      ] },
      { path: "/api/health", match: "exact", action: "redirect", redirect: { status: 302, location: "${scheme}://${host}/status" } },
    ],
  }]);

  const exact = routes.resolve("alias.example.test", "/api/health");
  assert.equal(exact.location.action, "redirect");
  assert.equal(exact.redirect.status, 302);

  const first = routes.resolve("blue.apps.example.test", "/api/users");
  const second = routes.resolve("blue.apps.example.test", "/api/users");
  assert.equal(first.location.path, "/api");
  assert.equal(first.url.port, "3001");
  assert.equal(second.url.port, "3002");
  routes.markFailure(second);
  assert.equal(routes.resolve("blue.apps.example.test", "/api/users").url.port, "3001");
  assert.equal(routes.resolve("apps.example.test", "/"), null);
});

test("ProxyRoutes rejects conflicting hosts and unsafe rule expressions", () => {
  assert.throws(() => new ProxyRoutes([
    { host: "one.test", aliases: ["shared.test"], target: "http://127.0.0.1:3000" },
    { host: "shared.test", target: "http://127.0.0.1:3001" },
  ]), /duplicate|conflict/i);
  assert.throws(() => new ProxyRoutes([{
    host: "headers.test",
    locations: [{
      path: "/",
      action: "proxy",
      upstreams: [{ target: "http://127.0.0.1:3000" }],
      requestHeaders: { set: { "x-danger": "${process.env.SECRET}" } },
    }],
  }]), /variable/i);
  assert.throws(() => new ProxyRoutes([{
    host: "redirect.test",
    locations: [{ path: "/", action: "redirect", redirect: { status: 305, location: "https://example.test" } }],
  }]), /redirect/i);
});

test("ProxyRoutes normalizes bounded security, cache and compression policies", () => {
  const routes = new ProxyRoutes([{
    host: "policy.test",
    locations: [{
      path: "/",
      action: "proxy",
      upstreams: [{ target: "http://127.0.0.1:3000" }],
      bodyLimitBytes: 4096,
      access: { allow: ["192.0.2.0/24"], deny: ["192.0.2.9/32"] },
      rateLimit: { enabled: true, requests: 5, windowMs: 1000 },
      cache: { enabled: true, ttlSeconds: 30, maxBytes: 8192 },
      compression: { enabled: true, minBytes: 1024 },
    }],
  }]);
  const location = routes.resolve("policy.test", "/").location;
  assert.equal(location.bodyLimitBytes, 4096);
  assert.deepEqual(location.access, { allow: ["192.0.2.0/24"], deny: ["192.0.2.9/32"] });
  assert.deepEqual(location.rateLimit, { enabled: true, requests: 5, windowMs: 1000 });
  assert.deepEqual(location.cache, { enabled: true, ttlSeconds: 30, maxBytes: 8192 });
  assert.deepEqual(location.compression, { enabled: true, minBytes: 1024 });

  const defaults = new ProxyRoutes([{ host: "defaults.test", target: "http://127.0.0.1:3000" }]).resolve("defaults.test").location;
  assert.equal(defaults.bodyLimitBytes, 10 * 1024 * 1024);
  assert.equal(defaults.rateLimit.enabled, false);
  assert.equal(defaults.cache.enabled, false);
  assert.equal(defaults.compression.enabled, true);
  assert.throws(() => new ProxyRoutes([{
    host: "invalid.test",
    locations: [{ path: "/", upstreams: [{ target: "http://127.0.0.1:3000" }], access: { allow: ["not-a-cidr"] } }],
  }]), /CIDR|access/i);
});
