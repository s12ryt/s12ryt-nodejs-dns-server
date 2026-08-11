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

test("ProxyRoutes uses smooth weighted round robin and an explicit fallback pool", () => {
  const routes = new ProxyRoutes([{
    host: "weighted.test",
    locations: [{
      path: "/",
      upstreams: [
        { id: "primary", target: "http://127.0.0.1:3101", weight: 5 },
        { id: "secondary", target: "http://127.0.0.1:3102", weight: 1 },
      ],
      fallbackUpstreams: [{ id: "fallback", target: "http://127.0.0.1:3199" }],
    }],
  }]);

  assert.deepEqual(
    Array.from({ length: 6 }, () => routes.resolve("weighted.test").url.port),
    ["3101", "3101", "3101", "3102", "3101", "3101"],
  );
  const first = routes.resolve("weighted.test");
  routes.setDraining(first, true);
  const second = routes.resolve("weighted.test");
  routes.setDraining(second, true);
  assert.equal(routes.resolve("weighted.test").unavailable, true);
  assert.equal(routes.resolveFallback("weighted.test").url.port, "3199");
});

test("ProxyRoutes circuit breaker opens after five failures and admits one half-open request", () => {
  let now = 1_000;
  const routes = new ProxyRoutes([{
    host: "breaker.test",
    locations: [{ path: "/", upstreams: [{ id: "only", target: "http://127.0.0.1:3201" }] }],
  }], { poolOptions: { now: () => now, openMs: 30_000, failureThreshold: 5 } });

  for (let failure = 0; failure < 5; failure += 1) {
    const resolution = routes.resolve("breaker.test");
    assert.equal(resolution.url.port, "3201");
    const transition = routes.markFailure(resolution);
    if (failure < 4) assert.equal(transition, null);
    else assert.deepEqual(transition, {
      site: "breaker.test",
      location: "prefix:/",
      upstream: "only",
      fallback: false,
      previousState: "healthy",
      state: "open",
    });
  }
  assert.equal(routes.resolve("breaker.test").unavailable, true);
  assert.equal(routes.health().sites[0].locations[0].upstreams[0].state, "open");

  now += 30_000;
  const probe = routes.resolve("breaker.test");
  assert.equal(probe.url.port, "3201");
  assert.equal(routes.resolve("breaker.test").unavailable, true);
  assert.equal(routes.health().sites[0].locations[0].upstreams[0].state, "half-open");
  assert.deepEqual(routes.markSuccess(probe), {
    site: "breaker.test",
    location: "prefix:/",
    upstream: "only",
    fallback: false,
    previousState: "half-open",
    state: "healthy",
  });
  assert.equal(routes.health().sites[0].locations[0].upstreams[0].state, "healthy");
  assert.equal(routes.resolve("breaker.test").url.port, "3201");
});

test("ProxyRoutes removes and restores upstreams after active health thresholds", () => {
  const routes = new ProxyRoutes([{
    host: "active-health.test",
    locations: [{ path: "/", upstreams: [{ id: "api", target: "http://127.0.0.1:3301" }] }],
  }]);
  const target = routes.healthTargets()[0];
  assert.deepEqual(target.health, {
    enabled: true,
    path: "/healthz",
    intervalMs: 10_000,
    timeoutMs: 2_000,
    statusMin: 200,
    statusMax: 399,
    failureThreshold: 2,
    recoveryThreshold: 2,
  });

  routes.recordActiveProbe(target, { healthy: false, latencyMs: 12, statusCode: 503, checkedAt: "2026-08-12T02:00:00.000Z" });
  assert.equal(routes.resolve("active-health.test").url.port, "3301");
  routes.recordActiveProbe(target, { healthy: false, latencyMs: 9, statusCode: 503, checkedAt: "2026-08-12T02:00:10.000Z" });
  assert.equal(routes.resolve("active-health.test").unavailable, true);
  routes.recordActiveProbe(target, { healthy: true, latencyMs: 4, statusCode: 204, checkedAt: "2026-08-12T02:00:20.000Z" });
  assert.equal(routes.resolve("active-health.test").unavailable, true);
  routes.recordActiveProbe(target, { healthy: true, latencyMs: 3, statusCode: 204, checkedAt: "2026-08-12T02:00:30.000Z" });
  assert.equal(routes.resolve("active-health.test").url.port, "3301");
  const status = routes.health().sites[0].locations[0].upstreams[0];
  assert.equal(status.activeState, "healthy");
  assert.equal(status.latencyMs, 3);
  assert.equal(status.statusCode, 204);
});

