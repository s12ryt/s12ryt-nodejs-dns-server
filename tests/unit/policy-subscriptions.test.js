"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { PolicyStore } = require("../../src/dns/policy");
const {
  PolicySubscriptionManager,
  normalizeSubscription,
} = require("../../src/dns/policy-subscriptions");

function response(text, { status = 200 } = {}) {
  const body = Buffer.from(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    body: (async function* bodyChunks() { yield body; })(),
  };
}

function subscription(overrides = {}) {
  return {
    id: "ads",
    enabled: true,
    url: "https://lists.example.test/ads.txt",
    priority: 20,
    refreshIntervalMs: 6 * 60 * 60 * 1000,
    action: { type: "NXDOMAIN" },
    ...overrides,
  };
}

test("policy subscriptions validate HTTPS, cadence, qtypes and action", () => {
  assert.deepEqual(normalizeSubscription(subscription()), subscription());
  assert.throws(() => normalizeSubscription(subscription({ url: "http://lists.example.test/ads.txt" })), /HTTPS/i);
  assert.throws(() => normalizeSubscription(subscription({ refreshIntervalMs: 1000 })), /interval/i);
  assert.throws(() => normalizeSubscription(subscription({ qtypes: ["BAD"] })), /qtype/i);
  assert.throws(() => normalizeSubscription(subscription({ action: { type: "A", value: "bad" } })), /IPv4/i);
});

test("subscription manager loads verified cache before non-blocking refresh and keeps local precedence", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-policy-subscriptions-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const scheduled = [];
  const schedule = (callback, delay) => {
    const timer = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
    scheduled.push(timer);
    return timer;
  };
  const cancel = () => {};
  const localRules = [{
    id: "local-allow-shape",
    enabled: true,
    priority: 20,
    match: { name: { kind: "exact", value: "ads.example" } },
    action: { type: "A", value: "192.0.2.40" },
  }];
  const firstStore = new PolicyStore();
  const first = new PolicySubscriptionManager({
    directory,
    policyStore: firstStore,
    rules: localRules,
    subscriptions: [subscription()],
    fetch: async () => response("ads.example\n0.0.0.0 tracker.example\n"),
    schedule,
    cancel,
  });

  await first.start();
  await first.refresh("ads");
  assert.equal(firstStore.evaluate({ name: "ads.example", type: "A", clientIp: "192.0.2.1" }).ruleId, "local-allow-shape");
  assert.match(firstStore.evaluate({ name: "tracker.example", type: "A", clientIp: "192.0.2.1" }).source, /^subscription:ads$/);
  assert.equal(first.status()[0].domains, 2);
  assert.equal(scheduled.at(-1).delay, 6 * 60 * 60 * 1000);
  assert.equal(scheduled.at(-1).unrefCalled, true);
  await first.close();

  const secondStore = new PolicyStore();
  const failures = [];
  const second = new PolicySubscriptionManager({
    directory,
    policyStore: secondStore,
    rules: localRules,
    subscriptions: [subscription()],
    fetch: async () => { throw new Error("offline"); },
    schedule,
    cancel,
    onEvent: (event) => failures.push(event),
  });
  await second.start();
  assert.equal(secondStore.evaluate({ name: "tracker.example", type: "A", clientIp: "192.0.2.1" }).action.type, "NXDOMAIN");
  await assert.rejects(second.refresh("ads"), /offline/);
  assert.equal(secondStore.evaluate({ name: "tracker.example", type: "A", clientIp: "192.0.2.1" }).action.type, "NXDOMAIN");
  assert.equal(failures.at(-1).kind, "dns-policy-subscription-error");
  await second.close();
});

test("subscription refresh rejects malformed or oversized lists without replacing last-known-good", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-policy-subscriptions-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let source = "good.example\n";
  const store = new PolicyStore();
  const manager = new PolicySubscriptionManager({
    directory,
    policyStore: store,
    subscriptions: [subscription()],
    fetch: async () => response(source),
    maxBytes: 32,
    schedule: () => ({ unref() {} }),
    cancel: () => {},
  });
  await manager.start();
  await manager.refresh("ads");
  assert.equal(store.evaluate({ name: "good.example", type: "A" }).action.type, "NXDOMAIN");

  source = "bad_name.example\n";
  await assert.rejects(manager.refresh("ads"), /domain/i);
  assert.equal(store.evaluate({ name: "good.example", type: "A" }).action.type, "NXDOMAIN");

  source = "one.example\ntwo.example\nthree.example\n";
  await assert.rejects(manager.refresh("ads"), /size|large/i);
  assert.equal(store.evaluate({ name: "good.example", type: "A" }).action.type, "NXDOMAIN");
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.includes(".tmp")), []);
  await manager.close();
});

test("subscription manager pauses, resumes and atomically replaces configured rules", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-policy-subscriptions-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cancelled = [];
  const timers = [];
  const store = new PolicyStore();
  const manager = new PolicySubscriptionManager({
    directory,
    policyStore: store,
    rules: [],
    subscriptions: [subscription()],
    fetch: async (url) => response(url.includes("new.txt") ? "new.example\n" : "old.example\n"),
    schedule: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => cancelled.push(timer),
  });

  await manager.start();
  await manager.refresh("ads");
  manager.pause();
  assert.equal(cancelled.includes(timers[0]), true);

  await manager.replace({
    rules: [{
      id: "local-new",
      enabled: true,
      priority: 1,
      match: { name: { kind: "exact", value: "local.example" } },
      action: { type: "REFUSED" },
    }],
    subscriptions: [subscription({ url: "https://lists.example.test/new.txt" })],
  });
  assert.equal(store.evaluate({ name: "local.example", type: "A" }).ruleId, "local-new");
  assert.equal(store.evaluate({ name: "old.example", type: "A" }), null);

  await manager.start();
  await manager.refresh("ads");
  assert.equal(store.evaluate({ name: "new.example", type: "A" }).source, "subscription:ads");
  await manager.close();
  await assert.rejects(manager.start(), /closed/i);
});
