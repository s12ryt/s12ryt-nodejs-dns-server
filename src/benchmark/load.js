"use strict";

const { performance } = require("node:perf_hooks");

const MAX_LATENCY_MS = 60_000;
const OVERFLOW_BUCKET = MAX_LATENCY_MS + 1;
const LATENCY_BUCKETS = OVERFLOW_BUCKET + 1;

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

class LatencyHistogram {
  #buckets = new Uint32Array(LATENCY_BUCKETS);
  #count = 0;

  get bucketCount() {
    return this.#buckets.length;
  }

  get count() {
    return this.#count;
  }

  observe(value) {
    if (!Number.isFinite(value) || value < 0) throw new Error("Latency must be a non-negative finite number");
    const bucket = Math.min(OVERFLOW_BUCKET, Math.floor(value));
    this.#buckets[bucket] += 1;
    this.#count += 1;
  }

  merge(values) {
    for (const value of values) this.observe(value);
  }

  percentile(quantile) {
    if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
      throw new Error("Percentile quantile must be between zero and one");
    }
    if (this.#count === 0) return 0;
    const target = Math.max(1, Math.ceil(this.#count * quantile));
    let cumulative = 0;
    for (let bucket = 0; bucket < this.#buckets.length; bucket += 1) {
      cumulative += this.#buckets[bucket];
      if (cumulative >= target) return bucket;
    }
    return OVERFLOW_BUCKET;
  }
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

async function runOperationBatch({ count, concurrency, operation, spreadMs = 0, clock = performance, wait = sleep }) {
  positiveInteger(count, "Operation count");
  positiveInteger(concurrency, "Operation concurrency");
  if (!Number.isFinite(spreadMs) || spreadMs < 0) throw new Error("Operation spread must be non-negative");
  if (typeof operation !== "function") throw new Error("Operation must be a function");
  if (typeof wait !== "function") throw new Error("Operation wait must be a function");
  const startedAt = clock.now();
  const latencies = new Array(count);
  let errors = 0;
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < count) {
      const index = nextIndex++;
      const scheduledAt = startedAt + (index * spreadMs / count);
      const delay = scheduledAt - clock.now();
      if (delay > 0) await wait(delay);
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
  total.histogram.merge(batch.latencies);
}

function summarizeSoak(total, durationMs) {
  return {
    requests: total.requests,
    errors: total.errors,
    durationMs,
    throughput: durationMs === 0 ? 0 : total.requests / (durationMs / 1000),
    p95Ms: total.histogram.percentile(0.95),
  };
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
  const dns = { requests: 0, errors: 0, histogram: new LatencyHistogram() };
  const proxy = { requests: 0, errors: 0, histogram: new LatencyHistogram() };
  const startedAt = clock.now();
  let coreInterruptions = 0;
  let operationalRuns = 0;
  let operationalFailures = 0;
  let tick = 0;
  const batches = [];
  const runTick = async (currentTick) => {
    const maintenance = async () => {
      if (!maintenanceOperation) return;
      try {
        if ((await maintenanceOperation({ tick: currentTick })) !== false) operationalRuns += 1;
      } catch {
        operationalRuns += 1;
        operationalFailures += 1;
      }
    };
    const [dnsBatch, proxyBatch] = await Promise.all([
      runOperationBatch({ count: dnsRate, concurrency: dnsConcurrency, operation: dnsOperation, spreadMs: intervalMs, clock, wait }),
      runOperationBatch({ count: proxyRate, concurrency: proxyConcurrency, operation: proxyOperation, spreadMs: intervalMs, clock, wait }),
      maintenance(),
    ]);
    mergeBatch(dns, dnsBatch);
    mergeBatch(proxy, proxyBatch);
    try {
      if ((await checkCore()) !== true) coreInterruptions += 1;
    } catch {
      coreInterruptions += 1;
    }
  };
  while (tick * intervalMs < durationMs) {
    const scheduledAt = startedAt + tick * intervalMs;
    const remaining = scheduledAt - clock.now();
    if (remaining > 0) await wait(remaining);
    batches.push(runTick(tick));
    tick += 1;
  }
  const remainingWindow = Math.max(0, startedAt + durationMs - clock.now());
  await Promise.all([Promise.all(batches), wait(remainingWindow)]);
  const elapsed = Math.max(0, clock.now() - startedAt);
  return {
    dns: summarizeSoak(dns, elapsed),
    proxy: summarizeSoak(proxy, elapsed),
    soak: { durationMs: elapsed, coreInterruptions, operationalRuns, operationalFailures, ticks: tick },
  };
}

module.exports = { LatencyHistogram, percentile, runOperationBatch, runSoakLoad };
