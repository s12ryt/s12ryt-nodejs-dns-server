"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CURRENT_SCHEMA_VERSION,
  SQLITE_APPLICATION_ID,
  SqliteStore,
} = require("../../src/storage/sqlite-store");

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), "s12-sqlite-"));
}

test("SQLite store creates the production schema with WAL and integrity guards", async (t) => {
  const directory = await temporaryDirectory();
  const store = new SqliteStore({ directory });
  t.after(() => store.close());
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const status = store.open();

  assert.equal(status.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(status.journalMode, "wal");
  assert.equal(status.integrity, "ok");
  assert.equal(store.database.pragma("application_id", { simple: true }), SQLITE_APPLICATION_ID);
  assert.equal(store.database.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(store.database.pragma("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
  assert.deepEqual(
    store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map((row) => row.name),
    ["audit_entries", "config_versions", "metric_samples", "schema_migrations", "webhook_jobs"],
  );
});

test("SQLite migrations are transactional and a failed migration leaves the prior version intact", async (t) => {
  const directory = await temporaryDirectory();
  const store = new SqliteStore({
    directory,
    migrations: [
      { version: 1, name: "base", up: (database) => database.exec("CREATE TABLE stable (id INTEGER PRIMARY KEY)") },
      { version: 2, name: "broken", up: (database) => {
        database.exec("CREATE TABLE transient (id INTEGER PRIMARY KEY)");
        throw new Error("migration failed");
      } },
    ],
  });
  t.after(() => store.close());
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  assert.throws(() => store.open(), /migration failed/);
  assert.equal(store.database.pragma("user_version", { simple: true }), 1);
  assert.equal(store.database.prepare("SELECT name FROM sqlite_master WHERE name = 'stable'").get().name, "stable");
  assert.equal(store.database.prepare("SELECT name FROM sqlite_master WHERE name = 'transient'").get(), undefined);
  assert.deepEqual(store.database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(), [
    { version: 1, name: "base" },
  ]);
});

test("SQLite store rejects a database created by a newer application schema", async (t) => {
  const directory = await temporaryDirectory();
  const first = new SqliteStore({ directory });
  first.open();
  first.database.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
  first.close();

  const reopened = new SqliteStore({ directory });
  t.after(() => reopened.close());
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.throws(() => reopened.open(), /newer schema version/i);
});

test("SQLite store reports corruption instead of starting with failed quick_check", async () => {
  const calls = [];
  const fakeDatabase = {
    open: true,
    pragma(statement, options) {
      calls.push([statement, options]);
      if (statement === "quick_check") return [{ quick_check: "database disk image is malformed" }];
      if (statement === "user_version" && options?.simple) return 0;
      if (statement === "application_id" && options?.simple) return 0;
      return undefined;
    },
    exec() {},
    close() { this.open = false; },
  };
  const store = new SqliteStore({
    directory: "unused",
    databaseFactory: () => fakeDatabase,
    migrations: [],
  });

  assert.throws(() => store.open(), /integrity check failed/i);
  assert.equal(fakeDatabase.open, false);
  assert.equal(calls.some(([statement]) => statement === "quick_check"), true);
});

test("SQLite store records immutable configuration versions and closes idempotently", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new SqliteStore({ directory });
  store.open();

  const first = store.recordConfigVersion({ schemaVersion: 1, records: [] }, { source: "startup", actor: "system" });
  const second = store.recordConfigVersion({ schemaVersion: 1, records: [{ name: "app.test" }] }, { source: "api", actor: "admin" });

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(store.listConfigVersions({ limit: 1 })[0].actor, "admin");
  assert.deepEqual(JSON.parse(store.getConfigVersion(1).configJson), { schemaVersion: 1, records: [] });
  store.close();
  store.close();
  assert.equal(store.status().open, false);
});

test("SQLite store persists metric samples and aggregates bounded time windows", async (t) => {
  const directory = await temporaryDirectory();
  const store = new SqliteStore({ directory });
  t.after(() => store.close());
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  store.open();

  store.recordMetricSamples([
    { recordedAt: "2026-08-10T00:00:00.000Z", metric: "dns_queries_total", labels: { source: "custom" }, value: 2 },
    { recordedAt: "2026-08-11T00:00:00.000Z", metric: "dns_queries_total", labels: { source: "custom" }, value: 3 },
    { recordedAt: "2026-08-11T00:00:00.000Z", metric: "proxy_errors_total", labels: {}, value: 1 },
  ]);

  assert.deepEqual(store.queryMetricTotals({
    since: "2026-08-11T00:00:00.000Z",
    until: "2026-08-12T00:00:00.000Z",
  }), [
    { metric: "dns_queries_total", labels: { source: "custom" }, value: 3 },
    { metric: "proxy_errors_total", labels: {}, value: 1 },
  ]);
  assert.throws(() => store.recordMetricSamples([{ metric: "bad", labels: {}, value: Number.NaN }]), /sample/i);
});

test("SQLite store persists webhook jobs and applies due and state updates", async (t) => {
  const directory = await temporaryDirectory();
  const store = new SqliteStore({ directory });
  t.after(() => store.close());
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  store.open();

  store.enqueueWebhook({
    id: "event-1",
    eventType: "upstream.down",
    payload: { upstream: "Cloudflare" },
    state: "pending",
    attempts: 0,
    nextAttemptAt: "2026-08-11T00:01:00.000Z",
    createdAt: "2026-08-11T00:00:00.000Z",
    lastError: null,
  });
  store.enqueueWebhook({
    id: "event-2",
    eventType: "storage.failure",
    payload: { message: "disk full" },
    state: "pending",
    attempts: 0,
    nextAttemptAt: "2026-08-11T00:03:00.000Z",
    createdAt: "2026-08-11T00:00:00.000Z",
    lastError: null,
  });

  assert.deepEqual(store.listDueWebhooks({ now: "2026-08-11T00:02:00.000Z" }).map((job) => job.id), ["event-1"]);
  assert.deepEqual(store.listDueWebhooks({ now: "2026-08-11T00:02:00.000Z" })[0].payload, { upstream: "Cloudflare" });
  const updated = store.updateWebhook("event-1", {
    state: "dead-letter",
    attempts: 4,
    nextAttemptAt: "2026-08-12T00:00:00.000Z",
    lastError: "HTTP 503",
  });
  assert.equal(updated.state, "dead-letter");
  assert.equal(store.listWebhooks({ state: "dead-letter" })[0].lastError, "HTTP 503");
  assert.throws(() => store.enqueueWebhook({
    id: "event-1",
    eventType: "duplicate",
    payload: {},
    state: "pending",
    attempts: 0,
    nextAttemptAt: "2026-08-11T00:04:00.000Z",
    createdAt: "2026-08-11T00:00:00.000Z",
    lastError: null,
  }), /unique|constraint/i);
  assert.throws(() => store.updateWebhook("missing", { state: "pending" }), /not found/i);
});

test("SQLite store creates an online backup that opens independently", async (t) => {
  const directory = await temporaryDirectory();
  const restoredDirectory = await temporaryDirectory();
  const store = new SqliteStore({ directory });
  store.open();
  store.recordConfigVersion({ schemaVersion: 1, records: [{ name: "backup.test" }] }, { source: "backup-test", actor: "system" });
  const destination = path.join(restoredDirectory, "operations.sqlite");
  t.after(async () => {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(restoredDirectory, { recursive: true, force: true });
  });

  const progress = await store.backupTo(destination);
  assert.equal(progress.totalPages >= progress.remainingPages, true);

  const restored = new SqliteStore({ directory: restoredDirectory });
  restored.open();
  assert.equal(JSON.parse(restored.getConfigVersion(1).configJson).records[0].name, "backup.test");
  restored.close();
});
