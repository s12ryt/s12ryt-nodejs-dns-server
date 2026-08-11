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
  let adminOptions;
  let proxyOptions;
  let metricsOptions;
  const configVersions = [];
  const metricQueries = [];
  const webhookQueries = [];
  const webhookConfigurations = [];
  const webhookRetries = [];
  const telemetryWebhooks = [];
  const zoneReplacements = [];
  const policyReplacements = [];
  const policySubscriptionReplacements = [];
  const proxyHealthEvents = [];
  const proxyHealthHistoryQueries = [];
  let policySubscriptionOptions;
  let proxyHealthOptions;
  const backupCalls = [];
  const sqliteStore = {
    open() { lifecycle.push("start:sqlite"); return { open: true, schemaVersion: 1, journalMode: "wal", integrity: "ok" }; },
    close() { lifecycle.push("close:sqlite"); },
    status() { return { open: true, schemaVersion: 1, journalMode: "wal", integrity: "ok" }; },
    recordConfigVersion(value, context) { configVersions.push({ value, context }); },
    recordMetricSamples() {},
    recordProxyHealthEvent(event) { proxyHealthEvents.push(event); return event; },
    queryProxyHealthHistory(query) { proxyHealthHistoryQueries.push(query); return []; },
    queryMetricTotals(range) { metricQueries.push(range); return [{ metric: "dns_queries_total", value: 4 }]; },
    enqueueWebhook(job) { return job; },
    listDueWebhooks() { return []; },
    listWebhooks(query) { webhookQueries.push(query); return [{ id: "dead-job", state: query.state }]; },
    updateWebhook(id, patch) { webhookRetries.push({ id, patch }); return { id, ...patch }; },
  };
  const metrics = {
    observe() {},
    drainSamples() { return []; },
    toPrometheus() { return "s12_test_total 1\n"; },
    snapshot() { return { counters: { dnsQueries: 1 } }; },
  };
  const logger = {
    async write() {},
    async close() { lifecycle.push("close:logger"); },
  };
  const telemetry = {
    record(event) { return event; },
    setWebhook(value) { telemetryWebhooks.push(value); },
    start() { lifecycle.push("start:telemetry"); },
    async close() { lifecycle.push("close:telemetry"); },
  };
  const proxyCache = {
    async start() { lifecycle.push("start:proxy-cache"); },
    async close() { lifecycle.push("close:proxy-cache"); },
    status() { return { entries: 3, bytes: 2048, maxBytes: 4096 }; },
    async clear(scope) { lifecycle.push(`clear:proxy-cache:${scope?.site || "all"}`); return this.status(); },
  };
  const tunnel = {
    status: () => ({ available: false, state: "stopped", logs: [] }),
    start: async () => { throw new Error("must not start without a token"); },
    stop: async () => { lifecycle.push("close:tunnel"); },
  };
  const backupManager = {
    async list() { backupCalls.push(["list"]); return [{ fileName: "s12-manual-20260811T030000Z.zip" }]; },
    async create(options) { backupCalls.push(["create", options]); return options; },
    async delete(fileName) { backupCalls.push(["delete", fileName]); return { deleted: true }; },
    async restore(filePath, options) { backupCalls.push(["restore", filePath, options]); return options; },
    async prune() {},
  };
  const runtime = createRuntime({
    directory,
    tunnel,
    output: (line) => output.push(line),
    serviceFactories: {
      dns: ({ resolver }) => ({ ...fakeService("dns", lifecycle), resolver }),
      doh: () => fakeService("doh", lifecycle),
      proxy: (options) => {
        proxyOptions = options;
        return {
          ...fakeService("proxy", lifecycle),
          routes: options.routes,
          drainStatus: () => ({ sites: [{ host: "app.test", draining: false }] }),
          websocketStatus: () => ({ sites: [{ site: "app.test", active: 1 }] }),
          drainSite: (host) => { lifecycle.push(`drain:site:${host}`); return true; },
          resumeSite: (host) => { lifecycle.push(`resume:site:${host}`); return true; },
          abortSite: (host) => { lifecycle.push(`abort:site:${host}`); return 1; },
          drainUpstream: (scope) => { lifecycle.push(`drain:upstream:${scope.id}`); return true; },
          resumeUpstream: (scope) => { lifecycle.push(`resume:upstream:${scope.id}`); return true; },
        };
      },
      admin: (options) => {
        adminOptions = options;
        return fakeService("admin", lifecycle);
      },
      metrics: (options) => {
        metricsOptions = options;
        return fakeService("metrics", lifecycle);
      },
    },
    proxyCacheFactory: () => proxyCache,
    sqliteStoreFactory: () => sqliteStore,
    metricsRegistryFactory: () => metrics,
    structuredLoggerFactory: () => logger,
    webhookDispatcherFactory: (options) => {
      webhookConfigurations.push(options);
      return {
        endpoint: options.endpoint,
        retry(id) { webhookRetries.push({ id, dispatcher: true }); return { id, state: "pending" }; },
      };
    },
    telemetryPipelineFactory: () => telemetry,
    zoneStoreFactory: (options) => ({
      replace(value) { zoneReplacements.push(value); },
      resolve(name, type) {
        if (name !== "zone-only.test" || type !== "A") return null;
        return {
          authoritative: true,
          rcode: "NOERROR",
          answers: [{ name, type: "A", value: "192.0.2.123", ttl: 60 }],
          authorities: [],
          additionals: [],
        };
      },
      initial: options,
    }),
    policyStoreFactory: ({ rules }) => {
      let current = rules;
      return {
        initial: rules,
        replace(next) { current = next; policyReplacements.push(next); },
        evaluate({ name }) {
          const rule = current.find((candidate) => candidate.match.name.value === name);
          return rule ? { ruleId: rule.id, source: "local", action: rule.action } : null;
        },
      };
    },
    policySubscriptionManagerFactory: (options) => {
      policySubscriptionOptions = options;
      return {
        async start() { lifecycle.push("start:policy-subscriptions"); },
        pause() { lifecycle.push("pause:policy-subscriptions"); },
        async replace(value) { policySubscriptionReplacements.push(value); },
        async refresh(id) { lifecycle.push(`refresh:policy-subscription:${id}`); return { id, domains: 3 }; },
        status() { return [{ id: "fixture", domains: 2 }]; },
        async close() { lifecycle.push("close:policy-subscriptions"); },
      };
    },
    backupManagerFactory: (options) => {
      assert.equal(options.storage, sqliteStore);
      assert.equal(options.directory, directory);
      return backupManager;
    },
    backupSchedulerFactory: ({ manager }) => {
      assert.equal(manager, backupManager);
      return {
        start() { lifecycle.push("start:backup-scheduler"); },
        close() { lifecycle.push("close:backup-scheduler"); },
      };
    },
    healthMonitorFactory: () => ({
      start() {},
      close() { lifecycle.push("close:health"); },
    }),
    proxyHealthMonitorFactory: (options) => {
      proxyHealthOptions = options;
      return {
        start() { lifecycle.push("start:proxy-health"); },
        pause() { lifecycle.push("pause:proxy-health"); },
        close() { lifecycle.push("close:proxy-health"); },
        status() { return { running: true, targets: 2 }; },
      };
    },
  });

  await runtime.start();
  assert.deepEqual(lifecycle, [
    "start:sqlite",
    "start:proxy-cache",
    "start:policy-subscriptions",
    "start:dns",
    "start:doh",
    "start:proxy",
    "start:admin",
    "start:metrics",
    "start:telemetry",
    "start:proxy-health",
    "start:backup-scheduler",
  ]);
  assert.match(output.join("\n"), /setup token/i);
  assert.equal(runtime.status().services.dns.port, 1000);
  assert.deepEqual(runtime.status().proxyCache, { entries: 3, bytes: 2048, maxBytes: 4096 });
  assert.deepEqual(runtime.status().storage, { open: true, schemaVersion: 1, journalMode: "wal", integrity: "ok" });
  assert.equal(runtime.status().services.metrics.port, 1000);
  assert.deepEqual(runtime.status().observability, { counters: { dnsQueries: 1 } });
  assert.deepEqual(runtime.status().proxyHealth, { running: true, targets: 2 });
  assert.equal(metricsOptions.registry, metrics);
  assert.equal(configVersions.length, 1);
  assert.deepEqual(configVersions[0].context, { source: "startup", actor: "system" });
  assert.equal(proxyOptions.cache, proxyCache);
  assert.equal(proxyHealthOptions.routes, proxyOptions.routes);
  const healthEvent = {
    kind: "proxy-health",
    site: "app.test",
    location: "prefix:/",
    upstream: "primary",
    fallback: false,
    healthy: true,
    statusCode: 204,
    latencyMs: 5,
    checkedAt: "2026-08-12T02:00:00.000Z",
    previousState: "unknown",
    state: "healthy",
  };
  proxyHealthOptions.onEvent(healthEvent);
  assert.deepEqual(proxyHealthEvents, [healthEvent]);
  assert.equal(runtime.components.zones.initial.domains.length, 0);
  assert.deepEqual(runtime.components.policies.initial, []);
  assert.equal(policySubscriptionOptions.policyStore, runtime.components.policies);
  assert.equal(policySubscriptionOptions.directory, path.join(directory, "dns-policy"));
  assert.deepEqual(runtime.status().dnsPolicySubscriptions, [{ id: "fixture", domains: 2 }]);
  const zoneResponse = parseMessage(await runtime.components.resolver.resolve(createQuery("zone-only.test", "A")));
  assert.equal(zoneResponse.answers[0].address, "192.0.2.123");
  assert.deepEqual(proxyOptions.trustedProxyCidrs, ["127.0.0.1/32", "::1/128"]);
  assert.equal(typeof adminOptions.clearProxyCache, "function");
  assert.deepEqual(adminOptions.getProxyOperations(), {
    health: runtime.components.routes.health(),
    draining: { sites: [{ host: "app.test", draining: false }] },
    websockets: { sites: [{ site: "app.test", active: 1 }] },
  });
  assert.equal(typeof adminOptions.getProxyHealthHistory, "function");
  await adminOptions.getProxyHealthHistory({ window: "24h", site: "app.test" });
  assert.equal(proxyHealthHistoryQueries.length, 1);
  assert.equal(proxyHealthHistoryQueries[0].site, "app.test");
  assert.equal(Date.parse(proxyHealthHistoryQueries[0].until) - Date.parse(proxyHealthHistoryQueries[0].since), 24 * 60 * 60 * 1000);
  assert.equal(adminOptions.drainProxySite("app.test"), true);
  assert.equal(adminOptions.resumeProxySite("app.test"), true);
  assert.equal(adminOptions.abortProxySite("app.test"), 1);
  assert.equal(adminOptions.drainProxyUpstream({ id: "one" }), true);
  assert.equal(adminOptions.resumeProxyUpstream({ id: "one" }), true);
  assert.deepEqual(adminOptions.listPolicySubscriptions(), [{ id: "fixture", domains: 2 }]);
  assert.deepEqual(await adminOptions.refreshPolicySubscription("fixture"), { id: "fixture", domains: 3 });
  assert.equal(lifecycle.includes("refresh:policy-subscription:fixture"), true);
  await adminOptions.clearProxyCache({ site: "app.test" });
  assert.equal(lifecycle.includes("clear:proxy-cache:app.test"), true);
  assert.deepEqual(await adminOptions.listBackups(), [{ fileName: "s12-manual-20260811T030000Z.zip" }]);
  await adminOptions.createBackup({ kind: "manual", dryRun: true });
  await adminOptions.restoreBackup("s12-manual-20260811T030000Z.zip", { dryRun: true });
  await adminOptions.deleteBackup("s12-manual-20260811T030000Z.zip");
  assert.deepEqual(backupCalls, [
    ["list"],
    ["create", { kind: "manual", dryRun: true }],
    ["restore", path.join(directory, "backups", "s12-manual-20260811T030000Z.zip"), { dryRun: true }],
    ["delete", "s12-manual-20260811T030000Z.zip"],
  ]);
  assert.equal(typeof adminOptions.getMetricHistory, "function");
  const history = await adminOptions.getMetricHistory("24h");
  assert.equal(history[0].value, 4);
  assert.equal(Date.parse(metricQueries[0].until) - Date.parse(metricQueries[0].since), 24 * 60 * 60 * 1000);
  assert.deepEqual(await adminOptions.listWebhookJobs({ state: "dead-letter" }), [{ id: "dead-job", state: "dead-letter" }]);
  assert.deepEqual(webhookQueries, [{ state: "dead-letter" }]);
  assert.throws(() => adminOptions.retryWebhookJob("dead-job"), /disabled/i);

  const webhookResult = await adminOptions.updateWebhookConfig({
    enabled: true,
    url: "https://alerts.example.test/s12",
    secret: "runtime-secret",
  });
  assert.deepEqual(webhookResult, {
    enabled: true,
    url: "https://alerts.example.test/s12",
    secret: "runtime-secret",
  });
  assert.equal(runtime.config.get().observability.webhook.secret, "runtime-secret");
  assert.equal(webhookConfigurations.at(-1).endpoint, "https://alerts.example.test/s12");
  assert.equal(telemetryWebhooks.at(-1).endpoint, "https://alerts.example.test/s12");
  assert.equal(adminOptions.retryWebhookJob("new-job").state, "pending");
  assert.deepEqual(webhookRetries.at(-1), { id: "new-job", dispatcher: true });

  const updated = runtime.config.get();
  updated.records = [{ name: "live.test", type: "A", value: "192.0.2.77", ttl: 30 }];
  updated.routes = [{ host: "app.test", dnsName: "live.test", scheme: "http", port: 9000 }];
  updated.domains = [{ name: "test", enabled: true, defaultTtl: 300, note: "runtime" }];
  updated.dnsPolicy.rules = [{
    id: "runtime-block",
    enabled: true,
    priority: 1,
    match: { name: { kind: "exact", value: "blocked.test" } },
    action: { type: "NXDOMAIN" },
  }];
  updated.dnsPolicy.subscriptions = [{
    id: "runtime-list",
    enabled: true,
    url: "https://lists.example.test/runtime.txt",
    priority: 10,
    action: { type: "NXDOMAIN" },
  }];
  await runtime.config.update(updated);
  assert.equal(zoneReplacements.at(-1).domains[0].name, "test");
  assert.equal(policyReplacements.at(-1)[0].id, "runtime-block");
  assert.equal(policySubscriptionReplacements.at(-1).subscriptions[0].id, "runtime-list");
  assert.equal(configVersions.length, 3);
  assert.deepEqual(configVersions.at(-1).context, { source: "runtime", actor: "system" });

  const response = parseMessage(await runtime.components.resolver.resolve(createQuery("live.test", "A", { id: 42 })));
  assert.equal(response.answers[0].address, "192.0.2.77");
  assert.equal(runtime.components.routes.resolve("app.test").url.href, "http://192.0.2.77:9000/");
  assert.equal(typeof adminOptions.diagnoseDns, "function");
  assert.equal((await adminOptions.diagnoseDns("live.test", "A")).answers[0].address, "192.0.2.77");
  const blocked = parseMessage(await runtime.components.resolver.resolve(createQuery("blocked.test", "A")));
  assert.equal(blocked.flags.rcode, 3);

  const disabled = runtime.config.get();
  disabled.domains[0].enabled = false;
  await runtime.config.update(disabled);
  assert.deepEqual(runtime.components.records.find("live.test", "A"), []);
  assert.equal(runtime.components.routes.resolve("app.test"), null);
  assert.equal(runtime.config.get().records[0].enabled, undefined);

  const restored = runtime.config.get();
  restored.domains[0].enabled = true;
  await runtime.config.update(restored);
  assert.equal(runtime.components.records.find("live.test", "A")[0].value, "192.0.2.77");
  assert.equal(runtime.components.routes.resolve("app.test").url.port, "9000");

  await runtime.close();
  assert.deepEqual(lifecycle.slice(-13), [
    "close:backup-scheduler",
    "close:proxy-health",
    "close:telemetry",
    "close:health",
    "close:policy-subscriptions",
    "close:metrics",
    "close:admin",
    "close:proxy",
    "close:doh",
    "close:dns",
    "close:proxy-cache",
    "close:sqlite",
    "close:tunnel",
  ]);
});

