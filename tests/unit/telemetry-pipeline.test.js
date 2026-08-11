"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { EventLog } = require("../../src/admin/event-log");
const { MetricsRegistry } = require("../../src/observability/metrics");
const { TelemetryPipeline } = require("../../src/observability/telemetry-pipeline");

test("telemetry pipeline fans events into memory, metrics, sensitive logs and alert webhooks", async () => {
  const events = new EventLog();
  const metrics = new MetricsRegistry({ now: () => new Date("2026-08-11T12:00:00.000Z") });
  const logged = [];
  const queued = [];
  const pipeline = new TelemetryPipeline({
    events,
    metrics,
    logger: { write: async (event) => logged.push(event), close: async () => {} },
    webhook: { enqueue: (kind, event) => queued.push({ kind, event }), processDue: async () => {} },
    storage: { recordMetricSamples() {} },
    now: () => new Date("2026-08-11T12:00:00.000Z"),
  });

  pipeline.record({ kind: "dns", source: "custom", name: "private.example", clientIp: "192.0.2.1", type: "A", durationMs: 3 });
  pipeline.record({ kind: "upstream-error", upstream: "Cloudflare", message: "timeout" });
  await pipeline.flush();

  assert.equal(events.list().length, 2);
  assert.equal(metrics.snapshot().counters.dnsQueries, 1);
  assert.equal(logged[0].name, "private.example");
  assert.equal(logged[0].clientIp, "192.0.2.1");
  assert.deepEqual(queued.map((item) => item.kind), ["upstream-error"]);
  assert.equal(logged.every((event) => event.timestamp === "2026-08-11T12:00:00.000Z"), true);
});

test("telemetry pipeline persists interval metric deltas, processes webhooks and isolates failures", async () => {
  const lifecycle = [];
  const stored = [];
  const scheduled = [];
  const events = new EventLog();
  const metrics = new MetricsRegistry({ now: () => new Date("2026-08-11T12:00:00.000Z") });
  const pipeline = new TelemetryPipeline({
    events,
    metrics,
    logger: { write: async () => {}, close: async () => lifecycle.push("close:logger") },
    webhook: { enqueue() {}, processDue: async () => lifecycle.push("process:webhooks") },
    storage: {
      recordMetricSamples(samples) {
        stored.push(samples);
        if (stored.length === 2) throw new Error("metrics disk full");
      },
    },
    sampleIntervalMs: 60000,
    schedule(callback, delay) {
      const timer = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
      scheduled.push(timer);
      return timer;
    },
    cancel: (timer) => lifecycle.push(`cancel:${timer.delay}`),
  });

  pipeline.record({ kind: "dns", source: "custom", type: "A", durationMs: 2 });
  pipeline.start();
  assert.equal(scheduled[0].delay, 60000);
  assert.equal(scheduled[0].unrefCalled, true);
  await scheduled[0].callback();
  pipeline.record({ kind: "dns", source: "cache", type: "A", durationMs: 4 });
  await scheduled[0].callback();

  assert.equal(stored[0].find((sample) => sample.metric === "dns_queries_total").value, 1);
  assert.equal(stored[1].find((sample) => sample.metric === "dns_queries_total").value, 1);
  assert.match(events.list().at(-1).message, /metrics disk full/);
  await pipeline.close();
  assert.deepEqual(lifecycle.slice(-2), ["cancel:60000", "close:logger"]);
});

test("telemetry pipeline replaces and disables webhook delivery without restarting", async () => {
  const queued = [];
  const pipeline = new TelemetryPipeline({
    events: new EventLog(),
    metrics: new MetricsRegistry(),
    logger: { write: async () => {}, close: async () => {} },
    storage: { recordMetricSamples() {} },
  });
  const webhook = {
    enqueue: (kind) => queued.push(kind),
    processDue: async () => {},
  };

  assert.equal(pipeline.setWebhook(webhook), webhook);
  pipeline.record({ kind: "storage-error", message: "disk full" });
  assert.deepEqual(queued, ["storage-error"]);
  assert.equal(pipeline.setWebhook(null), null);
  pipeline.record({ kind: "upstream-error", message: "timeout" });
  assert.deepEqual(queued, ["storage-error"]);
});
