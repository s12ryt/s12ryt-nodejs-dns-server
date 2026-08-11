"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_MANIFEST_URL,
  installShutdownHandlers,
  nativeBindingKey,
  resolveDownloadedRuntime,
} = require("../../index");

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
  const nativeBinding = Buffer.from("native-binding");
  const bindingKey = nativeBindingKey();
  const manifest = {
    version: "0.1.0",
    runtime: { url: "https://downloads.example/runtime.cjs", sha256: sha256(runtime) },
    nativeBindings: {
      [bindingKey]: { url: `https://downloads.example/${bindingKey}.node`, sha256: sha256(nativeBinding) },
    },
  };
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url === DEFAULT_MANIFEST_URL) return response(manifest, { json: true });
    return response(url === manifest.runtime.url ? runtime : nativeBinding);
  };

  const result = await resolveDownloadedRuntime({ directory, fetchImpl });

  assert.equal(result.version, "0.1.0");
  assert.equal(await fs.readFile(result.path, "utf8"), runtime.toString());
  assert.deepEqual(await fs.readFile(result.nativeBindingPath), nativeBinding);
  assert.deepEqual(requested, [DEFAULT_MANIFEST_URL, manifest.runtime.url, manifest.nativeBindings[bindingKey].url]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "active.json"), "utf8")), {
    version: "0.1.0",
    sha256: manifest.runtime.sha256,
    file: "runtime-0.1.0.cjs",
    nativeBinding: {
      key: bindingKey,
      sha256: manifest.nativeBindings[bindingKey].sha256,
      file: `better-sqlite3-${bindingKey}.node`,
    },
  });
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
});

test("bootstrap rejects an invalid download and falls back to the last verified cache", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-bootstrap-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const runtime = Buffer.from("module.exports = {};\n");
  const nativeBinding = Buffer.from("cached-native-binding");
  const digest = sha256(runtime);
  const bindingKey = nativeBindingKey();
  const bindingFile = `better-sqlite3-${bindingKey}.node`;
  await fs.writeFile(path.join(directory, "runtime-1.0.0.cjs"), runtime);
  await fs.writeFile(path.join(directory, bindingFile), nativeBinding);
  await fs.writeFile(path.join(directory, "active.json"), JSON.stringify({
    version: "1.0.0", sha256: digest, file: "runtime-1.0.0.cjs",
    nativeBinding: { key: bindingKey, sha256: sha256(nativeBinding), file: bindingFile },
  }));

  const cached = await resolveDownloadedRuntime({
    directory,
    fetchImpl: async () => { throw new Error("network unavailable"); },
  });
  assert.equal(cached.source, "cache");
  assert.equal(cached.version, "1.0.0");
  assert.equal(cached.nativeBindingPath, path.join(directory, bindingFile));

  await fs.writeFile(cached.nativeBindingPath, "corrupt");
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
        nativeBindings: {},
      }, { json: true }),
    }),
    /manifest|version|HTTPS/i,
  );
});

test("bootstrap does not use a runtime without a compatible verified native binding", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-bootstrap-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const runtime = Buffer.from("module.exports = {};\n");
  const manifest = {
    version: "2.0.0",
    runtime: { url: "https://downloads.example/runtime.cjs", sha256: sha256(runtime) },
    nativeBindings: {
      "node-v999-linux-x64": { url: "https://downloads.example/other.node", sha256: "0".repeat(64) },
    },
  };

  const result = await resolveDownloadedRuntime({
    directory,
    fetchImpl: async (url) => url === DEFAULT_MANIFEST_URL
      ? response(manifest, { json: true })
      : response(runtime),
  });

  assert.equal(result, null);
  await assert.rejects(fs.access(path.join(directory, "active.json")), /ENOENT/);
});

test("bootstrap waits for one graceful close when SIGTERM or SIGINT is received", async () => {
  const processRef = new EventEmitter();
  processRef.exitCode = undefined;
  let closes = 0;
  let releaseClose;
  const closed = new Promise((resolve) => { releaseClose = resolve; });
  const application = {
    async close() {
      closes += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      releaseClose();
    },
  };

  const removeHandlers = installShutdownHandlers(application, { processRef });
  processRef.emit("SIGTERM");
  processRef.emit("SIGINT");
  await closed;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closes, 1);
  assert.equal(processRef.exitCode, 0);
  removeHandlers();
  assert.equal(processRef.listenerCount("SIGTERM"), 0);
  assert.equal(processRef.listenerCount("SIGINT"), 0);
});
