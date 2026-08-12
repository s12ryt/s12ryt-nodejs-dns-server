"use strict";

const { BENCHMARK_PROFILES, evaluateBenchmarkReport, normalizeBenchmarkReport } = require("./profile");
const { runTransportBenchmark } = require("./runner");

const LOAD_HEADROOM_PERCENT = 110;

function loadWithHeadroom(target) {
  return Math.ceil(target * LOAD_HEADROOM_PERCENT / 100);
}

function benchmarkOptions(profileName, overrides = {}) {
  const profile = BENCHMARK_PROFILES[profileName];
  if (!profile) throw new TypeError(`Unknown benchmark profile: ${profileName}`);
  if (profile.formal && overrides.durationMs !== undefined && overrides.durationMs !== profile.soakDurationMs) {
    throw new Error("Formal release benchmark duration cannot be shortened");
  }
  const durationMs = overrides.durationMs ?? profile.soakDurationMs;
  return {
    records: profile.records,
    proxySites: profile.proxySites,
    durationMs,
    intervalMs: 1000,
    dnsOperationsPerInterval: loadWithHeadroom(profile.dnsQps),
    proxyOperationsPerInterval: loadWithHeadroom(profile.proxyRps),
    dnsConcurrency: 512,
    proxyConcurrency: 256,
    maintenanceEveryIntervals: 300,
    ...overrides,
    durationMs,
  };
}

async function executeBenchmark({ profileName, runner = runTransportBenchmark, overrides } = {}) {
  const options = benchmarkOptions(profileName, overrides);
  const raw = await runner(options);
  const report = normalizeBenchmarkReport({ ...raw, profile: profileName });
  return { report, evaluation: evaluateBenchmarkReport(report) };
}

module.exports = { LOAD_HEADROOM_PERCENT, benchmarkOptions, executeBenchmark, loadWithHeadroom };
