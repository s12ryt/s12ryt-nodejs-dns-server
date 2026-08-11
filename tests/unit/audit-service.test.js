"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { AuditService } = require("../../src/admin/audit-service");

test("audit service redacts secrets and delegates immutable records", () => {
  const calls = [];
  const storage = {
    appendAuditEntry: (entry) => {
      calls.push(entry);
      return { id: 1, ...entry, previousHash: null, entryHash: "a".repeat(64) };
    },
    listAuditEntries: (query) => ({ items: [{ id: 1 }], total: 1, ...query }),
    verifyAuditChain: () => ({ valid: true, entries: 1, brokenAt: null }),
  };
  const audit = new AuditService({ storage });

  const recorded = audit.record({
    actor: { id: "user-owner", type: "user" },
    action: "tunnel.token.update",
    resource: "tunnel:token",
    before: { tunnel: { token: "old-secret" }, passwordHash: "hash" },
    after: { tunnel: { token: "new-secret" }, nested: [{ secret: "value", safe: true }] },
    requestId: "request-1",
    sourceIp: "192.0.2.1",
  });

  assert.equal(recorded.id, 1);
  assert.deepEqual(calls[0].before, { passwordHash: "[redacted]", tunnel: { token: "[redacted]" } });
  assert.deepEqual(calls[0].after, { nested: [{ safe: true, secret: "[redacted]" }], tunnel: { token: "[redacted]" } });
  assert.deepEqual(audit.list({ action: "tunnel.token.update", limit: 20, offset: 0 }), {
    items: [{ id: 1 }], total: 1, action: "tunnel.token.update", limit: 20, offset: 0,
  });
  assert.deepEqual(audit.verify(), { valid: true, entries: 1, brokenAt: null });
});

test("audit service exports stable NDJSON without exposing secret material", () => {
  const storage = {
    appendAuditEntry() {},
    listAuditEntries({ offset }) {
      return offset === 0
        ? { items: [{ id: 1, action: "config.update", after: { secret: "[redacted]" } }], total: 1 }
        : { items: [], total: 1 };
    },
    verifyAuditChain: () => ({ valid: true, entries: 1, brokenAt: null }),
  };
  const audit = new AuditService({ storage });
  const exported = audit.exportNdjson();

  assert.equal(exported.contentType, "application/x-ndjson; charset=utf-8");
  assert.equal(exported.fileName.startsWith("s12-audit-"), true);
  assert.deepEqual(exported.body.trim().split("\n").map(JSON.parse), [
    { action: "config.update", after: { secret: "[redacted]" }, id: 1 },
  ]);
});
