"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");

const Database = require("better-sqlite3");

const CURRENT_SCHEMA_VERSION = 3;
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
]);

function nativeBindingKey() {
  return `node-v${process.versions.modules}-${process.platform}-${process.arch}`;
}

function createDatabase(filePath) {
  const configured = process.env.S12_SQLITE_NATIVE_BINDING || globalThis.__S12_SQLITE_NATIVE_BINDING__;
  const adjacent = path.join(__dirname, `better-sqlite3-${nativeBindingKey()}.node`);
  const nativeBinding = configured || (fs.existsSync(adjacent) ? adjacent : null);
  return new Database(filePath, nativeBinding ? { nativeBinding } : undefined);
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
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_MIGRATIONS,
  SQLITE_APPLICATION_ID,
  SqliteStore,
  createDatabase,
  nativeBindingKey,
};
