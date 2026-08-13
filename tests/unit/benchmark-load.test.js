"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { LatencyHistogram, percentile, runOperationBatch, runSoakLoad } = require("../../src/benchmark/load");

test("latency histogram keeps bounded memory across formal soak sample volumes", () => {
  const histogram = new LatencyHistogram();
  for (let index = 0; index < 10_000_000; index += 1) {
    histogram.observe(index % 100);
  }

  assert.equal(histogram.count, 10_000_000);
  assert.equal(histogram.bucketCount, 60_002);
  assert.equal(histogram.percentile(0.95), 94);
  assert.equal(histogram.percentile(1), 99);
});

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

test("operation batch paces starts across an interval instead of creating a transport burst", async () => {
  const starts = [];
  const result = await runOperationBatch({
    count: 5,
    concurrency: 5,
    spreadMs: 100,
    operation: async () => starts.push(performance.now()),
  });

  assert.equal(Math.max(...starts) - Math.min(...starts) >= 60, true);
  assert.equal(result.requests, 5);
  assert.equal(result.errors, 0);
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

test("soak load starts every wall-clock interval while slow batches finish", async () => {
  const result = await runSoakLoad({
    durationMs: 80,
    intervalMs: 20,
    dnsRate: 1,
    proxyRate: 1,
    dnsConcurrency: 1,
    proxyConcurrency: 1,
    dnsOperation: async () => new Promise((resolve) => setTimeout(resolve, 35)),
    proxyOperation: async () => new Promise((resolve) => setTimeout(resolve, 35)),
  });

  assert.equal(result.soak.ticks, 4);
  assert.equal(result.dns.requests, 4);
  assert.equal(result.proxy.requests, 4);
});

test("soak load retries early timer wakeups until every wall-clock deadline", async () => {
  let now = 0;
  const tickStarts = [];
  let waitCalls = 0;
  const result = await runSoakLoad({
    durationMs: 40,
    intervalMs: 20,
    dnsRate: 1,
    proxyRate: 1,
    dnsConcurrency: 1,
    proxyConcurrency: 1,
    dnsOperation: async () => tickStarts.push(now),
    proxyOperation: async () => {},
    clock: { now: () => now },
    wait: async (milliseconds) => {
      waitCalls += 1;
      now += Math.max(1, milliseconds - 2);
    },
  });

  assert.equal(result.soak.ticks, 2);
  assert.deepEqual(tickStarts, [0, 20]);
  assert.equal(result.soak.durationMs, 40);
  assert.equal(waitCalls > 2, true);
});
