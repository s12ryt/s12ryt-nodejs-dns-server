"use strict";

const crypto = require("node:crypto");

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function requestFingerprint({ method, path, body }) {
  return crypto.createHash("sha256").update(canonicalJson({
    body: body ?? null,
    method: String(method).toUpperCase(),
    path: String(path),
  })).digest("hex");
}

class IdempotencyService {
  constructor({ storage } = {}) {
    if (!storage || typeof storage.reserveIdempotency !== "function"
      || typeof storage.completeIdempotency !== "function"
      || typeof storage.abandonIdempotency !== "function") {
      throw new TypeError("Idempotency storage is required");
    }
    this.storage = storage;
  }

  async execute({ actorId, key, method, path, body }, operation) {
    if (typeof actorId !== "string" || !actorId || !IDEMPOTENCY_KEY.test(String(key))) {
      throw Object.assign(new Error("Idempotency-Key must contain 8 to 128 safe characters"), { statusCode: 400 });
    }
    if (typeof operation !== "function") throw new TypeError("Idempotent operation is required");
    const fingerprint = requestFingerprint({ method, path, body });
    const reservation = this.storage.reserveIdempotency({ actorId, key, fingerprint });
    if (reservation.state === "replay") {
      return { statusCode: reservation.statusCode, body: reservation.response, replayed: true };
    }
    if (reservation.state === "pending") {
      throw Object.assign(new Error("An idempotent request with this key is still processing"), { statusCode: 409 });
    }
    try {
      const result = await operation();
      if (!result || !Number.isInteger(result.statusCode) || result.statusCode < 100 || result.statusCode > 599) {
        throw new TypeError("Idempotent operation result is invalid");
      }
      this.storage.completeIdempotency({ actorId, key, statusCode: result.statusCode, response: result.body ?? null });
      return { statusCode: result.statusCode, body: result.body ?? null, replayed: false };
    } catch (error) {
      this.storage.abandonIdempotency({ actorId, key });
      throw error;
    }
  }
}

module.exports = { IDEMPOTENCY_KEY, IdempotencyService, canonicalJson, requestFingerprint };
