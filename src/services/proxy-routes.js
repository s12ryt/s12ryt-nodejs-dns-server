"use strict";

const { normalizeName } = require("../dns/message");

function normalizeHost(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw.startsWith("[")) return raw.slice(1, raw.indexOf("]"));
  return normalizeName(raw.split(":", 1)[0]);
}

function normalizeRoute(route, index, records) {
  const host = normalizeHost(route.host);
  if (!host) throw new TypeError(`Proxy route ${index} requires a host`);
  let url;
  let upstreamHost;
  if (route.target) {
    url = new URL(route.target);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError(`Proxy route ${index} target must use HTTP or HTTPS`);
    }
    if (normalizeHost(url.hostname) === host) throw new TypeError(`Proxy route ${index} would create a proxy loop`);
  } else {
    const dnsName = normalizeName(route.dnsName);
    const scheme = String(route.scheme || "http").toLowerCase();
    const port = Number(route.port);
    if (!dnsName || !["http", "https"].includes(scheme) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TypeError(`Proxy route ${index} has an invalid DNS-derived target`);
    }
    const address = records?.find(dnsName, "A")[0]?.value || records?.find(dnsName, "AAAA")[0]?.value;
    if (!address) throw new TypeError(`Proxy route ${index} DNS target has no A or AAAA record`);
    const formattedAddress = address.includes(":") ? `[${address}]` : address;
    url = new URL(`${scheme}://${formattedAddress}:${port}/`);
    upstreamHost = dnsName;
  }
  return Object.freeze({ ...route, host, url, upstreamHost, enabled: route.enabled !== false });
}

class ProxyRoutes {
  #routes = new Map();
  #records;

  constructor(routes = [], { records } = {}) {
    this.#records = records;
    this.replace(routes);
  }

  replace(routes) {
    if (!Array.isArray(routes)) throw new TypeError("Proxy routes must be an array");
    const next = new Map();
    routes.map((route, index) => normalizeRoute(route, index, this.#records)).forEach((route) => {
      if (next.has(route.host)) throw new TypeError(`Duplicate proxy route host: ${route.host}`);
      next.set(route.host, route);
    });
    this.#routes = next;
  }

  resolve(hostHeader) {
    const route = this.#routes.get(normalizeHost(hostHeader));
    return route?.enabled ? { ...route, url: new URL(route.url) } : null;
  }

  toJSON() {
    return [...this.#routes.values()].map(({ url, ...route }) => ({ ...route, target: url.href }));
  }
}

module.exports = { ProxyRoutes, normalizeHost, normalizeRoute };
