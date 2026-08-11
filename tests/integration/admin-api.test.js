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
  const clearedScopes = [];
  const clearProxyCache = async (scope) => {
    clearedScopes.push(scope);
    return { entries: 0, bytes: 0, maxBytes: 1024 };
  };
  const proxyOperations = [];
  const proxyHistoryQueries = [];
  const service = createAdminService({
    auth,
    config,
    tunnel: fakeTunnel(),
    clearProxyCache,
    getProxyOperations: () => ({ health: { sites: [] }, draining: { sites: [] }, websockets: { sites: [] } }),
    getProxyHealthHistory: async (query) => {
      proxyHistoryQueries.push(query);
      return [{ site: "app.example.test", upstream: "primary", state: "healthy" }];
    },
    drainProxySite: (host) => { proxyOperations.push(["drain-site", host]); return true; },
    resumeProxySite: (host) => { proxyOperations.push(["resume-site", host]); return true; },
    abortProxySite: (host) => { proxyOperations.push(["abort-site", host]); return 2; },
    drainProxyUpstream: (scope) => { proxyOperations.push(["drain-upstream", scope]); return true; },
    resumeProxyUpstream: (scope) => { proxyOperations.push(["resume-upstream", scope]); return true; },
    status: () => ({ proxyCache: { entries: 2, bytes: 512, maxBytes: 1024 } }),
    host: "127.0.0.1",
    port: 0,
  });
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
  assert.deepEqual((await jsonRequest(base, "/api/status", { cookie })).body.proxyCache, { entries: 2, bytes: 512, maxBytes: 1024 });
  assert.equal((await jsonRequest(base, "/api/proxy/cache", {
    method: "DELETE", cookie, body: { site: "app.example.test" },
  })).status, 403);
  const clearedSite = await jsonRequest(base, "/api/proxy/cache", {
    method: "DELETE", cookie, csrf, body: { site: "app.example.test" },
  });
  assert.equal(clearedSite.status, 200);
  assert.deepEqual(clearedScopes[0], { site: "app.example.test" });
  assert.equal((await jsonRequest(base, "/api/proxy/cache", {
    method: "DELETE", cookie, csrf, body: {},
  })).status, 200);
  assert.deepEqual(clearedScopes[1], {});

  assert.equal((await jsonRequest(base, "/api/proxy/operations", { cookie })).status, 200);
  assert.equal((await jsonRequest(base, "/api/proxy/health-history?window=bad", { cookie })).status, 400);
  const healthHistory = await jsonRequest(base, "/api/proxy/health-history?window=7d&site=app.example.test", { cookie });
  assert.equal(healthHistory.status, 200);
  assert.equal(healthHistory.body[0].state, "healthy");
  assert.deepEqual(proxyHistoryQueries, [{ window: "7d", site: "app.example.test" }]);
  assert.equal((await jsonRequest(base, "/api/proxy/sites/app.example.test/drain", { method: "POST", cookie })).status, 403);
  assert.equal((await jsonRequest(base, "/api/proxy/sites/app.example.test/drain", { method: "POST", cookie, csrf })).status, 200);
  assert.equal((await jsonRequest(base, "/api/proxy/sites/app.example.test/resume", { method: "POST", cookie, csrf })).status, 200);
  const aborted = await jsonRequest(base, "/api/proxy/sites/app.example.test/abort", { method: "POST", cookie, csrf });
  assert.equal(aborted.status, 200);
  assert.equal(aborted.body.aborted, 2);
  const location = encodeURIComponent("prefix:/api");
  assert.equal((await jsonRequest(base, `/api/proxy/sites/app.example.test/locations/${location}/upstreams/primary/drain?fallback=true`, {
    method: "POST", cookie, csrf,
  })).status, 200);
  assert.equal((await jsonRequest(base, `/api/proxy/sites/app.example.test/locations/${location}/upstreams/primary/resume?fallback=true`, {
    method: "POST", cookie, csrf,
  })).status, 200);
  assert.deepEqual(proxyOperations, [
    ["drain-site", "app.example.test"],
    ["resume-site", "app.example.test"],
    ["abort-site", "app.example.test"],
    ["drain-upstream", { host: "app.example.test", location: "prefix:/api", id: "primary", fallback: true }],
    ["resume-upstream", { host: "app.example.test", location: "prefix:/api", id: "primary", fallback: true }],
  ]);
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

