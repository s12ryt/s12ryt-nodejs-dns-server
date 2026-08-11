"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { ZoneStore } = require("../../src/dns/zones");

function createStore() {
  return new ZoneStore({
    domains: [{
      name: "example.test",
      enabled: true,
      defaultTtl: 300,
      soa: {
        mname: "ns1.example.test",
        rname: "hostmaster.example.test",
        serial: 2026081101,
        refresh: 3600,
        retry: 600,
        expire: 1209600,
        minimum: 300,
      },
    }],
    records: [
      { name: "example.test", type: "A", value: "192.0.2.10", ttl: 120 },
      { name: "www.example.test", type: "A", value: "192.0.2.20", ttl: 120 },
      { name: "*.wild.example.test", type: "A", value: "192.0.2.30", ttl: 60 },
      { name: "delegated.example.test", type: "NS", value: "ns.delegated.example.test", ttl: 600 },
      { name: "ns.delegated.example.test", type: "A", value: "192.0.2.53", ttl: 600 },
      { name: "ns.external.test", type: "A", value: "198.51.100.53", ttl: 600 },
      { name: "external.example.test", type: "NS", value: "ns.external.test", ttl: 600 },
    ],
  });
}

test("ZoneStore returns the editable SOA at the zone apex", () => {
  const result = createStore().resolve("example.test", "SOA");

  assert.equal(result.authoritative, true);
  assert.equal(result.rcode, "NOERROR");
  assert.equal(result.answers.length, 1);
  assert.deepEqual(result.answers[0], {
    name: "example.test",
    type: "SOA",
    ttl: 300,
    mname: "ns1.example.test",
    rname: "hostmaster.example.test",
    serial: 2026081101,
    refresh: 3600,
    retry: 600,
    expire: 1209600,
    minimum: 300,
  });
});

test("ZoneStore distinguishes NODATA from NXDOMAIN with an authority SOA", () => {
  const nodata = createStore().resolve("www.example.test", "AAAA");
  const missing = createStore().resolve("missing.example.test", "A");

  assert.equal(nodata.rcode, "NOERROR");
  assert.deepEqual(nodata.answers, []);
  assert.equal(nodata.authorities[0].type, "SOA");

  assert.equal(missing.rcode, "NXDOMAIN");
  assert.deepEqual(missing.answers, []);
  assert.equal(missing.authorities[0].type, "SOA");
});

test("ZoneStore materializes the closest wildcard owner", () => {
  const result = createStore().resolve("api.wild.example.test", "A");

  assert.equal(result.rcode, "NOERROR");
  assert.deepEqual(result.answers, [{
    name: "api.wild.example.test",
    sourceName: "*.wild.example.test",
    type: "A",
    value: "192.0.2.30",
    ttl: 60,
    enabled: true,
  }]);
});

test("ZoneStore returns delegation NS records and in-zone glue", () => {
  const delegated = createStore().resolve("app.delegated.example.test", "A");
  const external = createStore().resolve("app.external.example.test", "A");

  assert.equal(delegated.authoritative, false);
  assert.equal(delegated.rcode, "NOERROR");
  assert.deepEqual(delegated.answers, []);
  assert.equal(delegated.authorities[0].name, "delegated.example.test");
  assert.equal(delegated.authorities[0].type, "NS");
  assert.equal(delegated.additionals[0].name, "ns.delegated.example.test");
  assert.equal(delegated.additionals[0].type, "A");

  assert.equal(external.authoritative, false);
  assert.equal(external.authorities[0].value, "ns.external.test");
  assert.deepEqual(external.additionals, []);
});

test("ZoneStore ignores names outside enabled zones", () => {
  const store = createStore();

  assert.equal(store.resolve("outside.test", "A"), null);
});
