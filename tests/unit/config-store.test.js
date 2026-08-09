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

test("ConfigStore migrates a legacy configuration without a Tunnel section", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-config-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const legacy = structuredClone(DEFAULT_CONFIG);
  delete legacy.tunnel;
  await fs.writeFile(path.join(directory, "config.json"), JSON.stringify(legacy), "utf8");

  const store = new ConfigStore({ directory });
  const loaded = await store.load();

  assert.deepEqual(loaded.tunnel, { token: "" });
});
