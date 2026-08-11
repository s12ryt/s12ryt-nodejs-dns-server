"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { writeJsonAtomic } = require("../admin/atomic-file");
const { normalizeAction, parseHostsList } = require("./policy");
const { TYPES } = require("./message");

const DEFAULT_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_DOMAINS = 1_000_000;
const SUBSCRIPTION_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeSubscription(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("DNS policy subscription must be an object");
  }
  const id = String(value.id || "").trim();
  if (!SUBSCRIPTION_ID.test(id)) throw new TypeError("DNS policy subscription id is invalid");
  let url;
  try {
    url = new URL(value.url);
  } catch {
    throw new TypeError("DNS policy subscription URL must use HTTPS");
  }
  if (url.protocol !== "https:") throw new TypeError("DNS policy subscription URL must use HTTPS");
  const priority = Number(value.priority);
  if (!Number.isInteger(priority)) throw new TypeError("DNS policy subscription priority must be an integer");
  const refreshIntervalMs = value.refreshIntervalMs === undefined
    ? DEFAULT_REFRESH_INTERVAL_MS
    : Number(value.refreshIntervalMs);
  if (!Number.isInteger(refreshIntervalMs)
    || refreshIntervalMs < MIN_REFRESH_INTERVAL_MS
    || refreshIntervalMs > MAX_REFRESH_INTERVAL_MS) {
    throw new RangeError("DNS policy subscription refresh interval is invalid");
  }
  if (value.qtypes !== undefined && !Array.isArray(value.qtypes)) {
    throw new TypeError("DNS policy subscription qtypes must be an array");
  }
  const qtypes = value.qtypes === undefined
    ? []
    : [...new Set(value.qtypes.map((type) => String(type).toUpperCase()))];
  if (qtypes.some((type) => !TYPES[type] || ["OPT", "AXFR", "IXFR", "ANY"].includes(type))) {
    throw new TypeError("DNS policy subscription qtypes are invalid");
  }
  return {
    id,
    enabled: value.enabled !== false,
    url: url.toString(),
    priority,
    refreshIntervalMs,
    ...(qtypes.length ? { qtypes } : {}),
    action: normalizeAction(value.action),
  };
}

