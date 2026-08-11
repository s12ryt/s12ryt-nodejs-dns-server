"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ConfigStore, DEFAULT_CONFIG } = require("../../src/admin/config-store");

test("configuration migration adds a schema version and rejects future schemas", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-config-version-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const legacy = structuredClone(DEFAULT_CONFIG);
  delete legacy.schemaVersion;
  await fs.writeFile(path.join(directory, "config.json"), JSON.stringify(legacy));

  const store = new ConfigStore({ directory, now: () => new Date(2026, 7, 11, 9, 0) });
  const migrated = await store.load();
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, "config.json"), "utf8")).schemaVersion, 3);

  const future = { ...migrated, schemaVersion: 4 };
  await fs.writeFile(path.join(directory, "config.json"), JSON.stringify(future));
  await assert.rejects(new ConfigStore({ directory }).load(), /newer configuration schema/i);
});

test("ConfigStore creates defaults and persists validated updates atomically", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-config-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ConfigStore({ directory });

  assert.deepEqual(await store.load(), DEFAULT_CONFIG);
  assert.deepEqual(store.get().tunnel, { token: "" });
  assert.deepEqual(store.get().domains, []);
  assert.deepEqual(store.get().proxy.trustedProxyCidrs, ["127.0.0.1/32", "::1/128"]);
  assert.equal(store.get().proxy.cacheMaxBytes, 1024 * 1024 * 1024);
  assert.deepEqual(store.get().observability, {
    metrics: { host: "127.0.0.1", port: 9090, sampleIntervalMs: 60000 },
    logs: { enabled: true, retentionDays: 30 },
    webhook: { enabled: false, url: "", secret: "" },
  });
  assert.deepEqual(store.get().dnsPolicy, { rules: [], subscriptions: [] });
  const updated = await store.update({
    ...store.get(),
    tunnel: { token: "saved-cloudflare-token" },
    records: [{ name: "home.test", type: "A", value: "192.0.2.10", ttl: 60 }],
  });
  assert.equal(updated.records[0].name, "home.test");
  assert.equal(updated.tunnel.token, "saved-cloudflare-token");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "config.json"), "utf8")), updated);
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.includes(".tmp")), []);
});

test("ConfigStore rejects invalid updates without changing memory or disk", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-config-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ConfigStore({ directory });
  await store.load();
  const before = store.get();

  await assert.rejects(store.update({ ...before, dns: { ...before.dns, port: 70000 } }), /port/i);
  await assert.rejects(store.update({ ...before, tunnel: { token: 42 } }), /token/i);
  assert.deepEqual(store.get(), before);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "config.json"), "utf8")), before);
});

test("ConfigStore migrates a legacy configuration without Tunnel or domain sections", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-config-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const legacy = structuredClone(DEFAULT_CONFIG);
  delete legacy.tunnel;
  delete legacy.domains;
  delete legacy.proxy.trustedProxyCidrs;
  delete legacy.proxy.cacheMaxBytes;
  delete legacy.observability;
  delete legacy.dnsPolicy;
  legacy.routes = [{ host: "legacy.test", target: "http://127.0.0.1:3000", enabled: true }];
  await fs.writeFile(path.join(directory, "config.json"), JSON.stringify(legacy), "utf8");

  const store = new ConfigStore({ directory });
  const loaded = await store.load();

  assert.deepEqual(loaded.tunnel, { token: "" });
  assert.deepEqual(loaded.domains, []);
  assert.deepEqual(loaded.proxy.trustedProxyCidrs, ["127.0.0.1/32", "::1/128"]);
  assert.equal(loaded.proxy.cacheMaxBytes, 1024 * 1024 * 1024);
  assert.deepEqual(loaded.observability, DEFAULT_CONFIG.observability);
  assert.deepEqual(loaded.dnsPolicy, { rules: [], subscriptions: [] });
  assert.equal(loaded.routes[0].locations[0].path, "/");
  assert.equal(loaded.routes[0].locations[0].upstreams[0].target, "http://127.0.0.1:3000");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "config.json"), "utf8")), loaded);
});

test("ConfigStore validates observability listener, retention and webhook secrets", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-config-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ConfigStore({ directory });
  await store.load();
  const current = store.get();

  await assert.rejects(store.update({
    ...current,
    observability: { ...current.observability, metrics: { ...current.observability.metrics, host: "0.0.0.0" } },
  }), /loopback|metrics host/i);
  await assert.rejects(store.update({
    ...current,
    observability: { ...current.observability, logs: { enabled: true, retentionDays: 0 } },
  }), /retention/i);
  await assert.rejects(store.update({
    ...current,
    observability: {
      ...current.observability,
      webhook: { enabled: true, url: "http://hooks.test/events", secret: "secret" },
    },
  }), /HTTPS/i);
  await assert.rejects(store.update({
    ...current,
    observability: {
      ...current.observability,
      webhook: { enabled: true, url: "https://hooks.test/events", secret: "" },
    },
  }), /secret/i);
});

