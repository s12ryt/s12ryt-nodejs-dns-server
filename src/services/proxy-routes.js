"use strict";

const { normalizeName } = require("../dns/message");
const { normalizeCidrs } = require("./proxy-security");

const SAFE_VARIABLES = new Set(["host", "clientIp", "scheme", "requestId", "path"]);
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);
const DEFAULT_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
const DEFAULT_LOCATION_CACHE_BYTES = 100 * 1024 * 1024;

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
  return {
    raw: { ...upstream, enabled: upstream.enabled !== false },
    url,
    upstreamHost,
  };
}

class UpstreamPool {
  #cursor = 0;
  #failedUntil = new Map();

  constructor(upstreams, { now = Date.now, failureCooldownMs = 30000 } = {}) {
    this.upstreams = upstreams.filter(({ raw }) => raw.enabled);
    this.now = now;
    this.failureCooldownMs = failureCooldownMs;
  }

  next() {
    if (this.upstreams.length === 0) return null;
    const now = this.now();
    for (let offset = 0; offset < this.upstreams.length; offset += 1) {
      const index = (this.#cursor + offset) % this.upstreams.length;
      const upstream = this.upstreams[index];
      if ((this.#failedUntil.get(upstream) || 0) > now) continue;
      this.#cursor = (index + 1) % this.upstreams.length;
      return upstream;
    }
    return null;
  }

  markFailure(upstream) {
    if (upstream) this.#failedUntil.set(upstream, this.now() + this.failureCooldownMs);
  }

  markSuccess(upstream) {
    if (upstream) this.#failedUntil.delete(upstream);
  }
}

function normalizeLocation(location, index, records, publicNames) {
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
  const raw = { ...location, path, match, action, requestHeaders, responseHeaders, ...policies };

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
  return {
    raw: { ...raw, rewrite: { mode: rewrite.mode, ...(rewrite.mode === "replace-prefix" ? { value: rewrite.value } : {}) }, upstreams: upstreams.map(({ raw: value }) => value) },
    rewrite,
    upstreams,
    pool: new UpstreamPool(upstreams),
  };
}

function normalizeRoute(route, index, records) {
  const migrated = migrateRoute(route);
  const host = normalizeHost(migrated.host);
  if (!host) throw new TypeError(`Proxy route ${index} requires a host`);
  const aliases = (migrated.aliases || []).map((alias) => normalizeAlias(alias, `Proxy route ${index} alias`));
  if (new Set([host, ...aliases]).size !== aliases.length + 1) throw new TypeError(`Proxy route ${index} has a duplicate host or alias`);
  const publicNames = [host, ...aliases];
  if (!Array.isArray(migrated.locations) || migrated.locations.length === 0) throw new TypeError(`Proxy route ${index} requires a location`);
  const locations = migrated.locations.map((location, locationIndex) => normalizeLocation(location, locationIndex, records, publicNames));
  const keys = new Set();
  for (const location of locations) {
    const key = `${location.raw.match}:${location.raw.path}`;
    if (keys.has(key)) throw new TypeError(`Proxy route ${index} has a duplicate location: ${location.raw.path}`);
    keys.add(key);
  }
  return {
    raw: { ...migrated, host, aliases, enabled: migrated.enabled !== false, locations: locations.map(({ raw }) => raw) },
    host,
    aliases,
    enabled: migrated.enabled !== false,
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
  #records;

  constructor(routes = [], { records } = {}) {
    this.#records = records;
    this.replace(routes);
  }

  replace(routes) {
    if (!Array.isArray(routes)) throw new TypeError("Proxy routes must be an array");
    const sites = routes.map((route, index) => normalizeRoute(route, index, this.#records));
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
    this.#exact = exact;
    this.#wildcards = wildcards.sort((left, right) => right.suffix.length - left.suffix.length);
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

  markFailure(resolution) {
    resolution?._location?.pool.markFailure(resolution._upstream);
  }

  markSuccess(resolution) {
    resolution?._location?.pool.markSuccess(resolution._upstream);
  }

  toJSON() {
    return this.#sites.map(({ raw }) => structuredClone(raw));
  }
}

module.exports = {
  ProxyRoutes,
  DEFAULT_BODY_LIMIT_BYTES,
  DEFAULT_LOCATION_CACHE_BYTES,
  REDIRECT_STATUSES,
  SAFE_VARIABLES,
  UpstreamPool,
  matchLocation,
  migrateRoute,
  normalizeHeaderRules,
  normalizeHost,
  normalizeLocation,
  normalizeLocationPolicies,
  normalizeRoute,
  validateTemplate,
};
