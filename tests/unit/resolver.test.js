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