test("admin API exposes authenticated read-only DNS diagnostics", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-admin-api-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const auth = new AuthManager({ directory });
  const config = new ConfigStore({ directory });
  await auth.load();
  await config.load();
  await auth.setup(auth.createSetupToken(), "correct horse battery");
  const calls = [];
  const diagnoseDns = async (name, type) => {
    calls.push({ name, type });
    return {
      name,
      type,
      rcode: "NOERROR",
      sources: ["custom", "Cloudflare"],
      answers: [
        { name, type: "CNAME", ttl: 120, value: "origin.example.test" },
        { name: "origin.example.test", type: "A", ttl: 60, address: "192.0.2.88" },
      ],
    };
  };
  const service = createAdminService({
    auth,
    config,
    tunnel: fakeTunnel(),
    diagnoseDns,
    host: "127.0.0.1",
    port: 0,
  });
  await service.start();
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.address().port}`;

  assert.equal((await jsonRequest(base, "/api/dns/diagnose", {
    method: "POST", body: { name: "app.example.test", type: "A" },
  })).status, 401);
  const login = await jsonRequest(base, "/api/login", {
    method: "POST", body: { username: "admin", password: "correct horse battery" },
  });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const csrf = login.body.csrf;
  assert.equal((await jsonRequest(base, "/api/dns/diagnose", {
    method: "POST", cookie, body: { name: "app.example.test", type: "A" },
  })).status, 403);

  for (const body of [
    { name: "", type: "A" },
    { name: "app.example.test", type: "ANY" },
  ]) {
    assert.equal((await jsonRequest(base, "/api/dns/diagnose", {
      method: "POST", cookie, csrf, body,
    })).status, 400);
  }

  for (const type of ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV"]) {
    const response = await jsonRequest(base, "/api/dns/diagnose", {
      method: "POST",
      cookie,
      csrf,
      body: { name: "App.Example.Test.", type },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.rcode, "NOERROR");
    assert.deepEqual(response.body.sources, ["custom", "Cloudflare"]);
    assert.equal(response.body.answers.length, 2);
  }
  assert.deepEqual(calls.map((call) => call.type), ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV"]);
  assert.equal(config.get().records.length, 0);
});

test("admin API reports DNS policy subscriptions and protects manual refresh", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-admin-policy-subscriptions-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const auth = new AuthManager({ directory });
  const config = new ConfigStore({ directory });
  await auth.load();
  await config.load();
  await auth.setup(auth.createSetupToken(), "correct horse battery");
  const session = auth.createSession();
  const cookie = `s12_session=${session.id}`;
  const refreshed = [];
  const service = createAdminService({
    auth,
    config,
    tunnel: fakeTunnel(),
    listPolicySubscriptions: () => [{ id: "ads", domains: 42, fetchedAt: "2026-08-12T00:00:00.000Z" }],
    refreshPolicySubscription: async (id) => {
      refreshed.push(id);
      return { id, domains: 43, fetchedAt: "2026-08-12T01:00:00.000Z" };
    },
    host: "127.0.0.1",
    port: 0,
  });
  await service.start();
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.address().port}`;

  assert.equal((await jsonRequest(base, "/api/dns/policy/subscriptions")).status, 401);
  const listed = await jsonRequest(base, "/api/dns/policy/subscriptions", { cookie });
  assert.equal(listed.status, 200);
  assert.equal(listed.body[0].domains, 42);
  assert.equal((await jsonRequest(base, "/api/dns/policy/subscriptions/ads/refresh", {
    method: "POST", cookie,
  })).status, 403);
  const result = await jsonRequest(base, "/api/dns/policy/subscriptions/ads/refresh", {
    method: "POST", cookie, csrf: session.csrf,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.domains, 43);
  assert.deepEqual(refreshed, ["ads"]);
  assert.equal((await jsonRequest(base, "/api/dns/policy/subscriptions/bad%2Fid/refresh", {
    method: "POST", cookie, csrf: session.csrf,
  })).status, 400);
});

