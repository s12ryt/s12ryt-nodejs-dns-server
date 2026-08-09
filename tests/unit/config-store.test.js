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
  const updated = await store.update({
    ...store.get(),
    records: [{ name: "home.test", type: "A", value: "192.0.2.10", ttl: 60 }],
  });
  assert.equal(updated.records[0].name, "home.test");
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
  assert.deepEqual(store.get(), before);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "config.json"), "utf8")), before);
});
