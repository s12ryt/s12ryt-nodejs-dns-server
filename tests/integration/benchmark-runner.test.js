"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { runTransportBenchmark } = require("../../src/benchmark/runner");

test("benchmark runner drives real UDP DNS and HTTP proxy transports together", async () => {
  const report = await runTransportBenchmark({
    records: 25,
    proxySites: 5,
    durationMs: 40,
    intervalMs: 20,
    dnsOperationsPerInterval: 5,
    proxyOperationsPerInterval: 3,
    dnsConcurrency: 3,
    proxyConcurrency: 2,
  });
  assert.deepEqual(report.dataset, { records: 25, proxySites: 5 });
  assert.equal(report.dns.requests >= 5, true);
  assert.equal(report.proxy.requests >= 3, true);
  assert.equal(report.dns.errors, 0);
  assert.equal(report.proxy.errors, 0);
  assert.equal(report.dns.qps > 0, true);
  assert.equal(report.proxy.rps > 0, true);
  assert.equal(report.soak.durationMs >= 40, true);
  assert.equal(Number.isSafeInteger(report.soak.durationMs), true);
  assert.equal(report.soak.coreInterruptions, 0);
  assert.equal(Number.isFinite(Date.parse(report.startedAt)), true);
  assert.equal(Number.isFinite(Date.parse(report.finishedAt)), true);
});
