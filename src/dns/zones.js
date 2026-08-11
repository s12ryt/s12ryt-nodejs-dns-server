"use strict";

const { normalizeName } = require("./message");
const { SUPPORTED_TYPES, normalizeRecord } = require("./records");

const DEFAULT_SOA = Object.freeze({
  refresh: 3600,
  retry: 600,
  expire: 1209600,
});

function unsigned32(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${label} must be an unsigned 32-bit integer`);
  }
  return value;
}

function normalizeZone(domain, index) {
  if (!domain || typeof domain !== "object") throw new TypeError(`Zone ${index} must be an object`);
  const name = normalizeName(domain.name);
  if (!name) throw new TypeError(`Zone ${index} has an invalid name`);
  const defaultTtl = Number(domain.defaultTtl ?? 300);
  if (!Number.isInteger(defaultTtl) || defaultTtl < 0 || defaultTtl > 0x7fffffff) {
    throw new RangeError(`Zone ${index} has an invalid default TTL`);
  }
  const source = domain.soa || {};
  const soa = {
    mname: normalizeName(source.mname || `ns1.${name}`),
    rname: normalizeName(source.rname || `hostmaster.${name}`),
    serial: unsigned32(source.serial ?? 1, "SOA serial"),
    refresh: unsigned32(source.refresh ?? DEFAULT_SOA.refresh, "SOA refresh"),
    retry: unsigned32(source.retry ?? DEFAULT_SOA.retry, "SOA retry"),
    expire: unsigned32(source.expire ?? DEFAULT_SOA.expire, "SOA expire"),
    minimum: unsigned32(source.minimum ?? defaultTtl, "SOA minimum"),
  };
  if (!soa.mname || !soa.rname) throw new TypeError(`Zone ${index} has invalid SOA names`);
  return { ...domain, name, defaultTtl, enabled: domain.enabled !== false, soa };
}

function belongsTo(name, zoneName) {
  return name === zoneName || name.endsWith(`.${zoneName}`);
}

function recordTypeMatches(record, requestedType) {
  return requestedType === "ANY" || record.type === requestedType;
}

class ZoneStore {
  #zones = [];
  #records = new Map();

  constructor({ domains = [], records = [] } = {}) {
    this.replace({ domains, records });
  }

  replace({ domains = [], records = [] }) {
    if (!Array.isArray(domains) || !Array.isArray(records)) {
      throw new TypeError("Zones and DNS records must be arrays");
    }
    this.#zones = domains.map(normalizeZone).filter((zone) => zone.enabled)
      .sort((left, right) => right.name.length - left.name.length);
    const nextRecords = new Map();
    records.map(normalizeRecord).filter((record) => record.enabled).forEach((record) => {
      const values = nextRecords.get(record.name) || [];
      values.push(Object.freeze({ ...record }));
      nextRecords.set(record.name, values);
    });
    this.#records = nextRecords;
  }

  #zoneFor(name) {
    return this.#zones.find((zone) => belongsTo(name, zone.name)) || null;
  }

  #soaRecord(zone) {
    return { name: zone.name, type: "SOA", ttl: zone.defaultTtl, ...zone.soa };
  }

  #delegation(name, zone) {
    let candidate = name;
    while (candidate !== zone.name) {
      const records = this.#records.get(candidate) || [];
      const nameservers = records.filter((record) => record.type === "NS");
      if (nameservers.length > 0) return nameservers.map((record) => ({ ...record }));
      const dot = candidate.indexOf(".");
      if (dot === -1) break;
      candidate = candidate.slice(dot + 1);
    }
    return [];
  }

  #glue(nameservers, zone) {
    const records = [];
    for (const nameserver of nameservers) {
      const target = normalizeName(nameserver.value);
      if (!belongsTo(target, zone.name)) continue;
      for (const record of this.#records.get(target) || []) {
        if (record.type === "A" || record.type === "AAAA") records.push({ ...record });
      }
    }
    return records;
  }

  #answers(name, requestedType, zone) {
    const exact = this.#records.get(name);
    if (exact) {
      const matches = exact.filter((record) => recordTypeMatches(record, requestedType));
      if (matches.length > 0) return matches.map((record) => ({ ...record }));
      const aliases = exact.filter((record) => record.type === "CNAME");
      return aliases.map((record) => ({ ...record }));
    }

    const relativeLabels = name === zone.name ? [] : name.slice(0, -(zone.name.length + 1)).split(".");
    for (let index = 1; index <= relativeLabels.length; index += 1) {
      const suffix = relativeLabels.slice(index).join(".");
      const wildcard = suffix ? `*.${suffix}.${zone.name}` : `*.${zone.name}`;
      const records = this.#records.get(wildcard) || [];
      const matches = records.filter((record) => recordTypeMatches(record, requestedType));
      const selected = matches.length > 0 ? matches : records.filter((record) => record.type === "CNAME");
      if (selected.length > 0) {
        return selected.map((record) => ({ ...record, name, sourceName: wildcard }));
      }
    }
    return [];
  }

  resolve(name, type) {
    const normalizedName = normalizeName(name);
    const requestedType = String(type).toUpperCase();
    if (!normalizedName || (!SUPPORTED_TYPES.has(requestedType) && requestedType !== "SOA" && requestedType !== "ANY")) {
      throw new TypeError("Zone query has an invalid name or type");
    }
    const zone = this.#zoneFor(normalizedName);
    if (!zone) return null;

    const delegation = this.#delegation(normalizedName, zone);
    if (delegation.length > 0) {
      return {
        authoritative: false,
        rcode: "NOERROR",
        answers: [],
        authorities: delegation,
        additionals: this.#glue(delegation, zone),
      };
    }

    if (normalizedName === zone.name && (requestedType === "SOA" || requestedType === "ANY")) {
      return {
        authoritative: true,
        rcode: "NOERROR",
        answers: [this.#soaRecord(zone)],
        authorities: [],
        additionals: [],
      };
    }

    const ownerExists = this.#records.has(normalizedName);
    const answers = this.#answers(normalizedName, requestedType, zone);
    if (answers.length > 0) {
      return { authoritative: true, rcode: "NOERROR", answers, authorities: [], additionals: [] };
    }
    return {
      authoritative: true,
      rcode: ownerExists ? "NOERROR" : "NXDOMAIN",
      answers: [],
      authorities: [this.#soaRecord(zone)],
      additionals: [],
    };
  }
}

module.exports = { DEFAULT_SOA, ZoneStore, belongsTo, normalizeZone };