test("admin API previews and atomically manages domain workspace trees", async (t) => {
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
  const login = await jsonRequest(base, "/api/login", {
    method: "POST", body: { username: "admin", password: "correct horse battery" },
  });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const csrf = login.body.csrf;
  const domain = {
    name: "site.example",
    enabled: true,
    defaultTtl: 180,
    note: "website",
    website: { ipv4: "192.0.2.70", createWww: true, upstreamUrl: "http://127.0.0.1:3000" },
  };

  assert.equal((await jsonRequest(base, "/api/domains/preview", { method: "POST", cookie, body: domain })).status, 403);
  const preview = await jsonRequest(base, "/api/domains/preview", { method: "POST", cookie, csrf, body: domain });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.additions.records.length, 2);
  assert.equal(config.get().domains.length, 0);

  const created = await jsonRequest(base, "/api/domains", { method: "POST", cookie, csrf, body: domain });
  assert.equal(created.status, 201);
  assert.equal(config.get().domains[0].name, "site.example");
  assert.equal(config.get().records.length, 2);
  assert.equal(config.get().routes[0].host, "site.example");
  assert.equal((await jsonRequest(base, "/api/domains", { method: "POST", cookie, csrf, body: domain })).status, 400);

  const updated = await jsonRequest(base, "/api/domains/site.example", {
    method: "PUT",
    cookie,
    csrf,
    body: { name: "renamed.example", enabled: false, defaultTtl: 240, note: "paused" },
  });
  assert.equal(updated.status, 200);
  assert.equal(config.get().domains[0].name, "renamed.example");
  assert.equal(config.get().domains[0].enabled, false);
  assert.equal(config.get().records[0].name, "renamed.example");

  const removed = await jsonRequest(base, "/api/domains/renamed.example", { method: "DELETE", cookie, csrf });
  assert.equal(removed.status, 200);
  assert.deepEqual(config.get().domains, []);
  assert.deepEqual(config.get().records, []);
  assert.deepEqual(config.get().routes, []);
});

