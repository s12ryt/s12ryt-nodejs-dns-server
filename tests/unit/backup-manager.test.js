"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");

const yazl = require("yazl");

const { BackupManager } = require("../../src/backup/manager");

function writeArchive(filePath, entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, value] of entries) zip.addBuffer(Buffer.from(value), name);
    const output = require("node:fs").createWriteStream(filePath);
    zip.outputStream.once("error", reject);
    output.once("error", reject);
    output.once("close", resolve);
    zip.outputStream.pipe(output);
    zip.end();
  });
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-backup-"));
  const databaseSource = path.join(directory, "database-source.sqlite");
  await fs.mkdir(path.join(directory, "logs"), { recursive: true });
  await fs.mkdir(path.join(directory, "proxy-cache"), { recursive: true });
  await fs.mkdir(path.join(directory, "runtime"), { recursive: true });
  await fs.mkdir(path.join(directory, "backups"), { recursive: true });
  await fs.writeFile(path.join(directory, "config.json"), '{"schemaVersion":1,"tunnel":{"token":"stored-secret"}}');
  await fs.writeFile(path.join(directory, "admin.json"), '{"username":"admin","passwordHash":"sensitive"}');
  await fs.writeFile(path.join(directory, "logs", "operations-2026-08-11.jsonl"), '{"qname":"private.test"}\n');
  await fs.writeFile(path.join(directory, "proxy-cache", "cached.body"), "excluded cache");
  await fs.writeFile(path.join(directory, "runtime", "active.json"), "excluded runtime");
  await fs.writeFile(path.join(directory, "backups", "older.zip"), "excluded backup");
  await fs.writeFile(databaseSource, "sqlite backup bytes");
  const backupCalls = [];
  const storage = {
    status: () => ({ schemaVersion: 2 }),
    async backupTo(destination) {
      backupCalls.push(destination);
      await fs.copyFile(databaseSource, destination);
      return { totalPages: 1, remainingPages: 0 };
    },
  };
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, storage, backupCalls };
}

test("backup dry-run reports sensitive portable files without writing an archive", async (t) => {
  const { directory, storage, backupCalls } = await fixture(t);
  const manager = new BackupManager({
    directory,
    storage,
    now: () => new Date("2026-08-11T03:00:00.000Z"),
    applicationVersion: "0.2.0",
  });

  const result = await manager.create({ kind: "manual", dryRun: true });

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.files, ["admin.json", "config.json", "logs/operations-2026-08-11.jsonl", "operations.sqlite"]);
  assert.equal(backupCalls.length, 0);
  assert.deepEqual(await manager.list(), []);
});

test("backup archive has a verified manifest and excludes caches and runtime assets", async (t) => {
  const { directory, storage, backupCalls } = await fixture(t);
  const manager = new BackupManager({
    directory,
    storage,
    now: () => new Date("2026-08-11T03:00:00.000Z"),
    applicationVersion: "0.2.0",
  });

  const result = await manager.create({ kind: "manual" });
  assert.equal(result.fileName, "s12-manual-20260811T030000Z.zip");
  assert.equal(backupCalls.length, 1);
  const archive = await manager.inspect(result.path);
  assert.equal(archive.manifest.formatVersion, 1);
  assert.equal(archive.manifest.applicationVersion, "0.2.0");
  assert.equal(archive.manifest.databaseSchemaVersion, 2);
  assert.deepEqual(Object.keys(archive.files).sort(), ["admin.json", "config.json", "logs/operations-2026-08-11.jsonl", "operations.sqlite"]);
  assert.equal(archive.files["config.json"].toString().includes("stored-secret"), true);
  assert.equal(archive.files["admin.json"].toString().includes("passwordHash"), true);
  assert.equal(Object.keys(archive.files).some((name) => name.includes("proxy-cache") || name.includes("runtime") || name.includes("backups")), false);
  assert.equal((await manager.list())[0].fileName, result.fileName);
  if (process.platform !== "win32") assert.equal((await fs.stat(result.path)).mode & 0o777, 0o600);
});

