"use strict";

const crypto = require("node:crypto");

const DEAD_LETTER_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

class WebhookDispatcher {
  constructor({
    storage,
    endpoint,
    secret,
    fetchImpl = fetch,
    now = () => new Date(),
    idFactory = () => crypto.randomUUID(),
  } = {}) {
    if (!storage) throw new TypeError("Webhook storage is required");
    if (new URL(endpoint).protocol !== "https:") throw new TypeError("Webhook endpoint must use HTTPS");
    if (typeof secret !== "string" || secret.length === 0) throw new TypeError("Webhook secret is required");
    this.storage = storage;
    this.endpoint = endpoint;
    this.secret = secret;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.idFactory = idFactory;
  }

  enqueue(eventType, payload) {
    const createdAt = this.now().toISOString();
    return this.storage.enqueueWebhook({
      id: this.idFactory(),
      eventType,
      payload,
      state: "pending",
      attempts: 0,
      nextAttemptAt: createdAt,
      createdAt,
      lastError: null,
    });
  }

  async processDue() {
    const now = this.now();
    const due = this.storage.listDueWebhooks({ now: now.toISOString() });
    for (const job of due) await this.#deliver(job, now);
    return due.length;
  }

  retry(id) {
    return this.storage.updateWebhook(id, {
      state: "pending",
      attempts: 0,
      nextAttemptAt: this.now().toISOString(),
      lastError: null,
    });
  }

  async #deliver(job, now) {
    const body = JSON.stringify({
      id: job.id,
      eventType: job.eventType,
      createdAt: job.createdAt,
      payload: job.payload,
    });
    const signature = crypto.createHmac("sha256", this.secret).update(body).digest("hex");
    const attempts = job.attempts + 1;
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-s12-event-id": job.id,
          "x-s12-signature": `sha256=${signature}`,
          "x-s12-timestamp": now.toISOString(),
        },
        body,
      });
      if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
      this.storage.updateWebhook(job.id, {
        state: "delivered",
        attempts,
        deliveredAt: now.toISOString(),
        lastError: null,
      });
    } catch (error) {
      const expired = now.getTime() - Date.parse(job.createdAt) >= DEAD_LETTER_AFTER_MS;
      const delay = Math.min(60_000 * (2 ** Math.max(0, attempts - 1)), MAX_RETRY_DELAY_MS);
      this.storage.updateWebhook(job.id, {
        state: expired ? "dead-letter" : "pending",
        attempts,
        nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
        lastError: error.message,
      });
    }
  }
}

module.exports = { DEAD_LETTER_AFTER_MS, MAX_RETRY_DELAY_MS, WebhookDispatcher };
