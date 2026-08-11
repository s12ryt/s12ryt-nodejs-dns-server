"use strict";

const DAILY_RETENTION = 7;
const WEEKLY_RETENTION = 4;

function nextLocalRun(now = new Date()) {
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

class BackupScheduler {
  constructor({
    manager,
    now = () => new Date(),
    schedule = setTimeout,
    cancel = clearTimeout,
    onError = () => {},
  } = {}) {
    if (!manager || typeof manager.create !== "function" || typeof manager.prune !== "function") {
      throw new TypeError("Backup manager is required");
    }
    this.manager = manager;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.onError = onError;
    this.timer = null;
    this.running = false;
    this.closed = false;
  }

  start() {
    if (this.closed) throw new Error("Backup scheduler is closed");
    if (!this.timer) this.#scheduleNext();
  }

  async runNow(at = this.now()) {
    if (this.running) return false;
    this.running = true;
    try {
      await this.manager.create({ kind: "daily" });
      await this.manager.prune({ kind: "daily", keep: DAILY_RETENTION });
      if (at.getDay() === 0) {
        await this.manager.create({ kind: "weekly" });
        await this.manager.prune({ kind: "weekly", keep: WEEKLY_RETENTION });
      }
      return true;
    } finally {
      this.running = false;
    }
  }

  pause() {
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
  }

  close() {
    this.pause();
    this.closed = true;
  }

  #scheduleNext() {
    const current = this.now();
    const delay = Math.max(0, nextLocalRun(current).getTime() - current.getTime());
    this.timer = this.schedule(async () => {
      this.timer = null;
      try {
        await this.runNow(this.now());
      } catch (error) {
        this.onError(error);
      } finally {
        if (!this.closed) this.#scheduleNext();
      }
    }, delay);
    this.timer?.unref?.();
  }
}

module.exports = {
  BackupScheduler,
  DAILY_RETENTION,
  WEEKLY_RETENTION,
  nextLocalRun,
};
