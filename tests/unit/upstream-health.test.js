"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createUpstreamHealthMonitor } = require("../../src/dns/upstream-health");

test("upstream health monitor probes immediately and every five minutes", async () => {
  const probes = [];
  const scheduled = [];
  const cancelled = [];
  const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const upstreams = [
    { name: "one", probe: async () => { probes.push("one"); } },
    { name: "two", probe: async () => { probes.push("two"); throw new Error("offline"); } },
  ];
  const monitor = createUpstreamHealthMonitor({
    getUpstreams: () => upstreams,
    schedule(callback, intervalMs) {
      scheduled.push({ callback, intervalMs });
      return timer;
    },
    cancel(value) { cancelled.push(value); },
  });

  monitor.start();
  await monitor.probeNow();

  assert.deepEqual(probes, ["one", "two", "one", "two"]);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].intervalMs, 300000);
  assert.equal(timer.unrefCalled, true);

  await scheduled[0].callback();
  assert.deepEqual(probes, ["one", "two", "one", "two", "one", "two"]);

  monitor.close();
  assert.deepEqual(cancelled, [timer]);
});
