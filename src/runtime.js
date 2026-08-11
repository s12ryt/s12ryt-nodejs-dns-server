"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");

const { BackupManager } = require("./backup/manager");
const { BackupScheduler } = require("./backup/scheduler");
const { ConfigStore, validateConfig } = require("./admin/config-store");
const { AuditService } = require("./admin/audit-service");
const { applyDomainState } = require("./admin/domains");
const { EventLog } = require("./admin/event-log");
const { IdentityManager } = require("./admin/identity-manager");
const { IdempotencyService } = require("./admin/idempotency-service");
const { DiagnosticBundle } = require("./diagnostics/bundle");
const { createAdminService } = require("./admin/server");
const { DnsCache } = require("./dns/cache");
const { PolicyStore } = require("./dns/policy");
const { PolicySubscriptionManager } = require("./dns/policy-subscriptions");
const { RecordStore } = require("./dns/records");
const { createResolver } = require("./dns/resolver");
const { ZoneStore } = require("./dns/zones");
const { createDohUpstream } = require("./dns/upstream-doh");
const { createUpstreamHealthMonitor } = require("./dns/upstream-health");
const { MetricsRegistry } = require("./observability/metrics");
const { StructuredLogger } = require("./observability/structured-logger");
const { TelemetryPipeline } = require("./observability/telemetry-pipeline");
const { WebhookDispatcher } = require("./observability/webhook-dispatcher");
const { createDnsService } = require("./services/dns-server");
const { createDohService } = require("./services/doh-server");
const { createMetricsService } = require("./services/metrics-server");
const { createProxyService } = require("./services/proxy-server");
const { ProxyCache } = require("./services/proxy-cache");
const { ProxyHealthMonitor } = require("./services/proxy-health");
const { ProxyRoutes } = require("./services/proxy-routes");
const { RecoveryManager } = require("./recovery/manager");
const { SqliteStore } = require("./storage/sqlite-store");
const { ensureCloudflared } = require("./tunnel/download");
const { TunnelManager } = require("./tunnel/manager");

const DEFAULT_FACTORIES = Object.freeze({
  dns: createDnsService,
  doh: createDohService,
  proxy: createProxyService,
  admin: createAdminService,
  metrics: createMetricsService,
});

const DISABLED_LOGGER = Object.freeze({
  write: async () => {},
  close: async () => {},
});

const METRIC_WINDOW_MS = Object.freeze({
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
});
const APPLICATION_VERSION = require("../package.json").version;

function serviceAddress(service) {
  const address = service?.address?.();
  if (!address) return null;
  if (address.udp || address.tcp) {
    return { host: address.udp?.address, port: address.udp?.port };
  }
  return { host: address.address, port: address.port };
}

