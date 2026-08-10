"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { DnsCache } = require("../../src/dns/cache");
const { buildResponse, createQuery, parseMessage } = require("../../src/dns/message");
const { RecordStore } = require("../../src/dns/records");
const { UpstreamError, createResolver } = require("../../src/dns/resolver");

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
