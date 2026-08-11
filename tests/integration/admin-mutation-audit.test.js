"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AuditService } = require("../../src/admin/audit-service");
const { ConfigStore } = require("../../src/admin/config-store");
const { IdentityManager } = require("../../src/admin/identity-manager");
const { createAdminService } = require("../../src/admin/server");
const { SqliteStore } = require("../../src/storage/sqlite-store");

async function request(base, pathname, { method = "GET", cookie, csrf, body, requestId } = {}) {
  const headers = { accept: "application/json" };
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  if (requestId) headers["x-request-id"] = requestId;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

test("high-risk administration mutations append tamper-evident audit entries", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-admin-mutation-audit-"));
  const storage = new SqliteStore({ directory, now: () => new Date("2026-08-12T12:00:00.000Z") });
  storage.open();
  const auth = new IdentityManager({ directory, storage });
  await auth.load();
  const config = new ConfigStore({ directory });
  await config.load();
  let tunnelState = "stopped";
  const tunnel = {
    status: () => ({ available: true, state: tunnelState, logs: [] }),
    start: async () => { tunnelState = "running"; },
    stop: async () => { tunnelState = "stopped"; },
  };
  const service = createAdminService({
    auth,
    audit: new AuditService({ storage, now: () => new Date("2026-08-12T12:00:00.000Z") }),
    config,
    tunnel,
    createBackup: async () => ({ fileName: "s12-manual-20260812T120000Z.zip", size: 100 }),
    clearProxyCache: async () => ({ entries: 0, bytes: 0 }),
    updateWebhookConfig: async (value) => ({ ...value, hasSecret: true }),
    host: "127.0.0.1",
    port: 0,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    storage.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${service.address().port}`;
  const setupToken = auth.createSetupToken();
  const setup = await request(base, "/api/setup", {
    method: "POST",
    body: { token: setupToken, password: "correct horse battery" },
  });
  const cookie = setup.headers.get("set-cookie").split(";", 1)[0];
  const csrf = setup.body.csrf;

  const current = (await request(base, "/api/config", { cookie })).body;
  assert.equal((await request(base, "/api/config", {
    method: "PUT", cookie, csrf, requestId: "audit-config", body: { ...current, cache: { ...current.cache, maxEntries: 2049 } },
  })).status, 200);
  assert.equal((await request(base, "/api/backups", {
    method: "POST", cookie, csrf, requestId: "audit-backup", body: { dryRun: false },
  })).status, 201);
  assert.equal((await request(base, "/api/observability/webhook", {
    method: "PUT", cookie, csrf, requestId: "audit-webhook",
    body: { enabled: true, url: "https://alerts.example.test/s12", secret: "do-not-record-this-secret" },
  })).status, 200);
  assert.equal((await request(base, "/api/proxy/cache", {
    method: "DELETE", cookie, csrf, requestId: "audit-cache", body: {},
  })).status, 200);
  assert.equal((await request(base, "/api/tunnel/start", {
    method: "POST", cookie, csrf, requestId: "audit-tunnel",
  })).status, 200);

  const entries = storage.listAuditEntries({ limit: 100, offset: 0 }).items;
  const byAction = new Map(entries.map((entry) => [entry.action, entry]));
  for (const [action, resource, requestId] of [
    ["config.update", "config:global", "audit-config"],
    ["backup.create", "backup:s12-manual-20260812T120000Z.zip", "audit-backup"],
    ["webhook.update", "webhook:configuration", "audit-webhook"],
    ["proxy-cache.clear", "proxy-cache:all", "audit-cache"],
    ["tunnel.start", "tunnel:cloudflare", "audit-tunnel"],
  ]) {
    assert.equal(byAction.get(action)?.resource, resource, action);
    assert.equal(byAction.get(action)?.requestId, requestId, action);
    assert.equal(byAction.get(action)?.actorId, setup.body.identity.id, action);
  }
  assert.equal(JSON.stringify(entries).includes("do-not-record-this-secret"), false);
  assert.equal(storage.verifyAuditChain().valid, true);
});