test("runtime maintenance pauses public services and reloads restored state without closing admin", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-runtime-maintenance-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lifecycle = [];
  let backupOptions;
  const storage = {
    open() { lifecycle.push("open:sqlite"); return { open: true, schemaVersion: 2 }; },
    close() { lifecycle.push("close:sqlite"); },
    status() { return { open: true, schemaVersion: 2 }; },
    recordConfigVersion() {},
    recordMetricSamples() {},
    backupTo: async () => ({ totalPages: 1, remainingPages: 0 }),
  };
  const proxyCache = {
    async start() { lifecycle.push("start:proxy-cache"); },
    async close() { lifecycle.push("close:proxy-cache"); },
    status() { return { entries: 0, bytes: 0, maxBytes: 1 }; },
  };
  const runtime = createRuntime({
    directory,
    output: () => {},
    sqliteStoreFactory: () => storage,
    proxyCacheFactory: () => proxyCache,
    serviceFactories: Object.fromEntries(
      ["dns", "doh", "proxy", "admin", "metrics"].map((name) => [name, () => fakeService(name, lifecycle)]),
    ),
    telemetryPipelineFactory: () => ({
      record(event) { return event; },
      start() { lifecycle.push("start:telemetry"); },
      async close() { lifecycle.push("close:telemetry"); },
    }),
    backupManagerFactory: (options) => {
      backupOptions = options;
      return { list: async () => [], create: async () => {}, delete: async () => {}, restore: async () => {}, prune: async () => {} };
    },
    backupSchedulerFactory: () => ({
      start() { lifecycle.push("start:backup-scheduler"); },
      pause() { lifecycle.push("pause:backup-scheduler"); },
      close() { lifecycle.push("close:backup-scheduler"); },
    }),
    healthMonitorFactory: () => ({
      start() { lifecycle.push("start:health"); },
      close() { lifecycle.push("close:health"); },
    }),
    proxyHealthMonitorFactory: () => ({
      start() { lifecycle.push("start:proxy-health"); },
      pause() { lifecycle.push("pause:proxy-health"); },
      close() { lifecycle.push("close:proxy-health"); },
      status() { return { running: true, targets: 0 }; },
    }),
    tunnel: { status: () => ({ available: false, state: "stopped", logs: [] }), stop: async () => {} },
  });
  await runtime.start();
  lifecycle.length = 0;

  await backupOptions.maintenance.enter();
  assert.deepEqual(lifecycle, [
    "pause:backup-scheduler", "pause:proxy-health", "close:telemetry", "close:health",
    "close:metrics", "close:proxy", "close:doh", "close:dns", "close:proxy-cache",
  ]);
  assert.equal(lifecycle.includes("close:admin"), false);
  lifecycle.length = 0;

  await backupOptions.maintenance.reload();
  await backupOptions.maintenance.exit();
  assert.deepEqual(lifecycle, [
    "start:proxy-cache", "start:dns", "start:doh", "start:proxy", "start:metrics",
    "start:telemetry", "start:health", "start:proxy-health", "start:backup-scheduler",
  ]);
  await runtime.close();
});

