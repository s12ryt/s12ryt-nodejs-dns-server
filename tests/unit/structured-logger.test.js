"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { StructuredLogger } = require("../../src/observability/structured-logger");

test("structured logger preserves sensitive operational fields in daily owner-only JSON lines", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-logs-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = new Date("2026-08-11T23:59:59.000Z");
  const logger = new StructuredLogger({ directory, now: () => now, retentionDays: 30 });

  await logger.write({ kind: "dns", clientIp: "192.0.2.5", name: "private.example", type: "A" });
  now = new Date("2026-08-12T00:00:01.000Z");
  await logger.write({ kind: "proxy", clientIp: "192.0.2.6", url: "/secret?token=value", statusCode: 200 });
  await logger.close();

  const first = JSON.parse((await fs.readFile(path.join(directory, "operations-2026-08-11.jsonl"), "utf8")).trim());
  const second = JSON.parse((await fs.readFile(path.join(directory, "operations-2026-08-12.jsonl"), "utf8")).trim());
  assert.equal(first.name, "private.example");
  assert.equal(first.clientIp, "192.0.2.5");
  assert.equal(second.url, "/secret?token=value");
  assert.equal(second.timestamp, "2026-08-12T00:00:01.000Z");
  if (process.platform !== "win32") {
    const mode = (await fs.stat(path.join(directory, "operations-2026-08-12.jsonl"))).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test("structured logger removes daily files older than its retention window", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-logs-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "operations-2026-07-01.jsonl"), "old\n");
  await fs.writeFile(path.join(directory, "operations-2026-08-01.jsonl"), "kept\n");
  const logger = new StructuredLogger({
    directory,
    now: () => new Date("2026-08-11T00:00:00.000Z"),
    retentionDays: 30,
  });

  await logger.write({ kind: "system", message: "started" });
  await logger.close();

  await assert.rejects(fs.access(path.join(directory, "operations-2026-07-01.jsonl")), /ENOENT/);
  await fs.access(path.join(directory, "operations-2026-08-01.jsonl"));
});
