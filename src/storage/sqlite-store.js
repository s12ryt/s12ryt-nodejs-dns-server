"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");

const Database = require("better-sqlite3");

const CURRENT_SCHEMA_VERSION = 6;
const SQLITE_APPLICATION_ID = 0x53313244;

const DEFAULT_MIGRATIONS = Object.freeze([
  {
    version: 1,
    name: "operations foundation",
    up(database) {
      database.exec(`
        CREATE TABLE config_versions (
          version INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          source TEXT NOT NULL,
          actor TEXT NOT NULL,
          config_sha256 TEXT NOT NULL,
          config_json TEXT NOT NULL
        );
        CREATE TABLE metric_samples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recorded_at TEXT NOT NULL,
          metric TEXT NOT NULL,
          labels_json TEXT NOT NULL,
          value REAL NOT NULL
        );
        CREATE INDEX metric_samples_lookup ON metric_samples(metric, recorded_at);
        CREATE TABLE audit_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          resource TEXT NOT NULL,
          details_json TEXT NOT NULL
        );
        CREATE TABLE webhook_jobs (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          state TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_error TEXT
        );
        CREATE INDEX webhook_jobs_due ON webhook_jobs(state, next_attempt_at);
      `);
    },
  },
  {
    version: 2,
    name: "webhook delivery history",
    up(database) {
      database.exec("ALTER TABLE webhook_jobs ADD COLUMN delivered_at TEXT");
    },
  },
  {
    version: 3,
    name: "proxy health history",
    up(database) {
      database.exec(`
        CREATE TABLE proxy_health_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recorded_at TEXT NOT NULL,
          site TEXT NOT NULL,
          location TEXT NOT NULL,
          upstream TEXT NOT NULL,
          fallback INTEGER NOT NULL,
          healthy INTEGER NOT NULL,
          status_code INTEGER,
          latency_ms REAL,
          error TEXT,
          previous_state TEXT NOT NULL,
          state TEXT NOT NULL
        );
        CREATE INDEX proxy_health_events_lookup
          ON proxy_health_events(site, recorded_at DESC);
      `);
    },
  },
  {
    version: 4,
    name: "identity and access management",
    up(database) {
      database.exec(`
        CREATE TABLE roles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          permissions_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX users_role ON users(role);
        CREATE TABLE invitations (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          username TEXT NOT NULL COLLATE NOCASE,
          role TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          used_at TEXT
        );
        CREATE TABLE sessions (
          id_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          csrf_hash TEXT NOT NULL,
          csrf_token TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          source_ip TEXT NOT NULL,
          revoked_at TEXT
        );
        CREATE INDEX sessions_user ON sessions(user_id, revoked_at);
        CREATE TABLE api_tokens (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          scopes_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          last_used_at TEXT,
          revoked_at TEXT
        );
        CREATE INDEX api_tokens_user ON api_tokens(user_id, revoked_at);
      `);
    },
  },
  {
    version: 5,
    name: "tamper evident audit log",
    up(database) {
      database.exec(`
        CREATE TABLE audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          action TEXT NOT NULL,
          resource TEXT NOT NULL,
          before_json TEXT NOT NULL,
          after_json TEXT NOT NULL,
          request_id TEXT NOT NULL,
          source_ip TEXT NOT NULL,
          previous_hash TEXT,
          entry_hash TEXT NOT NULL
        );
        CREATE INDEX audit_log_created ON audit_log(created_at DESC, id DESC);
        CREATE INDEX audit_log_action ON audit_log(action, created_at DESC);
        CREATE INDEX audit_log_actor ON audit_log(actor_id, created_at DESC);
        CREATE INDEX audit_log_resource ON audit_log(resource, created_at DESC);
      `);
    },
  },
  {
    version: 6,
    name: "idempotent API requests",
    up(database) {
      database.exec(`
        CREATE TABLE idempotency_keys (
          actor_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          state TEXT NOT NULL,
          status_code INTEGER,
          response_json TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          PRIMARY KEY (actor_id, idempotency_key)
        );
        CREATE INDEX idempotency_keys_expiry ON idempotency_keys(expires_at);
      `);
    },
  },
]);

function nativeBindingKey() {
  return `node-v${process.versions.modules}-${process.platform}-${process.arch}`;
}

