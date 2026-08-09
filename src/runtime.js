"use strict";

const path = require("node:path");

const { AuthManager } = require("./admin/auth-manager");
const { ConfigStore } = require("./admin/config-store");
const { EventLog } = require("./admin/event-log");
const { createAdminService } = require("./admin/server");
const { DnsCache } = require("./dns/cache");
const { RecordStore } = require("./dns/records");
const { createResolver } = require("./dns/resolver");
const { createDohUpstream } = require("./dns/upstream-doh");
const { createDnsService } = require("./services/dns-server");
const { createDohService } = require("./services/doh-server");
const { createProxyService } = require("./services/proxy-server");
const { ProxyRoutes } = require("./services/proxy-routes");
const { ensureCloudflared } = require("./tunnel/download");
const { TunnelManager } = require("./tunnel/manager");

const DEFAULT_FACTORIES = Object.freeze({
  dns: createDnsService,
  doh: createDohService,
  proxy: createProxyService,
  admin: createAdminService,
});

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
} = {}) {
  const config = new ConfigStore({ directory });
  const auth = new AuthManager({ directory });
  const events = new EventLog(500);
  const factories = { ...DEFAULT_FACTORIES, ...serviceFactories };
  const components = {};
  const services = {};
  let unsubscribe = null;
  let started = false;
  const environmentToken = typeof environment.CLOUDFLARE_TUNNEL_TOKEN === "string"
    ? environment.CLOUDFLARE_TUNNEL_TOKEN : "";

  const tunnel = providedTunnel || new TunnelManager({
    token: "",
    ensureBinary: () => ensureCloudflared({ directory: path.join(directory, "cloudflared") }),
  });

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
        events.add({ kind: "tunnel-error", message: `Tunnel rollback failed: ${message}` });
      }
      const message = redactTunnelSecrets(error.message, token, previousToken, environmentToken);
      events.add({ kind: "tunnel-error", message: `Tunnel token update failed: ${message}` });
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

  function status() {
    return {
      services: {
        dns: serviceAddress(services.dns),
        doh: serviceAddress(services.doh),
        proxy: serviceAddress(services.proxy),
        admin: serviceAddress(services.admin),
      },
      upstreams: (components.upstreams || []).map((upstream) => ({
        name: upstream.name,
        ...upstream.status(),
      })),
      cache: { entries: components.cache?.size || 0 },
      tunnel: tunnel.status(),
    };
  }

  async function closeServices() {
    for (const name of ["admin", "proxy", "doh", "dns"]) {
      if (services[name]) await services[name].close().catch(() => {});
    }
  }

  return {
    config,
    auth,
    events,
    components,
    status,
    updateTunnelToken,
    clearTunnelToken,
    async start() {
      if (started) throw new Error("Runtime is already started");
      const current = await config.load();
      configureTunnel(current.tunnel.token);
      await auth.load();
      if (!auth.isConfigured()) {
        const token = auth.createSetupToken();
        output(`S12 DNS Server setup token (valid for 10 minutes): ${token}`);
      }

      components.records = new RecordStore(current.records);
      components.routes = new ProxyRoutes(current.routes, { records: components.records });
      components.cache = new DnsCache(current.cache);
      components.upstreams = current.upstreams.map(createDohUpstream);
      components.resolver = createResolver({
        records: components.records,
        upstreams: components.upstreams,
        cache: components.cache,
        onEvent: (event) => events.add(event),
      });

      unsubscribe = config.subscribe((next) => {
        components.records.replace(next.records);
        components.routes.replace(next.routes);
        components.upstreams.splice(0, components.upstreams.length, ...next.upstreams.map(createDohUpstream));
      });

      services.dns = factories.dns({ resolver: components.resolver, ...current.dns });
      services.doh = factories.doh({ resolver: components.resolver, ...current.doh });
      services.proxy = factories.proxy({
        routes: components.routes,
        onEvent: (event) => events.add(event),
        ...current.proxy,
      });
      services.admin = factories.admin({
        auth,
        config,
        tunnel,
        events,
        status,
        updateTunnelToken,
        clearTunnelToken,
        ...current.admin,
      });

      try {
        for (const name of ["dns", "doh", "proxy", "admin"]) await services[name].start();
        started = true;
      } catch (error) {
        await closeServices();
        unsubscribe?.();
        unsubscribe = null;
        throw error;
      }

      if (tunnel.status().available) {
        try {
          await tunnel.start();
          events.add({ kind: "tunnel", message: "Tunnel started automatically" });
        } catch (error) {
          events.add({ kind: "tunnel-error", message: `Automatic Tunnel startup failed: ${error.message}` });
        }
      }
      return status();
    },
    async close() {
      if (!started) return;
      await closeServices();
      await tunnel.stop().catch(() => {});
      unsubscribe?.();
      unsubscribe = null;
      started = false;
    },
  };
}

module.exports = { createRuntime, serviceAddress };
