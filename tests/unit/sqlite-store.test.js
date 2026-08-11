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
  createDatabase,
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
    ["api_tokens", "audit_entries", "audit_log", "config_versions", "idempotency_keys", "invitations", "metric_samples", "proxy_health_events", "roles", "schema_migrations", "sessions", "users", "webhook_jobs"],
  );
});

test("SQLite store persists completed idempotent responses and rejects conflicting reuse", async (t) => {
  let now = Date.parse("2026-08-12T12:00:00.000Z");
  const directory = await temporaryDirectory();
  const store = new SqliteStore({ directory, now: () => new Date(now) });
  t.after(() => store.close());
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  store.open();

  assert.deepEqual(store.reserveIdempotency({
    actorId: "user-owner",
    key: "create-role-1",
    fingerprint: "a".repeat(64),
  }), { state: "started" });
  assert.deepEqual(store.reserveIdempotency({
    actorId: "user-owner",
    key: "create-role-1",
    fingerprint: "a".repeat(64),
  }), { state: "pending" });
  assert.throws(() => store.reserveIdempotency({
    actorId: "user-owner",
    key: "create-role-1",
    fingerprint: "b".repeat(64),
  }), /different request/i);

  store.completeIdempotency({
    actorId: "user-owner",
    key: "create-role-1",
    statusCode: 201,
    response: { data: { id: "dns-editor" } },
  });
  assert.deepEqual(store.reserveIdempotency({
    actorId: "user-owner",
    key: "create-role-1",
    fingerprint: "a".repeat(64),
  }), {
    state: "replay",
    statusCode: 201,
    response: { data: { id: "dns-editor" } },
  });

  now += 24 * 60 * 60 * 1000 + 1;
  assert.deepEqual(store.reserveIdempotency({
    actorId: "user-owner",
    key: "create-role-1",
    fingerprint: "c".repeat(64),
  }), { state: "started" });
});

test("SQLite store persists roles, users, invitations, sessions and hashed API tokens", async (t) => {
  const directory = await temporaryDirectory();
  const store = new SqliteStore({ directory, now: () => new Date("2026-08-12T10:00:00.000Z") });
  t.after(() => store.close());
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  store.open();

  store.createRole({ id: "dns-editor", name: "DNS editor", permissions: ["dns:read", "dns:write"] });
  assert.deepEqual(store.listRoles(), [
    { id: "dns-editor", name: "DNS editor", permissions: ["dns:read", "dns:write"], createdAt: "2026-08-12T10:00:00.000Z", updatedAt: "2026-08-12T10:00:00.000Z" },
  ]);

  const owner = store.createUser({
    id: "user-owner",
    username: "owner",
    displayName: "Primary owner",
    role: "owner",
    passwordHash: "hash-owner",
    enabled: true,
  });
  const editor = store.createUser({
    id: "user-editor",
    username: "editor",
    displayName: "DNS editor",
    role: "dns-editor",
    passwordHash: "hash-editor",
    enabled: true,
  });
  assert.equal(owner.role, "owner");
  assert.equal(store.getUserByUsername("EDITOR").id, editor.id);
  assert.equal(store.listUsers().length, 2);
  assert.equal(store.updateUser("user-editor", { enabled: false }).enabled, false);
  assert.throws(() => store.createUser({ ...editor, id: "duplicate", passwordHash: "hash" }), /unique/i);

  const invitation = store.createInvitation({
    id: "invite-1",
    tokenHash: "invite-hash",
    username: "invited",
    role: "viewer",
    expiresAt: "2026-08-13T10:00:00.000Z",
    createdBy: owner.id,
  });
  assert.equal(store.getInvitationByTokenHash("invite-hash").id, invitation.id);
  assert.equal(store.consumeInvitation("invite-1", "2026-08-12T11:00:00.000Z").usedAt, "2026-08-12T11:00:00.000Z");

  store.createSessionRecord({
    idHash: "session-hash",
    userId: owner.id,
    csrfHash: "csrf-hash",
    csrf: "csrf-token",
    createdAt: "2026-08-12T10:00:00.000Z",
    lastSeenAt: "2026-08-12T10:00:00.000Z",
    expiresAt: "2026-08-13T10:00:00.000Z",
    sourceIp: "192.0.2.1",
  });
  assert.equal(store.getSessionRecord("session-hash").userId, owner.id);
  assert.equal(store.touchSession("session-hash", "2026-08-12T10:30:00.000Z").lastSeenAt, "2026-08-12T10:30:00.000Z");
  assert.equal(store.revokeUserSessions(owner.id), 1);
  assert.equal(store.getSessionRecord("session-hash").revokedAt, "2026-08-12T10:00:00.000Z");

  store.createApiToken({
    id: "token-1",
    userId: owner.id,
    name: "automation",
    tokenHash: "api-hash",
    scopes: ["dns:read", "dns:write"],
    createdAt: "2026-08-12T10:00:00.000Z",
    expiresAt: "2026-09-12T10:00:00.000Z",
  });
  const token = store.getApiTokenByHash("api-hash");
  assert.deepEqual(token.scopes, ["dns:read", "dns:write"]);
  assert.equal(store.markApiTokenUsed("token-1", "2026-08-12T10:05:00.000Z").lastUsedAt, "2026-08-12T10:05:00.000Z");
  assert.equal(store.revokeApiToken("token-1").revokedAt, "2026-08-12T10:00:00.000Z");
});