async function readBody(response, maxBytes) {
  if (!response || !response.ok) {
    throw new Error(`DNS policy subscription returned HTTP ${response?.status ?? "unknown"}`);
  }
  const chunks = [];
  let size = 0;
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== "function") {
    throw new TypeError("DNS policy subscription response body is unavailable");
  }
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new RangeError("DNS policy subscription is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

class PolicySubscriptionManager {
  constructor({
    directory,
    policyStore,
    rules = [],
    subscriptions = [],
    fetch = globalThis.fetch,
    schedule = setTimeout,
    cancel = clearTimeout,
    onEvent = () => {},
    maxBytes = DEFAULT_MAX_BYTES,
    maxDomains = DEFAULT_MAX_DOMAINS,
    now = () => new Date(),
  } = {}) {
    if (!directory) throw new TypeError("DNS policy subscription cache directory is required");
    if (!policyStore || typeof policyStore.replace !== "function") throw new TypeError("Policy store is required");
    if (!Array.isArray(rules)) throw new TypeError("Local policy rules must be an array");
    if (!Array.isArray(subscriptions)) throw new TypeError("DNS policy subscriptions must be an array");
    if (typeof fetch !== "function") throw new TypeError("DNS policy subscription fetch is required");
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError("DNS policy subscription size limit is invalid");
    if (!Number.isInteger(maxDomains) || maxDomains < 1) throw new RangeError("DNS policy subscription domain limit is invalid");
    this.directory = directory;
    this.policyStore = policyStore;
    this.rules = structuredClone(rules);
    this.subscriptions = subscriptions.map(normalizeSubscription);
    const ids = new Set();
    for (const subscription of this.subscriptions) {
      if (ids.has(subscription.id)) throw new TypeError(`Duplicate DNS policy subscription id: ${subscription.id}`);
      ids.add(subscription.id);
    }
    this.fetch = fetch;
    this.schedule = schedule;
    this.cancel = cancel;
    this.onEvent = onEvent;
    this.maxBytes = maxBytes;
    this.maxDomains = maxDomains;
    this.now = now;
    this.cached = new Map();
    this.timers = new Map();
    this.refreshes = new Map();
    this.active = false;
    this.closed = false;
  }

  cachePath(id) {
    return path.join(this.directory, `${id}.json`);
  }

  async loadCache(subscription) {
    try {
      const value = JSON.parse(await fs.readFile(this.cachePath(subscription.id), "utf8"));
      if (!value || value.formatVersion !== 1 || value.id !== subscription.id || value.url !== subscription.url
        || !Array.isArray(value.names) || typeof value.sha256 !== "string") return;
      const names = parseHostsList(value.names.join("\n"));
      if (names.length > this.maxDomains || sha256(`${names.join("\n")}\n`) !== value.sha256) return;
      this.cached.set(subscription.id, { names, fetchedAt: value.fetchedAt });
    } catch (error) {
      if (error.code !== "ENOENT") this.emitError(subscription, error);
    }
  }

  subscriptionRules() {
    const generated = [];
    for (const subscription of this.subscriptions) {
      if (!subscription.enabled) continue;
      const cache = this.cached.get(subscription.id);
      if (!cache) continue;
      for (const name of cache.names) {
        generated.push({
          id: `subscription:${subscription.id}:${sha256(name).slice(0, 16)}`,
          enabled: true,
          priority: subscription.priority,
          source: `subscription:${subscription.id}`,
          match: {
            name: { kind: "exact", value: name },
            ...(subscription.qtypes?.length ? { qtypes: [...subscription.qtypes] } : {}),
          },
          action: { ...subscription.action },
        });
      }
    }
    return generated;
  }

  rebuild() {
    this.policyStore.replace([...this.rules, ...this.subscriptionRules()]);
  }

  emitError(subscription, error) {
    this.onEvent({
      kind: "dns-policy-subscription-error",
      subscriptionId: subscription.id,
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }

  arrange(subscription) {
    if (!subscription.enabled || !this.active || this.closed) return;
    const previous = this.timers.get(subscription.id);
    if (previous) this.cancel(previous);
    const timer = this.schedule(async () => {
      try {
        await this.refresh(subscription.id);
      } catch {
        // refresh reports the failure and keeps the last-known-good cache.
      } finally {
        this.arrange(subscription);
      }
    }, subscription.refreshIntervalMs);
    timer?.unref?.();
    this.timers.set(subscription.id, timer);
  }

  async start() {
    if (this.closed) throw new Error("DNS policy subscription manager is closed");
    if (this.active) return;
    this.active = true;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await Promise.all(this.subscriptions.filter((item) => item.enabled).map((item) => this.loadCache(item)));
    this.rebuild();
    for (const subscription of this.subscriptions) {
      if (!subscription.enabled) continue;
      this.arrange(subscription);
      void this.refresh(subscription.id).catch(() => {});
    }
  }

  pause() {
    if (!this.active) return;
    this.active = false;
    for (const timer of this.timers.values()) this.cancel(timer);
    this.timers.clear();
  }

  async replace({ rules = [], subscriptions = [] } = {}) {
    if (!Array.isArray(rules)) throw new TypeError("Local policy rules must be an array");
    if (!Array.isArray(subscriptions)) throw new TypeError("DNS policy subscriptions must be an array");
    const normalized = subscriptions.map(normalizeSubscription);
    const ids = new Set();
    for (const subscription of normalized) {
      if (ids.has(subscription.id)) throw new TypeError(`Duplicate DNS policy subscription id: ${subscription.id}`);
      ids.add(subscription.id);
    }
    const wasActive = this.active;
    this.pause();
    this.rules = structuredClone(rules);
    this.subscriptions = normalized;
    this.cached.clear();
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await Promise.all(this.subscriptions.filter((item) => item.enabled).map((item) => this.loadCache(item)));
    this.rebuild();
    if (wasActive) await this.start();
  }

  async performRefresh(id) {
    const subscription = this.subscriptions.find((candidate) => candidate.id === id);
    if (!subscription) throw new TypeError(`DNS policy subscription is unavailable: ${id}`);
    try {
      const source = await readBody(await this.fetch(subscription.url, {
        headers: { accept: "text/plain" },
        redirect: "follow",
      }), this.maxBytes);
      const names = parseHostsList(source);
      if (names.length > this.maxDomains) throw new RangeError("DNS policy subscription has too many domains");
      const fetchedAt = this.now().toISOString();
      const digest = sha256(`${names.join("\n")}\n`);
      await writeJsonAtomic(this.cachePath(subscription.id), {
        formatVersion: 1,
        id: subscription.id,
        url: subscription.url,
        fetchedAt,
        names,
        sha256: digest,
      });
      this.cached.set(subscription.id, { names, fetchedAt });
      this.rebuild();
      return { id: subscription.id, domains: names.length, fetchedAt };
    } catch (error) {
      this.emitError(subscription, error);
      throw error;
    }
  }

  refresh(id) {
    const active = this.refreshes.get(id);
    if (active) return active;
    const operation = this.performRefresh(id);
    this.refreshes.set(id, operation);
    return operation.finally(() => {
      if (this.refreshes.get(id) === operation) this.refreshes.delete(id);
    });
  }

  status() {
    return this.subscriptions.map((subscription) => {
      const cache = this.cached.get(subscription.id);
      return {
        id: subscription.id,
        enabled: subscription.enabled,
        url: subscription.url,
        priority: subscription.priority,
        refreshIntervalMs: subscription.refreshIntervalMs,
        domains: cache?.names.length ?? 0,
        fetchedAt: cache?.fetchedAt ?? null,
      };
    });
  }

  async close() {
    if (this.closed) return;
    this.pause();
    this.closed = true;
  }
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_DOMAINS,
  DEFAULT_REFRESH_INTERVAL_MS,
  MAX_REFRESH_INTERVAL_MS,
  MIN_REFRESH_INTERVAL_MS,
  PolicySubscriptionManager,
  normalizeSubscription,
};
