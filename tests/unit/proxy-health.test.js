"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { ProxyHealthMonitor } = require("../../src/services/proxy-health");

test("ProxyHealthMonitor probes immediately, records results and schedules unref timers", async () => {
  const target = {
    id: "api",
    site: "app.example.test",
    location: "prefix:/",
    fallback: false,
    url: new URL("http://127.0.0.1:3301"),
    health: { enabled: true, path: "/healthz", intervalMs: 10_000, timeoutMs: 2_000, statusMin: 200, statusMax: 399 },
  };
  const results = [];
  const events = [];
  const timers = [];
  let cancelled;
  const monitor = new ProxyHealthMonitor({
    routes: {
      healthTargets: () => [target],
      recordActiveProbe: (received, result) => {
        results.push({ received, result });
        return { previousState: "unknown", state: "healthy" };
      },
    },
    probe: async (received) => ({ healthy: true, statusCode: 204, latencyMs: 7, checkedAt: "2026-08-12T02:00:00.000Z", target: received.id }),
    schedule: (callback, delay) => {
      const timer = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => { cancelled = timer; },
    onEvent: (event) => events.push(event),
  });

  monitor.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(results.length, 1);
  assert.equal(results[0].received, target);
  assert.equal(results[0].result.statusCode, 204);
  assert.deepEqual(events[0], {
    kind: "proxy-health",
    site: "app.example.test",
    location: "prefix:/",
    upstream: "api",
    fallback: false,
    healthy: true,
    statusCode: 204,
    latencyMs: 7,
    checkedAt: "2026-08-12T02:00:00.000Z",
    target: "api",
    previousState: "unknown",
    state: "healthy",
  });
  assert.equal(timers[0].delay, 10_000);
  assert.equal(timers[0].unrefCalled, true);
  assert.equal(monitor.status().running, true);
  monitor.close();
  assert.equal(cancelled, timers[0]);
});

test("ProxyHealthMonitor isolates probe failures and can be paused then restarted", async () => {
  const events = [];
  let probes = 0;
  const target = { id: "bad", health: { enabled: true, intervalMs: 10_000 } };
  const monitor = new ProxyHealthMonitor({
    routes: {
      healthTargets: () => [target],
      recordActiveProbe: (_target, result) => events.push(result),
    },
    probe: async () => { probes += 1; throw new Error("connection refused"); },
    schedule: () => ({ unref() {} }),
    cancel: () => {},
  });
  await monitor.probeNow();
  assert.equal(probes, 1);
  assert.equal(events[0].healthy, false);
  assert.match(events[0].error, /connection refused/);
  monitor.start();
  monitor.pause();
  assert.equal(monitor.status().running, false);
  monitor.start();
  assert.equal(monitor.status().running, true);
  monitor.close();
});
