"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { DnsCache } = require("../../src/dns/cache");
const { buildResponse, createQuery, parseMessage } = require("../../src/dns/message");
const { RecordStore } = require("../../src/dns/records");
const { PolicyStore } = require("../../src/dns/policy");
const { UpstreamError, createResolver } = require("../../src/dns/resolver");
const { ZoneStore } = require("../../src/dns/zones");

test("resolver answers custom records without contacting upstreams", async () => {
  let upstreamCalls = 0;
  const resolver = createResolver({
    records: new RecordStore([
      { name: "home.example.test", type: "A", value: "192.0.2.20", ttl: 45 },
    ]),
    upstreams: [{ resolve: async () => { upstreamCalls += 1; } }],
  });

  const response = parseMessage(await resolver.resolve(createQuery("home.example.test", "A")));

  assert.equal(response.flags.aa, true);
  assert.equal(response.answers[0].address, "192.0.2.20");
  assert.equal(upstreamCalls, 0);
});

test("resolver follows a custom CNAME to a custom address", async () => {
  const resolver = createResolver({
    records: new RecordStore([
      { name: "app.example.test", type: "CNAME", value: "origin.example.test", ttl: 120 },
      { name: "origin.example.test", type: "A", value: "192.0.2.80", ttl: 45 },
    ]),
    upstreams: [],
  });

  const response = parseMessage(await resolver.resolve(createQuery("app.example.test", "A")));

  assert.equal(response.flags.rcode, 0);
  assert.deepEqual(response.answers.map((answer) => answer.type), ["CNAME", "A"]);
  assert.equal(response.answers[0].value, "origin.example.test");
  assert.equal(response.answers[1].name, "origin.example.test");
  assert.equal(response.answers[1].address, "192.0.2.80");
});

test("resolver follows a custom CNAME through upstream resolution", async () => {
  const upstreamQuestions = [];
  const resolver = createResolver({
    records: new RecordStore([
      { name: "public.example.test", type: "CNAME", value: "origin.public.test", ttl: 120 },
    ]),
    upstreams: [{
      name: "test-upstream",
      resolve: async (queryWire) => {
        const query = parseMessage(queryWire);
        upstreamQuestions.push(query.questions[0]);
        return buildResponse(queryWire, [
          { name: "origin.public.test", type: "A", value: "198.51.100.90", ttl: 60 },
        ]);
      },
    }],
  });

  const response = parseMessage(await resolver.resolve(createQuery("public.example.test", "A")));

  assert.deepEqual(upstreamQuestions.map(({ name, type }) => ({ name, type })), [
    { name: "origin.public.test", type: "A" },
  ]);
  assert.deepEqual(response.answers.map((answer) => answer.type), ["CNAME", "A"]);
  assert.equal(response.answers[1].address, "198.51.100.90");
});

test("resolver returns SERVFAIL for a custom CNAME cycle", async () => {
  let upstreamCalls = 0;
  const resolver = createResolver({
    records: new RecordStore([
      { name: "one.example.test", type: "CNAME", value: "two.example.test", ttl: 120 },
      { name: "two.example.test", type: "CNAME", value: "one.example.test", ttl: 120 },
    ]),
    upstreams: [{ resolve: async () => { upstreamCalls += 1; } }],
  });

  const response = parseMessage(await resolver.resolve(createQuery("one.example.test", "A")));

  assert.equal(response.flags.rcode, 2);
  assert.equal(response.answers.length, 0);
  assert.equal(upstreamCalls, 0);
});

test("resolver diagnostics report rcode, source chain and complete answers", async () => {
  const resolver = createResolver({
    records: new RecordStore([
      { name: "diagnose.example.test", type: "CNAME", value: "origin.diagnose.test", ttl: 120 },
    ]),
    upstreams: [{
      name: "diagnostic-upstream",
      resolve: async (queryWire) => buildResponse(queryWire, [
        { name: "origin.diagnose.test", type: "A", value: "203.0.113.50", ttl: 60 },
      ]),
    }],
  });

  const result = await resolver.diagnose("diagnose.example.test", "A");

  assert.equal(result.name, "diagnose.example.test");
  assert.equal(result.type, "A");
  assert.equal(result.rcode, "NOERROR");
  assert.deepEqual(result.sources, ["custom", "diagnostic-upstream"]);
  assert.deepEqual(result.answers.map((answer) => answer.type), ["CNAME", "A"]);
  assert.equal(result.answers[0].value, "origin.diagnose.test");
  assert.equal(result.answers[1].address, "203.0.113.50");
});

