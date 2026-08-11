"use strict";

const { normalizeName, typeCode, validateAddress } = require("./message");

const SUPPORTED_TYPES = new Set(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV"]);

function normalizeRecord(record, index = 0) {
  if (!record || typeof record !== "object") throw new TypeError(`Record ${index} must be an object`);
  const name = normalizeName(record.name);
  const type = String(record.type || "").toUpperCase();
  if (!name || !SUPPORTED_TYPES.has(type)) throw new TypeError(`Record ${index} has an invalid name or type`);
  const ttl = Number(record.ttl ?? 300);
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > 0x7fffffff) throw new RangeError(`Record ${index} has an invalid TTL`);
  if (type === "A" || type === "AAAA") validateAddress(typeCode(type), record.value);
  if (type === "SRV" && (!Number.isInteger(record.port) || record.port < 1 || record.port > 65535)) {
    throw new RangeError(`Record ${index} has an invalid SRV port`);
  }

  return { ...record, name, type, ttl, enabled: record.enabled !== false };
}

function selectType(records, requestedType) {
  if (requestedType === "ANY") return records;
  const matches = records.filter((record) => record.type === requestedType);
  return matches.length > 0 ? matches : records.filter((record) => record.type === "CNAME");
}

class RecordStore {
  #records = new Map();

  constructor(records = []) {
    this.replace(records);
  }

  replace(records) {
    if (!Array.isArray(records)) throw new TypeError("DNS records must be an array");
    const next = new Map();
    records.map(normalizeRecord).filter((record) => record.enabled).forEach((record) => {
      const values = next.get(record.name) || [];
      values.push(Object.freeze({ ...record }));
      next.set(record.name, values);
    });
    this.#records = next;
  }

  find(name, type) {
    const normalizedName = normalizeName(name);
    const normalizedType = String(type).toUpperCase();
    const exact = selectType(this.#records.get(normalizedName) || [], normalizedType);
    if (exact.length > 0) return exact.map((record) => ({ ...record }));

    const labels = normalizedName.split(".");
    for (let index = 1; index < labels.length; index += 1) {
      const wildcard = `*.${labels.slice(index).join(".")}`;
      const matches = selectType(this.#records.get(wildcard) || [], normalizedType);
      if (matches.length > 0) {
        return matches.map((record) => ({ ...record, name: normalizedName, sourceName: wildcard }));
      }
    }
    return [];
  }

  toJSON() {
    return [...this.#records.values()].flat().map((record) => ({ ...record }));
  }
}

module.exports = { RecordStore, SUPPORTED_TYPES, normalizeRecord };