test("backup import validates a bounded ZIP stream before making it available", async (t) => {
  const { directory, storage } = await fixture(t);
  const manager = new BackupManager({
    directory,
    storage,
    now: () => new Date("2026-08-11T03:00:00.000Z"),
    applicationVersion: "0.2.0",
  });
  const created = await manager.create({ kind: "manual" });
  const archive = await fs.readFile(created.path);
  await manager.delete(created.fileName);

  const fileName = "s12-upload-20260811T031500Z.zip";
  const imported = await manager.importArchive(Readable.from(archive), { fileName });
  assert.equal(imported.fileName, fileName);
  assert.equal((await manager.inspect(imported.path)).manifest.applicationVersion, "0.2.0");
  assert.equal((await manager.list())[0].fileName, fileName);

  const limited = new BackupManager({ directory, storage, maxArchiveBytes: 8 });
  await assert.rejects(
    limited.importArchive(Readable.from(Buffer.alloc(9)), { fileName: "s12-upload-20260811T032000Z.zip" }),
    /too large/i,
  );
  await assert.rejects(
    manager.importArchive(Readable.from(Buffer.from("not a zip")), { fileName: "s12-upload-20260811T032500Z.zip" }),
    /zip|archive/i,
  );
  assert.equal((await fs.readdir(path.join(directory, "backups"))).some((name) => name.includes(".tmp-")), false);
});

test("backup inspection rejects untrusted manifests before restore", async (t) => {
  const { directory, storage } = await fixture(t);
  const manager = new BackupManager({ directory, storage, applicationVersion: "0.2.0" });
  const archive = path.join(directory, "external.zip");
  const content = Buffer.from("portable config");
  const baseManifest = {
    formatVersion: 1,
    applicationVersion: "0.2.0",
    databaseSchemaVersion: 2,
    createdAt: "2026-08-11T03:00:00.000Z",
    kind: "manual",
    files: [{ path: "config.json", size: content.length, sha256: "0".repeat(64) }],
  };

  await writeArchive(archive, [["config.json", content], ["manifest.json", JSON.stringify(baseManifest)]]);
  await assert.rejects(manager.inspect(archive), /verification failed/i);

  const traversal = {
    ...baseManifest,
    files: [{ path: "../config.json", size: content.length, sha256: "0".repeat(64) }],
  };
  await writeArchive(archive, [["config.json", content], ["manifest.json", JSON.stringify(traversal)]]);
  await assert.rejects(manager.inspect(archive), /manifest file entry/i);

  const futureSchema = { ...baseManifest, databaseSchemaVersion: 999, files: [] };
  await writeArchive(archive, [["manifest.json", JSON.stringify(futureSchema)]]);
  await assert.rejects(manager.inspect(archive), /newer database schema/i);

  const noFiles = { ...baseManifest, files: [] };
  await writeArchive(archive, [["undeclared.txt", "unexpected"], ["manifest.json", JSON.stringify(noFiles)]]);
  await assert.rejects(manager.inspect(archive), /undeclared files/i);
});

test("backup inspection rejects duplicate ZIP entries", async (t) => {
  const { directory, storage } = await fixture(t);
  const manager = new BackupManager({ directory, storage });
  const archive = path.join(directory, "duplicate.zip");
  await writeArchive(archive, [
    ["config.json", "first"],
    ["config.json", "second"],
    ["manifest.json", JSON.stringify({ formatVersion: 1, databaseSchemaVersion: 2, files: [] })],
  ]);
  await assert.rejects(manager.inspect(archive), /duplicate backup entry/i);
});

test("backup restore supports validation-only and applies a verified archive in maintenance mode", async (t) => {
  const { directory, storage } = await fixture(t);
  const lifecycle = [];
  storage.close = () => lifecycle.push("close:storage");
  storage.open = () => lifecycle.push("open:storage");
  const manager = new BackupManager({
    directory,
    storage,
    now: () => new Date("2026-08-11T03:00:00.000Z"),
    applicationVersion: "0.2.0",
    maintenance: {
      enter: async () => lifecycle.push("enter:maintenance"),
      reload: async () => lifecycle.push("reload:application"),
      exit: async () => lifecycle.push("exit:maintenance"),
    },
  });
  const created = await manager.create({ kind: "manual" });
  await fs.writeFile(path.join(directory, "config.json"), '{"changed":true}');
  await fs.writeFile(path.join(directory, "admin.json"), '{"changed":true}');
  await fs.writeFile(path.join(directory, "logs", "operations-2026-08-11.jsonl"), "changed log\n");

  const dryRun = await manager.restore(created.path, { dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, "config.json"), "utf8")).changed, true);
  assert.deepEqual(lifecycle, []);

  const restored = await manager.restore(created.path);
  assert.equal(restored.restored, true);
  assert.equal((await fs.readFile(path.join(directory, "config.json"), "utf8")).includes("stored-secret"), true);
  assert.equal((await fs.readFile(path.join(directory, "admin.json"), "utf8")).includes("passwordHash"), true);
  assert.equal((await fs.readFile(path.join(directory, "logs", "operations-2026-08-11.jsonl"), "utf8")).includes("private.test"), true);
  assert.equal((await fs.readFile(path.join(directory, "operations.sqlite"), "utf8")), "sqlite backup bytes");
  assert.deepEqual(lifecycle, [
    "enter:maintenance",
    "close:storage",
    "open:storage",
    "reload:application",
    "exit:maintenance",
  ]);
});