test("admin API exports, imports and atomically batches primary zone records", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-admin-api-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const now = new Date("2026-08-12T03:00:00Z");
  const auth = new AuthManager({ directory });
  const config = new ConfigStore({ directory, now: () => now });
  await auth.load();
  const initial = await config.load();
  initial.domains = [{ name: "example.test", enabled: true, defaultTtl: 300 }];
  initial.records = [
    { name: "www.example.test", type: "A", ttl: 300, enabled: true, value: "192.0.2.10" },
    { name: "example.test", type: "TXT", ttl: 300, enabled: true, value: "remove-me" },
  ];
  await config.update(initial);
  await auth.setup(auth.createSetupToken(), "correct horse battery");
  const service = createAdminService({ auth, config, tunnel: fakeTunnel(), host: "127.0.0.1", port: 0 });
  await service.start();
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.address().port}`;
  const login = await jsonRequest(base, "/api/login", {
    method: "POST", body: { username: "admin", password: "correct horse battery" },
  });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const csrf = login.body.csrf;

  assert.equal((await fetch(`${base}/api/zones/example.test/export`)).status, 401);
  const exported = await fetch(`${base}/api/zones/example.test/export`, { headers: { cookie } });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-type"), /^text\/dns/);
  assert.match(exported.headers.get("content-disposition"), /example\.test\.zone/);
  const exportedText = await exported.text();
  assert.match(exportedText, /^\$ORIGIN example\.test\./m);
  assert.match(exportedText, /www 300 IN A 192\.0\.2\.10/);

  const zoneText = [
    "$ORIGIN example.test.",
    "$TTL 300",
    "@ IN SOA ns1.example.test. hostmaster.example.test. (2026081299 3600 600 1209600 300)",
    "api IN A 192.0.2.20",
    "",
  ].join("\n");
  assert.equal((await fetch(`${base}/api/zones/example.test/import?mode=merge&preview=true`, {
    method: "POST", headers: { cookie, "content-type": "text/dns" }, body: zoneText,
  })).status, 403);
  assert.equal((await fetch(`${base}/api/zones/example.test/import?mode=merge&preview=true`, {
    method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: zoneText,
  })).status, 415);
  const beforePreview = config.get();
  const previewResponse = await fetch(`${base}/api/zones/example.test/import?mode=merge&preview=true`, {
    method: "POST",
    headers: { cookie, "x-csrf-token": csrf, "content-type": "text/plain" },
    body: zoneText,
  });
  assert.equal(previewResponse.status, 200);
  assert.deepEqual((await previewResponse.json()).summary, { added: 1, removed: 0, skipped: 0 });
  assert.deepEqual(config.get(), beforePreview);

  const importedResponse = await fetch(`${base}/api/zones/example.test/import?mode=merge`, {
    method: "POST",
    headers: { cookie, "x-csrf-token": csrf, "content-type": "text/dns" },
    body: zoneText,
  });
  assert.equal(importedResponse.status, 200);
  assert.equal(config.get().domains[0].soa.serial, 2026081299);
  assert.equal(config.get().records.some((record) => record.name === "api.example.test"), true);

  const current = config.get();
  const address = current.records.find((record) => record.name === "www.example.test");
  const text = current.records.find((record) => record.type === "TXT");
  const serialBeforeBatch = current.domains[0].soa.serial;
  const batch = await jsonRequest(base, "/api/zones/example.test/records/batch", {
    method: "POST",
    cookie,
    csrf,
    body: {
      create: [{ name: "ipv6.example.test", type: "AAAA", ttl: 120, enabled: true, value: "2001:db8::44" }],
      update: [{ id: address.id, record: { name: "www.example.test", type: "A", ttl: 60, enabled: false, value: "192.0.2.11" } }],
      delete: [text.id],
    },
  });
  assert.equal(batch.status, 200);
  assert.deepEqual(batch.body.summary, { created: 1, updated: 1, deleted: 1 });
  assert.equal(config.get().domains[0].soa.serial, serialBeforeBatch + 1);
  assert.equal(config.get().records.find((record) => record.id === address.id).value, "192.0.2.11");
  assert.equal(config.get().records.find((record) => record.id === address.id).enabled, false);
  assert.equal(config.get().records.some((record) => record.id === text.id), false);

  const beforeRejected = config.get();
  const rejected = await jsonRequest(base, "/api/zones/example.test/records/batch", {
    method: "POST",
    cookie,
    csrf,
    body: { create: [], update: [], delete: ["00000000-0000-4000-8000-000000000000"] },
  });
  assert.equal(rejected.status, 400);
  assert.deepEqual(config.get(), beforeRejected);
});

test("admin API persists Tunnel tokens without returning their plaintext", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-admin-api-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const auth = new AuthManager({ directory });
  const config = new ConfigStore({ directory });
  await auth.load();
  const current = await config.load();
  current.tunnel = { token: "initial-stored-secret" };
  await config.update(current);
  await auth.setup(auth.createSetupToken(), "correct horse battery");
  const tunnel = {
    status: () => ({
      available: Boolean(config.get().tunnel.token),
      tokenSource: config.get().tunnel.token ? "config" : "none",
      hasStoredToken: Boolean(config.get().tunnel.token),
      state: "stopped",
      logs: [],
    }),
    start: async () => {},
    stop: async () => {},
  };
  let rejectNextToken = false;
  const updateTunnelToken = async (token) => {
    if (rejectNextToken) throw new Error(`cloudflared rejected ${token}`);
    await config.update({ ...config.get(), tunnel: { token } });
    return tunnel.status();
  };
  const clearTunnelToken = async () => updateTunnelToken("");
  const service = createAdminService({
    auth,
    config,
    tunnel,
    updateTunnelToken,
    clearTunnelToken,
    host: "127.0.0.1",
    port: 0,
  });
  await service.start();
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.address().port}`;
  const login = await jsonRequest(base, "/api/login", {
    method: "POST", body: { username: "admin", password: "correct horse battery" },
  });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const csrf = login.body.csrf;

  const exposed = await jsonRequest(base, "/api/config", { cookie });
  assert.equal(JSON.stringify(exposed.body).includes("initial-stored-secret"), false);
  assert.deepEqual(exposed.body.tunnel, { hasStoredToken: true });
  const changed = { ...exposed.body, records: [{ name: "safe.test", type: "A", value: "192.0.2.9", ttl: 60 }] };
  assert.equal((await jsonRequest(base, "/api/config", { method: "PUT", cookie, csrf, body: changed })).status, 200);
  assert.equal(config.get().tunnel.token, "initial-stored-secret");

  assert.equal((await jsonRequest(base, "/api/tunnel/token", {
    method: "PUT", cookie, body: { token: "replacement-secret" },
  })).status, 403);
  assert.equal((await jsonRequest(base, "/api/tunnel/token", {
    method: "PUT", cookie, csrf, body: { token: "" },
  })).status, 400);
  const replaced = await jsonRequest(base, "/api/tunnel/token", {
    method: "PUT", cookie, csrf, body: { token: "replacement-secret" },
  });
  assert.equal(replaced.status, 200);
  assert.equal(JSON.stringify(replaced.body).includes("replacement-secret"), false);
  assert.equal(config.get().tunnel.token, "replacement-secret");
  assert.equal((await fs.readFile(path.join(directory, "config.json"), "utf8")).includes("replacement-secret"), true);

  rejectNextToken = true;
  const rejected = await jsonRequest(base, "/api/tunnel/token", {
    method: "PUT", cookie, csrf, body: { token: "never-return-this-secret" },
  });
  assert.equal(rejected.status, 503);
  assert.equal(JSON.stringify(rejected.body).includes("never-return-this-secret"), false);
  rejectNextToken = false;

  const cleared = await jsonRequest(base, "/api/tunnel/token", { method: "DELETE", cookie, csrf });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.hasStoredToken, false);
  assert.equal(config.get().tunnel.token, "");
});

