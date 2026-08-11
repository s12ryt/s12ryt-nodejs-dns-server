"use strict";

const { normalizeName } = require("../dns/message");
const { normalizeCidrs } = require("./proxy-security");

const SAFE_VARIABLES = new Set(["host", "clientIp", "scheme", "requestId", "path"]);
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);
const DEFAULT_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
const DEFAULT_LOCATION_CACHE_BYTES = 100 * 1024 * 1024;
const DEFAULT_SHADOW_BODY_BYTES = 1024 * 1024;

function normalizeHost(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw.startsWith("[")) return raw.slice(1, raw.indexOf("]"));
  return normalizeName(raw.split(":", 1)[0]);
}

function normalizeAlias(value, label) {
  const alias = normalizeHost(value);
  if (!alias) throw new TypeError(`${label} is invalid`);
  if (alias.includes("*") && (!alias.startsWith("*.") || alias.slice(2).includes("*"))) {
    throw new TypeError(`${label} wildcard is invalid`);
  }
  return alias;
}

function validateTemplate(value, label) {
  const template = String(value ?? "");
  for (const match of template.matchAll(/\$\{([^}]+)\}/g)) {
    if (!SAFE_VARIABLES.has(match[1])) throw new TypeError(`${label} uses an unsupported variable: ${match[1]}`);
  }
  const remainder = template.replace(/\$\{[^}]+\}/g, "");
  if (remainder.includes("${")) throw new TypeError(`${label} has an invalid variable`);
  return template;
}

function normalizeHeaderRules(value = {}, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const set = {};
  for (const [rawName, rawValue] of Object.entries(value.set || {})) {
    const name = rawName.toLowerCase();
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name)) throw new TypeError(`${label} header name is invalid`);
    set[name] = validateTemplate(rawValue, `${label} ${name}`);
  }
  if (!Array.isArray(value.remove || [])) throw new TypeError(`${label} remove must be an array`);
  const remove = (value.remove || []).map((rawName) => {
    const name = String(rawName).toLowerCase();
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name)) throw new TypeError(`${label} header name is invalid`);
    return name;
  });
  return { set, remove: [...new Set(remove)] };
}

function normalizeLocationPolicies(location, index) {
  const bodyLimitBytes = location.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  if (!Number.isInteger(bodyLimitBytes) || bodyLimitBytes < 1 || bodyLimitBytes > 1024 * 1024 * 1024) {
    throw new RangeError(`Proxy location ${index} body limit is invalid`);
  }
  const access = location.access || {};
  const normalizedAccess = {
    allow: normalizeCidrs(access.allow || [], `Proxy location ${index} access allow`),
    deny: normalizeCidrs(access.deny || [], `Proxy location ${index} access deny`),
  };
  const rateLimit = { enabled: false, requests: 60, windowMs: 60000, ...(location.rateLimit || {}) };
  if (typeof rateLimit.enabled !== "boolean" || !Number.isInteger(rateLimit.requests) || rateLimit.requests < 1
    || !Number.isInteger(rateLimit.windowMs) || rateLimit.windowMs < 1000 || rateLimit.windowMs > 86400000) {
    throw new RangeError(`Proxy location ${index} rate limit is invalid`);
  }
  const cache = { enabled: false, ttlSeconds: 60, maxBytes: DEFAULT_LOCATION_CACHE_BYTES, ...(location.cache || {}) };
  if (typeof cache.enabled !== "boolean" || !Number.isInteger(cache.ttlSeconds) || cache.ttlSeconds < 1 || cache.ttlSeconds > 31536000
    || !Number.isInteger(cache.maxBytes) || cache.maxBytes < 1 || cache.maxBytes > 1024 * 1024 * 1024) {
    throw new RangeError(`Proxy location ${index} cache policy is invalid`);
  }
  const compression = { enabled: true, minBytes: 1024, ...(location.compression || {}) };
  if (typeof compression.enabled !== "boolean" || !Number.isInteger(compression.minBytes)
    || compression.minBytes < 0 || compression.minBytes > 1024 * 1024 * 1024) {
    throw new RangeError(`Proxy location ${index} compression policy is invalid`);
  }
  return { bodyLimitBytes, access: normalizedAccess, rateLimit, cache, compression };
}