test("resolver emits one timed client event for a complete CNAME chain", async () => {
  const events = [];
  const resolver = createResolver({
    records: new RecordStore([
      { name: "alias.telemetry.test", type: "CNAME", value: "target.telemetry.test", ttl: 60 },
      { name: "target.telemetry.test", type: "A", value: "192.0.2.88", ttl: 60 },
    ]),
    onEvent: (event) => events.push(event),
  });

  await resolver.resolve(createQuery("alias.telemetry.test", "A"), {
    transport: "doh",
    clientIp: "192.0.2.7",
    method: "POST",
  });

  const queries = events.filter((event) => event.kind === "dns");
  assert.equal(queries.length, 1);
  assert.equal(queries[0].name, "alias.telemetry.test");
  assert.equal(queries[0].type, "A");
  assert.equal(queries[0].source, "custom");
  assert.equal(queries[0].rcode, "NOERROR");
  assert.equal(queries[0].transport, "doh");
  assert.equal(queries[0].clientIp, "192.0.2.7");
  assert.equal(Number.isFinite(queries[0].durationMs), true);
});

test("resolver fails over retryable errors, caches success, and rewrites transaction IDs", async () => {
  let firstCalls = 0;
  let secondCalls = 0;
  const cache = new DnsCache({ maxEntries: 10 });
  const resolver = createResolver({
    records: new RecordStore([]),
    cache,
    upstreams: [
      { resolve: async () => { firstCalls += 1; throw new UpstreamError("timeout", { retryable: true }); } },
      { resolve: async (query) => {
        secondCalls += 1;
        return buildResponse(query, [
          { name: "public.example", type: "A", value: "198.51.100.5", ttl: 60 },
        ]);
      } },
    ],
  });

  const first = parseMessage(await resolver.resolve(createQuery("public.example", "A", { id: 1 })));
  const cached = parseMessage(await resolver.resolve(createQuery("public.example", "A", { id: 2 })));

  assert.equal(first.answers[0].address, "198.51.100.5");
  assert.equal(cached.id, 2);
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);
});

test("resolver does not fail over a valid NXDOMAIN or a terminal upstream error", async () => {
  for (const firstResult of [
    (query) => buildResponse(query, [], { rcode: "NXDOMAIN" }),
    () => { throw new UpstreamError("HTTP 429", { retryable: false }); },
  ]) {
    let secondCalls = 0;
    const resolver = createResolver({
      records: new RecordStore([]),
      upstreams: [
        { resolve: async (query) => firstResult(query) },
        { resolve: async () => { secondCalls += 1; throw new Error("must not run"); } },
      ],
    });

    const response = parseMessage(await resolver.resolve(createQuery("missing.example", "A")));
    assert.equal(secondCalls, 0);
    assert.ok([2, 3].includes(response.flags.rcode));
  }
});

test("resolver returns NOTIMP for zone transfer queries", async () => {
  const resolver = createResolver({ records: new RecordStore([]), upstreams: [] });

  const response = parseMessage(await resolver.resolve(createQuery("example.test", "AXFR")));

  assert.equal(response.flags.rcode, 4);
});

test("resolver serves authoritative NXDOMAIN and NODATA without querying upstreams", async () => {
  let upstreamCalls = 0;
  const domains = [{ name: "example.test", enabled: true, defaultTtl: 300 }];
  const zoneRecords = [{ name: "www.example.test", type: "A", value: "192.0.2.20", ttl: 60 }];
  const resolver = createResolver({
    records: new RecordStore(zoneRecords),
    zones: new ZoneStore({ domains, records: zoneRecords }),
    upstreams: [{ resolve: async () => { upstreamCalls += 1; } }],
  });

  const nodata = parseMessage(await resolver.resolve(createQuery("www.example.test", "AAAA")));
  const missing = parseMessage(await resolver.resolve(createQuery("missing.example.test", "A")));

  assert.equal(nodata.flags.rcode, 0);
  assert.equal(nodata.flags.aa, true);
  assert.equal(nodata.authorities[0].type, "SOA");
  assert.equal(missing.flags.rcode, 3);
  assert.equal(missing.flags.aa, true);
  assert.equal(missing.authorities[0].type, "SOA");
  assert.equal(upstreamCalls, 0);
});

