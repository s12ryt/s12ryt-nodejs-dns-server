"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createQuery, parseMessage } = require("../../src/dns/message");
const { createRuntime } = require("../../src/runtime");

function fakeService(name, lifecycle) {
  return {
    async start() { lifecycle.push(`start:${name}`); },
    async close() { lifecycle.push(`close:${name}`); },
    address() { return { address: "127.0.0.1", port: 1000 }; },
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
