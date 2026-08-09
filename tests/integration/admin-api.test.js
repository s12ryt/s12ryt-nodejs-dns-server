"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AuthManager } = require("../../src/admin/auth-manager");
const { ConfigStore } = require("../../src/admin/config-store");
const { createAdminService } = require("../../src/admin/server");

function fakeTunnel() {
  let state = "stopped";
  return {
    status: () => ({ available: true, state, version: "test", lastError: null, logs: [] }),
    start: async () => { state = "running"; },
    stop: async () => { state = "stopped"; },
  };
}

async function jsonRequest(base, pathname, { method = "GET", cookie, csrf, body } = {}) {
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
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

test("admin API enforces setup, session and CSRF around configuration", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-admin-api-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const auth = new AuthManager({ directory });
  const config = new ConfigStore({ directory });
  await auth.load();
  await config.load();
  const setupToken = auth.createSetupToken();
  const service = createAdminService({ auth, config, tunnel: fakeTunnel(), host: "127.0.0.1", port: 0 });
  await service.start();
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.address().port}`;

  assert.deepEqual((await jsonRequest(base, "/api/bootstrap")).body, { configured: false });
  assert.equal((await jsonRequest(base, "/api/config")).status, 401);
  assert.equal((await jsonRequest(base, "/api/setup", {
    method: "POST",
    body: { token: "wrong", password: "correct horse battery" },
  })).status, 400);

  const setup = await jsonRequest(base, "/api/setup", {
    method: "POST",
    body: { token: setupToken, password: "correct horse battery" },
  });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get("set-cookie").split(";", 1)[0];
  assert.match(setup.headers.get("set-cookie"), /HttpOnly/i);
  assert.match(setup.headers.get("set-cookie"), /SameSite=Strict/i);
  const csrf = setup.body.csrf;

  const current = await jsonRequest(base, "/api/config", { cookie });
  assert.equal(current.status, 200);
  const changed = {
    ...current.body,
    records: [{ name: "api.test", type: "A", value: "192.0.2.44", ttl: 60 }],
  };
  assert.equal((await jsonRequest(base, "/api/config", { method: "PUT", cookie, body: changed })).status, 403);
  assert.equal((await jsonRequest(base, "/api/config", { method: "PUT", cookie, csrf, body: changed })).status, 200);
  assert.equal(config.get().records[0].name, "api.test");

  assert.equal((await jsonRequest(base, "/api/tunnel", { cookie })).body.available, true);
  assert.equal((await jsonRequest(base, "/api/tunnel/start", { method: "POST", cookie, csrf })).status, 200);
  assert.equal((await jsonRequest(base, "/api/tunnel", { cookie })).body.state, "running");
});

test("admin API supports login and invalidates logout sessions", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-admin-api-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const auth = new AuthManager({ directory });
  const config = new ConfigStore({ directory });
  await auth.load();
  await config.load();
  await auth.setup(auth.createSetupToken(), "correct horse battery");
  const service = createAdminService({ auth, config, tunnel: fakeTunnel(), host: "127.0.0.1", port: 0 });
  await service.start();
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.address().port}`;

  assert.equal((await jsonRequest(base, "/api/login", {
    method: "POST", body: { username: "admin", password: "wrong password" },
  })).status, 401);
  const login = await jsonRequest(base, "/api/login", {
    method: "POST", body: { username: "admin", password: "correct horse battery" },
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  assert.equal((await jsonRequest(base, "/api/logout", {
    method: "POST", cookie, csrf: login.body.csrf,
  })).status, 204);
  assert.equal((await jsonRequest(base, "/api/config", { cookie })).status, 401);
});