function createRuntime({
  directory = path.resolve("data"),
  output = console.log,
  environment = process.env,
  tunnel: providedTunnel,
  serviceFactories = {},
  healthMonitorFactory = createUpstreamHealthMonitor,
  proxyCacheFactory = (options) => new ProxyCache(options),
  sqliteStoreFactory = (options) => new SqliteStore(options),
  zoneStoreFactory = (options) => new ZoneStore(options),
  policyStoreFactory = (options) => new PolicyStore(options),
  policySubscriptionManagerFactory = (options) => new PolicySubscriptionManager(options),
  metricsRegistryFactory = (options) => new MetricsRegistry(options),
  structuredLoggerFactory = (options) => new StructuredLogger(options),
  webhookDispatcherFactory = (options) => new WebhookDispatcher(options),
  telemetryPipelineFactory = (options) => new TelemetryPipeline(options),
  backupManagerFactory = (options) => new BackupManager(options),
  backupSchedulerFactory = (options) => new BackupScheduler(options),
  proxyHealthMonitorFactory = (options) => new ProxyHealthMonitor(options),
  identityManagerFactory = (options) => new IdentityManager(options),
  auditServiceFactory = (options) => new AuditService(options),
  idempotencyServiceFactory = (options) => new IdempotencyService(options),
  diagnosticBundleFactory = (options) => new DiagnosticBundle(options),
  recoveryManagerFactory = (options) => new RecoveryManager(options),
  applicationVersion = APPLICATION_VERSION,
} = {}) {
  const config = new ConfigStore({ directory });
  let auth = null;
  const events = new EventLog(500);
  const factories = { ...DEFAULT_FACTORIES, ...serviceFactories };
  const components = {};
  const services = {};
  let unsubscribe = null;
  let started = false;
  let maintenanceActive = false;
  let maintenanceRestored = false;
  let maintenanceTunnelWasActive = false;
  const environmentToken = typeof environment.CLOUDFLARE_TUNNEL_TOKEN === "string"
    ? environment.CLOUDFLARE_TUNNEL_TOKEN : "";

  const tunnel = providedTunnel || new TunnelManager({
    token: "",
    ensureBinary: () => ensureCloudflared({ directory: path.join(directory, "cloudflared") }),
  });

  function recordEvent(event) {
    const recorded = components.telemetry ? components.telemetry.record(event) : events.add(event);
    if (event?.kind === "proxy-health" && typeof components.storage?.recordProxyHealthEvent === "function") {
      try {
        components.storage.recordProxyHealthEvent(event);
      } catch (error) {
        const failure = { kind: "storage-error", message: `Proxy health history was not recorded: ${error.message}` };
        if (components.telemetry) components.telemetry.record(failure);
        else events.add(failure);
      }
    }
    return recorded;
  }

  function tunnelConfiguration(storedToken) {
    if (environmentToken) {
      return { token: environmentToken, tokenSource: "environment", hasStoredToken: Boolean(storedToken) };
    }
    if (storedToken) return { token: storedToken, tokenSource: "config", hasStoredToken: true };
    return { token: "", tokenSource: "none", hasStoredToken: false };
  }

  function configureTunnel(storedToken) {
    const next = tunnelConfiguration(storedToken);
    if (typeof tunnel.configure === "function") tunnel.configure(next);
    return next;
  }

  function tunnelIsActive() {
    return ["running", "starting"].includes(tunnel.status().state);
  }

  function redactTunnelSecrets(value, ...tokens) {
    return tokens.filter(Boolean).reduce(
      (message, token) => message.split(token).join("[redacted]"),
      String(value),
    );
  }

  async function persistTunnelToken(token) {
    return config.update({ ...config.get(), tunnel: { token } });
  }

  async function replaceTunnelToken(token) {
    const previousToken = config.get().tunnel.token;
    if (token === previousToken) {
      configureTunnel(token);
      return tunnel.status();
    }
    const wasActive = tunnelIsActive();
    await persistTunnelToken(token);

    if (environmentToken) {
      configureTunnel(token);
      return tunnel.status();
    }

    try {
      if (wasActive) await tunnel.stop();
      configureTunnel(token);
      if (wasActive && token) await tunnel.start();
      return tunnel.status();
    } catch (error) {
      try {
        await persistTunnelToken(previousToken);
        if (tunnelIsActive()) await tunnel.stop();
        configureTunnel(previousToken);
        if (wasActive && previousToken) await tunnel.start();
      } catch (restoreError) {
        error.restoreError = restoreError;
        const message = redactTunnelSecrets(restoreError.message, token, previousToken, environmentToken);
        recordEvent({ kind: "tunnel-error", message: `Tunnel rollback failed: ${message}` });
      }
      const message = redactTunnelSecrets(error.message, token, previousToken, environmentToken);
      recordEvent({ kind: "tunnel-error", message: `Tunnel token update failed: ${message}` });
      throw error;
    }
  }

  async function updateTunnelToken(token) {
    if (typeof token !== "string" || token.length === 0) throw new TypeError("Tunnel token must be a non-empty string");
    return replaceTunnelToken(token);
  }

  async function clearTunnelToken() {
    return replaceTunnelToken("");
  }

  function getMetricHistory(window) {
    const duration = METRIC_WINDOW_MS[window];
    if (!duration) throw new RangeError("Metric history window is invalid");
    const until = new Date();
    const since = new Date(until.getTime() - duration);
    return components.storage.queryMetricTotals({ since: since.toISOString(), until: until.toISOString() });
  }

  function listWebhookJobs(query) {
    return components.storage.listWebhooks(query);
  }

  function retryWebhookJob(id) {
    if (!components.webhook) throw new Error("Webhook delivery is disabled");
    return components.webhook.retry(id);
  }

  async function updateWebhookConfig(value) {
    const nextWebhook = value.enabled
      ? webhookDispatcherFactory({
        storage: components.storage,
        endpoint: value.url,
        secret: value.secret,
      })
      : null;
    const current = config.get();
    const updated = await config.update({
      ...current,
      observability: { ...current.observability, webhook: value },
    });
    components.webhook = nextWebhook;
    components.telemetry.setWebhook(nextWebhook);
    return updated.observability.webhook;
  }

  function status() {
    return {
      services: {
        dns: serviceAddress(services.dns),
        doh: serviceAddress(services.doh),
        proxy: serviceAddress(services.proxy),
        admin: serviceAddress(services.admin),
        metrics: serviceAddress(services.metrics),
      },
      upstreams: (components.upstreams || []).map((upstream) => ({
        name: upstream.name,
        ...upstream.status(),
      })),
      cache: { entries: components.cache?.size || 0 },
      proxyCache: components.proxyCache?.status() || null,
      proxyHealth: components.proxyHealth?.status() || null,
      storage: components.storage?.status() || null,
      observability: components.metrics?.snapshot() || null,
      dnsPolicySubscriptions: components.policySubscriptions?.status() || [],
      backup: {
        scheduled: Boolean(components.backupScheduler),
        maintenance: maintenanceActive,
      },
      tunnel: tunnel.status(),
    };
  }

  async function closeServices() {
    for (const name of ["metrics", "admin", "proxy", "doh", "dns"]) {
      if (services[name]) await services[name].close().catch(() => {});
    }
  }

  async function closePublicServices() {
    for (const name of ["metrics", "proxy", "doh", "dns"]) {
      if (services[name]) await services[name].close().catch(() => {});
    }
  }

  async function applyLoadedConfiguration(current) {
    const effective = applyDomainState(current);
    components.records.replace(effective.records);
    components.zones.replace({ domains: effective.domains, records: effective.records });
    components.policies.replace(current.dnsPolicy.rules);
    await components.policySubscriptions.replace(current.dnsPolicy);
    components.routes.replace(effective.routes.filter((route) => route.enabled));
    components.upstreams.splice(0, components.upstreams.length, ...current.upstreams.map(createDohUpstream));
    components.trustedProxyCidrs.splice(0, components.trustedProxyCidrs.length, ...current.proxy.trustedProxyCidrs);
  }

  function createTelemetry(current) {
    components.logger = current.observability.logs.enabled
      ? structuredLoggerFactory({
        directory: path.join(directory, "logs"),
        retentionDays: current.observability.logs.retentionDays,
      })
      : DISABLED_LOGGER;
    components.webhook = current.observability.webhook.enabled
      ? webhookDispatcherFactory({
        storage: components.storage,
        endpoint: current.observability.webhook.url,
        secret: current.observability.webhook.secret,
      })
      : null;
    components.telemetry = telemetryPipelineFactory({
      events,
      metrics: components.metrics,
      logger: components.logger,
      webhook: components.webhook,
      storage: components.storage,
      sampleIntervalMs: current.observability.metrics.sampleIntervalMs,
    });
  }

  function createPublicServices(current) {
    services.dns = factories.dns({ resolver: components.resolver, ...current.dns });
    services.doh = factories.doh({ resolver: components.resolver, ...current.doh });
    services.proxy = factories.proxy({
      routes: components.routes,
      cache: components.proxyCache,
      trustedProxyCidrs: components.trustedProxyCidrs,
      onEvent: (event) => recordEvent(event),
      ...current.proxy,
    });
    services.metrics = factories.metrics({
      registry: components.metrics,
      ...current.observability.metrics,
    });
  }

  async function enterMaintenance() {
    if (maintenanceActive) throw new Error("Runtime is already in maintenance mode");
    await components.recovery.begin("restore");
    maintenanceActive = true;
    maintenanceRestored = false;
    maintenanceTunnelWasActive = tunnelIsActive();
    components.backupScheduler?.pause();
    components.proxyHealth?.pause();
    await components.telemetry?.close();
    components.upstreamHealth?.close();
    components.policySubscriptions?.pause();
    await closePublicServices();
    await components.proxyCache?.close();
    if (maintenanceTunnelWasActive) await tunnel.stop();
  }

  async function reloadAfterRestore() {
    const current = await config.load();
    await auth.load();
    await applyLoadedConfiguration(current);
    configureTunnel(current.tunnel.token);
    if (typeof components.proxyCache.configure === "function") {
      await components.proxyCache.configure({ maxBytes: current.proxy.cacheMaxBytes });
    }
    createTelemetry(current);
    createPublicServices(current);
    await components.proxyCache.start();
    await components.policySubscriptions.start();
    for (const name of ["dns", "doh", "proxy", "metrics"]) await services[name].start();
    components.telemetry.start();
    components.upstreamHealth.start();
    components.proxyHealth.start();
    if (maintenanceTunnelWasActive && tunnel.status().available) await tunnel.start();
    maintenanceRestored = true;
  }

  async function exitMaintenance() {
    if (maintenanceRestored) components.backupScheduler?.start();
    maintenanceActive = false;
    maintenanceRestored = false;
    maintenanceTunnelWasActive = false;
    await components.recovery.complete("restore");
  }

  return {
    config,
    get auth() { return auth; },
    events,
    components,
    status,
    updateTunnelToken,
    clearTunnelToken,
    async start() {
      if (started) throw new Error("Runtime is already started");
      components.recovery = recoveryManagerFactory({ directory });
      await components.recovery.recover();
      await components.recovery.begin("startup");
      const current = await config.load();
      const effective = applyDomainState(current);
      configureTunnel(current.tunnel.token);
      components.storage = sqliteStoreFactory({ directory });
      components.storage.open();
      components.audit = auditServiceFactory({ storage: components.storage });
      components.idempotency = idempotencyServiceFactory({ storage: components.storage });
      auth = identityManagerFactory({ directory, storage: components.storage });
      await auth.load();
      if (!auth.isConfigured()) {
        const token = auth.createSetupToken();
        output(`S12 DNS Server setup token (valid for 10 minutes): ${token}`);
      }

      components.records = new RecordStore(effective.records);
      components.zones = zoneStoreFactory({ domains: effective.domains, records: effective.records });
      components.policies = policyStoreFactory({ rules: current.dnsPolicy.rules });
      components.policySubscriptions = policySubscriptionManagerFactory({
        directory: path.join(directory, "dns-policy"),
        policyStore: components.policies,
        rules: current.dnsPolicy.rules,
        subscriptions: current.dnsPolicy.subscriptions,
        onEvent: (event) => recordEvent(event),
      });
      components.routes = new ProxyRoutes(effective.routes.filter((route) => route.enabled), { records: components.records });
      components.proxyHealth = proxyHealthMonitorFactory({
        routes: components.routes,
        onEvent: (event) => recordEvent(event),
      });
      components.cache = new DnsCache(current.cache);
      components.proxyCache = proxyCacheFactory({
        directory: path.join(directory, "proxy-cache"),
        maxBytes: current.proxy.cacheMaxBytes,
      });
      components.trustedProxyCidrs = [...current.proxy.trustedProxyCidrs];
      components.metrics = metricsRegistryFactory({});
      createTelemetry(current);
      const observableEvents = {
        add: (event) => recordEvent(event),
        list: () => events.list(),
      };
      components.upstreams = current.upstreams.map(createDohUpstream);
      components.upstreamHealth = healthMonitorFactory({ getUpstreams: () => components.upstreams });
      components.resolver = createResolver({
        records: components.records,
         zones: components.zones,
         policies: components.policies,
        upstreams: components.upstreams,
        cache: components.cache,
        onEvent: (event) => recordEvent(event),
      });

      unsubscribe = config.subscribe((next) => {
        const nextEffective = applyDomainState(next);
        components.records.replace(nextEffective.records);
         components.zones.replace({ domains: nextEffective.domains, records: nextEffective.records });
         components.policies.replace(next.dnsPolicy.rules);
         void components.policySubscriptions.replace(next.dnsPolicy).catch((error) => {
           recordEvent({ kind: "dns-policy-subscription-error", message: error.message });
         });
        components.routes.replace(nextEffective.routes.filter((route) => route.enabled));
        components.upstreams.splice(0, components.upstreams.length, ...next.upstreams.map(createDohUpstream));
        components.trustedProxyCidrs.splice(0, components.trustedProxyCidrs.length, ...next.proxy.trustedProxyCidrs);
        if (typeof components.proxyCache.configure === "function") {
          void components.proxyCache.configure({ maxBytes: next.proxy.cacheMaxBytes }).catch((error) => {
            recordEvent({ kind: "proxy-cache-error", message: error.message });
          });
        }
        try {
          components.storage.recordConfigVersion(next, { source: "runtime", actor: "system" });
        } catch (error) {
          recordEvent({ kind: "storage-error", message: `Configuration history was not recorded: ${error.message}` });
        }
      });

      createPublicServices(current);
      components.backups = backupManagerFactory({
        directory,
        storage: components.storage,
        applicationVersion,
        validateConfiguration: (value) => validateConfig(value),
        validateDatabase: (content, manifest) => components.storage.validateBackup(content, {
          expectedSchemaVersion: manifest.databaseSchemaVersion,
        }),
        maintenance: {
          enter: enterMaintenance,
          reload: reloadAfterRestore,
          exit: exitMaintenance,
        },
      });
      components.backupScheduler = backupSchedulerFactory({
        manager: components.backups,
        onError: (error) => recordEvent({ kind: "backup-error", message: error.message }),
      });
      components.diagnostics = diagnosticBundleFactory({
        directory,
        applicationVersion,
        getConfig: () => config.get(),
        getRuntime: async () => {
          try {
            return JSON.parse(await fs.readFile(path.join(directory, "runtime", "active.json"), "utf8"));
          } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
          }
        },
        getStatus: status,
        getStorage: () => components.storage.status(),
        getAuditVerification: () => components.audit.verify(),
        getEvents: () => events.list(),
      });
      services.admin = factories.admin({
        auth,
        audit: components.audit,
        idempotency: components.idempotency,
        config,
        tunnel,
        events: observableEvents,
        status,
        diagnoseDns: (name, type) => components.resolver.diagnose(name, type),
        updateTunnelToken,
        clearTunnelToken,
        clearProxyCache: (scope) => components.proxyCache.clear(scope),
        getProxyOperations: () => ({
          health: components.routes.health(),
          draining: services.proxy.drainStatus(),
          websockets: services.proxy.websocketStatus(),
        }),
        getProxyHealthHistory: ({ window, site }) => {
          const until = new Date().toISOString();
          const since = new Date(Date.parse(until) - METRIC_WINDOW_MS[window]).toISOString();
          return components.storage.queryProxyHealthHistory({ since, until, site });
        },
        drainProxySite: (host) => services.proxy.drainSite(host),
        resumeProxySite: (host) => services.proxy.resumeSite(host),
        abortProxySite: (host) => services.proxy.abortSite(host),
        drainProxyUpstream: (scope) => services.proxy.drainUpstream(scope),
        resumeProxyUpstream: (scope) => services.proxy.resumeUpstream(scope),
        getMetricHistory,
        listWebhookJobs,
        retryWebhookJob,
        updateWebhookConfig,
        listBackups: () => components.backups.list(),
        createBackup: (options) => components.backups.create(options),
        importBackup: (stream, options) => components.backups.importArchive(stream, options),
        getBackupDownload: async (fileName) => {
          const item = (await components.backups.list()).find((backup) => backup.fileName === fileName);
          if (!item) throw Object.assign(new Error(`Backup not found: ${fileName}`), { statusCode: 404 });
          return item;
        },
        deleteBackup: (fileName) => components.backups.delete(fileName),
        restoreBackup: (fileName, options) => components.backups.restore(path.join(directory, "backups", fileName), options),
        createDiagnosticBundle: () => components.diagnostics.create(),
        listPolicySubscriptions: () => components.policySubscriptions.status(),
        refreshPolicySubscription: (id) => components.policySubscriptions.refresh(id),
        ...current.admin,
      });

      try {
        components.storage.recordConfigVersion(current, { source: "startup", actor: "system" });
        await components.proxyCache.start();
        await components.policySubscriptions.start();
        for (const name of ["dns", "doh", "proxy", "admin", "metrics"]) await services[name].start();
        components.telemetry.start();
        components.proxyHealth.start();
        components.backupScheduler.start();
        started = true;
        components.upstreamHealth.start();
      } catch (error) {
        await closeServices();
        await components.telemetry?.close().catch(() => {});
        components.proxyHealth?.close();
        await components.policySubscriptions?.close().catch(() => {});
        components.backupScheduler?.close();
        await components.proxyCache?.close().catch(() => {});
        components.storage?.close();
        unsubscribe?.();
        unsubscribe = null;
        throw error;
      }

      if (tunnel.status().available) {
        try {
          await tunnel.start();
          recordEvent({ kind: "tunnel", message: "Tunnel started automatically" });
        } catch (error) {
          recordEvent({ kind: "tunnel-error", message: `Automatic Tunnel startup failed: ${error.message}` });
        }
      }
      await components.recovery.complete("startup");
      return status();
    },
    async close() {
      if (!started) return;
      await components.recovery.begin("shutdown");
      components.backupScheduler?.close();
      components.proxyHealth?.close();
      await components.telemetry?.close().catch(() => {});
      components.upstreamHealth?.close();
      await components.policySubscriptions?.close().catch(() => {});
      await closeServices();
      await components.proxyCache?.close().catch(() => {});
      components.storage?.close();
      await tunnel.stop().catch(() => {});
      unsubscribe?.();
      unsubscribe = null;
      started = false;
      await components.recovery.complete("shutdown");
    },
  };
}

module.exports = { APPLICATION_VERSION, METRIC_WINDOW_MS, createRuntime, serviceAddress };