test("backup restore rolls every file back when an atomic replacement fails", async (t) => {
  const { directory, storage } = await fixture(t);
  const sourceManager = new BackupManager({
    directory,
    storage,
    now: () => new Date("2026-08-11T03:00:00.000Z"),
    applicationVersion: "0.2.0",
  });
  const created = await sourceManager.create({ kind: "manual" });
  await fs.writeFile(path.join(directory, "config.json"), "current config");
  await fs.writeFile(path.join(directory, "admin.json"), "current admin");
  await fs.writeFile(path.join(directory, "logs", "operations-2026-08-11.jsonl"), "current log\n");
  await fs.writeFile(path.join(directory, "operations.sqlite"), "current sqlite");
  const lifecycle = [];
  let replacements = 0;
  storage.close = () => lifecycle.push("close:storage");
  storage.open = () => lifecycle.push("open:storage");
  const manager = new BackupManager({
    directory,
    storage,
    maintenance: {
      enter: async () => lifecycle.push("enter:maintenance"),
      reload: async () => lifecycle.push("reload:application"),
      exit: async () => lifecycle.push("exit:maintenance"),
    },
    replaceFile: async (source, destination) => {
      replacements += 1;
      if (replacements === 2) throw new Error("simulated replace failure");
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(source, destination);
    },
  });

  await assert.rejects(manager.restore(created.path), /simulated replace failure/);
  assert.equal(await fs.readFile(path.join(directory, "config.json"), "utf8"), "current config");
  assert.equal(await fs.readFile(path.join(directory, "admin.json"), "utf8"), "current admin");
  assert.equal(await fs.readFile(path.join(directory, "logs", "operations-2026-08-11.jsonl"), "utf8"), "current log\n");
  assert.equal(await fs.readFile(path.join(directory, "operations.sqlite"), "utf8"), "current sqlite");
  assert.deepEqual(lifecycle, [
    "enter:maintenance",
    "close:storage",
    "close:storage",
    "open:storage",
    "reload:application",
    "exit:maintenance",
  ]);
});

test("backup retention deletes only excess managed archives", async (t) => {
  const { directory, storage } = await fixture(t);
  const manager = new BackupManager({ directory, storage });
  const backupDirectory = path.join(directory, "backups");
  for (let day = 1; day <= 9; day += 1) {
    await fs.writeFile(path.join(backupDirectory, `s12-daily-202608${String(day).padStart(2, "0")}T030000Z.zip`), `daily-${day}`);
  }
  for (let week = 1; week <= 5; week += 1) {
    await fs.writeFile(path.join(backupDirectory, `s12-weekly-202607${String(week).padStart(2, "0")}T030000Z.zip`), `weekly-${week}`);
  }
  await fs.writeFile(path.join(backupDirectory, "unmanaged.zip"), "leave me");

  const daily = await manager.prune({ kind: "daily", keep: 7 });
  const weekly = await manager.prune({ kind: "weekly", keep: 4 });
  assert.equal(daily.deleted.length, 2);
  assert.equal(weekly.deleted.length, 1);
  assert.equal((await manager.list()).filter((item) => item.fileName.includes("-daily-")).length, 7);
  assert.equal((await manager.list()).filter((item) => item.fileName.includes("-weekly-")).length, 4);
  assert.equal(await fs.readFile(path.join(backupDirectory, "unmanaged.zip"), "utf8"), "leave me");
  await assert.rejects(manager.delete("../config.json"), /invalid backup file/i);
});