function normalizeShadow(value, index, publicNames) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Proxy location ${index} shadow policy must be an object`);
  }
  let target;
  try {
    target = new URL(value.target);
  } catch {
    throw new TypeError(`Proxy location ${index} shadow target is invalid`);
  }
  if (!new Set(["http:", "https:"]).has(target.protocol)
    || publicHostMatches(normalizeHost(target.hostname), publicNames)) {
    throw new TypeError(`Proxy location ${index} shadow target is invalid`);
  }
  const sampleRate = value.sampleRate === undefined ? 1 : Number(value.sampleRate);
  const timeoutMs = value.timeoutMs === undefined ? 1000 : Number(value.timeoutMs);
  const maxBodyBytes = value.maxBodyBytes === undefined ? DEFAULT_SHADOW_BODY_BYTES : Number(value.maxBodyBytes);
  const allowUnsafeMethods = value.allowUnsafeMethods === true;
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000
    || !Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > DEFAULT_SHADOW_BODY_BYTES
    || (value.allowUnsafeMethods !== undefined && typeof value.allowUnsafeMethods !== "boolean")) {
    throw new RangeError(`Proxy location ${index} shadow policy is invalid`);
  }
  return { target: target.href.replace(/\/$/, target.pathname === "/" ? "" : "/"), sampleRate, timeoutMs, allowUnsafeMethods, maxBodyBytes };
}

function migrateRoute(route) {
  if (Array.isArray(route.locations)) return structuredClone(route);
  const {
    target,
    dnsName,
    scheme,
    port,
    timeoutMs,
    ...site
  } = structuredClone(route);
  const upstream = target ? { target } : { dnsName, scheme, port };
  const location = {
    path: "/",
    match: "prefix",
    action: "proxy",
    upstreams: [upstream],
    rewrite: { mode: "none" },
    requestHeaders: { set: {}, remove: [] },
    responseHeaders: { set: {}, remove: [] },
  };
  if (timeoutMs !== undefined) location.timeoutMs = timeoutMs;
  return {
    ...site,
    aliases: site.aliases || [],
    locations: [location],
  };
}

function publicHostMatches(host, names) {
  return names.some((name) => name.startsWith("*.")
    ? host !== name.slice(2) && host.endsWith(name.slice(1))
    : host === name);
}

function normalizeUpstream(upstream, index, records, publicNames) {
  if (!upstream || typeof upstream !== "object") throw new TypeError(`Proxy upstream ${index} must be an object`);
  let url;
  let upstreamHost;
  if (upstream.target) {
    url = new URL(upstream.target);
    if (!new Set(["http:", "https:"]).has(url.protocol)) {
      throw new TypeError(`Proxy upstream ${index} target must use HTTP or HTTPS`);
    }
    if (publicHostMatches(normalizeHost(url.hostname), publicNames)) {
      throw new TypeError(`Proxy upstream ${index} would create a proxy loop`);
    }
  } else {
    const dnsName = normalizeName(upstream.dnsName);
    const scheme = String(upstream.scheme || "http").toLowerCase();
    const port = Number(upstream.port);
    if (!dnsName || !["http", "https"].includes(scheme) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TypeError(`Proxy upstream ${index} has an invalid DNS-derived target`);
    }
    const address = records?.find(dnsName, "A")[0]?.value || records?.find(dnsName, "AAAA")[0]?.value;
    if (!address) throw new TypeError(`Proxy upstream ${index} DNS target has no A or AAAA record`);
    const formattedAddress = address.includes(":") ? `[${address}]` : address;
    url = new URL(`${scheme}://${formattedAddress}:${port}/`);
    upstreamHost = dnsName;
  }
  const id = String(upstream.id || `upstream-${index + 1}`).trim();
  const weight = upstream.weight === undefined ? 1 : Number(upstream.weight);
  const protocol = String(upstream.protocol || (url.protocol === "https:" ? "auto" : "http1")).toLowerCase();
  const health = {
    enabled: true,
    path: "/healthz",
    intervalMs: 10_000,
    timeoutMs: 2_000,
    statusMin: 200,
    statusMax: 399,
    failureThreshold: 2,
    recoveryThreshold: 2,
    ...(upstream.health || {}),
  };
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i.test(id)) throw new TypeError(`Proxy upstream ${index} id is invalid`);
  if (!Number.isInteger(weight) || weight < 1 || weight > 100) throw new RangeError(`Proxy upstream ${index} weight is invalid`);
  if (!["http1", "http2", "auto"].includes(protocol) || (url.protocol !== "https:" && protocol !== "http1")) {
    throw new TypeError(`Proxy upstream ${index} protocol is invalid`);
  }
  if (typeof health.enabled !== "boolean" || !String(health.path).startsWith("/") || String(health.path).includes("#")
    || !Number.isInteger(health.intervalMs) || health.intervalMs < 1_000 || health.intervalMs > 3_600_000
    || !Number.isInteger(health.timeoutMs) || health.timeoutMs < 100 || health.timeoutMs > health.intervalMs
    || !Number.isInteger(health.statusMin) || !Number.isInteger(health.statusMax) || health.statusMin < 100 || health.statusMax > 599 || health.statusMin > health.statusMax
    || !Number.isInteger(health.failureThreshold) || health.failureThreshold < 1 || health.failureThreshold > 100
    || !Number.isInteger(health.recoveryThreshold) || health.recoveryThreshold < 1 || health.recoveryThreshold > 100) {
    throw new RangeError(`Proxy upstream ${index} health check is invalid`);
  }
  return {
    raw: { ...upstream, id, weight, protocol, health, enabled: upstream.enabled !== false },
    url,
    upstreamHost,
    id,
    weight,
    protocol,
    currentWeight: 0,
    consecutiveFailures: 0,
    state: "healthy",
    openUntil: 0,
    halfOpenInFlight: false,
    draining: false,
    activeHealthy: true,
    activeState: "unknown",
    activeFailures: 0,
    activeSuccesses: 0,
    lastProbe: null,
  };
}