test("runtime keeps core configuration live when SQLite history recording fails", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-runtime-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let records = 0;
  let proxyHealthOptions;
  const sqliteStore = {
    open: () => ({ open: true }),
    close() {},
    status: () => ({ open: true }),
    recordConfigVersion() {
      records += 1;
      if (records > 1) throw new Error("history disk full");
    },
    recordMetricSamples() {},
    recordProxyHealthEvent() { throw new Error("proxy health history disk full"); },
    backupTo: async () => ({ totalPages: 1, remainingPages: 0 }),
  };
  const serviceFactories = Object.fromEntries(
    ["dns", "doh", "proxy", "admin"].map((name) => [name, () => fakeService(name, [])]),
  );
  const runtime = createRuntime({
    directory,
    output: () => {},
    serviceFactories,
    sqliteStoreFactory: () => sqliteStore,
    healthMonitorFactory: () => ({ start() {}, close() {} }),
    proxyHealthMonitorFactory: (options) => {
      proxyHealthOptions = options;
      return { start() {}, pause() {}, close() {}, status: () => ({ running: true, targets: 0 }) };
    },
    tunnel: { status: () => ({ available: false, state: "stopped", logs: [] }), stop: async () => {} },
  });
  await runtime.start();

  const next = runtime.config.get();
  next.records = [{ name: "still-live.test", type: "A", value: "192.0.2.9", ttl: 60 }];
  await runtime.config.update(next);

  assert.equal(runtime.components.records.find("still-live.test", "A")[0].value, "192.0.2.9");
  assert.match(runtime.events.list().at(-1).message, /history disk full/);
  assert.doesNotThrow(() => proxyHealthOptions.onEvent({
    kind: "proxy-health",
    site: "app.test",
    location: "prefix:/",
    upstream: "primary",
    fallback: false,
    healthy: false,
    statusCode: 503,
    latencyMs: 2,
    checkedAt: "2026-08-12T02:00:00.000Z",
    previousState: "healthy",
    state: "unhealthy",
  }));
  assert.match(runtime.events.list().at(-1).message, /proxy health history disk full/);
  await runtime.close();
});

