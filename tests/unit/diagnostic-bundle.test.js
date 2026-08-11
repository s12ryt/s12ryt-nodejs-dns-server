"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const yauzl = require("yauzl");

const { DiagnosticBundle } = require("../../src/diagnostics/bundle");

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, strictFileNames: true },
      (error, zipFile) => error ? reject(error) : resolve(zipFile));
  });
}

function readEntry(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.once("error", reject);
      stream.once("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function readZip(filePath) {
  const zipFile = await openZip(filePath);
  const entries = {};
  try {
    return await new Promise((resolve, reject) => {
      zipFile.once("error", reject);
      zipFile.once("end", () => resolve(entries));
      zipFile.on("entry", async (entry) => {
        try {
          entries[entry.fileName] = await readEntry(zipFile, entry);
          zipFile.readEntry();
        } catch (error) {
          reject(error);
        }
      });
      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }
}

test("diagnostic bundle contains bounded verified diagnostics without secrets", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-diagnostic-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "logs"), { recursive: true });
  await fs.mkdir(path.join(directory, "backups"), { recursive: true });
  await fs.writeFile(path.join(directory, "operations.sqlite"), "database-secret");
  await fs.writeFile(path.join(directory, "backups", "s12-manual.zip"), "backup-secret");
  await fs.writeFile(path.join(directory, "logs", "operations-2026-08-12.jsonl"), [
    JSON.stringify({ kind: "dns", qname: "old.example", token: "old-token", sequence: 1 }),
    JSON.stringify({ kind: "proxy", url: "/private", authorization: "Bearer log-secret", sequence: 2 }),
    JSON.stringify({ kind: "dns", qname: "recent.example", sequence: 3 }),
    "",
  ].join("\n"));

  const bundle = new DiagnosticBundle({
    directory,
    applicationVersion: "1.0.0",
    now: () => new Date("2026-08-12T04:05:06.000Z"),
    platform: { platform: "linux", arch: "x64", node: "v20.19.0", abi: "115" },
    getConfig: () => ({
      schemaVersion: 3,
      tunnel: { token: "tunnel-secret" },
      observability: { webhook: { secret: "webhook-secret", url: "https://alerts.example" } },
      domains: [{ name: "example.test", enabled: true }],
    }),
    getRuntime: () => ({ source: "active", version: "1.0.0", sha256: "a".repeat(64), nativeBindingKey: "node-v115-linux-x64" }),
    getStatus: () => ({ services: { dns: { port: 5354 } }, tunnel: { state: "running", token: "runtime-secret" } }),
    getStorage: () => ({ schemaVersion: 6, integrity: "ok" }),
    getAuditVerification: () => ({ valid: true, entries: 12, brokenAt: null }),
    getEvents: () => Array.from({ length: 120 }, (_, index) => ({
      kind: "event",
      message: `event-${index}`,
      cookie: index === 119 ? "session-secret" : undefined,
    })),
    maxEvents: 50,
    maxLogLines: 2,
  });

  const result = await bundle.create();
  assert.equal(result.fileName, "s12-diagnostic-20260812T040506Z.zip");
  assert.equal(result.size > 0, true);
  const entries = await readZip(result.path);
  assert.deepEqual(Object.keys(entries).sort(), [
    "config.json",
    "events.json",
    "logs/operations-2026-08-12.tail.jsonl",
    "manifest.json",
    "system.json",
  ]);

  const manifest = JSON.parse(entries["manifest.json"].toString("utf8"));
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.applicationVersion, "1.0.0");
  assert.equal(manifest.files.length, 4);
  for (const descriptor of manifest.files) {
    const content = entries[descriptor.path];
    assert.equal(descriptor.size, content.length);
    assert.equal(descriptor.sha256, crypto.createHash("sha256").update(content).digest("hex"));
  }

  const config = JSON.parse(entries["config.json"].toString("utf8"));
  assert.equal(config.tunnel.token, "[redacted]");
  assert.equal(config.observability.webhook.secret, "[redacted]");
  assert.equal(config.domains[0].name, "example.test");
  const system = JSON.parse(entries["system.json"].toString("utf8"));
  assert.deepEqual(system.audit, { valid: true, entries: 12, brokenAt: null });
  assert.equal(system.status.tunnel.token, "[redacted]");
  const events = JSON.parse(entries["events.json"].toString("utf8"));
  assert.equal(events.length, 50);
  assert.equal(events[49].cookie, "[redacted]");
  const logTail = entries["logs/operations-2026-08-12.tail.jsonl"].toString("utf8");
  assert.doesNotMatch(logTail, /old\.example|old-token|log-secret|session-secret|tunnel-secret|webhook-secret|database-secret|backup-secret/);
  assert.match(logTail, /recent\.example/);
  assert.match(logTail, /\[redacted\]/);
  assert.equal(Object.keys(entries).some((name) => /sqlite|backup/i.test(name)), false);
  if (process.platform !== "win32") assert.equal((await fs.stat(result.path)).mode & 0o777, 0o600);
});