class UpstreamPool {
  constructor(upstreams, { now = Date.now, openMs = 30000, failureThreshold = 5 } = {}) {
    this.upstreams = upstreams.filter(({ raw }) => raw.enabled);
    this.now = now;
    this.openMs = openMs;
    this.failureThreshold = failureThreshold;
  }

  next() {
    const now = this.now();
    for (const upstream of this.upstreams) {
      if (upstream.state === "open" && upstream.openUntil <= now) upstream.state = "half-open";
    }
    const halfOpen = this.upstreams.find((upstream) => upstream.state === "half-open" && !upstream.halfOpenInFlight && !upstream.draining);
    if (halfOpen) {
      halfOpen.halfOpenInFlight = true;
      return halfOpen;
    }
    const available = this.upstreams.filter((upstream) => upstream.state === "healthy" && upstream.activeHealthy && !upstream.draining);
    if (!available.length) return null;
    const totalWeight = available.reduce((total, upstream) => total + upstream.weight, 0);
    let selected = available[0];
    for (const upstream of available) {
      upstream.currentWeight += upstream.weight;
      if (upstream.currentWeight > selected.currentWeight) selected = upstream;
    }
    selected.currentWeight -= totalWeight;
    return selected;
  }

  markFailure(upstream) {
    if (!upstream) return null;
    const previousState = upstream.state;
    upstream.halfOpenInFlight = false;
    upstream.consecutiveFailures += 1;
    if (upstream.state === "half-open" || upstream.consecutiveFailures >= this.failureThreshold) {
      upstream.state = "open";
      upstream.openUntil = this.now() + this.openMs;
    }
    return previousState === upstream.state ? null : { previousState, state: upstream.state };
  }

  markSuccess(upstream) {
    if (!upstream) return null;
    const previousState = upstream.state;
    upstream.state = "healthy";
    upstream.consecutiveFailures = 0;
    upstream.openUntil = 0;
    upstream.halfOpenInFlight = false;
    return previousState === upstream.state ? null : { previousState, state: upstream.state };
  }

  setDraining(upstream, value) {
    if (upstream) upstream.draining = Boolean(value);
  }

