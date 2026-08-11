"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const { WebhookDispatcher } = require("../../src/observability/webhook-dispatcher");

function repository(jobs = []) {
  return {
    jobs,
    enqueueWebhook(job) { this.jobs.push({ ...job }); return { ...job }; },
    listDueWebhooks() { return this.jobs.filter((job) => job.state === "pending").map((job) => ({ ...job })); },
    updateWebhook(id, patch) {
      const job = this.jobs.find((candidate) => candidate.id === id);
      Object.assign(job, patch);
      return { ...job };
    },
  };
}

test("webhook dispatcher persists unique events and sends an HMAC signed payload", async () => {
  const storage = repository();
  const requests = [];
  const now = () => new Date("2026-08-11T12:00:00.000Z");
  const dispatcher = new WebhookDispatcher({
    storage,
    endpoint: "https://hooks.example.test/events",
    secret: "owner-secret",
    now,
    idFactory: () => "event-1",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 204 };
    },
  });

  const queued = dispatcher.enqueue("upstream.down", { upstream: "Cloudflare" });
  assert.equal(queued.id, "event-1");
  assert.equal(storage.jobs[0].state, "pending");
  await dispatcher.processDue();

  const body = requests[0].options.body;
  const expected = crypto.createHmac("sha256", "owner-secret").update(body).digest("hex");
  assert.equal(requests[0].url, "https://hooks.example.test/events");
  assert.equal(requests[0].options.headers["x-s12-event-id"], "event-1");
  assert.equal(requests[0].options.headers["x-s12-signature"], `sha256=${expected}`);
  assert.equal(storage.jobs[0].state, "delivered");
  assert.equal(storage.jobs[0].attempts, 1);
});

test("webhook dispatcher applies exponential retry for 24 hours then dead-letters", async () => {
  let timestamp = Date.parse("2026-08-11T00:00:00.000Z");
  const storage = repository();
  const dispatcher = new WebhookDispatcher({
    storage,
    endpoint: "https://hooks.example.test/events",
    secret: "secret",
    now: () => new Date(timestamp),
    idFactory: () => "event-2",
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  dispatcher.enqueue("storage.failure", { message: "disk full" });

  await dispatcher.processDue();
  assert.equal(storage.jobs[0].state, "pending");
  assert.equal(storage.jobs[0].attempts, 1);
  assert.equal(storage.jobs[0].nextAttemptAt, "2026-08-11T00:01:00.000Z");

  timestamp = Date.parse("2026-08-12T00:00:01.000Z");
  storage.jobs[0].nextAttemptAt = new Date(timestamp).toISOString();
  await dispatcher.processDue();
  assert.equal(storage.jobs[0].state, "dead-letter");
  assert.match(storage.jobs[0].lastError, /503/);

  dispatcher.retry("event-2");
  assert.equal(storage.jobs[0].state, "pending");
  assert.equal(storage.jobs[0].attempts, 0);
});
