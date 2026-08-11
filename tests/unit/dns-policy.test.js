"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { PolicyStore, parseHostsList } = require("../../src/dns/policy");

function request(name, type = "A", overrides = {}) {
  return {
    name,
    type,
    clientIp: "192.0.2.25",
    now: new Date("2026-08-12T02:30:00.000Z"),
    ...overrides,
  };
}

test("policy rules use priority then stable configuration order", () => {
  const store = new PolicyStore({
    rules: [
      { id: "later", priority: 20, match: { name: { kind: "suffix", value: "example.test" } }, action: { type: "REFUSED" } },
      { id: "first-at-priority", priority: 10, match: { name: { kind: "exact", value: "www.example.test" } }, action: { type: "A", value: "192.0.2.10" } },
      { id: "second-at-priority", priority: 10, match: { name: { kind: "exact", value: "www.example.test" } }, action: { type: "NXDOMAIN" } },
    ],
  });

  assert.deepEqual(store.evaluate(request("www.example.test")), {
    ruleId: "first-at-priority",
    source: "local",
    action: { type: "A", value: "192.0.2.10", ttl: 60 },
  });
});

test("policy name, qtype and client CIDR matchers compose", () => {
  const store = new PolicyStore({
    rules: [
      {
        id: "wildcard-v6",
        priority: 1,
        match: {
          name: { kind: "wildcard", value: "*.blocked.example" },
          qtypes: ["AAAA"],
          clientCidrs: ["2001:db8::/32"],
        },
        action: { type: "AAAA", value: "2001:db8::53", ttl: 120 },
      },
      {
        id: "suffix-v4",
        priority: 2,
        match: {
          name: { kind: "suffix", value: "blocked.example" },
          qtypes: ["A"],
          clientCidrs: ["192.0.2.0/24"],
        },
        action: { type: "CNAME", value: "notice.example", ttl: 30 },
      },
    ],
  });

  assert.equal(store.evaluate(request("blocked.example", "AAAA", { clientIp: "2001:db8::1" })), null);
  assert.equal(store.evaluate(request("api.blocked.example", "AAAA", { clientIp: "2001:db9::1" })), null);
  assert.equal(store.evaluate(request("other.example", "A")), null);
  assert.equal(store.evaluate(request("api.blocked.example", "AAAA", { clientIp: "2001:db8::1" })).ruleId, "wildcard-v6");
  assert.deepEqual(store.evaluate(request("blocked.example", "A")).action, {
    type: "CNAME",
    value: "notice.example",
    ttl: 30,
  });
});

test("policy schedules honor IANA time zones, weekdays and overnight windows", () => {
  const store = new PolicyStore({
    rules: [
      {
        id: "taipei-office",
        priority: 1,
        match: {
          name: { kind: "exact", value: "office.example" },
          schedule: { timezone: "Asia/Taipei", weekdays: ["wed"], start: "09:00", end: "18:00" },
        },
        action: { type: "REFUSED" },
      },
      {
        id: "new-york-overnight",
        priority: 2,
        match: {
          name: { kind: "exact", value: "night.example" },
          schedule: { timezone: "America/New_York", weekdays: ["tue"], start: "22:00", end: "02:00" },
        },
        action: { type: "NXDOMAIN" },
      },
    ],
  });

  assert.equal(store.evaluate(request("office.example")).ruleId, "taipei-office");
  assert.equal(store.evaluate(request("office.example", "A", { now: new Date("2026-08-12T11:00:00.000Z") })), null);
  assert.equal(store.evaluate(request("night.example", "A", { now: new Date("2026-08-12T05:30:00.000Z") })).ruleId, "new-york-overnight");
  assert.equal(store.evaluate(request("night.example", "A", { now: new Date("2026-08-12T07:00:00.000Z") })), null);
});

test("disabled rules are ignored and all supported actions are normalized", () => {
  const disabled = new PolicyStore({
    rules: [{ id: "off", enabled: false, priority: 1, match: { name: { kind: "exact", value: "off.example" } }, action: { type: "NXDOMAIN" } }],
  });
  assert.equal(disabled.evaluate(request("off.example")), null);

  for (const action of [
    { type: "NXDOMAIN" },
    { type: "REFUSED" },
    { type: "A", value: "0.0.0.0" },
    { type: "AAAA", value: "::" },
    { type: "CNAME", value: "blocked.example" },
  ]) {
    const store = new PolicyStore({
      rules: [{ id: action.type, priority: 1, match: { name: { kind: "exact", value: "target.example" } }, action }],
    });
    const type = ["A", "AAAA"].includes(action.type) ? action.type : "A";
    assert.equal(store.evaluate(request("target.example", type)).action.type, action.type);
  }
});

test("hosts subscriptions parse domains deterministically and reject malformed input", () => {
  assert.deepEqual(parseHostsList(`
    # comment
    blocked.example
    0.0.0.0 ads.example tracker.example # hosts comment
    :: ipv6-block.example
    blocked.example
  `), ["ads.example", "blocked.example", "ipv6-block.example", "tracker.example"]);

  assert.throws(() => parseHostsList("https://bad.example/path"), /domain/i);
  assert.throws(() => parseHostsList("0.0.0.0"), /domain/i);
  assert.throws(() => parseHostsList("bad_name.example"), /domain/i);
});
