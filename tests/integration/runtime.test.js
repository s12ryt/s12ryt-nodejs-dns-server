"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createQuery, parseMessage } = require("../../src/dns/message");
const { ConfigStore } = require("../../src/admin/config-store");
const { createRuntime } = require("../../src/runtime");

function fakeService(name, lifecycle) {
  return {
    async start() { lifecycle.push(`start:${name}`); },
    async close() { lifecycle.push(`close:${name}`); },
    address() { return { address: "127.0.0.1", port: 1000 }; },
  };
}

function configurableTunnel() {
  let token = "";
  let tokenSource = "none";
  let hasStoredToken = false;
  let state = "stopped";
  const calls = [];
  const failingTokens = new Set();
  return {
    calls,
    failingTokens,
    status: () => ({ available: Boolean(token), tokenSource, hasStoredToken, state, logs: [] }),
    configure(next) {
      ({ token, tokenSource, hasStoredToken } = next);
      calls.push({ action: "configure", token, tokenSource, hasStoredToken });
    },
    async start() {
      calls.push({ action: "start", token });
      if (failingTokens.has(token)) {
        state = "error";
        throw new Error(`token rejected: ${token}`);
      }
      state = "running";
    },
    async stop() {
      calls.push({ action: "stop", token });
      state = "stopped";
    },
  };
}

test("runtime shares live DNS and proxy state and closes services in reverse order", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-runtime-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lifecycle = [];
  const output = [];
  const tunnel = {
    status: () => ({ available: false, state: "stopped", logs: [] }),
    start: async () => { throw new Error("must not start without a token"); },
    stop: async () => { lifecycle.push("close:tunnel"); },
  };
  const runtime = createRuntime({
    directory,
    tunnel,
    output: (line) => output.push(line),
    serviceFactories: {
      dns: ({ resolver }) => ({ ...fakeService("dns", lifecycle), resolver }),
      doh: () => fakeService("doh", lifecycle),
      proxy: ({ routes }) => ({ ...fakeService("proxy", lifecycle), routes }),
      admin: () => fakeService("admin", lifecycle),
    },
  });

  await runtime.start();
  assert.deepEqual(lifecycle, ["start:dns", "start:doh", "start:proxy", "start:admin"]);
  assert.match(output.join("\n"), /setup token/i);
  assert.equal(runtime.status().services.dns.port, 1000);

  const updated = runtime.config.get();
  updated.records = [{ name: "live.test", type: "A", value: "192.0.2.77", ttl: 30 }];
  updated.routes = [{ host: "app.test", dnsName: "live.test", scheme: "http", port: 9000 }];
  await runtime.config.update(updated);

  const response = parseMessage(await runtime.components.resolver.resolve(createQuery("live.test", "A", { id: 42 })));
  assert.equal(response.answers[0].address, "192.0.2.77");
  assert.equal(runtime.components.routes.resolve("app.test").url.href, "http://192.0.2.77:9000/");

  await runtime.close();
  assert.deepEqual(lifecycle.slice(-5), ["close:admin", "close:proxy", "close:doh", "close:dns", "close:tunnel"]);
});

test("runtime keeps core services available when automatic Tunnel startup fails", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-runtime-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lifecycle = [];
  const tunnel = {
    status: () => ({ available: true, state: "error", lastError: "download failed", logs: [] }),
    start: async () => { throw new Error("download failed"); },
    stop: async () => {},
  };
  const serviceFactories = Object.fromEntries(
    ["dns", "doh", "proxy", "admin"].map((name) => [name, () => fakeService(name, lifecycle)]),
  );
  const runtime = createRuntime({ directory, tunnel, output: () => {}, serviceFactories });

  await runtime.start();

  assert.deepEqual(lifecycle, ["start:dns", "start:doh", "start:proxy", "start:admin"]);
  assert.equal(runtime.status().tunnel.state, "error");
  assert.match(runtime.events.list().at(-1).message, /download failed/);
  await runtime.close();
});

test("runtime restarts Tunnel for a stored token and rolls back a rejected replacement", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-runtime-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const seed = new ConfigStore({ directory });
  const initial = await seed.load();
  initial.tunnel = { token: "old-config-token" };
  await seed.update(initial);
  const lifecycle = [];
  const tunnel = configurableTunnel();
  const serviceFactories = Object.fromEntries(
    ["dns", "doh", "proxy", "admin"].map((name) => [name, () => fakeService(name, lifecycle)]),
  );
  const runtime = createRuntime({ directory, environment: {}, tunnel, output: () => {}, serviceFactories });
  await runtime.start();
  assert.equal(runtime.status().tunnel.tokenSource, "config");

  tunnel.calls.length = 0;
  await runtime.updateTunnelToken("new-config-token");
  assert.deepEqual(tunnel.calls.map((call) => call.action), ["stop", "configure", "start"]);
  assert.equal(runtime.config.get().tunnel.token, "new-config-token");
  assert.equal(lifecycle.some((entry) => entry.startsWith("close:")), false);

  tunnel.calls.length = 0;
  tunnel.failingTokens.add("rejected-token");
  await assert.rejects(runtime.updateTunnelToken("rejected-token"), /token rejected/i);
  assert.equal(runtime.config.get().tunnel.token, "new-config-token");
  assert.deepEqual(tunnel.calls.map((call) => call.action), ["stop", "configure", "start", "configure", "start"]);
  assert.equal(runtime.status().tunnel.state, "running");
  assert.equal(JSON.stringify(runtime.events.list()).includes("rejected-token"), false);

  tunnel.calls.length = 0;
  await runtime.clearTunnelToken();
  assert.deepEqual(tunnel.calls.map((call) => call.action), ["stop", "configure"]);
  assert.deepEqual(runtime.config.get().tunnel, { token: "" });
  assert.equal(runtime.status().tunnel.available, false);
  await runtime.close();
});

test("runtime keeps the environment token active while stored fallback changes", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-runtime-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const seed = new ConfigStore({ directory });
  const initial = await seed.load();
  initial.tunnel = { token: "stored-fallback" };
  await seed.update(initial);
  const lifecycle = [];
  const tunnel = configurableTunnel();
  const serviceFactories = Object.fromEntries(
    ["dns", "doh", "proxy", "admin"].map((name) => [name, () => fakeService(name, lifecycle)]),
  );
  const runtime = createRuntime({
    directory,
    environment: { CLOUDFLARE_TUNNEL_TOKEN: "environment-token" },
    tunnel,
    output: () => {},
    serviceFactories,
  });
  await runtime.start();
  tunnel.calls.length = 0;

  await runtime.updateTunnelToken("next-fallback");
  assert.equal(runtime.config.get().tunnel.token, "next-fallback");
  assert.equal(runtime.status().tunnel.tokenSource, "environment");
  assert.equal(runtime.status().tunnel.hasStoredToken, true);
  assert.deepEqual(tunnel.calls.map((call) => call.action), ["configure"]);

  tunnel.calls.length = 0;
  await runtime.clearTunnelToken();
  assert.equal(runtime.status().tunnel.state, "running");
  assert.equal(runtime.status().tunnel.tokenSource, "environment");
  assert.equal(runtime.status().tunnel.hasStoredToken, false);
  assert.deepEqual(tunnel.calls.map((call) => call.action), ["configure"]);
  await runtime.close();
});
