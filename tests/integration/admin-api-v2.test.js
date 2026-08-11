"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AuditService } = require("../../src/admin/audit-service");
const { ConfigStore } = require("../../src/admin/config-store");
const { IdempotencyService } = require("../../src/admin/idempotency-service");
const { IdentityManager } = require("../../src/admin/identity-manager");
const { createAdminService } = require("../../src/admin/server");
const { SqliteStore } = require("../../src/storage/sqlite-store");

async function jsonRequest(base, pathname, { method = "GET", cookie, bearer, csrf, key, body } = {}) {
  const headers = { accept: "application/json" };
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (csrf) headers["x-csrf-token"] = csrf;
  if (key) headers["idempotency-key"] = key;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

test("API v2 publishes OpenAPI and provides paginated idempotent role administration", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-admin-v2-"));
  const storage = new SqliteStore({ directory, now: () => new Date("2026-08-12T12:00:00.000Z") });
  storage.open();
  const auth = new IdentityManager({ directory, storage });
  await auth.load();
  const config = new ConfigStore({ directory });
  await config.load();
  const service = createAdminService({
    auth,
    audit: new AuditService({ storage }),
    config,
    idempotency: new IdempotencyService({ storage }),
    tunnel: { status: () => ({ available: false, state: "stopped", logs: [] }) },
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

  const openapi = await jsonRequest(base, "/api/v2/openapi.json");
  assert.equal(openapi.status, 200);
  assert.equal(openapi.body.openapi, "3.1.0");
  assert.equal(Boolean(openapi.body.paths["/api/v2/roles"]), true);

  const setupToken = auth.createSetupToken();
  const setup = await jsonRequest(base, "/api/setup", {
    method: "POST",
    body: { token: setupToken, password: "correct horse battery" },
  });
  const cookie = setup.headers.get("set-cookie").split(";", 1)[0];
  const csrf = setup.body.csrf;

  const users = await jsonRequest(base, "/api/v2/users?limit=1&offset=0", { cookie });
  assert.equal(users.status, 200);
  assert.equal(users.body.data.length, 1);
  assert.deepEqual(users.body.meta.pagination, { limit: 1, offset: 0, total: 1 });

  const legacyConfig = await jsonRequest(base, "/api/v1/config", { cookie });
  assert.equal(legacyConfig.status, 200);
  assert.equal(legacyConfig.body.schemaVersion >= 1, true);
  assert.equal(legacyConfig.headers.get("deprecation"), "true");
  assert.match(legacyConfig.headers.get("link"), /\/api\/v2\/openapi\.json/);
  const legacyWrite = await jsonRequest(base, "/api/v1/config", {
    method: "PUT", cookie, csrf, body: legacyConfig.body,
  });
  assert.equal(legacyWrite.status, 405);
  assert.equal(legacyWrite.headers.get("allow"), "GET");

  const missingKey = await jsonRequest(base, "/api/v2/roles", {
    method: "POST", cookie, csrf, body: { id: "dns-editor", name: "DNS editor", permissions: ["dns:read"] },
  });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.body.error.code, "IDEMPOTENCY_KEY_REQUIRED");
  assert.match(missingKey.body.error.requestId, /^[0-9a-f-]{36}$/);

  const roleBody = { id: "dns-editor", name: "DNS editor", permissions: ["dns:read", "dns:write"] };
  const created = await jsonRequest(base, "/api/v2/roles", {
    method: "POST", cookie, csrf, key: "create-dns-editor-001", body: roleBody,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.id, "dns-editor");
  assert.equal(created.body.meta.idempotencyReplayed, false);

  const replay = await jsonRequest(base, "/api/v2/roles", {
    method: "POST", cookie, csrf, key: "create-dns-editor-001", body: roleBody,
  });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.equal(replay.body.meta.idempotencyReplayed, false);
  assert.equal(auth.listRoles(setup.body.identity).filter((role) => role.id === "dns-editor").length, 1);

  const conflict = await jsonRequest(base, "/api/v2/roles", {
    method: "POST", cookie, csrf, key: "create-dns-editor-001",
    body: { ...roleBody, name: "Different role" },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "IDEMPOTENCY_KEY_CONFLICT");

  const automation = auth.createApiToken(setup.body.identity, {
    name: "Role automation",
    scopes: ["roles:write"],
    expiresAt: null,
  });
  const bearerCreated = await jsonRequest(base, "/api/v2/roles", {
    method: "POST",
    bearer: automation.token,
    key: "create-ops-role-0001",
    body: { id: "ops-role", name: "Operations", permissions: ["proxy:read"] },
  });
  assert.equal(bearerCreated.status, 201);
  const denied = await jsonRequest(base, "/api/v2/users", { bearer: automation.token });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "TOKEN_SCOPE_INSUFFICIENT");
  assert.equal(storage.listAuditEntries({ action: "role.create", limit: 20, offset: 0 }).items
    .some((entry) => entry.actorId === automation.id && entry.actorType === "api-token"), true);

  const missing = await jsonRequest(base, "/api/v2/not-found", { cookie });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "NOT_FOUND");
});

test("API v2 manages DNS zones and proxy sites while exposing operational resources", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-admin-v2-resources-"));
  const storage = new SqliteStore({ directory, now: () => new Date("2026-08-12T12:00:00.000Z") });
  storage.open();
  const auth = new IdentityManager({ directory, storage });
  await auth.load();
  const config = new ConfigStore({ directory, now: () => new Date("2026-08-12T12:00:00.000Z") });
  await config.load();
  const service = createAdminService({
    auth,
    audit: new AuditService({ storage }),
    config,
    idempotency: new IdempotencyService({ storage }),
    tunnel: { status: () => ({ available: true, state: "running", logs: [] }) },
    listBackups: async () => [{ fileName: "s12-manual-20260812T120000Z.zip", size: 42 }],
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
  const openapi = await jsonRequest(base, "/api/v2/openapi.json");
  for (const resourcePath of ["/api/v2/dns/zones", "/api/v2/proxy/sites", "/api/v2/tunnel", "/api/v2/backups", "/api/v2/audit"]) {
    assert.equal(Boolean(openapi.body.paths[resourcePath]), true, resourcePath);
  }

  const setupToken = auth.createSetupToken();
  const setup = await jsonRequest(base, "/api/setup", {
    method: "POST",
    body: { token: setupToken, password: "correct horse battery" },
  });
  const cookie = setup.headers.get("set-cookie").split(";", 1)[0];
  const csrf = setup.body.csrf;

  const zoneBody = { name: "api.example.test", enabled: true, defaultTtl: 300, note: "API managed" };
  const zone = await jsonRequest(base, "/api/v2/dns/zones", {
    method: "POST", cookie, csrf, key: "create-zone-api-example", body: zoneBody,
  });
  assert.equal(zone.status, 201);
  assert.equal(zone.body.data.name, "api.example.test");
  const zoneReplay = await jsonRequest(base, "/api/v2/dns/zones", {
    method: "POST", cookie, csrf, key: "create-zone-api-example", body: zoneBody,
  });
  assert.equal(zoneReplay.headers.get("idempotency-replayed"), "true");
  const zones = await jsonRequest(base, "/api/v2/dns/zones?limit=10&offset=0", { cookie });
  assert.deepEqual(zones.body.meta.pagination, { limit: 10, offset: 0, total: 1 });

  const siteBody = { host: "proxy.api.example.test", enabled: true, target: "http://127.0.0.1:9000" };
  const site = await jsonRequest(base, "/api/v2/proxy/sites", {
    method: "POST", cookie, csrf, key: "create-proxy-api-example", body: siteBody,
  });
  assert.equal(site.status, 201);
  assert.equal(site.body.data.host, "proxy.api.example.test");
  const sites = await jsonRequest(base, "/api/v2/proxy/sites?enabled=true", { cookie });
  assert.equal(sites.body.data.length, 1);
  assert.equal(sites.body.data[0].locations[0].path, "/");

  const tunnel = await jsonRequest(base, "/api/v2/tunnel", { cookie });
  assert.equal(tunnel.body.data.state, "running");
  const backups = await jsonRequest(base, "/api/v2/backups?limit=5&offset=0", { cookie });
  assert.equal(backups.body.data[0].fileName, "s12-manual-20260812T120000Z.zip");
  const audit = await jsonRequest(base, "/api/v2/audit?limit=20&offset=0", { cookie });
  assert.equal(audit.body.data.some((entry) => entry.action === "zone.create"), true);
  assert.equal(audit.body.data.some((entry) => entry.action === "proxy-site.create"), true);
});