  recordActiveProbe(upstream, result) {
    if (!upstream) return null;
    const previousState = upstream.activeState;
    upstream.lastProbe = { ...result };
    if (result.healthy) {
      upstream.activeFailures = 0;
      upstream.activeSuccesses += 1;
      if (upstream.activeSuccesses >= upstream.raw.health.recoveryThreshold) {
        upstream.activeHealthy = true;
        upstream.activeState = "healthy";
      }
    } else {
      upstream.activeSuccesses = 0;
      upstream.activeFailures += 1;
      if (upstream.activeFailures >= upstream.raw.health.failureThreshold) {
        upstream.activeHealthy = false;
        upstream.activeState = "unhealthy";
      }
    }
    return { previousState, state: upstream.activeState };
  }

  status() {
    const now = this.now();
    return this.upstreams.map((upstream) => ({
      id: upstream.id,
      state: upstream.state,
      draining: upstream.draining,
      weight: upstream.weight,
      consecutiveFailures: upstream.consecutiveFailures,
      openUntil: upstream.openUntil > now ? new Date(upstream.openUntil).toISOString() : null,
      activeState: upstream.activeState,
      latencyMs: upstream.lastProbe?.latencyMs ?? null,
      statusCode: upstream.lastProbe?.statusCode ?? null,
      checkedAt: upstream.lastProbe?.checkedAt ?? null,
      lastError: upstream.lastProbe?.error ?? null,
    }));
  }
}

function normalizeLocation(location, index, records, publicNames, poolOptions) {
  if (!location || typeof location !== "object") throw new TypeError(`Proxy location ${index} must be an object`);
  const path = String(location.path || "/");
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) throw new TypeError(`Proxy location ${index} path is invalid`);
  const match = location.match || "prefix";
  if (!["exact", "prefix"].includes(match)) throw new TypeError(`Proxy location ${index} match must be exact or prefix`);
  const action = location.action || "proxy";
  if (!["proxy", "redirect"].includes(action)) throw new TypeError(`Proxy location ${index} action is invalid`);
  const requestHeaders = normalizeHeaderRules(location.requestHeaders, `Proxy location ${index} request headers`);
  const responseHeaders = normalizeHeaderRules(location.responseHeaders, `Proxy location ${index} response headers`);
  const policies = normalizeLocationPolicies(location, index);
  const shadow = normalizeShadow(location.shadow, index, publicNames);
  const allowUnsafeFallback = location.allowUnsafeFallback === true;
  if (location.allowUnsafeFallback !== undefined && typeof location.allowUnsafeFallback !== "boolean") {
    throw new TypeError(`Proxy location ${index} unsafe fallback setting is invalid`);
  }
  const raw = {
    ...location,
    path,
    match,
    action,
    requestHeaders,
    responseHeaders,
    allowUnsafeFallback,
    ...(shadow ? { shadow } : {}),
    ...policies,
  };

  if (action === "redirect") {
    const status = Number(location.redirect?.status);
    if (!REDIRECT_STATUSES.has(status)) throw new TypeError(`Proxy location ${index} redirect status is invalid`);
    const redirect = {
      status,
      location: validateTemplate(location.redirect?.location, `Proxy location ${index} redirect`),
    };
    if (!redirect.location) throw new TypeError(`Proxy location ${index} redirect location is required`);
    return { raw: { ...raw, redirect }, redirect };
  }

  if (!Array.isArray(location.upstreams) || location.upstreams.length === 0) {
    throw new TypeError(`Proxy location ${index} requires at least one upstream`);
  }
  const rewrite = location.rewrite || { mode: "none" };
  if (!["none", "strip-prefix", "replace-prefix"].includes(rewrite.mode)) {
    throw new TypeError(`Proxy location ${index} rewrite mode is invalid`);
  }
  if (rewrite.mode === "replace-prefix" && !String(rewrite.value || "").startsWith("/")) {
    throw new TypeError(`Proxy location ${index} replacement prefix is invalid`);
  }
  const upstreams = location.upstreams.map((upstream, upstreamIndex) => normalizeUpstream(upstream, upstreamIndex, records, publicNames));
  if (new Set(upstreams.map(({ id }) => id)).size !== upstreams.length) throw new TypeError(`Proxy location ${index} has duplicate upstream ids`);
  const fallbackUpstreams = (location.fallbackUpstreams || []).map((upstream, upstreamIndex) => normalizeUpstream(upstream, upstreamIndex, records, publicNames));
  if (new Set(fallbackUpstreams.map(({ id }) => id)).size !== fallbackUpstreams.length) throw new TypeError(`Proxy location ${index} has duplicate fallback upstream ids`);
  return {
    raw: { ...raw, rewrite: { mode: rewrite.mode, ...(rewrite.mode === "replace-prefix" ? { value: rewrite.value } : {}) }, upstreams: upstreams.map(({ raw: value }) => value), ...(fallbackUpstreams.length ? { fallbackUpstreams: fallbackUpstreams.map(({ raw: value }) => value) } : {}) },
    rewrite,
    upstreams,
    fallbackUpstreams,
    pool: new UpstreamPool(upstreams, poolOptions),
    fallbackPool: new UpstreamPool(fallbackUpstreams, poolOptions),
  };
}

