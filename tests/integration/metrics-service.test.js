"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { MetricsRegistry } = require("../../src/observability/metrics");
const { createMetricsService } = require("../../src/services/metrics-server");

test("metrics service exposes Prometheus data on an independent listener", async (t) => {
  const registry = new MetricsRegistry();
  registry.observe({ kind: "dns", source: "custom", type: "A", durationMs: 3 });
  const service = createMetricsService({ registry, host: "127.0.0.1", port: 0 });
  t.after(() => service.close());
  await service.start();
  const address = service.address();

  const metrics = await fetch(`http://127.0.0.1:${address.port}/metrics`);
  assert.equal(metrics.status, 200);
  assert.match(metrics.headers.get("content-type"), /text\/plain/);
  assert.match(await metrics.text(), /s12_dns_queries_total/);

  const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/private`)).status, 404);
});

test("metrics service lifecycle is idempotent only after close", async () => {
  const service = createMetricsService({ registry: new MetricsRegistry(), host: "127.0.0.1", port: 0 });
  await service.start();
  await assert.rejects(service.start(), /already started/i);
  await service.close();
  await service.close();
});
