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

test("owner manages roles, invitations, users, sessions and scoped API tokens", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-admin-users-"));
  const storage = new SqliteStore({ directory });
  storage.open();
  const auth = new IdentityManager({ directory, storage });
  await auth.load();
  const config = new ConfigStore({ directory });
  await config.load();
  const service = createAdminService({
    auth,
    audit: new AuditService({ storage }),
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
  const setupToken = auth.createSetupToken();
  const setup = await request(base, "/api/setup", {
    method: "POST",
    body: { token: setupToken, password: "correct horse battery" },
  });
  const owner = {
    cookie: setup.headers.get("set-cookie").split(";", 1)[0],
    csrf: setup.body.csrf,
  };

  assert.equal((await request(base, "/api/roles", { ...owner, method: "POST", body: {
    id: "dns-editor", name: "DNS editor", permissions: ["dns:read", "dns:write"],
  } })).status, 201);
  assert.equal((await request(base, "/api/roles", owner)).body.some((role) => role.id === "dns-editor"), true);

  const invitation = await request(base, "/api/users/invitations", {
    ...owner,
    method: "POST",
    body: { username: "editor", role: "dns-editor", ttlMs: 3600000 },
  });
  assert.equal(invitation.status, 201);
  assert.match(invitation.body.token, /^s12_inv_/);
  assert.equal(Object.hasOwn(invitation.body, "tokenHash"), false);
  const accepted = await request(base, `/api/invitations/${encodeURIComponent(invitation.body.token)}/accept`, {
    method: "POST",
    body: { password: "editor secure password", displayName: "Editor" },
  });
  assert.equal(accepted.status, 201);
  const editorId = accepted.body.identity.id;

  const users = await request(base, "/api/users", owner);
  assert.equal(users.status, 200);
  assert.equal(JSON.stringify(users.body).includes("passwordHash"), false);
  assert.equal(users.body.some((user) => user.username === "editor"), true);

  const token = await request(base, "/api/tokens", {
    ...owner,
    method: "POST",
    body: { name: "DNS automation", scopes: ["dns:read"], expiresAt: null },
  });
  assert.equal(token.status, 201);
  assert.match(token.body.token, /^s12_api_/);
  assert.equal(Object.hasOwn(token.body, "tokenHash"), false);
  const tokens = await request(base, "/api/tokens", owner);
  assert.equal(JSON.stringify(tokens.body).includes(token.body.token), false);
  assert.equal(JSON.stringify(tokens.body).includes("tokenHash"), false);
  assert.equal((await request(base, `/api/tokens/${token.body.id}`, { ...owner, method: "DELETE" })).status, 204);

  const editorLogin = await request(base, "/api/login", {
    method: "POST", body: { username: "editor", password: "editor secure password" },
  });
  const editorCookie = editorLogin.headers.get("set-cookie").split(";", 1)[0];
  assert.equal((await request(base, `/api/users/${editorId}/sessions/revoke`, { ...owner, method: "POST" })).status, 200);
  assert.equal((await request(base, "/api/session", { cookie: editorCookie })).status, 401);
  assert.equal((await request(base, `/api/users/${editorId}`, {
    ...owner, method: "PATCH", body: { enabled: false },
  })).status, 200);

  assert.deepEqual(
    storage.listAuditEntries({ limit: 20, offset: 0 }).items.map((entry) => entry.action).sort(),
    ["api-token.create", "api-token.revoke", "invitation.create", "role.create", "session.revoke", "user.update"].sort(),
  );
});
