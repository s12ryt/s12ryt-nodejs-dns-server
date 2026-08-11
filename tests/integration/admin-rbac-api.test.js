"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ConfigStore } = require("../../src/admin/config-store");
const { IdentityManager } = require("../../src/admin/identity-manager");
const { createAdminService } = require("../../src/admin/server");
const { SqliteStore } = require("../../src/storage/sqlite-store");

async function request(base, pathname, { method = "GET", cookie, csrf, bearer, body } = {}) {
  const headers = { accept: "application/json" };
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

test("admin API enforces fixed roles, owner-only data and scoped bearer tokens", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-admin-rbac-"));
  const storage = new SqliteStore({ directory });
  storage.open();
  const auth = new IdentityManager({ directory, storage });
  await auth.load();
  await auth.setup(auth.createSetupToken(), "correct horse battery");
  const owner = storage.getUserByUsername("admin");
  const viewerInvite = auth.createInvitation(owner, { username: "viewer", role: "viewer" });
  await auth.acceptInvitation(viewerInvite.token, "viewer secure password", "Viewer");
  const operatorInvite = auth.createInvitation(owner, { username: "operator", role: "operator" });
  await auth.acceptInvitation(operatorInvite.token, "operator secure password", "Operator");
  const dnsToken = auth.createApiToken(owner, { name: "DNS reader", scopes: ["dns:read"] });
  const config = new ConfigStore({ directory });
  await config.load();
  const service = createAdminService({
    auth,
    config,
    tunnel: {
      status: () => ({ available: true, state: "stopped", logs: [] }),
      start: async () => {},
      stop: async () => {},
    },
    listBackups: async () => [],
    getBackupDownload: async () => ({ fileName: "s12-manual-20260812T010000Z.zip", path: "missing" }),
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

  async function login(username, password) {
    const result = await request(base, "/api/login", { method: "POST", body: { username, password } });
    assert.equal(result.status, 200);
    return {
      cookie: result.headers.get("set-cookie").split(";", 1)[0],
      csrf: result.body.csrf,
    };
  }

  const viewer = await login("viewer", "viewer secure password");
  assert.equal((await request(base, "/api/config", viewer)).status, 200);
  assert.equal((await request(base, "/api/config", { ...viewer, method: "PUT", body: config.get() })).status, 403);
  assert.equal((await request(base, "/api/tunnel/start", { ...viewer, method: "POST" })).status, 403);

  const operator = await login("operator", "operator secure password");
  assert.equal((await request(base, "/api/tunnel/start", { ...operator, method: "POST" })).status, 200);
  assert.equal((await request(base, "/api/config", { ...operator, method: "PUT", body: config.get() })).status, 403);

  assert.equal((await request(base, "/api/config", { bearer: dnsToken.token })).status, 200);
  assert.equal((await request(base, "/api/events", { bearer: dnsToken.token })).status, 403);
  assert.equal((await request(base, "/api/config", { bearer: dnsToken.token, method: "PUT", body: config.get() })).status, 403);

  const ownerSession = await login("admin", "correct horse battery");
  const sensitive = await request(base, "/api/backups/s12-manual-20260812T010000Z.zip/download", ownerSession);
  assert.notEqual(sensitive.status, 403);
  const viewerSensitive = await request(base, "/api/backups/s12-manual-20260812T010000Z.zip/download", viewer);
  assert.equal(viewerSensitive.status, 403);
});
