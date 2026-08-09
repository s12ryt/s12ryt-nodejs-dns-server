"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { DEFAULT_MANIFEST_URL, resolveDownloadedRuntime } = require("../../index");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function response(body, { json = false } = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    arrayBuffer: async () => json ? Buffer.from(JSON.stringify(body)) : Buffer.from(body),
  };
}

test("bootstrap downloads an HTTPS runtime, verifies SHA-256 and records an atomic active cache", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-bootstrap-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const runtime = Buffer.from("module.exports = { start: async () => 'started' };\n");
  const manifest = {
    version: "0.1.0",
    runtime: { url: "https://downloads.example/runtime.cjs", sha256: sha256(runtime) },
  };
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    return url === DEFAULT_MANIFEST_URL ? response(manifest, { json: true }) : response(runtime);
  };

  const result = await resolveDownloadedRuntime({ directory, fetchImpl });

  assert.equal(result.version, "0.1.0");
  assert.equal(await fs.readFile(result.path, "utf8"), runtime.toString());
  assert.deepEqual(requested, [DEFAULT_MANIFEST_URL, manifest.runtime.url]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "active.json"), "utf8")), {
    version: "0.1.0",
    sha256: manifest.runtime.sha256,
    file: "runtime-0.1.0.cjs",
  });
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
});

test("bootstrap rejects an invalid download and falls back to the last verified cache", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-bootstrap-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const runtime = Buffer.from("module.exports = {};\n");
  const digest = sha256(runtime);
  await fs.writeFile(path.join(directory, "runtime-1.0.0.cjs"), runtime);
  await fs.writeFile(path.join(directory, "active.json"), JSON.stringify({
    version: "1.0.0", sha256: digest, file: "runtime-1.0.0.cjs",
  }));

  const cached = await resolveDownloadedRuntime({
    directory,
    fetchImpl: async () => { throw new Error("network unavailable"); },
  });
  assert.equal(cached.source, "cache");
  assert.equal(cached.version, "1.0.0");

  await fs.writeFile(cached.path, "corrupt");
  assert.equal(await resolveDownloadedRuntime({
    directory,
    fetchImpl: async () => { throw new Error("network unavailable"); },
  }), null);
});

test("bootstrap rejects non-HTTPS manifests, runtime URLs and malformed versions", async () => {
  await assert.rejects(
    resolveDownloadedRuntime({ manifestUrl: "http://example.test/manifest.json" }),
    /HTTPS/i,
  );
  await assert.rejects(
    resolveDownloadedRuntime({
      fetchImpl: async () => response({
        version: "../escape",
        runtime: { url: "http://example.test/runtime.cjs", sha256: "0".repeat(64) },
      }, { json: true }),
    }),
    /manifest|version|HTTPS/i,
  );
});
