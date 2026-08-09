"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { RecordStore } = require("../../src/dns/records");
const { ProxyRoutes } = require("../../src/services/proxy-routes");

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
