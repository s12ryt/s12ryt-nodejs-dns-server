"use strict";

class DnsCache {
  #entries = new Map();
  #maxEntries;
  #minTtl;
  #maxTtl;
  #now;

  constructor({ maxEntries = 1000, minTtl = 0, maxTtl = 0x7fffffff, now = Date.now } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be a positive integer");
    if (!Number.isInteger(minTtl) || !Number.isInteger(maxTtl) || minTtl < 0 || maxTtl < minTtl) {
      throw new RangeError("TTL bounds are invalid");
    }
    this.#maxEntries = maxEntries;
    this.#minTtl = minTtl;
    this.#maxTtl = maxTtl;
    this.#now = now;
  }

  get size() {
    this.#removeExpired();
    return this.#entries.size;
  }

  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return null;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return Buffer.from(entry.wire);
  }

  set(key, wire, ttlSeconds, { successful = true } = {}) {
    if (!successful || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return;
    const boundedTtl = Math.min(this.#maxTtl, Math.max(this.#minTtl, ttlSeconds));
    if (boundedTtl <= 0) return;
    const expiresAt = this.#now() + Math.floor(boundedTtl * 1000);
    this.#entries.delete(key);
    this.#entries.set(key, { wire: Buffer.from(wire), expiresAt });
    this.#removeExpired();
    while (this.#entries.size > this.#maxEntries) {
      this.#entries.delete(this.#entries.keys().next().value);
    }
  }

  clear() {
    this.#entries.clear();
  }

  #removeExpired() {
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }
}

module.exports = { DnsCache };
