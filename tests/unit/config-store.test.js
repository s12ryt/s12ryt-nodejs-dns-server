"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ConfigStore, DEFAULT_CONFIG } = require("../../src/admin/config-store");

test("ConfigStore creates defaults and persists validated updates atomically", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-config-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ConfigStore({ directory });

  assert.deepEqual(await store.load(), DEFAULT_CONFIG);
  assert.deepEqual(store.get().tunnel, { token: "" });
  assert.deepEqual(store.get().domains, []);
  assert.deepEqual(store.get().proxy.trustedProxyCidrs, ["127.0.0.1/32", "::1/128"]);
  assert.equal(store.get().proxy.cacheMaxBytes, 1024 * 1024 * 1024);
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
  legacy.routes = [{ host: "legacy.test", target: "http://127.0.0.1:3000", enabled: true }];
  await fs.writeFile(path.join(directory, "config.json"), JSON.stringify(legacy), "utf8");

  const store = new ConfigStore({ directory });
  const loaded = await store.load();

  assert.deepEqual(loaded.tunnel, { token: "" });
  assert.deepEqual(loaded.domains, []);
  assert.deepEqual(loaded.proxy.trustedProxyCidrs, ["127.0.0.1/32", "::1/128"]);
  assert.equal(loaded.proxy.cacheMaxBytes, 1024 * 1024 * 1024);
  assert.equal(loaded.routes[0].locations[0].path, "/");
  assert.equal(loaded.routes[0].locations[0].upstreams[0].target, "http://127.0.0.1:3000");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "config.json"), "utf8")), loaded);
});
