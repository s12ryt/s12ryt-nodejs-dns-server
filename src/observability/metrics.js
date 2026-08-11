"use strict";

function labelKey(labels) {
  return JSON.stringify(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)));
}

function parseLabelKey(key) {
  return Object.fromEntries(JSON.parse(key));
}

function escapeLabel(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function prometheusLabels(labels) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",")}}`;
}

class MetricsRegistry {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    this.series = new Map();
    this.windowSeries = new Map();
    this.counters = { dnsQueries: 0, dnsErrors: 0, proxyRequests: 0, proxyErrors: 0 };
    this.latency = {
      dns: { count: 0, sumMs: 0 },
      proxy: { count: 0, sumMs: 0 },
    };
    this.windowLatency = {
      dns: { count: 0, sumMs: 0 },
      proxy: { count: 0, sumMs: 0 },
    };
  }

  observe(event) {
    if (!event || typeof event !== "object") return;
    if (event.kind === "dns") {
      this.counters.dnsQueries += 1;
      this.#increment("s12_dns_queries_total", { source: event.source || "unknown", type: event.type || "unknown" });
      this.#latency("dns", event.durationMs);
      return;
    }
    if (event.kind === "upstream-error") {
      this.counters.dnsErrors += 1;
      this.#increment("s12_dns_errors_total", { upstream: event.upstream || "unknown" });
      return;
    }
    if (event.kind === "proxy") {
      this.counters.proxyRequests += 1;
      const labels = {
        host: event.host || "unknown",
        method: event.method || "unknown",
        status: String(event.statusCode || 0),
      };
      this.#increment("s12_proxy_requests_total", labels);
      this.#latency("proxy", event.durationMs);
      return;
    }
    if (event.kind === "proxy-error") {
      this.counters.proxyErrors += 1;
      this.#increment("s12_proxy_errors_total", {});
    }
  }

  snapshot() {
    return {
      recordedAt: this.now().toISOString(),
      counters: { ...this.counters },
      latency: {
        dns: { ...this.latency.dns },
        proxy: { ...this.latency.proxy },
      },
    };
  }

  samples() {
    return this.#samples(this.series, this.latency);
  }

  drainSamples() {
    const samples = this.#samples(this.windowSeries, this.windowLatency);
    this.windowSeries = new Map();
    this.windowLatency = {
      dns: { count: 0, sumMs: 0 },
      proxy: { count: 0, sumMs: 0 },
    };
    return samples;
  }

  #samples(series, latency) {
    const recordedAt = this.now().toISOString();
    const samples = [];
    for (const [name, values] of series) {
      for (const [key, value] of values) {
        samples.push({ recordedAt, metric: name.slice(4), labels: parseLabelKey(key), value });
      }
    }
    for (const category of ["dns", "proxy"]) {
      samples.push({ recordedAt, metric: `${category}_latency_milliseconds_count`, labels: {}, value: latency[category].count });
      samples.push({ recordedAt, metric: `${category}_latency_milliseconds_sum`, labels: {}, value: latency[category].sumMs });
    }
    return samples;
  }

  toPrometheus() {
    const lines = [];
    for (const [name, values] of this.series) {
      for (const [key, value] of values) lines.push(`${name}${prometheusLabels(parseLabelKey(key))} ${value}`);
    }
    for (const category of ["dns", "proxy"]) {
      lines.push(`s12_${category}_latency_milliseconds_count ${this.latency[category].count}`);
      lines.push(`s12_${category}_latency_milliseconds_sum ${this.latency[category].sumMs}`);
    }
    return `${lines.join("\n")}\n`;
  }

  #increment(name, labels) {
    const key = labelKey(labels);
    for (const series of [this.series, this.windowSeries]) {
      if (!series.has(name)) series.set(name, new Map());
      const values = series.get(name);
      values.set(key, (values.get(key) || 0) + 1);
    }
  }

  #latency(category, value) {
    if (!Number.isFinite(value) || value < 0) return;
    this.latency[category].count += 1;
    this.latency[category].sumMs += value;
    this.windowLatency[category].count += 1;
    this.windowLatency[category].sumMs += value;
  }
}

module.exports = { MetricsRegistry, escapeLabel, prometheusLabels };