test("runtime starts and closes the non-blocking upstream health monitor", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-runtime-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lifecycle = [];
  const monitor = {
    start() { lifecycle.push("start:health"); },
    close() { lifecycle.push("close:health"); },
  };
  const serviceFactories = Object.fromEntries(
    ["dns", "doh", "proxy", "admin"].map((name) => [name, () => fakeService(name, lifecycle)]),
  );
  const runtime = createRuntime({
    directory,
    output: () => {},
    serviceFactories,
    healthMonitorFactory: () => monitor,
    tunnel: {
      status: () => ({ available: false, state: "stopped", logs: [] }),
      stop: async () => {},
    },
  });

  await runtime.start();
  assert.equal(lifecycle.includes("start:health"), true);

  await runtime.close();
  assert.equal(lifecycle.includes("close:health"), true);
});

test("runtime applies and persists CNAME updates without restarting services", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-runtime-"));
  const lifecycle = [];
  const serviceFactories = Object.fromEntries(
    ["dns", "doh", "proxy", "admin"].map((name) => [name, () => fakeService(name, lifecycle)]),
  );
  const runtime = createRuntime({
    directory,
    output: () => {},
    serviceFactories,
    healthMonitorFactory: () => ({ start() {}, close() {} }),
    tunnel: {
      status: () => ({ available: false, state: "stopped", logs: [] }),
      stop: async () => {},
    },
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await runtime.start();

  const updated = runtime.config.get();
  updated.domains = [{ name: "16516565.tw", enabled: true, defaultTtl: 300, note: "" }];
  updated.records = [{
    name: "awa.16516565.tw",
    type: "CNAME",
    value: "chatgpt.com",
    ttl: 300,
    enabled: true,
  }];
  await runtime.config.update(updated);

  const diagnosis = await runtime.components.resolver.diagnose("awa.16516565.tw", "CNAME");
  assert.equal(diagnosis.rcode, "NOERROR");
  assert.deepEqual(diagnosis.sources, ["custom"]);
  assert.equal(diagnosis.answers[0].value, "chatgpt.com");
  assert.equal(lifecycle.filter((entry) => entry.startsWith("start:")).length, 4);

  const persisted = await new ConfigStore({ directory }).load();
  assert.match(persisted.records[0].id, /^[0-9a-f-]{36}$/);
  const { id, ...persistedRecord } = persisted.records[0];
  assert.equal(typeof id, "string");
  assert.deepEqual(persistedRecord, updated.records[0]);
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
