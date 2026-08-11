"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { MetricsRegistry } = require("../../src/observability/metrics");

test("metrics registry aggregates operational events and exports Prometheus text", () => {
  const metrics = new MetricsRegistry({ now: () => new Date("2026-08-11T12:00:00.000Z") });

  metrics.observe({ kind: "dns", source: "custom", name: "private.example", type: "A", durationMs: 2 });
  metrics.observe({ kind: "dns", source: "Cloudflare", name: "public.example", type: "AAAA", durationMs: 18 });
  metrics.observe({ kind: "proxy", host: "app.example", method: "GET", statusCode: 200, durationMs: 24 });
  metrics.observe({ kind: "proxy", host: "app.example", method: "GET", statusCode: 502, durationMs: 80 });
  metrics.observe({ kind: "proxy-error", host: "app.example", method: "GET", statusCode: 502, durationMs: 80 });

  assert.deepEqual(metrics.snapshot().counters, {
    dnsQueries: 2,
    dnsErrors: 0,
    proxyRequests: 2,
    proxyErrors: 1,
  });
  assert.equal(metrics.snapshot().latency.dns.count, 2);
  assert.equal(metrics.snapshot().latency.proxy.sumMs, 104);

  const output = metrics.toPrometheus();
  assert.match(output, /s12_dns_queries_total\{source="custom",type="A"\} 1/);
  assert.match(output, /s12_proxy_requests_total\{host="app\.example",method="GET",status="200"\} 1/);
  assert.match(output, /s12_proxy_errors_total 1/);
  assert.match(output, /s12_dns_latency_milliseconds_sum 20/);
});

test("metrics registry emits SQLite samples without sensitive DNS names or URLs", () => {
  const metrics = new MetricsRegistry({ now: () => new Date("2026-08-11T12:00:00.000Z") });
  metrics.observe({ kind: "dns", source: "cache", name: "secret.example", type: "TXT", durationMs: 4 });
  metrics.observe({ kind: "proxy", host: "app.example", url: "/private?id=7", method: "POST", statusCode: 201, durationMs: 9 });

  const samples = metrics.samples();
  assert.equal(samples.every((sample) => sample.recordedAt === "2026-08-11T12:00:00.000Z"), true);
  assert.equal(JSON.stringify(samples).includes("secret.example"), false);
  assert.equal(JSON.stringify(samples).includes("/private"), false);
  assert.equal(samples.some((sample) => sample.metric === "dns_queries_total" && sample.value === 1), true);
  assert.equal(samples.some((sample) => sample.metric === "proxy_latency_milliseconds_sum" && sample.value === 9), true);
});

test("metrics registry drains interval samples without resetting Prometheus totals", () => {
  const metrics = new MetricsRegistry({ now: () => new Date("2026-08-11T12:00:00.000Z") });
  metrics.observe({ kind: "dns", source: "custom", type: "A", durationMs: 3 });
  assert.equal(metrics.drainSamples().find((sample) => sample.metric === "dns_queries_total").value, 1);
  metrics.observe({ kind: "dns", source: "custom", type: "A", durationMs: 5 });
  assert.equal(metrics.drainSamples().find((sample) => sample.metric === "dns_queries_total").value, 1);
  assert.match(metrics.toPrometheus(), /s12_dns_queries_total\{source="custom",type="A"\} 2/);
});
