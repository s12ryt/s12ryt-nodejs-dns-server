"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ConfigStore } = require("../../src/admin/config-store");
const { AuditService } = require("../../src/admin/audit-service");
const { IdentityManager } = require("../../src/admin/identity-manager");
const { createAdminService } = require("../../src/admin/server");
const { SqliteStore } = require("../../src/storage/sqlite-store");

async function request(base, pathname, { method = "GET", cookie, csrf, body } = {}) {
  const headers = { accept: "application/json" };
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

test("admin API uses persistent identities for setup, login, session and CSRF", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-admin-identity-"));
  const storage = new SqliteStore({ directory });
  storage.open();
  const auth = new IdentityManager({ directory, storage });
  await auth.load();
  const config = new ConfigStore({ directory });
  await config.load();
  const setupToken = auth.createSetupToken();
  const service = createAdminService({
    auth,
    config,
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

  const setup = await request(base, "/api/setup", {
    method: "POST",
    body: { token: setupToken, password: "correct horse battery" },
  });
  assert.equal(setup.status, 201);
  assert.equal(setup.body.identity.role, "owner");
  assert.equal(setup.body.identity.permissions.includes("users:write"), true);
  const cookie = setup.headers.get("set-cookie").split(";", 1)[0];

  const session = await request(base, "/api/session", { cookie });
  assert.equal(session.status, 200);
  assert.equal(session.body.identity.username, "admin");
  assert.equal(session.body.csrf, setup.body.csrf);
  assert.equal((await request(base, "/api/logout", { method: "POST", cookie, csrf: setup.body.csrf })).status, 204);
  assert.equal((await request(base, "/api/session", { cookie })).status, 401);

  const login = await request(base, "/api/login", {
    method: "POST",
    body: { username: "admin", password: "correct horse battery" },
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.identity.role, "owner");
});

test("owner reads, verifies and exports audit records for identity mutations", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-admin-audit-"));
  const storage = new SqliteStore({ directory, now: () => new Date("2026-08-12T12:00:00.000Z") });
  storage.open();
  const auth = new IdentityManager({ directory, storage });
  await auth.load();
  const config = new ConfigStore({ directory });
  await config.load();
  const audit = new AuditService({ storage, now: () => new Date("2026-08-12T12:00:00.000Z") });
  const setupToken = auth.createSetupToken();
  const service = createAdminService({
    auth,
    audit,
    config,
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
  const setup = await request(base, "/api/setup", {
    method: "POST",
    body: { token: setupToken, password: "correct horse battery" },
  });
  const cookie = setup.headers.get("set-cookie").split(";", 1)[0];
  const csrf = setup.body.csrf;

  const created = await fetch(`${base}/api/roles`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      cookie,
      "x-csrf-token": csrf,
      "x-request-id": "audit-request-1",
    },
    body: JSON.stringify({ id: "audit-viewer", name: "Audit viewer", permissions: ["audit:read"] }),
  });
  assert.equal(created.status, 201);

  const list = await request(base, "/api/audit?action=role.create&limit=20&offset=0", { cookie });
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items[0].actorId, setup.body.identity.id);
  assert.equal(list.body.items[0].requestId, "audit-request-1");
  assert.equal(list.body.items[0].sourceIp.includes("127.0.0.1"), true);
  assert.equal(list.body.items[0].resource, "role:audit-viewer");
  assert.equal(list.body.items[0].before, null);
  assert.equal(list.body.items[0].after.id, "audit-viewer");
  assert.deepEqual((await request(base, "/api/audit/verify", { cookie })).body, {
    valid: true, entries: 1, brokenAt: null,
  });

  const exported = await fetch(`${base}/api/audit/export`, { headers: { cookie } });
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
  assert.match(exported.headers.get("content-disposition"), /s12-audit-20260812T120000Z\.ndjson/);
  assert.match(await exported.text(), /"action":"role.create"/);
});
