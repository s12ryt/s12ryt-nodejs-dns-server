"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_PATTERN = /^operations-(\d{4}-\d{2}-\d{2})\.jsonl$/;

class StructuredLogger {
  constructor({ directory, retentionDays = 30, now = () => new Date() } = {}) {
    if (!directory) throw new TypeError("Log directory is required");
    if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new RangeError("Log retention is invalid");
    this.directory = directory;
    this.retentionDays = retentionDays;
    this.now = now;
    this.queue = Promise.resolve();
    this.lastPrunedDate = null;
  }

  write(event) {
    this.queue = this.queue.then(async () => {
      const timestamp = event.timestamp ? new Date(event.timestamp) : this.now();
      if (Number.isNaN(timestamp.getTime())) throw new TypeError("Log timestamp is invalid");
      const date = timestamp.toISOString().slice(0, 10);
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (this.lastPrunedDate !== date) {
        await this.#prune(timestamp);
        this.lastPrunedDate = date;
      }
      const filePath = path.join(this.directory, `operations-${date}.jsonl`);
      await fs.appendFile(filePath, `${JSON.stringify({ ...event, timestamp: timestamp.toISOString() })}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.chmod(filePath, 0o600).catch(() => {});
    });
    return this.queue;
  }

  close() {
    return this.queue;
  }

  async #prune(now) {
    const cutoff = now.getTime() - this.retentionDays * DAY_MS;
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile()) return;
      const match = LOG_PATTERN.exec(entry.name);
      if (!match) return;
      const fileTime = Date.parse(`${match[1]}T00:00:00.000Z`);
      if (fileTime < cutoff) await fs.rm(path.join(this.directory, entry.name), { force: true });
    }));
  }
}

module.exports = { DAY_MS, StructuredLogger };
