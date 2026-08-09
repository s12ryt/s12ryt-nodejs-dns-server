"use strict";

const path = require("node:path");

const { RecordStore } = require("../dns/records");
const { ProxyRoutes } = require("../services/proxy-routes");
const { readJson, writeJsonAtomic } = require("./atomic-file");

const DEFAULT_CONFIG = Object.freeze({
  dns: { host: "0.0.0.0", port: 5354 },
  doh: { host: "0.0.0.0", port: 8053 },
  proxy: { host: "0.0.0.0", port: 8080, timeoutMs: 30000 },
  admin: { host: "0.0.0.0", port: 8081 },
  cache: { maxEntries: 1000, minTtl: 1, maxTtl: 86400 },
  upstreams: [
    { name: "Cloudflare", url: "https://cloudflare-dns.com/dns-query", timeoutMs: 5000 },
    { name: "Google", url: "https://dns.google/dns-query", timeoutMs: 5000 },
  ],
  tunnel: { token: "" },
  records: [],
  routes: [],
});

function migrateConfig(input) {
  const migrated = structuredClone(input);
  if (!("tunnel" in migrated)) migrated.tunnel = { token: "" };
  return migrated;
}

function validatePortGroup(name, value) {
  if (!value || typeof value.host !== "string" || !value.host.trim()) throw new TypeError(`${name} host is required`);
  if (!Number.isInteger(value.port) || value.port < 0 || value.port > 65535) throw new RangeError(`${name} port is invalid`);
}

function validateConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Configuration must be an object");
  for (const name of ["dns", "doh", "proxy", "admin"]) validatePortGroup(name, input[name]);
  if (!Number.isInteger(input.proxy.timeoutMs) || input.proxy.timeoutMs < 100 || input.proxy.timeoutMs > 300000) {
    throw new RangeError("Proxy timeout is invalid");
  }
  const { maxEntries, minTtl, maxTtl } = input.cache || {};
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 100000) throw new RangeError("Cache size is invalid");
  if (!Number.isInteger(minTtl) || !Number.isInteger(maxTtl) || minTtl < 0 || maxTtl < minTtl) {
    throw new RangeError("Cache TTL range is invalid");
  }
  if (!Array.isArray(input.upstreams) || input.upstreams.length === 0) throw new TypeError("At least one upstream is required");
  input.upstreams.forEach((upstream, index) => {
    if (!upstream.name || !upstream.url || new URL(upstream.url).protocol !== "https:") {
      throw new TypeError(`Upstream ${index} must have a name and HTTPS URL`);
    }
  });
  if (!input.tunnel || typeof input.tunnel !== "object" || typeof input.tunnel.token !== "string") {
    throw new TypeError("Tunnel token must be a string");
  }
  const records = new RecordStore(input.records);
  new ProxyRoutes(input.routes, { records });
  return structuredClone(input);
}

class ConfigStore {
  #config;
  #listeners = new Set();

  constructor({ directory = path.resolve("data") } = {}) {
    this.filePath = path.join(directory, "config.json");
  }

  async load() {
    try {
      const stored = await readJson(this.filePath);
      const migrated = migrateConfig(stored);
      this.#config = validateConfig(migrated);
      if (!("tunnel" in stored)) await writeJsonAtomic(this.filePath, this.#config);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.#config = structuredClone(DEFAULT_CONFIG);
      await writeJsonAtomic(this.filePath, this.#config);
    }
    return this.get();
  }

  get() {
    if (!this.#config) throw new Error("Configuration has not been loaded");
    return structuredClone(this.#config);
  }

  async update(value) {
    const validated = validateConfig(value);
    await writeJsonAtomic(this.filePath, validated);
    this.#config = validated;
    for (const listener of this.#listeners) listener(this.get());
    return this.get();
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

module.exports = { ConfigStore, DEFAULT_CONFIG, migrateConfig, validateConfig };