test("resolver follows zone CNAME chains and emits delegation glue referrals", async () => {
  const records = [
    { name: "alias.example.test", type: "CNAME", value: "origin.example.test", ttl: 120 },
    { name: "origin.example.test", type: "A", value: "192.0.2.80", ttl: 60 },
    { name: "delegated.example.test", type: "NS", value: "ns.delegated.example.test", ttl: 600 },
    { name: "ns.delegated.example.test", type: "A", value: "192.0.2.53", ttl: 600 },
  ];
  const zones = new ZoneStore({ domains: [{ name: "example.test", enabled: true }], records });
  const resolver = createResolver({ records: new RecordStore(records), zones });

  const alias = parseMessage(await resolver.resolve(createQuery("alias.example.test", "A")));
  const referral = parseMessage(await resolver.resolve(createQuery("app.delegated.example.test", "A")));

  assert.deepEqual(alias.answers.map(({ type }) => type), ["CNAME", "A"]);
  assert.equal(alias.flags.aa, true);
  assert.equal(referral.flags.aa, false);
  assert.equal(referral.authorities[0].type, "NS");
  assert.equal(referral.additionals[0].address, "192.0.2.53");
});

test("resolver applies DNS policy before zones, custom records and upstreams", async () => {
  let upstreamCalls = 0;
  const events = [];
  const records = new RecordStore([
    { name: "blocked.example.test", type: "A", value: "192.0.2.10", ttl: 60 },
  ]);
  const resolver = createResolver({
    records,
    zones: new ZoneStore({ domains: [{ name: "example.test", enabled: true }], records: records.toJSON() }),
    policies: new PolicyStore({
      rules: [
        { id: "deny-zone", priority: 1, match: { name: { kind: "exact", value: "blocked.example.test" } }, action: { type: "NXDOMAIN" } },
        { id: "refuse", priority: 1, match: { name: { kind: "exact", value: "refused.public.test" } }, action: { type: "REFUSED" } },
        { id: "sinkhole", priority: 1, match: { name: { kind: "exact", value: "sink.public.test" }, qtypes: ["A"] }, action: { type: "A", value: "0.0.0.0", ttl: 120 } },
      ],
    }),
    upstreams: [{ resolve: async () => { upstreamCalls += 1; throw new Error("must not run"); } }],
    onEvent: (event) => events.push(event),
  });

  const blocked = parseMessage(await resolver.resolve(createQuery("blocked.example.test", "A"), { clientIp: "192.0.2.20" }));
  const refused = parseMessage(await resolver.resolve(createQuery("refused.public.test", "A"), { clientIp: "192.0.2.20" }));
  const sinkhole = parseMessage(await resolver.resolve(createQuery("sink.public.test", "A"), { clientIp: "192.0.2.20" }));

  assert.equal(blocked.flags.rcode, 3);
  assert.equal(refused.flags.rcode, 5);
  assert.equal(sinkhole.answers[0].address, "0.0.0.0");
  assert.equal(sinkhole.answers[0].ttl, 120);
  assert.equal(upstreamCalls, 0);
  assert.equal(events.at(-1).source, "policy");
  assert.equal(events.at(-1).policyRule, "sinkhole");
  assert.equal(events.at(-1).policyAction, "A");
});

test("resolver follows a policy CNAME action to its final address", async () => {
  const resolver = createResolver({
    records: new RecordStore([
      { name: "target.policy.test", type: "A", value: "192.0.2.90", ttl: 45 },
    ]),
    policies: new PolicyStore({
      rules: [{
        id: "redirect",
        priority: 1,
        match: { name: { kind: "exact", value: "alias.policy.test" }, qtypes: ["A"] },
        action: { type: "CNAME", value: "target.policy.test", ttl: 90 },
      }],
    }),
  });

  const response = parseMessage(await resolver.resolve(createQuery("alias.policy.test", "A")));
  assert.deepEqual(response.answers.map((answer) => answer.type), ["CNAME", "A"]);
  assert.equal(response.answers[0].value, "target.policy.test");
  assert.equal(response.answers[1].address, "192.0.2.90");
});
