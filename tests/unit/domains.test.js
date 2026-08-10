"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applyDomainState,
  classifyDomain,
  createDomainPlan,
  deleteDomainTree,
  qualifyDomainName,
  renameDomainTree,
  setDomainEnabled,
  updateDomain,
} = require("../../src/admin/domains");

function sampleConfig() {
  return {
    domains: [
      { name: "example.test", enabled: true, defaultTtl: 300, note: "parent" },
      { name: "dev.example.test", enabled: true, defaultTtl: 60, note: "child" },
      { name: "other.test", enabled: true, defaultTtl: 120, note: "" },
    ],
    records: [
      { name: "www.example.test", type: "A", value: "192.0.2.10", ttl: 300, enabled: true },
      { name: "api.dev.example.test", type: "A", value: "192.0.2.11", ttl: 60, enabled: true },
      { name: "off.dev.example.test", type: "A", value: "192.0.2.12", ttl: 60, enabled: false },
      { name: "outside.invalid", type: "A", value: "192.0.2.13", ttl: 60, enabled: true },
    ],
    routes: [
      { host: "app.example.test", aliases: ["www.example.test", "*.dev.example.test"], target: "http://127.0.0.1:3000", enabled: true },
      { host: "outside.invalid", target: "http://127.0.0.1:4000", enabled: true },
    ],
  };
}

test("domain workspaces classify by longest suffix and qualify relative DNS names", () => {
  const domains = sampleConfig().domains;

  assert.equal(classifyDomain(domains, "api.dev.example.test").name, "dev.example.test");
  assert.equal(classifyDomain(domains, "www.example.test").name, "example.test");
  assert.equal(classifyDomain(domains, "outside.invalid"), null);
  assert.equal(qualifyDomainName("example.test", "@"), "example.test");
  assert.equal(qualifyDomainName("example.test", "www"), "www.example.test");
  assert.equal(qualifyDomainName("example.test", "*"), "*.example.test");
  assert.equal(qualifyDomainName("example.test", "_service._tcp"), "_service._tcp.example.test");
  assert.equal(qualifyDomainName("example.test", "api.example.test."), "api.example.test");
  assert.throws(() => qualifyDomainName("example.test", "api.other.test."), /outside/i);
});

test("disabled parent domains suspend descendants without overwriting child item flags", () => {
  const disabled = setDomainEnabled(sampleConfig(), "example.test", false);
  const effective = applyDomainState(disabled);

  assert.equal(disabled.domains.find(({ name }) => name === "dev.example.test").enabled, true);
  assert.equal(disabled.records.find(({ name }) => name === "api.dev.example.test").enabled, true);
  assert.equal(effective.records.find(({ name }) => name === "api.dev.example.test").enabled, false);
  assert.equal(effective.routes.find(({ host }) => host === "app.example.test").enabled, false);
  assert.equal(effective.records.find(({ name }) => name === "outside.invalid").enabled, true);
});

test("domain tree rename and delete update all owned DNS and proxy names atomically", () => {
  const original = sampleConfig();
  const renamed = renameDomainTree(original, "example.test", "renamed.test");

  assert.deepEqual(renamed.domains.map(({ name }) => name), ["renamed.test", "dev.renamed.test", "other.test"]);
  assert.equal(renamed.records[0].name, "www.renamed.test");
  assert.equal(renamed.records[1].name, "api.dev.renamed.test");
  assert.equal(renamed.routes[0].host, "app.renamed.test");
  assert.deepEqual(renamed.routes[0].aliases, ["www.renamed.test", "*.dev.renamed.test"]);
  assert.equal(original.domains[0].name, "example.test");

  const deleted = deleteDomainTree(renamed, "renamed.test");
  assert.deepEqual(deleted.domains.map(({ name }) => name), ["other.test"]);
  assert.deepEqual(deleted.records.map(({ name }) => name), ["outside.invalid"]);
  assert.deepEqual(deleted.routes.map(({ host }) => host), ["outside.invalid"]);

  const conflicting = sampleConfig();
  conflicting.domains.push({ name: "renamed.test", enabled: true, defaultTtl: 300, note: "conflict" });
  assert.throws(() => renameDomainTree(conflicting, "example.test", "renamed.test"), /conflict/i);
  assert.equal(conflicting.domains[0].name, "example.test");
});

test("domain metadata updates preserve the workspace tree", () => {
  const updated = updateDomain(sampleConfig(), "example.test", {
    enabled: false,
    defaultTtl: 900,
    note: "maintenance",
  });

  assert.deepEqual(updated.domains[0], {
    name: "example.test",
    enabled: false,
    defaultTtl: 900,
    note: "maintenance",
  });
  assert.equal(updated.domains[1].name, "dev.example.test");
});

test("website domain plan previews records and proxy additions without mutating config", () => {
  const config = { domains: [], records: [], routes: [] };
  const plan = createDomainPlan(config, {
    name: "site.example",
    enabled: true,
    defaultTtl: 180,
    note: "website",
    website: {
      ipv4: "192.0.2.40",
      ipv6: "2001:db8::40",
      createWww: true,
      upstreamUrl: "http://127.0.0.1:3000",
    },
  });

  assert.deepEqual(plan.additions.records.map(({ name, type }) => ({ name, type })), [
    { name: "site.example", type: "A" },
    { name: "site.example", type: "AAAA" },
    { name: "www.site.example", type: "CNAME" },
  ]);
  assert.deepEqual(plan.additions.routes, [{
    host: "site.example",
    aliases: ["www.site.example"],
    target: "http://127.0.0.1:3000",
    enabled: true,
  }]);
  assert.deepEqual(config, { domains: [], records: [], routes: [] });
});