function createDatabase(filePath, options = {}) {
  const configured = process.env.S12_SQLITE_NATIVE_BINDING || globalThis.__S12_SQLITE_NATIVE_BINDING__;
  const adjacent = path.join(__dirname, `better-sqlite3-${nativeBindingKey()}.node`);
  const nativeBinding = configured || (fs.existsSync(adjacent) ? adjacent : null);
  return new Database(filePath, nativeBinding ? { ...options, nativeBinding } : options);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function integrityResult(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "unknown";
  return Object.values(rows[0])[0];
}

function validIsoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function stableJson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "{}";
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function auditHash(entry) {
  return sha256(canonicalJson({
    createdAt: entry.createdAt,
    actorId: entry.actorId,
    actorType: entry.actorType,
    action: entry.action,
    resource: entry.resource,
    before: entry.before,
    after: entry.after,
    requestId: entry.requestId,
    sourceIp: entry.sourceIp,
    previousHash: entry.previousHash,
  }));
}

function auditFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorType: row.actorType,
    action: row.action,
    resource: row.resource,
    before: JSON.parse(row.beforeJson),
    after: JSON.parse(row.afterJson),
    requestId: row.requestId,
    sourceIp: row.sourceIp,
    previousHash: row.previousHash,
    entryHash: row.entryHash,
  };
}

function webhookFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventType: row.eventType,
    payload: JSON.parse(row.payloadJson),
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    createdAt: row.createdAt,
    lastError: row.lastError,
    deliveredAt: row.deliveredAt,
  };
}

function proxyHealthFromRow(row) {
  return {
    checkedAt: row.checkedAt,
    site: row.site,
    location: row.location,
    upstream: row.upstream,
    fallback: Boolean(row.fallback),
    healthy: Boolean(row.healthy),
    statusCode: row.statusCode,
    latencyMs: row.latencyMs,
    error: row.error,
    previousState: row.previousState,
    state: row.state,
  };
}