function normalizeRoute(route, index, records, poolOptions) {
  const migrated = migrateRoute(route);
  const host = normalizeHost(migrated.host);
  if (!host) throw new TypeError(`Proxy route ${index} requires a host`);
  const aliases = (migrated.aliases || []).map((alias) => normalizeAlias(alias, `Proxy route ${index} alias`));
  if (new Set([host, ...aliases]).size !== aliases.length + 1) throw new TypeError(`Proxy route ${index} has a duplicate host or alias`);
  const publicNames = [host, ...aliases];
  const maintenance = { enabled: false, retryAfterSeconds: 60, ...(migrated.maintenance || {}) };
  if (typeof maintenance.enabled !== "boolean" || !Number.isInteger(maintenance.retryAfterSeconds)
    || maintenance.retryAfterSeconds < 1 || maintenance.retryAfterSeconds > 86400) {
    throw new TypeError(`Proxy route ${index} maintenance setting is invalid`);
  }
  const websocket = { maxConnections: 1000, idleTimeoutMs: 300_000, drainTimeoutMs: 30_000, ...(migrated.websocket || {}) };
  if (!Number.isInteger(websocket.maxConnections) || websocket.maxConnections < 1 || websocket.maxConnections > 100_000
    || !Number.isInteger(websocket.idleTimeoutMs) || websocket.idleTimeoutMs < 1_000 || websocket.idleTimeoutMs > 86_400_000
    || !Number.isInteger(websocket.drainTimeoutMs) || websocket.drainTimeoutMs < 1_000 || websocket.drainTimeoutMs > 300_000) {
    throw new TypeError(`Proxy route ${index} WebSocket setting is invalid`);
  }
  if (!Array.isArray(migrated.locations) || migrated.locations.length === 0) throw new TypeError(`Proxy route ${index} requires a location`);
  const locations = migrated.locations.map((location, locationIndex) => normalizeLocation(location, locationIndex, records, publicNames, poolOptions));
  const keys = new Set();
  for (const location of locations) {
    const key = `${location.raw.match}:${location.raw.path}`;
    if (keys.has(key)) throw new TypeError(`Proxy route ${index} has a duplicate location: ${location.raw.path}`);
    keys.add(key);
  }
  return {
    raw: { ...migrated, host, aliases, enabled: migrated.enabled !== false, maintenance, websocket, locations: locations.map(({ raw }) => raw) },
    host,
    aliases,
    enabled: migrated.enabled !== false,
    maintenance,
    websocket,
    locations,
  };
}

function matchLocation(locations, requestPath) {
  const pathname = new URL(requestPath || "/", "http://proxy.local").pathname;
  const exact = locations.find((location) => location.raw.match === "exact" && location.raw.path === pathname);
  if (exact) return exact;
  return locations
    .filter((location) => location.raw.match === "prefix" && pathname.startsWith(location.raw.path))
    .sort((left, right) => right.raw.path.length - left.raw.path.length)[0] || null;
}

class ProxyRoutes {
  #exact = new Map();
  #wildcards = [];
  #sites = [];
  #drainingSites = new Set();
  #records;
  #poolOptions;

  constructor(routes = [], { records, poolOptions } = {}) {
    this.#records = records;
    this.#poolOptions = poolOptions;
    this.replace(routes);
  }

