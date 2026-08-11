"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { BENCHMARK_PROFILES, evaluateBenchmarkReport, normalizeBenchmarkReport } = require("../../src/benchmark/profile");

test("release benchmark profile fixes the v1 scale and 24 hour soak contract", () => {
  assert.deepEqual(BENCHMARK_PROFILES.release, {
    name: "release",
    formal: true,
    records: 100000,
    proxySites: 1000,
    dnsQps: 5000,
    proxyRps: 1000,
    soakDurationMs: 24 * 60 * 60 * 1000,
    maxErrorRate: 0.001,
    maxCoreInterruptions: 0,
    minOperationalRuns: 1,
    maxOperationalFailures: 0,
  });
  assert.equal(BENCHMARK_PROFILES.ci.formal, false);
  assert.deepEqual(BENCHMARK_PROFILES.scale, {
    name: "scale",
    formal: false,
    records: 100000,
    proxySites: 1000,
    dnsQps: 5000,
    proxyRps: 1000,
    soakDurationMs: 30000,
    maxErrorRate: 0.001,
    maxCoreInterruptions: 0,
    minOperationalRuns: 1,
    maxOperationalFailures: 0,
  });
  assert.equal(BENCHMARK_PROFILES.ci.soakDurationMs < BENCHMARK_PROFILES.release.soakDurationMs, true);
});

test("benchmark report passes only when every measured release threshold is met", () => {
  const report = normalizeBenchmarkReport({
    profile: "release",
    startedAt: "2026-08-12T00:00:00.000Z",
    finishedAt: "2026-08-13T00:00:00.000Z",
    environment: { platform: "linux", arch: "x64", node: "v20.19.0", libc: "glibc" },
    dataset: { records: 100000, proxySites: 1000 },
    dns: { requests: 432000000, errors: 0, qps: 5000, p95Ms: 4.2 },
    proxy: { requests: 86400000, errors: 20, rps: 1000, p95Ms: 7.5 },
    soak: { durationMs: 86400000, coreInterruptions: 0, operationalRuns: 1, operationalFailures: 0 },
  });
  assert.deepEqual(evaluateBenchmarkReport(report), { passed: true, formal: true, failures: [] });

  const failed = evaluateBenchmarkReport({
    ...report,
    dataset: { records: 99999, proxySites: 999 },
    dns: { ...report.dns, qps: 4999 },
    proxy: { ...report.proxy, rps: 999, errors: 100000 },
    soak: { durationMs: 86399999, coreInterruptions: 1, operationalRuns: 0, operationalFailures: 1 },
  });
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.failures.map((failure) => failure.code), [
    "RECORD_COUNT", "PROXY_SITE_COUNT", "DNS_QPS", "PROXY_RPS", "PROXY_ERROR_RATE", "SOAK_DURATION", "CORE_INTERRUPTION",
    "OPERATION_RUNS", "OPERATION_FAILURES",
  ]);
});

test("a CI smoke report can pass its own profile but is never formal release evidence", () => {
  const profile = BENCHMARK_PROFILES.ci;
  const report = normalizeBenchmarkReport({
    profile: "ci",
    startedAt: "2026-08-12T00:00:00.000Z",
    finishedAt: new Date(Date.parse("2026-08-12T00:00:00.000Z") + profile.soakDurationMs).toISOString(),
    environment: { platform: "linux", arch: "x64", node: "v20.19.0", libc: "glibc" },
    dataset: { records: profile.records, proxySites: profile.proxySites },
    dns: { requests: 1000, errors: 0, qps: profile.dnsQps, p95Ms: 1 },
    proxy: { requests: 1000, errors: 0, rps: profile.proxyRps, p95Ms: 1 },
    soak: { durationMs: profile.soakDurationMs, coreInterruptions: 0, operationalRuns: 1, operationalFailures: 0 },
  });
  const result = evaluateBenchmarkReport(report);
  assert.equal(result.passed, true);
  assert.equal(result.formal, false);
});