function roleFromRow(row) {
  return row ? {
    id: row.id,
    name: row.name,
    permissions: JSON.parse(row.permissionsJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } : null;
}

function userFromRow(row) {
  return row ? {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    passwordHash: row.passwordHash,
    enabled: Boolean(row.enabled),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } : null;
}

function invitationFromRow(row) {
  return row ? {
    id: row.id,
    tokenHash: row.tokenHash,
    username: row.username,
    role: row.role,
    expiresAt: row.expiresAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    usedAt: row.usedAt,
  } : null;
}

function sessionFromRow(row) {
  return row ? {
    idHash: row.idHash,
    userId: row.userId,
    csrfHash: row.csrfHash,
    csrf: row.csrf,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    sourceIp: row.sourceIp,
    revokedAt: row.revokedAt,
  } : null;
}

function apiTokenFromRow(row) {
  return row ? {
    id: row.id,
    userId: row.userId,
    name: row.name,
    tokenHash: row.tokenHash,
    scopes: JSON.parse(row.scopesJson),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  } : null;
}

class SqliteStore {
  constructor({
    directory = path.resolve("data"),
    fileName = "operations.sqlite",
    databaseFactory = createDatabase,
    migrations = DEFAULT_MIGRATIONS,
    now = () => new Date(),
  } = {}) {
    this.filePath = path.join(directory, fileName);
    this.databaseFactory = databaseFactory;
    this.migrations = [...migrations].sort((left, right) => left.version - right.version);
    this.now = now;
    this.database = null;
    this.lastIntegrity = null;
    this.lastJournalMode = null;
  }

  open() {
    if (this.database?.open) return this.status();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.database = this.databaseFactory(this.filePath);

    const integrity = integrityResult(this.database.pragma("quick_check"));
    this.lastIntegrity = integrity;
    if (integrity !== "ok") {
      this.close();
      throw new Error(`SQLite integrity check failed: ${integrity}`);
    }

    const targetVersion = this.migrations.at(-1)?.version || 0;
    const existingVersion = this.database.pragma("user_version", { simple: true });
    if (existingVersion > targetVersion) {
      this.close();
      throw new Error(`SQLite database uses newer schema version ${existingVersion}; this runtime supports ${targetVersion}`);
    }

    const applicationId = this.database.pragma("application_id", { simple: true });
    if (applicationId !== 0 && applicationId !== SQLITE_APPLICATION_ID) {
      this.close();
      throw new Error("SQLite database belongs to another application");
    }
    this.database.pragma(`application_id = ${SQLITE_APPLICATION_ID}`);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("synchronous = NORMAL");
    this.lastJournalMode = this.database.pragma("journal_mode = WAL", { simple: true });
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    for (const migration of this.migrations) {
      if (migration.version <= existingVersion) continue;
      const apply = this.database.transaction(() => {
        migration.up(this.database);
        this.database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, this.now().toISOString());
        this.database.pragma(`user_version = ${migration.version}`);
      });
      apply();
    }
    return this.status();
  }

  recordConfigVersion(config, { source = "runtime", actor = "system" } = {}) {
    this.#requireOpen();
    const configJson = JSON.stringify(config);
    const result = this.database.prepare(`
      INSERT INTO config_versions (created_at, source, actor, config_sha256, config_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(this.now().toISOString(), source, actor, sha256(configJson), configJson);
    return this.getConfigVersion(Number(result.lastInsertRowid));
  }

  getConfigVersion(version) {
    this.#requireOpen();
    return this.database.prepare(`
      SELECT version, created_at AS createdAt, source, actor, config_sha256 AS configSha256,
        config_json AS configJson
      FROM config_versions WHERE version = ?
    `).get(version) || null;
  }

  listConfigVersions({ limit = 50, offset = 0 } = {}) {
    this.#requireOpen();
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("Config version limit is invalid");
    if (!Number.isInteger(offset) || offset < 0) throw new RangeError("Config version offset is invalid");
    return this.database.prepare(`
      SELECT version, created_at AS createdAt, source, actor, config_sha256 AS configSha256,
        config_json AS configJson
      FROM config_versions ORDER BY version DESC LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  reserveIdempotency({ actorId, key, fingerprint }) {
    this.#requireOpen();
    if (typeof actorId !== "string" || !actorId || typeof key !== "string" || !key
      || !/^[a-f0-9]{64}$/.test(String(fingerprint))) {
      throw new TypeError("Idempotency reservation is invalid");
    }
    const now = this.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    return this.database.transaction(() => {
      this.database.prepare("DELETE FROM idempotency_keys WHERE expires_at <= ?").run(nowIso);
      const existing = this.database.prepare(`
        SELECT fingerprint, state, status_code AS statusCode, response_json AS responseJson
        FROM idempotency_keys WHERE actor_id = ? AND idempotency_key = ?
      `).get(actorId, key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw Object.assign(new Error("Idempotency key was already used for a different request"), { statusCode: 409 });
        }
        if (existing.state === "completed") {
          return { state: "replay", statusCode: existing.statusCode, response: JSON.parse(existing.responseJson) };
        }
        return { state: "pending" };
      }
      this.database.prepare(`
        INSERT INTO idempotency_keys (
          actor_id, idempotency_key, fingerprint, state, created_at, expires_at
        ) VALUES (?, ?, ?, 'pending', ?, ?)
      `).run(actorId, key, fingerprint, nowIso, expiresAt);
      return { state: "started" };
    })();
  }

  completeIdempotency({ actorId, key, statusCode, response }) {
    this.#requireOpen();
    if (typeof actorId !== "string" || !actorId || typeof key !== "string" || !key
      || !Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
      throw new TypeError("Idempotency completion is invalid");
    }
    const result = this.database.prepare(`
      UPDATE idempotency_keys
      SET state = 'completed', status_code = ?, response_json = ?
      WHERE actor_id = ? AND idempotency_key = ? AND state = 'pending'
    `).run(statusCode, canonicalJson(response), actorId, key);
    if (result.changes !== 1) throw Object.assign(new Error("Pending idempotency request was not found"), { statusCode: 409 });
    return { state: "completed", statusCode, response };
  }

  abandonIdempotency({ actorId, key }) {
    this.#requireOpen();
    if (typeof actorId !== "string" || !actorId || typeof key !== "string" || !key) {
      throw new TypeError("Idempotency abandonment is invalid");
    }
    return this.database.prepare(`
      DELETE FROM idempotency_keys
      WHERE actor_id = ? AND idempotency_key = ? AND state = 'pending'
    `).run(actorId, key).changes === 1;
  }

  recordMetricSamples(samples) {
    this.#requireOpen();
    if (!Array.isArray(samples)) throw new TypeError("Metric samples must be an array");
    const insert = this.database.prepare(`
      INSERT INTO metric_samples (recorded_at, metric, labels_json, value) VALUES (?, ?, ?, ?)
    `);
    const write = this.database.transaction(() => {
      for (const sample of samples) {
        if (!sample || !validIsoTimestamp(sample.recordedAt)
          || typeof sample.metric !== "string" || !sample.metric
          || !Number.isFinite(sample.value)) {
          throw new TypeError("Metric sample is invalid");
        }
        insert.run(sample.recordedAt, sample.metric, stableJson(sample.labels), sample.value);
      }
    });
    write();
    return samples.length;
  }

  queryMetricTotals({ since, until } = {}) {
    this.#requireOpen();
    if (!validIsoTimestamp(since) || !validIsoTimestamp(until) || Date.parse(since) >= Date.parse(until)) {
      throw new RangeError("Metric time window is invalid");
    }
    return this.database.prepare(`
      SELECT metric, labels_json AS labelsJson, SUM(value) AS value
      FROM metric_samples
      WHERE recorded_at >= ? AND recorded_at < ?
      GROUP BY metric, labels_json
      ORDER BY metric, labels_json
    `).all(since, until).map((row) => ({
      metric: row.metric,
      labels: JSON.parse(row.labelsJson),
      value: row.value,
    }));
  }

  recordProxyHealthEvent(event) {
    this.#requireOpen();
    if (!event || !validIsoTimestamp(event.checkedAt)
      || typeof event.site !== "string" || !event.site
      || typeof event.location !== "string" || !event.location
      || typeof event.upstream !== "string" || !event.upstream
      || typeof event.fallback !== "boolean" || typeof event.healthy !== "boolean"
      || (event.statusCode !== null && event.statusCode !== undefined
        && (!Number.isInteger(event.statusCode) || event.statusCode < 100 || event.statusCode > 599))
      || (event.latencyMs !== null && event.latencyMs !== undefined
        && (!Number.isFinite(event.latencyMs) || event.latencyMs < 0))
      || (event.error !== null && event.error !== undefined && typeof event.error !== "string")
      || typeof event.previousState !== "string" || !event.previousState
      || typeof event.state !== "string" || !event.state) {
      throw new TypeError("Proxy health event is invalid");
    }
    const cutoff = new Date(this.now().getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const write = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO proxy_health_events (
          recorded_at, site, location, upstream, fallback, healthy, status_code, latency_ms,
          error, previous_state, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.checkedAt,
        event.site,
        event.location,
        event.upstream,
        event.fallback ? 1 : 0,
        event.healthy ? 1 : 0,
        event.statusCode ?? null,
        event.latencyMs ?? null,
        event.error || null,
        event.previousState,
        event.state,
      );
      this.database.prepare("DELETE FROM proxy_health_events WHERE recorded_at < ?").run(cutoff);
    });
    write();
    return proxyHealthFromRow(this.database.prepare(`
      SELECT recorded_at AS checkedAt, site, location, upstream, fallback, healthy,
        status_code AS statusCode, latency_ms AS latencyMs, error,
        previous_state AS previousState, state
      FROM proxy_health_events WHERE id = last_insert_rowid()
    `).get());
  }

  queryProxyHealthHistory({ since, until, site, limit = 500 } = {}) {
    this.#requireOpen();
    if (!validIsoTimestamp(since) || !validIsoTimestamp(until) || Date.parse(since) >= Date.parse(until)) {
      throw new RangeError("Proxy health time window is invalid");
    }
    if (site !== undefined && (typeof site !== "string" || !site)) throw new TypeError("Proxy health site is invalid");
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new RangeError("Proxy health limit is invalid");
    const select = `
      SELECT recorded_at AS checkedAt, site, location, upstream, fallback, healthy,
        status_code AS statusCode, latency_ms AS latencyMs, error,
        previous_state AS previousState, state
      FROM proxy_health_events
      WHERE recorded_at >= ? AND recorded_at < ?
    `;
    const rows = site === undefined
      ? this.database.prepare(`${select} ORDER BY recorded_at DESC, id DESC LIMIT ?`).all(since, until, limit)
      : this.database.prepare(`${select} AND site = ? ORDER BY recorded_at DESC, id DESC LIMIT ?`).all(since, until, site, limit);
    return rows.map(proxyHealthFromRow);
  }

  appendAuditEntry(entry) {
    this.#requireOpen();
    if (!entry || typeof entry.actorId !== "string" || !entry.actorId
      || !["user", "api-token", "system"].includes(entry.actorType)
      || typeof entry.action !== "string" || !entry.action
      || typeof entry.resource !== "string" || !entry.resource
      || typeof entry.requestId !== "string" || !entry.requestId
      || typeof entry.sourceIp !== "string" || !entry.sourceIp) {
      throw new TypeError("Audit entry is invalid");
    }
    const createdAt = this.now().toISOString();
    const cutoff = new Date(this.now().getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
    let insertedId;
    const write = this.database.transaction(() => {
      const removed = this.database.prepare("DELETE FROM audit_log WHERE created_at < ?").run(cutoff).changes;
      if (removed > 0) this.#rebuildAuditChain();
      const previousHash = this.database.prepare("SELECT entry_hash AS entryHash FROM audit_log ORDER BY id DESC LIMIT 1").get()?.entryHash || null;
      const normalized = {
        createdAt,
        actorId: entry.actorId,
        actorType: entry.actorType,
        action: entry.action,
        resource: entry.resource,
        before: entry.before ?? null,
        after: entry.after ?? null,
        requestId: entry.requestId,
        sourceIp: entry.sourceIp,
        previousHash,
      };
      const result = this.database.prepare(`
        INSERT INTO audit_log (
          created_at, actor_id, actor_type, action, resource, before_json, after_json,
          request_id, source_ip, previous_hash, entry_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.createdAt,
        normalized.actorId,
        normalized.actorType,
        normalized.action,
        normalized.resource,
        canonicalJson(normalized.before),
        canonicalJson(normalized.after),
        normalized.requestId,
        normalized.sourceIp,
        normalized.previousHash,
        auditHash(normalized),
      );
      insertedId = Number(result.lastInsertRowid);
    });
    write();
    return this.#getAuditEntry(insertedId);
  }

  listAuditEntries({ action, actorId, resource, since, until, limit = 100, offset = 0 } = {}) {
    this.#requireOpen();
    for (const [label, value] of [["action", action], ["actor", actorId], ["resource", resource]]) {
      if (value !== undefined && (typeof value !== "string" || !value)) throw new TypeError(`Audit ${label} filter is invalid`);
    }
    if (since !== undefined && !validIsoTimestamp(since)) throw new RangeError("Audit start time is invalid");
    if (until !== undefined && !validIsoTimestamp(until)) throw new RangeError("Audit end time is invalid");
    if (since !== undefined && until !== undefined && Date.parse(since) >= Date.parse(until)) {
      throw new RangeError("Audit time window is invalid");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0) {
      throw new RangeError("Audit pagination is invalid");
    }
    const conditions = [];
    const values = [];
    for (const [column, value] of [["action", action], ["actor_id", actorId], ["resource", resource]]) {
      if (value !== undefined) {
        conditions.push(`${column} = ?`);
        values.push(value);
      }
    }
    if (since !== undefined) {
      conditions.push("created_at >= ?");
      values.push(since);
    }
    if (until !== undefined) {
      conditions.push("created_at < ?");
      values.push(until);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const total = this.database.prepare(`SELECT COUNT(*) AS count FROM audit_log${where}`).get(...values).count;
    const rows = this.database.prepare(`${this.#auditSelect()}${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset).map(auditFromRow);
    return { items: rows, total, limit, offset };
  }

  verifyAuditChain() {
    this.#requireOpen();
    const entries = this.database.prepare(`${this.#auditSelect()} ORDER BY id`).all().map(auditFromRow);
    let previousHash = null;
    for (const entry of entries) {
      const expected = auditHash({ ...entry, previousHash });
      if (entry.previousHash !== previousHash || entry.entryHash !== expected) {
        return { valid: false, entries: entries.length, brokenAt: entry.id };
      }
      previousHash = entry.entryHash;
    }
    return { valid: true, entries: entries.length, brokenAt: null };
  }

  enqueueWebhook(job) {
    this.#requireOpen();
    if (!job || typeof job.id !== "string" || !job.id
      || typeof job.eventType !== "string" || !job.eventType
      || !["pending", "delivered", "dead-letter"].includes(job.state)
      || !Number.isInteger(job.attempts) || job.attempts < 0
      || !validIsoTimestamp(job.nextAttemptAt) || !validIsoTimestamp(job.createdAt)) {
      throw new TypeError("Webhook job is invalid");
    }
    this.database.prepare(`
      INSERT INTO webhook_jobs (
        id, event_type, payload_json, state, attempts, next_attempt_at, created_at, last_error, delivered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id,
      job.eventType,
      JSON.stringify(job.payload ?? null),
      job.state,
      job.attempts,
      job.nextAttemptAt,
      job.createdAt,
      job.lastError || null,
      job.deliveredAt || null,
    );
    return this.#getWebhook(job.id);
  }

  listDueWebhooks({ now, limit = 100 } = {}) {
    this.#requireOpen();
    if (!validIsoTimestamp(now)) throw new RangeError("Webhook due time is invalid");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("Webhook due limit is invalid");
    return this.database.prepare(`
      SELECT id, event_type AS eventType, payload_json AS payloadJson, state, attempts,
        next_attempt_at AS nextAttemptAt, created_at AS createdAt, last_error AS lastError,
        delivered_at AS deliveredAt
      FROM webhook_jobs
      WHERE state = 'pending' AND next_attempt_at <= ?
      ORDER BY next_attempt_at, created_at, id
      LIMIT ?
    `).all(now, limit).map(webhookFromRow);
  }

  listWebhooks({ state, limit = 100, offset = 0 } = {}) {
    this.#requireOpen();
    if (state !== undefined && !["pending", "delivered", "dead-letter"].includes(state)) {
      throw new RangeError("Webhook state is invalid");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0) {
      throw new RangeError("Webhook pagination is invalid");
    }
    const select = `
      SELECT id, event_type AS eventType, payload_json AS payloadJson, state, attempts,
        next_attempt_at AS nextAttemptAt, created_at AS createdAt, last_error AS lastError,
        delivered_at AS deliveredAt
      FROM webhook_jobs
    `;
    const rows = state === undefined
      ? this.database.prepare(`${select} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(limit, offset)
      : this.database.prepare(`${select} WHERE state = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(state, limit, offset);
    return rows.map(webhookFromRow);
  }

  updateWebhook(id, patch) {
    this.#requireOpen();
    const current = this.#getWebhook(id);
    if (!current) throw new Error(`Webhook job not found: ${id}`);
    const next = { ...current, ...patch };
    if (!["pending", "delivered", "dead-letter"].includes(next.state)
      || !Number.isInteger(next.attempts) || next.attempts < 0
      || !validIsoTimestamp(next.nextAttemptAt)
      || (next.deliveredAt !== null && next.deliveredAt !== undefined && !validIsoTimestamp(next.deliveredAt))) {
      throw new TypeError("Webhook update is invalid");
    }
    this.database.prepare(`
      UPDATE webhook_jobs
      SET state = ?, attempts = ?, next_attempt_at = ?, last_error = ?, delivered_at = ?
      WHERE id = ?
    `).run(next.state, next.attempts, next.nextAttemptAt, next.lastError || null, next.deliveredAt || null, id);
    return this.#getWebhook(id);
  }

  createRole(role) {
    this.#requireOpen();
    if (!role || typeof role.id !== "string" || !role.id || typeof role.name !== "string" || !role.name
      || !Array.isArray(role.permissions)) throw new TypeError("Role is invalid");
    const timestamp = this.now().toISOString();
    this.database.prepare(`
      INSERT INTO roles (id, name, permissions_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    `).run(role.id, role.name, JSON.stringify(role.permissions), timestamp, timestamp);
    return this.#getRole(role.id);
  }

  listRoles() {
    this.#requireOpen();
    return this.database.prepare(`
      SELECT id, name, permissions_json AS permissionsJson, created_at AS createdAt, updated_at AS updatedAt
      FROM roles ORDER BY id
    `).all().map(roleFromRow);
  }

  createUser(user) {
    this.#requireOpen();
    if (!user || typeof user.id !== "string" || !user.id || typeof user.username !== "string" || !user.username
      || typeof user.displayName !== "string" || !user.displayName || typeof user.role !== "string" || !user.role
      || typeof user.passwordHash !== "string" || !user.passwordHash || typeof user.enabled !== "boolean") {
      throw new TypeError("User is invalid");
    }
    const timestamp = this.now().toISOString();
    this.database.prepare(`
      INSERT INTO users (id, username, display_name, role, password_hash, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(user.id, user.username, user.displayName, user.role, user.passwordHash, user.enabled ? 1 : 0, timestamp, timestamp);
    return this.#getUser(user.id);
  }

  getUserByUsername(username) {
    this.#requireOpen();
    return userFromRow(this.database.prepare(`
      SELECT id, username, display_name AS displayName, role, password_hash AS passwordHash,
        enabled, created_at AS createdAt, updated_at AS updatedAt
      FROM users WHERE username = ? COLLATE NOCASE
    `).get(String(username)));
  }

  listUsers() {
    this.#requireOpen();
    return this.database.prepare(`
      SELECT id, username, display_name AS displayName, role, password_hash AS passwordHash,
        enabled, created_at AS createdAt, updated_at AS updatedAt
      FROM users ORDER BY username COLLATE NOCASE
    `).all().map(userFromRow);
  }

  updateUser(id, patch) {
    this.#requireOpen();
    const current = this.#getUser(id);
    if (!current) throw new Error(`User not found: ${id}`);
    const next = { ...current, ...patch };
    if (typeof next.displayName !== "string" || !next.displayName || typeof next.role !== "string" || !next.role
      || typeof next.passwordHash !== "string" || !next.passwordHash || typeof next.enabled !== "boolean") {
      throw new TypeError("User update is invalid");
    }
    this.database.prepare(`
      UPDATE users SET display_name = ?, role = ?, password_hash = ?, enabled = ?, updated_at = ? WHERE id = ?
    `).run(next.displayName, next.role, next.passwordHash, next.enabled ? 1 : 0, this.now().toISOString(), id);
    return this.#getUser(id);
  }

  createInvitation(invitation) {
    this.#requireOpen();
    if (!invitation || !invitation.id || !invitation.tokenHash || !invitation.username || !invitation.role
      || !validIsoTimestamp(invitation.expiresAt) || !invitation.createdBy) throw new TypeError("Invitation is invalid");
    this.database.prepare(`
      INSERT INTO invitations (id, token_hash, username, role, expires_at, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(invitation.id, invitation.tokenHash, invitation.username, invitation.role, invitation.expiresAt,
      invitation.createdBy, this.now().toISOString());
    return this.#getInvitation(invitation.id);
  }

  getInvitationByTokenHash(tokenHash) {
    this.#requireOpen();
    return invitationFromRow(this.database.prepare(`
      SELECT id, token_hash AS tokenHash, username, role, expires_at AS expiresAt,
        created_by AS createdBy, created_at AS createdAt, used_at AS usedAt
      FROM invitations WHERE token_hash = ?
    `).get(String(tokenHash)));
  }

  listInvitations() {
    this.#requireOpen();
    return this.database.prepare(`
      SELECT id, token_hash AS tokenHash, username, role, expires_at AS expiresAt,
        created_by AS createdBy, created_at AS createdAt, used_at AS usedAt
      FROM invitations ORDER BY created_at DESC, id
    `).all().map(invitationFromRow);
  }

  consumeInvitation(id, usedAt = this.now().toISOString()) {
    this.#requireOpen();
    if (!validIsoTimestamp(usedAt)) throw new TypeError("Invitation use time is invalid");
    const result = this.database.prepare("UPDATE invitations SET used_at = ? WHERE id = ? AND used_at IS NULL").run(usedAt, id);
    if (result.changes !== 1) throw new Error(`Invitation not found or already used: ${id}`);
    return this.#getInvitation(id);
  }

  createSessionRecord(session) {
    this.#requireOpen();
    if (!session || !session.idHash || !session.userId || !session.csrfHash || !session.csrf
      || !validIsoTimestamp(session.createdAt) || !validIsoTimestamp(session.lastSeenAt)
      || !validIsoTimestamp(session.expiresAt) || typeof session.sourceIp !== "string") {
      throw new TypeError("Session is invalid");
    }
    this.database.prepare(`
      INSERT INTO sessions (id_hash, user_id, csrf_hash, csrf_token, created_at, last_seen_at, expires_at, source_ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.idHash, session.userId, session.csrfHash, session.csrf, session.createdAt, session.lastSeenAt,
      session.expiresAt, session.sourceIp);
    return this.getSessionRecord(session.idHash);
  }

  getSessionRecord(idHash) {
    this.#requireOpen();
    return sessionFromRow(this.database.prepare(`
      SELECT id_hash AS idHash, user_id AS userId, csrf_hash AS csrfHash, csrf_token AS csrf, created_at AS createdAt,
        last_seen_at AS lastSeenAt, expires_at AS expiresAt, source_ip AS sourceIp, revoked_at AS revokedAt
      FROM sessions WHERE id_hash = ?
    `).get(String(idHash)));
  }

  touchSession(idHash, lastSeenAt) {
    this.#requireOpen();
    if (!validIsoTimestamp(lastSeenAt)) throw new TypeError("Session last-seen time is invalid");
    const result = this.database.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ? AND revoked_at IS NULL")
      .run(lastSeenAt, idHash);
    if (result.changes !== 1) throw new Error("Session not found or revoked");
    return this.getSessionRecord(idHash);
  }

  revokeUserSessions(userId) {
    this.#requireOpen();
    return this.database.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .run(this.now().toISOString(), userId).changes;
  }

  revokeSession(idHash) {
    this.#requireOpen();
    return this.database.prepare("UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL")
      .run(this.now().toISOString(), idHash).changes === 1;
  }

  createApiToken(token) {
    this.#requireOpen();
    if (!token || !token.id || !token.userId || !token.name || !token.tokenHash || !Array.isArray(token.scopes)
      || !validIsoTimestamp(token.createdAt)
      || (token.expiresAt !== null && token.expiresAt !== undefined && !validIsoTimestamp(token.expiresAt))) {
      throw new TypeError("API token is invalid");
    }
    this.database.prepare(`
      INSERT INTO api_tokens (id, user_id, name, token_hash, scopes_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(token.id, token.userId, token.name, token.tokenHash, JSON.stringify(token.scopes), token.createdAt,
      token.expiresAt || null);
    return this.#getApiToken(token.id);
  }

  getApiTokenByHash(tokenHash) {
    this.#requireOpen();
    return apiTokenFromRow(this.database.prepare(`
      SELECT id, user_id AS userId, name, token_hash AS tokenHash, scopes_json AS scopesJson,
        created_at AS createdAt, expires_at AS expiresAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt
      FROM api_tokens WHERE token_hash = ?
    `).get(String(tokenHash)));
  }

  listApiTokens(userId = null) {
    this.#requireOpen();
    const query = `
      SELECT id, user_id AS userId, name, token_hash AS tokenHash, scopes_json AS scopesJson,
        created_at AS createdAt, expires_at AS expiresAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt
      FROM api_tokens${userId ? " WHERE user_id = ?" : ""} ORDER BY created_at DESC, id
    `;
    const rows = userId ? this.database.prepare(query).all(userId) : this.database.prepare(query).all();
    return rows.map(apiTokenFromRow);
  }

  markApiTokenUsed(id, lastUsedAt) {
    this.#requireOpen();
    if (!validIsoTimestamp(lastUsedAt)) throw new TypeError("API token use time is invalid");
    const result = this.database.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(lastUsedAt, id);
    if (result.changes !== 1) throw new Error("API token not found or revoked");
    return this.#getApiToken(id);
  }

  revokeApiToken(id) {
    this.#requireOpen();
    const result = this.database.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(this.now().toISOString(), id);
    if (result.changes !== 1) throw new Error("API token not found or revoked");
    return this.#getApiToken(id);
  }

  async backupTo(destination) {
    this.#requireOpen();
    await fsPromises.mkdir(path.dirname(destination), { recursive: true });
    try {
      return await this.database.backup(destination);
    } catch (error) {
      await fsPromises.rm(destination, { force: true }).catch(() => {});
      throw error;
    }
  }

  async validateBackup(content, { expectedSchemaVersion } = {}) {
    if (!Buffer.isBuffer(content) || content.length === 0) {
      throw new TypeError("SQLite backup content must be a non-empty buffer");
    }
    if (!Number.isInteger(expectedSchemaVersion) || expectedSchemaVersion < 0) {
      throw new TypeError("SQLite backup schema version is invalid");
    }

    const parent = path.dirname(this.filePath);
    await fsPromises.mkdir(parent, { recursive: true });
    const temporaryDirectory = await fsPromises.mkdtemp(path.join(parent, ".backup-validation-"));
    const temporaryPath = path.join(temporaryDirectory, "operations.sqlite");
    let database;
    try {
      await fsPromises.writeFile(temporaryPath, content, { mode: 0o600 });
      database = this.databaseFactory(temporaryPath, { readonly: true, fileMustExist: true });
      const integrity = integrityResult(database.pragma("quick_check"));
      if (integrity !== "ok") throw new Error(`SQLite backup integrity check failed: ${integrity}`);

      const applicationId = database.pragma("application_id", { simple: true });
      if (applicationId !== SQLITE_APPLICATION_ID) {
        throw new Error("SQLite backup belongs to another application");
      }
      const schemaVersion = database.pragma("user_version", { simple: true });
      if (schemaVersion > CURRENT_SCHEMA_VERSION) {
        throw new Error(`SQLite backup uses newer schema version ${schemaVersion}; this runtime supports ${CURRENT_SCHEMA_VERSION}`);
      }
      if (schemaVersion !== expectedSchemaVersion) {
        throw new Error(`SQLite backup schema version does not match manifest: expected ${expectedSchemaVersion}, got ${schemaVersion}`);
      }
      return { applicationId, integrity, schemaVersion };
    } finally {
      if (database?.open) database.close();
      await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  status() {
    return {
      open: Boolean(this.database?.open),
      filePath: this.filePath,
      schemaVersion: this.database?.open
        ? this.database.pragma("user_version", { simple: true })
        : null,
      journalMode: this.lastJournalMode,
      integrity: this.lastIntegrity,
    };
  }

  close() {
    if (this.database?.open) this.database.close();
  }

  #requireOpen() {
    if (!this.database?.open) throw new Error("SQLite store is not open");
  }

  #getWebhook(id) {
    const row = this.database.prepare(`
      SELECT id, event_type AS eventType, payload_json AS payloadJson, state, attempts,
        next_attempt_at AS nextAttemptAt, created_at AS createdAt, last_error AS lastError,
        delivered_at AS deliveredAt
      FROM webhook_jobs WHERE id = ?
    `).get(id);
    return webhookFromRow(row);
  }

  #getRole(id) {
    return roleFromRow(this.database.prepare(`
      SELECT id, name, permissions_json AS permissionsJson, created_at AS createdAt, updated_at AS updatedAt
      FROM roles WHERE id = ?
    `).get(id));
  }

  #getUser(id) {
    return userFromRow(this.database.prepare(`
      SELECT id, username, display_name AS displayName, role, password_hash AS passwordHash,
        enabled, created_at AS createdAt, updated_at AS updatedAt
      FROM users WHERE id = ?
    `).get(id));
  }

  #getInvitation(id) {
    return invitationFromRow(this.database.prepare(`
      SELECT id, token_hash AS tokenHash, username, role, expires_at AS expiresAt,
        created_by AS createdBy, created_at AS createdAt, used_at AS usedAt
      FROM invitations WHERE id = ?
    `).get(id));
  }

  #getApiToken(id) {
    return apiTokenFromRow(this.database.prepare(`
      SELECT id, user_id AS userId, name, token_hash AS tokenHash, scopes_json AS scopesJson,
        created_at AS createdAt, expires_at AS expiresAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt
      FROM api_tokens WHERE id = ?
    `).get(id));
  }

  #auditSelect() {
    return `SELECT id, created_at AS createdAt, actor_id AS actorId, actor_type AS actorType,
      action, resource, before_json AS beforeJson, after_json AS afterJson,
      request_id AS requestId, source_ip AS sourceIp, previous_hash AS previousHash,
      entry_hash AS entryHash FROM audit_log`;
  }

  #getAuditEntry(id) {
    return auditFromRow(this.database.prepare(`${this.#auditSelect()} WHERE id = ?`).get(id));
  }

  #rebuildAuditChain() {
    const rows = this.database.prepare(`${this.#auditSelect()} ORDER BY id`).all().map(auditFromRow);
    const update = this.database.prepare("UPDATE audit_log SET previous_hash = ?, entry_hash = ? WHERE id = ?");
    let previousHash = null;
    for (const row of rows) {
      const entryHash = auditHash({ ...row, previousHash });
      update.run(previousHash, entryHash, row.id);
      previousHash = entryHash;
    }
  }
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_MIGRATIONS,
  SQLITE_APPLICATION_ID,
  SqliteStore,
  createDatabase,
  nativeBindingKey,
  canonicalJson,
};
