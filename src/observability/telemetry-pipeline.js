"use strict";

const ALERT_KINDS = new Set([
  "proxy-error",
  "storage-error",
  "tunnel-error",
  "upstream-error",
]);

class TelemetryPipeline {
  constructor({
    events,
    metrics,
    logger,
    webhook = null,
    storage,
    sampleIntervalMs = 60000,
    now = () => new Date(),
    schedule = setInterval,
    cancel = clearInterval,
  } = {}) {
    if (!events || typeof events.add !== "function") throw new TypeError("Event log is required");
    if (!metrics || typeof metrics.observe !== "function" || typeof metrics.drainSamples !== "function") {
      throw new TypeError("Metrics registry is required");
    }
    if (!logger || typeof logger.write !== "function" || typeof logger.close !== "function") {
      throw new TypeError("Structured logger is required");
    }
    if (!storage || typeof storage.recordMetricSamples !== "function") throw new TypeError("Telemetry storage is required");
    this.events = events;
    this.metrics = metrics;
    this.logger = logger;
    this.webhook = webhook;
    this.storage = storage;
    this.sampleIntervalMs = sampleIntervalMs;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.timer = null;
    this.logQueue = Promise.resolve();
  }

  record(event) {
    const normalized = {
      ...event,
      timestamp: event.timestamp || this.now().toISOString(),
    };
    this.events.add(normalized);
    this.metrics.observe(normalized);
    this.logQueue = this.logQueue.then(() => this.logger.write(normalized)).catch((error) => {
      this.events.add({ kind: "logging-error", message: `Structured log write failed: ${error.message}` });
    });
    if (this.webhook && ALERT_KINDS.has(normalized.kind)) {
      try {
        this.webhook.enqueue(normalized.kind, normalized);
      } catch (error) {
        this.events.add({ kind: "webhook-error", message: `Webhook enqueue failed: ${error.message}` });
      }
    }
    return normalized;
  }

  setWebhook(webhook) {
    if (webhook !== null
      && (typeof webhook?.enqueue !== "function" || typeof webhook?.processDue !== "function")) {
      throw new TypeError("Webhook dispatcher is invalid");
    }
    this.webhook = webhook;
    return this.webhook;
  }

  start() {
    if (this.timer) throw new Error("Telemetry pipeline is already started");
    this.timer = this.schedule(() => this.flush(), this.sampleIntervalMs);
    this.timer?.unref?.();
  }

  async flush() {
    await this.logQueue;
    const samples = this.metrics.drainSamples();
    try {
      if (samples.length > 0) this.storage.recordMetricSamples(samples);
    } catch (error) {
      this.events.add({ kind: "storage-error", message: `Metric samples were not recorded: ${error.message}` });
    }
    if (this.webhook) {
      try {
        await this.webhook.processDue();
      } catch (error) {
        this.events.add({ kind: "webhook-error", message: `Webhook processing failed: ${error.message}` });
      }
    }
  }

  async close() {
    if (this.timer) {
      this.cancel(this.timer);
      this.timer = null;
    }
    await this.logQueue;
    const samples = this.metrics.drainSamples();
    try {
      if (samples.length > 0) this.storage.recordMetricSamples(samples);
    } catch (error) {
      this.events.add({ kind: "storage-error", message: `Final metric samples were not recorded: ${error.message}` });
    }
    await this.logger.close();
  }
}

module.exports = { ALERT_KINDS, TelemetryPipeline };
