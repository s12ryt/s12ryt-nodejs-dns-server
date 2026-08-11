"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { RecoveryManager } = require("../../src/recovery/manager");

test("recovery manager persists owner-only operation markers and rejects overlap", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-recovery-marker-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manager = new RecoveryManager({
    directory,
    now: () => new Date("2026-08-12T10:00:00.000Z"),
    processId: 4242,
  });

  const marker = await manager.begin("startup");
  assert.deepEqual(marker, {
    formatVersion: 1,
    operation: "startup",
    startedAt: "2026-08-12T10:00:00.000Z",
    processId: 4242,
  });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "recovery", "operation.json"), "utf8")), marker);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(path.join(directory, "recovery", "operation.json"))).mode & 0o777, 0o600);
  }
  await assert.rejects(manager.begin("restore"), /already in progress/i);
  await manager.complete("startup");
  await assert.rejects(fs.access(path.join(directory, "recovery", "operation.json")));
  await manager.complete("startup");
});

test("recovery manager reports an interrupted operation and removes only managed temporary artifacts", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-recovery-cleanup-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "recovery"), { recursive: true });
  await fs.mkdir(path.join(directory, "backups"), { recursive: true });
  await fs.mkdir(path.join(directory, "runtime"), { recursive: true });
  await fs.mkdir(path.join(directory, ".restore-abandoned"));
  await fs.mkdir(path.join(directory, ".rollback-abandoned"));
  await fs.writeFile(path.join(directory, "config.json.99.deadbeefcafe.tmp"), "partial");
  await fs.writeFile(path.join(directory, "backups", ".s12-upload.zip.99.deadbeefcafe.tmp-upload"), "partial");
  await fs.writeFile(path.join(directory, "runtime", "active.json.99.deadbeefcafe.tmp"), "partial");
  await fs.writeFile(path.join(directory, "config.json"), "stable-config");
  await fs.writeFile(path.join(directory, "backups", "s12-manual-20260812T030000Z.zip"), "stable-backup");
  await fs.writeFile(path.join(directory, "runtime", "active.json"), "stable-runtime");
  await fs.writeFile(path.join(directory, ".unmanaged"), "preserve");
  await fs.writeFile(path.join(directory, "recovery", "operation.json"), JSON.stringify({
    formatVersion: 1,
    operation: "restore",
    startedAt: "2026-08-12T09:00:00.000Z",
    processId: 99,
  }));

  const manager = new RecoveryManager({
    directory,
    now: () => new Date("2026-08-12T10:00:00.000Z"),
    processId: 4242,
  });
  const report = await manager.recover();

  assert.equal(report.recovered, true);
  assert.equal(report.interrupted.operation, "restore");
  assert.equal(report.completedAt, "2026-08-12T10:00:00.000Z");
  assert.deepEqual(report.removed.sort(), [
    ".restore-abandoned",
    ".rollback-abandoned",
    "backups/.s12-upload.zip.99.deadbeefcafe.tmp-upload",
    "config.json.99.deadbeefcafe.tmp",
    "runtime/active.json.99.deadbeefcafe.tmp",
  ].sort());
  for (const stable of [
    "config.json",
    "backups/s12-manual-20260812T030000Z.zip",
    "runtime/active.json",
    ".unmanaged",
  ]) {
    assert.equal((await fs.readFile(path.join(directory, ...stable.split("/")), "utf8")).startsWith("stable") || stable === ".unmanaged", true);
  }
  await assert.rejects(fs.access(path.join(directory, "recovery", "operation.json")));
  assert.deepEqual(await manager.recover(), { recovered: false, interrupted: null, removed: [] });
});
