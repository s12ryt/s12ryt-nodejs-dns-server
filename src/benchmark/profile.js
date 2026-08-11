"use strict";

const RELEASE_DURATION_MS = 24 * 60 * 60 * 1000;

const BENCHMARK_PROFILES = Object.freeze({
  ci: Object.freeze({
    name: "ci",
    formal: false,
    records: 1000,
    proxySites: 100,
    dnsQps: 500,
    proxyRps: 100,
    soakDurationMs: 30 * 1000,
    maxErrorRate: 0.01,
    maxCoreInterruptions: 0,
    minOperationalRuns: 1,
    maxOperationalFailures: 0,
  }),
  scale: Object.freeze({
    name: "scale",
    formal: false,
    records: 100000,
    proxySites: 1000,
    dnsQps: 5000,
    proxyRps: 1000,
    soakDurationMs: 30 * 1000,
    maxErrorRate: 0.001,
    maxCoreInterruptions: 0,
    minOperationalRuns: 1,
    maxOperationalFailures: 0,
  }),
  release: Object.freeze({
    name: "release",
    formal: true,
    records: 100000,
    proxySites: 1000,
    dnsQps: 5000,
    proxyRps: 1000,
    soakDurationMs: RELEASE_DURATION_MS,
    maxErrorRate: 0.001,
    maxCoreInterruptions: 0,
    minOperationalRuns: 1,
    maxOperationalFailures: 0,
  }),
});

function finiteNumber(value, name, { minimum = 0 } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(`Benchmark ${name} is invalid`);
  }
  return value;
}

function integer(value, name) {
  finiteNumber(value, name);
  if (!Number.isSafeInteger(value)) throw new TypeError(`Benchmark ${name} must be an integer`);
  return value;
}

function dateString(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`Benchmark ${name} is invalid`);
  }
  return new Date(value).toISOString();
}

function normalizeBenchmarkReport(value) {
  if (!value || typeof value !== "object" || !BENCHMARK_PROFILES[value.profile]) {
    throw new TypeError("Benchmark report profile is invalid");
  }
  const environment = value.environment;
  if (!environment || ["platform", "arch", "node", "libc"].some((name) => typeof environment[name] !== "string" || !environment[name])) {
    throw new TypeError("Benchmark environment is invalid");
  }
  const operation = (input, name) => {
    if (!input || typeof input !== "object") throw new TypeError(`Benchmark ${name} result is invalid`);
    return {
      requests: integer(input.requests, `${name} requests`),
      errors: integer(input.errors, `${name} errors`),
      [name === "dns" ? "qps" : "rps"]: finiteNumber(input[name === "dns" ? "qps" : "rps"], `${name} throughput`),
      p95Ms: finiteNumber(input.p95Ms, `${name} p95 latency`),
    };
  };
  return {
    formatVersion: 1,
    profile: value.profile,
    formal: BENCHMARK_PROFILES[value.profile].formal,
    startedAt: dateString(value.startedAt, "start time"),
    finishedAt: dateString(value.finishedAt, "finish time"),
    environment: { ...environment },
    dataset: {
      records: integer(value.dataset?.records, "record count"),
      proxySites: integer(value.dataset?.proxySites, "proxy site count"),
    },
    dns: operation(value.dns, "dns"),
    proxy: operation(value.proxy, "proxy"),
    soak: {
      durationMs: integer(value.soak?.durationMs, "soak duration"),
      coreInterruptions: integer(value.soak?.coreInterruptions, "core interruptions"),
      operationalRuns: integer(value.soak?.operationalRuns ?? 0, "operational runs"),
      operationalFailures: integer(value.soak?.operationalFailures ?? 0, "operational failures"),
    },
  };
}

function failure(code, actual, expected) {
  return { code, actual, expected };
}

function evaluateBenchmarkReport(input) {
  const report = input?.formatVersion === 1 ? normalizeBenchmarkReport(input) : normalizeBenchmarkReport(input);
  const profile = BENCHMARK_PROFILES[report.profile];
  const failures = [];
  if (report.dataset.records < profile.records) failures.push(failure("RECORD_COUNT", report.dataset.records, profile.records));
  if (report.dataset.proxySites < profile.proxySites) failures.push(failure("PROXY_SITE_COUNT", report.dataset.proxySites, profile.proxySites));
  if (report.dns.qps < profile.dnsQps) failures.push(failure("DNS_QPS", report.dns.qps, profile.dnsQps));
  if (report.proxy.rps < profile.proxyRps) failures.push(failure("PROXY_RPS", report.proxy.rps, profile.proxyRps));
  const dnsErrorRate = report.dns.requests ? report.dns.errors / report.dns.requests : report.dns.errors ? 1 : 0;
  const proxyErrorRate = report.proxy.requests ? report.proxy.errors / report.proxy.requests : report.proxy.errors ? 1 : 0;
  if (dnsErrorRate > profile.maxErrorRate) failures.push(failure("DNS_ERROR_RATE", dnsErrorRate, profile.maxErrorRate));
  if (proxyErrorRate > profile.maxErrorRate) failures.push(failure("PROXY_ERROR_RATE", proxyErrorRate, profile.maxErrorRate));
  if (report.soak.durationMs < profile.soakDurationMs) failures.push(failure("SOAK_DURATION", report.soak.durationMs, profile.soakDurationMs));
  if (report.soak.coreInterruptions > profile.maxCoreInterruptions) {
    failures.push(failure("CORE_INTERRUPTION", report.soak.coreInterruptions, profile.maxCoreInterruptions));
  }
  if (report.soak.operationalRuns < profile.minOperationalRuns) {
    failures.push(failure("OPERATION_RUNS", report.soak.operationalRuns, profile.minOperationalRuns));
  }
  if (report.soak.operationalFailures > profile.maxOperationalFailures) {
    failures.push(failure("OPERATION_FAILURES", report.soak.operationalFailures, profile.maxOperationalFailures));
  }
  return { passed: failures.length === 0, formal: profile.formal, failures };
}

module.exports = { BENCHMARK_PROFILES, evaluateBenchmarkReport, normalizeBenchmarkReport };