test("SQLite store writes a verifiable filtered audit hash chain with bounded retention", async (t) => {
  let now = Date.parse("2026-08-12T12:00:00.000Z");
  const directory = await temporaryDirectory();
  const store = new SqliteStore({ directory, now: () => new Date(now) });
  t.after(() => store.close());
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  store.open();

  store.database.prepare(`
    INSERT INTO audit_log (
      created_at, actor_id, actor_type, action, resource, before_json, after_json,
      request_id, source_ip, previous_hash, entry_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("2025-01-01T00:00:00.000Z", "old", "user", "old.action", "old", "null", "null", "old-request", "127.0.0.1", null, "stale");

  const first = store.appendAuditEntry({
    actorId: "user-owner",
    actorType: "user",
    action: "dns.record.create",
    resource: "dns-record:record-1",
    before: null,
    after: { name: "www.example.test", type: "A", value: "192.0.2.10" },
    requestId: "request-1",
    sourceIp: "192.0.2.1",
  });
  now += 1000;
  const second = store.appendAuditEntry({
    actorId: "token-1",
    actorType: "api-token",
    action: "dns.record.update",
    resource: "dns-record:record-1",
    before: { value: "192.0.2.10" },
    after: { value: "192.0.2.11" },
    requestId: "request-2",
    sourceIp: "198.51.100.2",
  });

  assert.equal(first.previousHash, null);
  assert.equal(second.previousHash, first.entryHash);
  assert.match(second.entryHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(store.verifyAuditChain(), { valid: true, entries: 2, brokenAt: null });
  assert.deepEqual(store.listAuditEntries({ action: "dns.record.update", limit: 10, offset: 0 }), {
    items: [second], total: 1, limit: 10, offset: 0,
  });
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE actor_id = 'old'").get().count, 0);

  store.database.prepare("UPDATE audit_log SET after_json = ? WHERE id = ?").run('{"value":"tampered"}', second.id);
  assert.deepEqual(store.verifyAuditChain(), { valid: false, entries: 2, brokenAt: second.id });
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

test("SQLite store retains bounded proxy health history with transition details", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-sqlite-proxy-health-"));
  const store = new SqliteStore({ directory, now: () => new Date("2026-08-12T12:00:00.000Z") });
  t.after(() => {
    store.close();
    return fs.rm(directory, { recursive: true, force: true });
  });
  store.open();

  store.database.prepare(`
    INSERT INTO proxy_health_events (
      recorded_at, site, location, upstream, fallback, healthy, status_code, latency_ms,
      error, previous_state, state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("2026-07-01T00:00:00.000Z", "old.example.test", "prefix:/", "old", 0, 1, 200, 1, null, "unknown", "healthy");
  store.recordProxyHealthEvent({
    checkedAt: "2026-08-12T10:00:00.000Z",
    site: "app.example.test",
    location: "prefix:/",
    upstream: "primary-a",
    fallback: false,
    healthy: false,
    statusCode: 503,
    latencyMs: 18.5,
    error: "maintenance",
    previousState: "healthy",
    state: "unhealthy",
  });
  store.recordProxyHealthEvent({
    checkedAt: "2026-08-12T11:00:00.000Z",
    site: "fallback.example.test",
    location: "exact:/health",
    upstream: "fallback-a",
    fallback: true,
    healthy: true,
    statusCode: 204,
    latencyMs: 4,
    previousState: "unknown",
    state: "healthy",
  });
  const history = store.queryProxyHealthHistory({
    since: "2026-08-12T00:00:00.000Z",
    until: "2026-08-13T00:00:00.000Z",
    site: "app.example.test",
  });
  assert.deepEqual(history, [{
    checkedAt: "2026-08-12T10:00:00.000Z",
    site: "app.example.test",
    location: "prefix:/",
    upstream: "primary-a",
    fallback: false,
    healthy: false,
    statusCode: 503,
    latencyMs: 18.5,
    error: "maintenance",
    previousState: "healthy",
    state: "unhealthy",
  }]);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM proxy_health_events WHERE site = 'old.example.test'").get().count, 0);
  assert.throws(() => store.recordProxyHealthEvent({ site: "bad" }), /proxy health/i);
  assert.throws(() => store.queryProxyHealthHistory({ since: "bad", until: "also-bad" }), /time window/i);
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

test("SQLite store validates backup bytes before restore without leaving temporary files", async (t) => {
  const directory = await temporaryDirectory();
  const sourceDirectory = await temporaryDirectory();
  const source = new SqliteStore({ directory: sourceDirectory });
  source.open();
  const backupPath = path.join(directory, "source.sqlite");
  await source.backupTo(backupPath);
  source.close();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  t.after(() => fs.rm(sourceDirectory, { recursive: true, force: true }));

  const store = new SqliteStore({ directory });
  const valid = await fs.readFile(backupPath);
  assert.deepEqual(await store.validateBackup(valid, {
    expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
  }), {
    applicationId: SQLITE_APPLICATION_ID,
    integrity: "ok",
    schemaVersion: CURRENT_SCHEMA_VERSION,
  });
  await assert.rejects(
    store.validateBackup(valid, { expectedSchemaVersion: CURRENT_SCHEMA_VERSION - 1 }),
    /schema version does not match/i,
  );

  const futureDatabase = createDatabase(backupPath);
  futureDatabase.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
  futureDatabase.close();
  await assert.rejects(
    store.validateBackup(await fs.readFile(backupPath), {
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION + 1,
    }),
    /newer schema version/i,
  );
  await assert.rejects(
    store.validateBackup(Buffer.from("not a sqlite database"), {
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
    }),
    /sqlite|database|integrity/i,
  );

  const remaining = await fs.readdir(directory);
  assert.deepEqual(remaining, ["source.sqlite"]);
});
