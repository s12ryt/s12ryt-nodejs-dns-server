"use strict";

const { performance } = require("node:perf_hooks");

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function percentile(values, quantile) {
  if (!Array.isArray(values) || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Percentile values must be non-negative finite numbers");
  }
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
    throw new Error("Percentile quantile must be between zero and one");
  }
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function summarize(requests, errors, latencies, durationMs) {
  return {
    requests,
    errors,
    durationMs,
    throughput: durationMs === 0 ? 0 : requests / (durationMs / 1000),
    p95Ms: percentile(latencies, 0.95),
    latencies,
  };
}

async function runOperationBatch({ count, concurrency, operation, clock = performance }) {
  positiveInteger(count, "Operation count");
  positiveInteger(concurrency, "Operation concurrency");
  if (typeof operation !== "function") throw new Error("Operation must be a function");
  const startedAt = clock.now();
  const latencies = new Array(count);
  let errors = 0;
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < count) {
      const index = nextIndex++;
      const operationStartedAt = clock.now();
      try {
        await operation(index);
      } catch {
        errors += 1;
      } finally {
        latencies[index] = Math.max(0, clock.now() - operationStartedAt);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, () => worker()));
  return summarize(count, errors, latencies, Math.max(0, clock.now() - startedAt));
}

function mergeBatch(total, batch) {
  total.requests += batch.requests;
  total.errors += batch.errors;
  total.latencies.push(...batch.latencies);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runSoakLoad({
  durationMs,
  intervalMs = 1000,
  dnsRate,
  proxyRate,
  dnsConcurrency = 512,
  proxyConcurrency = 256,
  dnsOperation,
  proxyOperation,
  checkCore = async () => true,
  maintenanceOperation = null,
  clock = performance,
  wait = sleep,
}) {
  positiveInteger(durationMs, "Soak duration");
  positiveInteger(intervalMs, "Soak interval");
  positiveInteger(dnsRate, "DNS operations per interval");
  positiveInteger(proxyRate, "Proxy operations per interval");
  if (typeof checkCore !== "function") throw new Error("Core health check must be a function");
  if (maintenanceOperation !== null && typeof maintenanceOperation !== "function") {
    throw new Error("Maintenance operation must be a function");
  }
  const dns = { requests: 0, errors: 0, latencies: [] };
  const proxy = { requests: 0, errors: 0, latencies: [] };
  const startedAt = clock.now();
  let coreInterruptions = 0;
  let operationalRuns = 0;
  let operationalFailures = 0;
  let tick = 0;
  while (clock.now() - startedAt < durationMs) {
    const tickStartedAt = startedAt + tick * intervalMs;
    const maintenance = async () => {
      if (!maintenanceOperation) return;
      try {
        if ((await maintenanceOperation({ tick })) !== false) operationalRuns += 1;
      } catch {
        operationalRuns += 1;
        operationalFailures += 1;
      }
    };
    const [dnsBatch, proxyBatch] = await Promise.all([
      runOperationBatch({ count: dnsRate, concurrency: dnsConcurrency, operation: dnsOperation, clock }),
      runOperationBatch({ count: proxyRate, concurrency: proxyConcurrency, operation: proxyOperation, clock }),
      maintenance(),
    ]);
    mergeBatch(dns, dnsBatch);
    mergeBatch(proxy, proxyBatch);
    try {
      if ((await checkCore()) !== true) coreInterruptions += 1;
    } catch {
      coreInterruptions += 1;
    }
    tick += 1;
    const remaining = tickStartedAt + intervalMs - clock.now();
    if (remaining > 0) await wait(remaining);
  }
  const elapsed = Math.max(0, clock.now() - startedAt);
  return {
    dns: summarize(dns.requests, dns.errors, dns.latencies, elapsed),
    proxy: summarize(proxy.requests, proxy.errors, proxy.latencies, elapsed),
    soak: { durationMs: elapsed, coreInterruptions, operationalRuns, operationalFailures, ticks: tick },
  };
}

module.exports = { percentile, runOperationBatch, runSoakLoad };
