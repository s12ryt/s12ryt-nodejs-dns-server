"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { percentile, runOperationBatch, runSoakLoad } = require("../../src/benchmark/load");

test("operation batch bounds concurrency and reports errors latency and throughput", async () => {
  let active = 0;
  let peak = 0;
  const result = await runOperationBatch({
    count: 20,
    concurrency: 4,
    operation: async (index) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (index === 7) throw new Error("expected failure");
    },
  });
  assert.equal(peak <= 4, true);
  assert.equal(result.requests, 20);
  assert.equal(result.errors, 1);
  assert.equal(result.durationMs > 0, true);
  assert.equal(result.throughput > 0, true);
  assert.equal(result.p95Ms >= 0, true);
  assert.equal(result.latencies.length, 20);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.95), 5);
});

test("soak load runs DNS and proxy together and records health interruptions", async () => {
  let ticks = 0;
  let maintenance = 0;
  const result = await runSoakLoad({
    durationMs: 40,
    intervalMs: 20,
    dnsRate: 5,
    proxyRate: 3,
    dnsConcurrency: 2,
    proxyConcurrency: 2,
    dnsOperation: async () => {},
    proxyOperation: async () => {},
    checkCore: async () => ++ticks !== 2,
    maintenanceOperation: async () => {
      maintenance += 1;
      if (maintenance === 2) throw new Error("simulated maintenance failure");
    },
  });
  assert.equal(result.dns.requests >= 5, true);
  assert.equal(result.proxy.requests >= 3, true);
  assert.equal(result.soak.durationMs >= 40, true);
  assert.equal(result.soak.coreInterruptions, 1);
  assert.equal(result.soak.operationalRuns >= 2, true);
  assert.equal(result.soak.operationalFailures, 1);
  assert.equal(result.dns.p95Ms >= 0, true);
  assert.equal(result.proxy.p95Ms >= 0, true);
});
