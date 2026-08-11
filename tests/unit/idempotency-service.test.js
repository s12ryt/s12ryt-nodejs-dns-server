"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { IdempotencyService } = require("../../src/admin/idempotency-service");

test("idempotency service executes once and replays the stored response", async () => {
  const records = new Map();
  const storage = {
    reserveIdempotency({ actorId, key, fingerprint }) {
      const id = `${actorId}:${key}`;
      const existing = records.get(id);
      if (!existing) {
        records.set(id, { fingerprint, state: "pending" });
        return { state: "started" };
      }
      if (existing.fingerprint !== fingerprint) throw Object.assign(new Error("different request"), { statusCode: 409 });
      return existing.state === "completed"
        ? { state: "replay", statusCode: existing.statusCode, response: existing.response }
        : { state: "pending" };
    },
    completeIdempotency({ actorId, key, statusCode, response }) {
      records.set(`${actorId}:${key}`, { ...records.get(`${actorId}:${key}`), state: "completed", statusCode, response });
    },
    abandonIdempotency({ actorId, key }) { records.delete(`${actorId}:${key}`); },
  };
  const service = new IdempotencyService({ storage });
  let calls = 0;
  const request = {
    actorId: "user-owner", key: "create-role-0001", method: "POST", path: "/api/v2/roles",
    body: { permissions: ["dns:write", "dns:read"], name: "DNS editor" },
  };

  const first = await service.execute(request, async () => {
    calls += 1;
    return { statusCode: 201, body: { data: { id: "dns-editor" } } };
  });
  const replay = await service.execute({ ...request, body: { name: "DNS editor", permissions: ["dns:write", "dns:read"] } }, async () => {
    calls += 1;
    throw new Error("must not execute");
  });

  assert.equal(calls, 1);
  assert.deepEqual(first, { statusCode: 201, body: { data: { id: "dns-editor" } }, replayed: false });
  assert.deepEqual(replay, { statusCode: 201, body: { data: { id: "dns-editor" } }, replayed: true });
});

test("idempotency service rejects invalid, pending and conflicting keys and releases failed work", async () => {
  let state = "started";
  let abandoned = 0;
  const storage = {
    reserveIdempotency() { return { state }; },
    completeIdempotency() {},
    abandonIdempotency() { abandoned += 1; },
  };
  const service = new IdempotencyService({ storage });
  const base = { actorId: "owner", method: "POST", path: "/api/v2/roles", body: {} };

  await assert.rejects(() => service.execute({ ...base, key: "short" }, async () => ({})), /Idempotency-Key/i);
  state = "pending";
  await assert.rejects(() => service.execute({ ...base, key: "pending-key-01" }, async () => ({})), (error) => error.statusCode === 409);
  state = "started";
  await assert.rejects(() => service.execute({ ...base, key: "failed-key-001" }, async () => {
    throw new Error("operation failed");
  }), /operation failed/);
  assert.equal(abandoned, 1);
});