  replace(routes) {
    if (!Array.isArray(routes)) throw new TypeError("Proxy routes must be an array");
    const drainingUpstreams = new Set(this.healthTargets()
      .filter(({ _upstream }) => _upstream.draining)
      .map((target) => `${target.site}\n${target.location}\n${target.fallback}\n${target.id}`));
    const sites = routes.map((route, index) => normalizeRoute(route, index, this.#records, this.#poolOptions));
    const exact = new Map();
    const wildcards = [];
    for (const site of sites) {
      for (const name of [site.host, ...site.aliases]) {
        if (name.startsWith("*.")) {
          if (wildcards.some((entry) => entry.name === name) || exact.has(name)) throw new TypeError(`Duplicate proxy host: ${name}`);
          wildcards.push({ name, suffix: name.slice(1), site });
        } else {
          if (exact.has(name) || wildcards.some((entry) => entry.name === name)) throw new TypeError(`Duplicate proxy host: ${name}`);
          exact.set(name, site);
        }
      }
    }
    for (const { name } of wildcards) {
      if (exact.has(name.slice(2))) continue;
    }
    this.#sites = sites;
    this.#drainingSites = new Set([...this.#drainingSites].filter((host) => sites.some((site) => site.host === host)));
    this.#exact = exact;
    this.#wildcards = wildcards.sort((left, right) => right.suffix.length - left.suffix.length);
    for (const target of this.healthTargets()) {
      const key = `${target.site}\n${target.location}\n${target.fallback}\n${target.id}`;
      if (drainingUpstreams.has(key)) target._pool.setDraining(target._upstream, true);
    }
  }

  #findSite(hostHeader) {
    const host = normalizeHost(hostHeader);
    const exact = this.#exact.get(host);
    if (exact) return exact;
    return this.#wildcards.find(({ suffix }) => host.endsWith(suffix) && host !== suffix.slice(1))?.site || null;
  }

  resolve(hostHeader, requestPath = "/") {
    const site = this.#findSite(hostHeader);
    if (!site?.enabled) return null;
    const location = matchLocation(site.locations, requestPath);
    if (!location) return null;
    const base = {
      host: site.host,
      aliases: [...site.aliases],
      site: structuredClone(site.raw),
      location: structuredClone(location.raw),
      requestPath,
    };
    if (this.#drainingSites.has(site.host)) {
      return { ...base, draining: true, retryAfterSeconds: Math.ceil(site.websocket.drainTimeoutMs / 1000), _location: location };
    }
    if (site.maintenance.enabled) {
      return { ...base, maintenance: true, retryAfterSeconds: site.maintenance.retryAfterSeconds, _location: location };
    }
    if (location.raw.action === "redirect") return { ...base, redirect: { ...location.redirect }, _location: location };
    const upstream = location.pool.next();
    if (!upstream) return { ...base, unavailable: true, _location: location };
    return {
      ...base,
      url: new URL(upstream.url),
      upstreamHost: upstream.upstreamHost,
      timeoutMs: location.raw.timeoutMs,
      rewrite: { ...location.rewrite },
      requestHeaders: structuredClone(location.raw.requestHeaders),
      responseHeaders: structuredClone(location.raw.responseHeaders),
      _location: location,
      _upstream: upstream,
    };
  }

  resolveFallback(hostHeader, requestPath = "/") {
    const site = this.#findSite(hostHeader);
    if (!site?.enabled) return null;
    const location = matchLocation(site.locations, requestPath);
    if (!location || location.raw.action !== "proxy") return null;
    const upstream = location.fallbackPool.next();
    if (!upstream) return { host: site.host, location: structuredClone(location.raw), unavailable: true, fallback: true, _location: location };
    return {
      host: site.host,
      aliases: [...site.aliases],
      site: structuredClone(site.raw),
      location: structuredClone(location.raw),
      requestPath,
      url: new URL(upstream.url),
      upstreamHost: upstream.upstreamHost,
      timeoutMs: location.raw.timeoutMs,
      rewrite: { ...location.rewrite },
      requestHeaders: structuredClone(location.raw.requestHeaders),
      responseHeaders: structuredClone(location.raw.responseHeaders),
      fallback: true,
      _location: location,
      _upstream: upstream,
      _pool: location.fallbackPool,
    };
  }

  markFailure(resolution) {
    const transition = (resolution?._pool || resolution?._location?.pool)?.markFailure(resolution?._upstream);
    return transition ? {
      site: resolution.host,
      location: `${resolution.location.match}:${resolution.location.path}`,
      upstream: resolution._upstream.id,
      fallback: Boolean(resolution.fallback),
      ...transition,
    } : null;
  }

  markSuccess(resolution) {
    const transition = (resolution?._pool || resolution?._location?.pool)?.markSuccess(resolution?._upstream);
    return transition ? {
      site: resolution.host,
      location: `${resolution.location.match}:${resolution.location.path}`,
      upstream: resolution._upstream.id,
      fallback: Boolean(resolution.fallback),
      ...transition,
    } : null;
  }

  setDraining(resolution, value) {
    (resolution?._pool || resolution?._location?.pool)?.setDraining(resolution._upstream, value);
  }

  setSiteDraining(host, value) {
    const normalized = normalizeHost(host);
    if (!this.#sites.some((site) => site.host === normalized)) return false;
    if (value) this.#drainingSites.add(normalized);
    else this.#drainingSites.delete(normalized);
    return true;
  }

  setUpstreamDraining({ host, location, id, fallback = false } = {}, value) {
    const normalized = normalizeHost(host);
    const target = this.healthTargets().find((entry) => entry.site === normalized
      && entry.location === location && entry.id === id && entry.fallback === Boolean(fallback));
    if (!target) return false;
    target._pool.setDraining(target._upstream, value);
    return true;
  }

  siteDrainTimeout(host) {
    return this.#sites.find((site) => site.host === normalizeHost(host))?.websocket.drainTimeoutMs ?? null;
  }

  drainStatus() {
    return {
      sites: this.#sites.map((site) => ({
        host: site.host,
        draining: this.#drainingSites.has(site.host),
        drainTimeoutMs: site.websocket.drainTimeoutMs,
        locations: site.locations.map((location) => ({
          path: location.raw.path,
          match: location.raw.match,
          upstreams: location.pool?.status() || [],
          fallbackUpstreams: location.fallbackPool?.status() || [],
        })),
      })),
    };
  }

  healthTargets() {
    return this.#sites.flatMap((site) => site.locations.flatMap((location) => [
      ...(location.upstreams || []).map((upstream) => ({
        site: site.host,
        location: `${location.raw.match}:${location.raw.path}`,
        id: upstream.id,
        url: new URL(upstream.url),
        health: structuredClone(upstream.raw.health),
        fallback: false,
        _pool: location.pool,
        _upstream: upstream,
      })),
      ...(location.fallbackUpstreams || []).map((upstream) => ({
        site: site.host,
        location: `${location.raw.match}:${location.raw.path}`,
        id: upstream.id,
        url: new URL(upstream.url),
        health: structuredClone(upstream.raw.health),
        fallback: true,
        _pool: location.fallbackPool,
        _upstream: upstream,
      })),
    ]));
  }

  recordActiveProbe(target, result) {
    return target?._pool?.recordActiveProbe(target._upstream, result) || null;
  }

  health() {
    return {
      sites: this.#sites.map((site) => ({
        host: site.host,
        draining: this.#drainingSites.has(site.host),
        locations: site.locations.map((location) => ({
          path: location.raw.path,
          match: location.raw.match,
          upstreams: location.pool?.status() || [],
          fallbackUpstreams: location.fallbackPool?.status() || [],
        })),
      })),
    };
  }

  toJSON() {
    return this.#sites.map(({ raw }) => structuredClone(raw));
  }
}

module.exports = {
  ProxyRoutes,
  DEFAULT_BODY_LIMIT_BYTES,
  DEFAULT_LOCATION_CACHE_BYTES,
  DEFAULT_SHADOW_BODY_BYTES,
  REDIRECT_STATUSES,
  SAFE_VARIABLES,
  UpstreamPool,
  matchLocation,
  migrateRoute,
  normalizeHeaderRules,
  normalizeHost,
  normalizeLocation,
  normalizeLocationPolicies,
  normalizeShadow,
  normalizeRoute,
  validateTemplate,
};
