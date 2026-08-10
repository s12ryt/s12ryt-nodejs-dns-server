"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { readJson, writeJsonAtomic } = require("../admin/atomic-file");

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizedHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

function cacheControl(value) {
  const directives = new Map();
  for (const part of String(value || "").split(",")) {
    const [name, rawValue] = part.trim().toLowerCase().split("=", 2);
    if (name) directives.set(name, rawValue?.replace(/^"|"$/g, "") ?? true);
  }
  return directives;
}

function varyNames(value) {
  return [...new Set(String(value || "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean))].sort();
}

function baseKey({ site, location, request }) {
  return `${site}\n${location}\nGET\n${String(request.host).toLowerCase()}\n${request.url}`;
}

function variantValues(names, headers) {
  const normalized = normalizedHeaders(headers);
  return Object.fromEntries(names.map((name) => [name, String(normalized[name] || "")]));
}

async function writeBufferAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, value, { mode: 0o600 });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

class ProxyCache {
  #entries = new Map();
  #bytes = 0;
  #queue = Promise.resolve();
  #started = false;

  constructor({ directory, maxBytes = 1024 * 1024 * 1024, now = Date.now } = {}) {
    if (!directory) throw new TypeError("Proxy cache directory is required");
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError("Proxy cache size is invalid");
    this.directory = directory;
    this.indexPath = path.join(directory, "index.json");
    this.maxBytes = maxBytes;
    this.now = now;
  }

  #run(operation) {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #persist() {
    await writeJsonAtomic(this.indexPath, { version: 1, entries: [...this.#entries.values()] });
  }

  async #remove(entry) {
    this.#entries.delete(entry.id);
    this.#bytes -= entry.size;
    await fs.rm(path.join(this.directory, entry.file), { force: true }).catch(() => {});
  }

  async #evict(locationKey, locationMaxBytes) {
    const ordered = () => [...this.#entries.values()].sort((left, right) => left.lastAccess - right.lastAccess);
    const locationBytes = () => [...this.#entries.values()]
      .filter((entry) => entry.locationKey === locationKey)
      .reduce((total, entry) => total + entry.size, 0);
    while (locationBytes() > locationMaxBytes) {
      const victim = ordered().find((entry) => entry.locationKey === locationKey);
      if (!victim) break;
      await this.#remove(victim);
    }
    while (this.#bytes > this.maxBytes) {
      const victim = ordered()[0];
      if (!victim) break;
      await this.#remove(victim);
    }
  }

  async start() {
    return this.#run(async () => {
      if (this.#started) return;
      await fs.mkdir(this.directory, { recursive: true });
      let stored = { version: 1, entries: [] };
      try {
        stored = await readJson(this.indexPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const now = this.now();
      for (const entry of Array.isArray(stored.entries) ? stored.entries : []) {
        if (!entry?.id || entry.expiresAt <= now) continue;
        try {
          const body = await fs.readFile(path.join(this.directory, entry.file));
          if (body.length !== entry.size || digest(body) !== entry.digest) continue;
          this.#entries.set(entry.id, entry);
          this.#bytes += entry.size;
        } catch {}
      }
      this.#started = true;
      await this.#evict("", Number.MAX_SAFE_INTEGER);
      await this.#persist();
    });
  }

  async get({ site, location, request }) {
    return this.#run(async () => {
      if (!this.#started) throw new Error("Proxy cache has not been started");
      if (!new Set(["GET", "HEAD"]).has(String(request.method || "GET").toUpperCase())) return null;
      const key = baseKey({ site, location, request });
      const requestHeaders = normalizedHeaders(request.headers);
      const now = this.now();
      for (const entry of this.#entries.values()) {
        if (entry.baseKey !== key) continue;
        if (entry.expiresAt <= now) {
          await this.#remove(entry);
          await this.#persist();
          continue;
        }
        if (entry.vary.some((name) => String(requestHeaders[name] || "") !== entry.variant[name])) continue;
        try {
          const body = await fs.readFile(path.join(this.directory, entry.file));
          if (body.length !== entry.size || digest(body) !== entry.digest) throw new Error("Proxy cache digest mismatch");
          entry.lastAccess = now;
          await this.#persist();
          return { status: entry.status, headers: structuredClone(entry.headers), body };
        } catch {
          await this.#remove(entry);
          await this.#persist();
          return null;
        }
      }
      return null;
    });
  }

  async put({ site, location, request, response, policy }) {
    return this.#run(async () => {
      if (!this.#started) throw new Error("Proxy cache has not been started");
      const method = String(request.method || "GET").toUpperCase();
      const requestHeaders = normalizedHeaders(request.headers);
      const headers = normalizedHeaders(response.headers);
      const directives = cacheControl(headers["cache-control"]);
      const vary = varyNames(headers.vary);
      const body = Buffer.from(response.body);
      if (!policy?.enabled || method !== "GET" || response.status !== 200 || requestHeaders.authorization || requestHeaders.cookie) return false;
      if (headers["set-cookie"] || directives.has("private") || directives.has("no-store") || directives.has("no-cache") || vary.includes("*")) return false;
      if (!Number.isInteger(policy.maxBytes) || body.length > policy.maxBytes || body.length > this.maxBytes) return false;
      const configuredTtl = Number(policy.ttlSeconds);
      const maxAge = directives.has("max-age") ? Number(directives.get("max-age")) : configuredTtl;
      const ttlSeconds = Math.min(configuredTtl, maxAge);
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return false;

      const key = baseKey({ site, location, request });
      const variant = variantValues(vary, requestHeaders);
      const id = digest(`${key}\n${JSON.stringify(variant)}`);
      const bodyDigest = digest(body);
      const file = `${id}.${bodyDigest}.body`;
      await writeBufferAtomic(path.join(this.directory, file), body);
      const previous = this.#entries.get(id);
      if (previous) await this.#remove(previous);
      const now = this.now();
      const locationKey = `${site}\n${location}`;
      const entry = {
        id,
        baseKey: key,
        site,
        location,
        locationKey,
        vary,
        variant,
        status: response.status,
        headers,
        file,
        digest: bodyDigest,
        size: body.length,
        createdAt: now,
        lastAccess: now,
        expiresAt: now + ttlSeconds * 1000,
      };
      this.#entries.set(id, entry);
      this.#bytes += entry.size;
      await this.#evict(locationKey, policy.maxBytes);
      await this.#persist();
      return this.#entries.has(id);
    });
  }

  status() {
    return { entries: this.#entries.size, bytes: this.#bytes, maxBytes: this.maxBytes };
  }

  async configure({ maxBytes }) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError("Proxy cache size is invalid");
    return this.#run(async () => {
      this.maxBytes = maxBytes;
      await this.#evict("", Number.MAX_SAFE_INTEGER);
      if (this.#started) await this.#persist();
      return this.status();
    });
  }

  async clear({ site, location } = {}) {
    return this.#run(async () => {
      for (const entry of [...this.#entries.values()]) {
        if (site && entry.site !== site) continue;
        if (location && entry.location !== location) continue;
        await this.#remove(entry);
      }
      await this.#persist();
      return this.status();
    });
  }

  async close() {
    return this.#run(async () => {
      if (!this.#started) return;
      await this.#persist();
      this.#started = false;
    });
  }
}

module.exports = {
  ProxyCache,
  baseKey,
  cacheControl,
  digest,
  normalizedHeaders,
  varyNames,
};
