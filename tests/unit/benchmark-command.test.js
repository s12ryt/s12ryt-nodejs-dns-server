"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { benchmarkOptions, executeBenchmark } = require("../../src/benchmark/command");

test("benchmark command derives fixed CI and formal release workloads", () => {
  const ci = benchmarkOptions("ci");
  assert.deepEqual({ records: ci.records, proxySites: ci.proxySites, durationMs: ci.durationMs }, {
    records: 1000,
    proxySites: 100,
    durationMs: 30000,
  });
  assert.equal(ci.dnsOperationsPerInterval, 550);
  assert.equal(ci.proxyOperationsPerInterval, 110);

  const release = benchmarkOptions("release");
  assert.equal(release.records, 100000);
  assert.equal(release.proxySites, 1000);
  assert.equal(release.durationMs, 86400000);
  assert.equal(release.dnsOperationsPerInterval, 5500);
  assert.equal(release.proxyOperationsPerInterval, 1100);
  assert.equal(release.dnsClientSockets, 8);
  assert.equal(release.dnsConcurrency, 128);
  assert.throws(() => benchmarkOptions("release", { durationMs: 1000 }), /cannot be shortened/i);
});

test("benchmark command emits normalized evaluated reports without promoting CI smoke", async () => {
  let received;
  const result = await executeBenchmark({
    profileName: "ci",
    runner: async (options) => {
      received = options;
      return {
        formatVersion: 1,
        startedAt: "2026-08-12T00:00:00.000Z",
        finishedAt: "2026-08-12T00:00:30.000Z",
        environment: { platform: "linux", arch: "x64", node: "v20.20.0", libc: "glibc-2.31" },
        dataset: { records: 1000, proxySites: 100 },
        dns: { requests: 15000, errors: 0, qps: 500, p95Ms: 2 },
        proxy: { requests: 3000, errors: 0, rps: 100, p95Ms: 4 },
        soak: { durationMs: 30000, coreInterruptions: 0, operationalRuns: 1, operationalFailures: 0 },
      };
    },
  });
  assert.equal(received.durationMs, 30000);
  assert.equal(result.report.profile, "ci");
  assert.equal(result.report.formal, false);
  assert.deepEqual(result.evaluation, { passed: true, formal: false, failures: [] });
});
