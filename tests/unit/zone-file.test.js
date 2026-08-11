"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  exportZoneFile,
  parseZoneFile,
  planZoneImport,
} = require("../../src/dns/zone-file");

const SOURCE = `
$ORIGIN example.test.
$TTL 300
@ IN SOA ns1.example.test. hostmaster.example.test. (
  2026081105 ; serial
  3600       ; refresh
  600        ; retry
  1209600    ; expire
  300        ; minimum
)
  IN NS ns1.example.test.
ns1 IN A 192.0.2.53
www 60 IN A 192.0.2.20
ipv6 IN AAAA 2001:db8::20
alias IN CNAME www
@ IN MX 10 mail
@ IN TXT "self hosted dns"
_http._tcp IN SRV 1 5 8080 www
`;

test("zone file parser accepts common BIND syntax and every supported type", () => {
  const parsed = parseZoneFile(SOURCE, { origin: "example.test" });

  assert.equal(parsed.origin, "example.test");
  assert.deepEqual(parsed.soa, {
    mname: "ns1.example.test",
    rname: "hostmaster.example.test",
    serial: 2026081105,
    refresh: 3600,
    retry: 600,
    expire: 1209600,
    minimum: 300,
  });
  assert.deepEqual(parsed.records.map(({ name, type, ttl }) => ({ name, type, ttl })), [
    { name: "_http._tcp.example.test", type: "SRV", ttl: 300 },
    { name: "alias.example.test", type: "CNAME", ttl: 300 },
    { name: "example.test", type: "MX", ttl: 300 },
    { name: "example.test", type: "NS", ttl: 300 },
    { name: "example.test", type: "TXT", ttl: 300 },
    { name: "ipv6.example.test", type: "AAAA", ttl: 300 },
    { name: "ns1.example.test", type: "A", ttl: 300 },
    { name: "www.example.test", type: "A", ttl: 60 },
  ]);
  assert.equal(parsed.records.find(({ type }) => type === "CNAME").value, "www.example.test");
  assert.equal(parsed.records.find(({ type }) => type === "TXT").value, "self hosted dns");
});

test("zone file export is stable and can be imported again", () => {
  const parsed = parseZoneFile(SOURCE, { origin: "example.test" });
  const text = exportZoneFile({
    domain: { name: parsed.origin, defaultTtl: 300, soa: parsed.soa },
    records: parsed.records,
  });
  const roundTrip = parseZoneFile(text, { origin: "example.test" });

  assert.match(text, /^\$ORIGIN example\.test\./m);
  assert.match(text, /^\$TTL 300$/m);
  assert.deepEqual(roundTrip, parsed);
  assert.equal(exportZoneFile({
    domain: { name: parsed.origin, defaultTtl: 300, soa: parsed.soa },
    records: [...parsed.records].reverse(),
  }), text);
});

test("zone file parser rejects unknown syntax and out-of-zone owners", () => {
  assert.throws(
    () => parseZoneFile("$ORIGIN example.test.\n@ IN CAA 0 issue ca.test.", { origin: "example.test" }),
    /unsupported.*CAA/i,
  );
  assert.throws(
    () => parseZoneFile("$ORIGIN example.test.\noutside.test. IN A 192.0.2.1", { origin: "example.test" }),
    /outside.*zone/i,
  );
  assert.throws(
    () => parseZoneFile("$INCLUDE other.zone", { origin: "example.test" }),
    /unsupported.*directive/i,
  );
});

function importConfig() {
  return {
    domains: [
      {
        name: "example.test",
        enabled: true,
        defaultTtl: 300,
        kind: "primary",
        soa: {
          mname: "ns1.example.test",
          rname: "hostmaster.example.test",
          serial: 2026081101,
          refresh: 3600,
          retry: 600,
          expire: 1209600,
          minimum: 300,
        },
      },
      { name: "child.example.test", enabled: true, defaultTtl: 60 },
    ],
    records: [
      { id: "00000000-0000-4000-8000-000000000001", name: "www.example.test", type: "A", value: "192.0.2.20", ttl: 60, enabled: true },
      { id: "00000000-0000-4000-8000-000000000002", name: "api.example.test", type: "A", value: "192.0.2.21", ttl: 60, enabled: true },
      { id: "00000000-0000-4000-8000-000000000003", name: "app.child.example.test", type: "A", value: "192.0.2.30", ttl: 60, enabled: true },
    ],
    routes: [],
  };
}

test("zone imports merge or replace direct records atomically and preserve child zones", () => {
  const parsed = parseZoneFile(`
$ORIGIN example.test.
$TTL 60
@ IN SOA ns1 hostmaster (2026081205 3600 600 1209600 300)
www IN A 192.0.2.20
new IN A 192.0.2.40
`, { origin: "example.test" });
  let uuidSequence = 10;
  const uuid = () => `00000000-0000-4000-8000-${String(uuidSequence++).padStart(12, "0")}`;

  const merged = planZoneImport(importConfig(), "example.test", parsed, {
    mode: "merge",
    uuid,
    now: new Date(2026, 7, 12, 9, 0),
  });
  assert.deepEqual(merged.summary, { added: 1, removed: 0, skipped: 1 });
  assert.equal(merged.config.records.some(({ name }) => name === "api.example.test"), true);
  assert.equal(merged.config.records.some(({ name }) => name === "app.child.example.test"), true);
  assert.equal(merged.config.domains[0].soa.serial, 2026081205);

  const replaced = planZoneImport(importConfig(), "example.test", parsed, {
    mode: "replace",
    uuid,
    now: new Date(2026, 7, 12, 9, 0),
  });
  assert.deepEqual(replaced.summary, { added: 2, removed: 2, skipped: 0 });
  assert.equal(replaced.config.records.some(({ name }) => name === "api.example.test"), false);
  assert.equal(replaced.config.records.some(({ name }) => name === "app.child.example.test"), true);
});

test("zone import rejects CNAME coexistence without mutating the input", () => {
  const config = importConfig();
  const parsed = parseZoneFile("$ORIGIN example.test.\nwww IN CNAME target.example.test.", { origin: "example.test" });

  assert.throws(
    () => planZoneImport(config, "example.test", parsed, { mode: "merge" }),
    /CNAME.*coexist/i,
  );
  assert.equal(config.records.length, 3);
  assert.equal(config.domains[0].soa.serial, 2026081101);
});