test("ConfigStore migrates domains to primary zones and bumps only changed authority", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-config-zones-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const legacy = structuredClone(DEFAULT_CONFIG);
  legacy.schemaVersion = 1;
  legacy.domains = [{ name: "example.test", enabled: true, defaultTtl: 300, note: "legacy" }];
  legacy.records = [{ name: "www.example.test", type: "A", value: "192.0.2.10", ttl: 60, enabled: true }];
  await fs.writeFile(path.join(directory, "config.json"), JSON.stringify(legacy));
  const store = new ConfigStore({ directory, now: () => new Date(2026, 7, 11, 9, 0) });

  const migrated = await store.load();
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.domains[0].kind, "primary");
  assert.equal(migrated.domains[0].soa.serial, 2026081100);

  const authorityUpdate = structuredClone(migrated);
  authorityUpdate.records[0].value = "192.0.2.11";
  const changed = await store.update(authorityUpdate);
  assert.equal(changed.domains[0].soa.serial, 2026081101);

  const unrelatedUpdate = structuredClone(changed);
  unrelatedUpdate.proxy.timeoutMs += 1;
  const unchanged = await store.update(unrelatedUpdate);
  assert.equal(unchanged.domains[0].soa.serial, 2026081101);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "config.json"), "utf8")), unchanged);
});

test("ConfigStore validates and persists DNS policy rules", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-config-policy-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ConfigStore({ directory });
  await store.load();

  const current = store.get();
  const updated = await store.update({
    ...current,
    dnsPolicy: {
      rules: [{
        id: "block-tracking",
        enabled: true,
        priority: 10,
        match: {
          name: { kind: "suffix", value: "tracking.example" },
          qtypes: ["A", "AAAA"],
          clientCidrs: ["192.0.2.0/24"],
        },
        action: { type: "NXDOMAIN" },
      }],
      subscriptions: [{
        id: "tracking-list",
        enabled: true,
        url: "https://lists.example.test/tracking.txt",
        priority: 20,
        refreshIntervalMs: 360000,
        qtypes: ["a", "AAAA", "A"],
        action: { type: "NXDOMAIN" },
      }],
    },
  });

  assert.equal(updated.dnsPolicy.rules[0].id, "block-tracking");
  assert.deepEqual(updated.dnsPolicy.subscriptions[0].qtypes, ["A", "AAAA"]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "config.json"), "utf8")).dnsPolicy, updated.dnsPolicy);

  const invalid = structuredClone(updated);
  invalid.dnsPolicy.rules[0].match.clientCidrs = ["not-a-cidr"];
  await assert.rejects(store.update(invalid), /CIDR/i);
  assert.deepEqual(store.get(), updated);

  const insecure = structuredClone(updated);
  insecure.dnsPolicy.subscriptions[0].url = "http://lists.example.test/tracking.txt";
  await assert.rejects(store.update(insecure), /HTTPS/i);
  assert.deepEqual(store.get(), updated);
});

test("ConfigStore assigns stable UUIDs to records and rejects duplicate identifiers", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-config-record-ids-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const legacy = structuredClone(DEFAULT_CONFIG);
  legacy.schemaVersion = 1;
  legacy.records = [{ name: "one.example.test", type: "A", value: "192.0.2.1", ttl: 60 }];
  await fs.writeFile(path.join(directory, "config.json"), JSON.stringify(legacy));
  const store = new ConfigStore({ directory });

  const migrated = await store.load();
  assert.match(migrated.records[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, "config.json"), "utf8")).records[0].id, migrated.records[0].id);

  const withNewRecord = structuredClone(migrated);
  withNewRecord.records.push({ name: "two.example.test", type: "A", value: "192.0.2.2", ttl: 60 });
  const updated = await store.update(withNewRecord);
  assert.equal(updated.records[0].id, migrated.records[0].id);
  assert.match(updated.records[1].id, /^[0-9a-f-]{36}$/);

  const duplicate = structuredClone(updated);
  duplicate.records[1].id = duplicate.records[0].id;
  await assert.rejects(store.update(duplicate), /duplicate record id/i);

  const malformed = structuredClone(updated);
  malformed.records[1].id = "not-a-uuid";
  await assert.rejects(store.update(malformed), /record id/i);
  assert.deepEqual(store.get(), updated);
});