test("admin API protects observability secrets and manages metric history and webhook retries", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-admin-api-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const auth = new AuthManager({ directory });
  const config = new ConfigStore({ directory });
  await auth.load();
  const initial = await config.load();
  initial.observability.webhook = {
    enabled: true,
    url: "https://alerts.example.test/s12",
    secret: "stored-webhook-secret",
  };
  await config.update(initial);
  await auth.setup(auth.createSetupToken(), "correct horse battery");
  const metricWindows = [];
  const retryIds = [];
  const updateWebhooks = [];
  const service = createAdminService({
    auth,
    config,
    tunnel: fakeTunnel(),
    getMetricHistory: async (window) => {
      metricWindows.push(window);
      return [{ metric: "dns_queries_total", labels: { source: "custom" }, value: 9 }];
    },
    listWebhookJobs: ({ state }) => [{ id: "job-dead", state, attempts: 3 }],
    retryWebhookJob: async (id) => { retryIds.push(id); return { id, state: "pending" }; },
    updateWebhookConfig: async (value) => { updateWebhooks.push(value); return value; },
    host: "127.0.0.1",
    port: 0,
  });
  await service.start();
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.address().port}`;
  const login = await jsonRequest(base, "/api/login", {
    method: "POST", body: { username: "admin", password: "correct horse battery" },
  });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const csrf = login.body.csrf;

  const exposed = await jsonRequest(base, "/api/config", { cookie });
  assert.equal(JSON.stringify(exposed.body).includes("stored-webhook-secret"), false);
  assert.deepEqual(exposed.body.observability.webhook, {
    enabled: true,
    url: "https://alerts.example.test/s12",
    hasSecret: true,
  });
  const roundTrip = await jsonRequest(base, "/api/config", {
    method: "PUT", cookie, csrf, body: exposed.body,
  });
  assert.equal(roundTrip.status, 200);
  assert.equal(config.get().observability.webhook.secret, "stored-webhook-secret");

  assert.equal((await jsonRequest(base, "/api/observability/metrics?window=bad", { cookie })).status, 400);
  const metrics = await jsonRequest(base, "/api/observability/metrics?window=24h", { cookie });
  assert.equal(metrics.status, 200);
  assert.equal(metrics.body[0].value, 9);
  assert.deepEqual(metricWindows, ["24h"]);

  const webhooks = await jsonRequest(base, "/api/observability/webhooks?state=dead-letter", { cookie });
  assert.equal(webhooks.status, 200);
  assert.equal(webhooks.body[0].state, "dead-letter");
  assert.equal((await jsonRequest(base, "/api/observability/webhooks/job-dead/retry", {
    method: "POST", cookie,
  })).status, 403);
  assert.equal((await jsonRequest(base, "/api/observability/webhooks/job-dead/retry", {
    method: "POST", cookie, csrf,
  })).status, 200);
  assert.deepEqual(retryIds, ["job-dead"]);

  assert.equal((await jsonRequest(base, "/api/observability/webhook", {
    method: "PUT",
    cookie,
    csrf,
    body: { enabled: true, url: "https://next.example.test/hook", secret: "" },
  })).status, 400);
  const updated = await jsonRequest(base, "/api/observability/webhook", {
    method: "PUT",
    cookie,
    csrf,
    body: { enabled: true, url: "https://next.example.test/hook", secret: "next-secret" },
  });
  assert.equal(updated.status, 200);
  assert.equal(JSON.stringify(updated.body).includes("next-secret"), false);
  assert.deepEqual(updateWebhooks, [{ enabled: true, url: "https://next.example.test/hook", secret: "next-secret" }]);
});

test("admin API manages and downloads owner-sensitive backups", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-admin-api-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const auth = new AuthManager({ directory });
  const config = new ConfigStore({ directory });
  await auth.load();
  await config.load();
  await auth.setup(auth.createSetupToken(), "correct horse battery");
  const archivePath = path.join(directory, "s12-manual-20260811T030000Z.zip");
  await fs.writeFile(archivePath, "sensitive backup bytes");
  const calls = [];
  const fileName = path.basename(archivePath);
  const service = createAdminService({
    auth,
    config,
    tunnel: fakeTunnel(),
    listBackups: async () => [{ fileName, size: 22 }],
    createBackup: async (options) => { calls.push(["create", options]); return { fileName, ...options }; },
    importBackup: async (stream, options) => {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      calls.push(["import", options, Buffer.concat(chunks).toString("utf8")]);
      return { fileName: options.fileName, imported: true };
    },
    getBackupDownload: async (name) => { calls.push(["download", name]); return { fileName: name, path: archivePath }; },
    deleteBackup: async (name) => { calls.push(["delete", name]); return { fileName: name, deleted: true }; },
    restoreBackup: async (name, options) => { calls.push(["restore", name, options]); return { restored: !options.dryRun, dryRun: options.dryRun }; },
    host: "127.0.0.1",
    port: 0,
  });
  await service.start();
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.address().port}`;
  const login = await jsonRequest(base, "/api/login", {
    method: "POST", body: { username: "admin", password: "correct horse battery" },
  });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const csrf = login.body.csrf;

  assert.equal((await jsonRequest(base, "/api/backups")).status, 401);
  assert.equal((await jsonRequest(base, "/api/backups", { cookie })).body[0].fileName, fileName);
  assert.equal((await jsonRequest(base, "/api/backups", {
    method: "POST", cookie, body: { dryRun: true },
  })).status, 403);
  const dryRun = await jsonRequest(base, "/api/backups", {
    method: "POST", cookie, csrf, body: { dryRun: true },
  });
  assert.equal(dryRun.status, 200);
  assert.equal(dryRun.body.dryRun, true);
  const created = await jsonRequest(base, "/api/backups", {
    method: "POST", cookie, csrf, body: {},
  });
  assert.equal(created.status, 201);

  const uploadName = "s12-upload-20260811T031500Z.zip";
  assert.equal((await fetch(`${base}/api/backups/upload`, {
    method: "POST",
    headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json", "x-backup-filename": uploadName },
    body: "zip bytes",
  })).status, 415);
  assert.equal((await fetch(`${base}/api/backups/upload`, {
    method: "POST",
    headers: { cookie, "x-csrf-token": csrf, "content-type": "application/zip" },
    body: "zip bytes",
  })).status, 400);
  const uploaded = await fetch(`${base}/api/backups/upload`, {
    method: "POST",
    headers: { cookie, "x-csrf-token": csrf, "content-type": "application/zip", "x-backup-filename": uploadName },
    body: "zip bytes",
  });
  assert.equal(uploaded.status, 201);
  assert.equal((await uploaded.json()).fileName, uploadName);

  const download = await fetch(`${base}/api/backups/${fileName}/download`, {
    headers: { cookie },
  });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/zip");
  assert.match(download.headers.get("content-disposition"), /attachment/);
  assert.equal(await download.text(), "sensitive backup bytes");

  assert.equal((await jsonRequest(base, `/api/backups/${fileName}/restore`, {
    method: "POST", cookie, csrf, body: { dryRun: true },
  })).body.dryRun, true);
  assert.equal((await jsonRequest(base, `/api/backups/${fileName}`, {
    method: "DELETE", cookie, csrf,
  })).status, 200);
  assert.equal((await jsonRequest(base, "/api/backups/..%2Fconfig.json", {
    method: "DELETE", cookie, csrf,
  })).status, 400);
  assert.deepEqual(calls, [
    ["create", { kind: "manual", dryRun: true }],
    ["create", { kind: "manual", dryRun: false }],
    ["import", { fileName: uploadName }, "zip bytes"],
    ["download", fileName],
    ["restore", fileName, { dryRun: true }],
    ["delete", fileName],
  ]);
});