test("ProxyRoutes persists maintenance policy and exposes fallback safety settings", () => {
  const routes = new ProxyRoutes([{
    host: "maintenance.test",
    maintenance: { enabled: true, retryAfterSeconds: 120 },
    locations: [{
      path: "/",
      upstreams: [{ target: "http://127.0.0.1:3401" }],
      fallbackUpstreams: [{ target: "http://127.0.0.1:3402" }],
      allowUnsafeFallback: true,
    }],
  }]);
  const resolution = routes.resolve("maintenance.test");
  assert.equal(resolution.maintenance, true);
  assert.equal(resolution.retryAfterSeconds, 120);
  assert.equal(routes.toJSON()[0].maintenance.enabled, true);
  assert.equal(routes.toJSON()[0].locations[0].allowUnsafeFallback, true);
});

test("ProxyRoutes normalizes bounded non-blocking shadow traffic policies", () => {
  const routes = new ProxyRoutes([{
    host: "shadow.test",
    locations: [{
      path: "/",
      upstreams: [{ target: "http://127.0.0.1:3201" }],
      shadow: {
        target: "https://shadow.internal.test/base",
        sampleRate: 0.25,
        timeoutMs: 750,
        allowUnsafeMethods: true,
        maxBodyBytes: 524288,
      },
    }],
  }]);
  assert.deepEqual(routes.toJSON()[0].locations[0].shadow, {
    target: "https://shadow.internal.test/base",
    sampleRate: 0.25,
    timeoutMs: 750,
    allowUnsafeMethods: true,
    maxBodyBytes: 524288,
  });
  assert.throws(() => new ProxyRoutes([{
    host: "bad-shadow.test",
    locations: [{ path: "/", upstreams: [{ target: "http://127.0.0.1:3201" }], shadow: { target: "ftp://bad.test", sampleRate: 2 } }],
  }]), /shadow/i);
});

test("ProxyRoutes normalizes per-site WebSocket limits", () => {
  const routes = new ProxyRoutes([{
    host: "socket.test",
    websocket: { maxConnections: 12, idleTimeoutMs: 45_000, drainTimeoutMs: 15_000 },
    target: "http://127.0.0.1:3201",
  }]);
  assert.deepEqual(routes.toJSON()[0].websocket, {
    maxConnections: 12,
    idleTimeoutMs: 45_000,
    drainTimeoutMs: 15_000,
  });
  assert.throws(() => new ProxyRoutes([{
    host: "bad-socket.test",
    websocket: { maxConnections: 0 },
    target: "http://127.0.0.1:3201",
  }]), /websocket/i);
});

test("ProxyRoutes normalizes HTTPS upstream protocol preferences", () => {
  const routes = new ProxyRoutes([{
    host: "h2.example.test",
    locations: [{
      path: "/",
      action: "proxy",
      upstreams: [
        { id: "auto", target: "https://upstream.example.test", protocol: "auto" },
        { id: "h2", target: "https://internal-h2.example.test", protocol: "http2" },
        { id: "h1", target: "https://internal-h1.example.test", protocol: "http1" },
      ],
    }],
  }]);

  assert.deepEqual(
    routes.toJSON()[0].locations[0].upstreams.map(({ protocol }) => protocol),
    ["auto", "http2", "http1"],
  );
  assert.throws(() => new ProxyRoutes([{
    host: "invalid-h2.example.test",
    locations: [{
      path: "/",
      action: "proxy",
      upstreams: [{ target: "http://127.0.0.1:8080", protocol: "http2" }],
    }],
  }]), /protocol/i);
  assert.throws(() => new ProxyRoutes([{
    host: "invalid-protocol.example.test",
    locations: [{
      path: "/",
      action: "proxy",
      upstreams: [{ target: "https://127.0.0.1:8443", protocol: "http3" }],
    }],
  }]), /protocol/i);
});

test("ProxyRoutes applies transient site and upstream draining without persisting it", () => {
  const routes = new ProxyRoutes([{
    host: "drain.example.test",
    locations: [{
      path: "/api",
      action: "proxy",
      upstreams: [
        { id: "one", target: "http://127.0.0.1:3201" },
        { id: "two", target: "http://127.0.0.1:3202" },
      ],
    }],
  }]);

  assert.equal(routes.setSiteDraining("drain.example.test", true), true);
  assert.equal(routes.resolve("drain.example.test", "/api").draining, true);
  assert.equal(routes.drainStatus().sites[0].draining, true);
  assert.equal(routes.toJSON()[0].draining, undefined);
  routes.setSiteDraining("drain.example.test", false);

  assert.equal(routes.setUpstreamDraining({
    host: "drain.example.test",
    location: "prefix:/api",
    id: "one",
    fallback: false,
  }, true), true);
  assert.equal(routes.resolve("drain.example.test", "/api")._upstream.id, "two");
  assert.equal(routes.drainStatus().sites[0].locations[0].upstreams.find(({ id }) => id === "one").draining, true);
  assert.equal(routes.setUpstreamDraining({ host: "missing.test", location: "prefix:/", id: "one" }, true), false);
});
