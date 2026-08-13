"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createDnsBenchmarkClientPool, runTransportBenchmark } = require("../../src/benchmark/runner");

test("DNS benchmark client pool starts, rotates, and closes every socket", async () => {
  const events = [];
  let created = 0;
  const pool = createDnsBenchmarkClientPool({
    host: "127.0.0.1",
    port: 5354,
    size: 3,
    createClient: () => {
      const id = created++;
      return {
        start: async () => events.push(`start:${id}`),
        query: async (recordCount) => events.push(`query:${id}:${recordCount}`),
        close: async () => events.push(`close:${id}`),
      };
    },
  });

  await pool.start();
  await Promise.all([pool.query(10), pool.query(10), pool.query(10), pool.query(10)]);
  await pool.close();

  assert.deepEqual(events, [
    "start:0", "start:1", "start:2",
    "query:0:10", "query:1:10", "query:2:10", "query:0:10",
    "close:0", "close:1", "close:2",
  ]);
});

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
