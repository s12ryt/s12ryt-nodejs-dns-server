"use strict";

const SENSITIVE_KEY = /(?:password|secret|token|hash|credential|authorization|cookie)/i;

function redactAuditValue(value, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redactAuditValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((name) => [name, redactAuditValue(value[name], name)]));
  }
  return value;
}

class AuditService {
  constructor({ storage, now = () => new Date() } = {}) {
    if (!storage || typeof storage.appendAuditEntry !== "function"
      || typeof storage.listAuditEntries !== "function"
      || typeof storage.verifyAuditChain !== "function") {
      throw new TypeError("Audit storage is required");
    }
    this.storage = storage;
    this.now = now;
  }

  record({ actor, action, resource, before = null, after = null, requestId, sourceIp }) {
    if (!actor || typeof actor.id !== "string" || typeof actor.type !== "string") {
      throw new TypeError("Audit actor is invalid");
    }
    return this.storage.appendAuditEntry({
      actorId: actor.id,
      actorType: actor.type,
      action,
      resource,
      before: redactAuditValue(before),
      after: redactAuditValue(after),
      requestId,
      sourceIp,
    });
  }

  list(query = {}) {
    return this.storage.listAuditEntries(query);
  }

  verify() {
    return this.storage.verifyAuditChain();
  }

  exportNdjson() {
    const lines = [];
    const pageSize = 1000;
    let offset = 0;
    while (true) {
      const page = this.storage.listAuditEntries({ limit: pageSize, offset });
      for (const item of page.items) lines.push(JSON.stringify(item));
      offset += page.items.length;
      if (offset >= page.total || page.items.length === 0) break;
    }
    const stamp = this.now().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    return {
      contentType: "application/x-ndjson; charset=utf-8",
      fileName: `s12-audit-${stamp}.ndjson`,
      body: `${lines.join("\n")}${lines.length ? "\n" : ""}`,
    };
  }
}

module.exports = { AuditService, redactAuditValue };
