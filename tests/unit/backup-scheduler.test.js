"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { BackupScheduler, nextLocalRun } = require("../../src/backup/scheduler");

test("backup scheduler plans local 03:00 and releases the timer on close", () => {
  const monday = new Date(2026, 7, 10, 2, 30, 0, 0);
  const scheduled = [];
  const cancelled = [];
  const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const scheduler = new BackupScheduler({
    manager: { create: async () => {}, prune: async () => {} },
    now: () => monday,
    schedule(callback, delay) {
      scheduled.push({ callback, delay });
      return timer;
    },
    cancel(value) { cancelled.push(value); },
  });

  assert.equal(nextLocalRun(monday).getHours(), 3);
  assert.equal(nextLocalRun(monday).getDate(), monday.getDate());
  scheduler.start();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 30 * 60 * 1000);
  assert.equal(timer.unrefCalled, true);
  scheduler.close();
  assert.deepEqual(cancelled, [timer]);
});

test("backup scheduler pauses for maintenance and resumes until final close", () => {
  const scheduled = [];
  const cancelled = [];
  const scheduler = new BackupScheduler({
    manager: { create: async () => {}, prune: async () => {} },
    schedule(callback, delay) {
      const timer = { callback, delay, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    cancel(timer) { cancelled.push(timer); },
  });

  scheduler.start();
  scheduler.pause();
  scheduler.start();
  assert.equal(scheduled.length, 2);
  assert.deepEqual(cancelled, [scheduled[0]]);

  scheduler.close();
  assert.deepEqual(cancelled, [scheduled[0], scheduled[1]]);
  assert.throws(() => scheduler.start(), /closed/i);
});

test("backup scheduler creates daily and Sunday weekly archives with bounded retention", async () => {
  const calls = [];
  const manager = {
    async create(options) { calls.push(["create", options.kind]); },
    async prune(options) { calls.push(["prune", options.kind, options.keep]); },
  };
  const scheduler = new BackupScheduler({ manager });

  await scheduler.runNow(new Date(2026, 7, 10, 3, 0, 0));
  assert.deepEqual(calls, [["create", "daily"], ["prune", "daily", 7]]);

  calls.length = 0;
  await scheduler.runNow(new Date(2026, 7, 16, 3, 0, 0));
  assert.deepEqual(calls, [
    ["create", "daily"],
    ["prune", "daily", 7],
    ["create", "weekly"],
    ["prune", "weekly", 4],
  ]);
});

test("backup scheduler prevents overlapping scheduled runs", async () => {
  let release;
  let creates = 0;
  const manager = {
    async create() {
      creates += 1;
      await new Promise((resolve) => { release = resolve; });
    },
    async prune() {},
  };
  const scheduler = new BackupScheduler({ manager });
  const first = scheduler.runNow(new Date(2026, 7, 10, 3));
  const second = scheduler.runNow(new Date(2026, 7, 10, 3));
  assert.equal(await second, false);
  assert.equal(creates, 1);
  release();
  assert.equal(await first, true);
});
