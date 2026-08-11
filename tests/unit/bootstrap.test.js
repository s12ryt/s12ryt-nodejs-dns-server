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
  launch,
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

test("bootstrap downloads and verifies an HTTPS runtime without replacing the active cache", async (t) => {
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
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "pending.json"), "utf8")), {
    version: "0.1.0",
    sha256: manifest.runtime.sha256,
    file: `runtime-0.1.0-${manifest.runtime.sha256.slice(0, 12)}.cjs`,
    nativeBinding: {
      key: bindingKey,
      sha256: manifest.nativeBindings[bindingKey].sha256,
      file: `better-sqlite3-${bindingKey}-${manifest.nativeBindings[bindingKey].sha256.slice(0, 12)}.node`,
    },
  });
  await assert.rejects(fs.access(path.join(directory, "active.json")), /ENOENT/);
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
});

test("launch promotes a downloaded candidate only after it starts successfully", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-bootstrap-launch-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const runtime = Buffer.from("candidate");
  const nativeBinding = Buffer.from("candidate-binding");
  const bindingKey = nativeBindingKey();
  const manifest = {
    version: "1.0.0",
    runtime: { url: "https://downloads.example/runtime.cjs", sha256: sha256(runtime) },
    nativeBindings: {
      [bindingKey]: { url: "https://downloads.example/runtime.node", sha256: sha256(nativeBinding) },
    },
  };
  const application = { close: async () => {} };

  const result = await launch({
    directory,
    localEntry: "missing-local-entry",
    fetchImpl: async (url) => url === DEFAULT_MANIFEST_URL
      ? response(manifest, { json: true })
      : response(url === manifest.runtime.url ? runtime : nativeBinding),
    requireImpl: () => ({ start: async () => application }),
    fallbackStart: async () => assert.fail("fallback must not start"),
  });

  assert.equal(result, application);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, "active.json"), "utf8")).version, "1.0.0");
  await assert.rejects(fs.access(path.join(directory, "pending.json")), /ENOENT/);
});

test("launch records a failed candidate and starts the previous verified active runtime", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-bootstrap-rollback-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bindingKey = nativeBindingKey();
  const bindingFile = `better-sqlite3-${bindingKey}.node`;
  const activeRuntime = Buffer.from("active-runtime");
  const activeBinding = Buffer.from("active-binding");
  await fs.writeFile(path.join(directory, "runtime-0.4.0.cjs"), activeRuntime);
  await fs.writeFile(path.join(directory, bindingFile), activeBinding);
  await fs.writeFile(path.join(directory, "active.json"), JSON.stringify({
    version: "0.4.0",
    sha256: sha256(activeRuntime),
    file: "runtime-0.4.0.cjs",
    nativeBinding: { key: bindingKey, sha256: sha256(activeBinding), file: bindingFile },
  }));
  const candidateRuntime = Buffer.from("candidate-runtime");
  const candidateBinding = Buffer.from("candidate-binding");
  const manifest = {
    version: "1.0.0",
    runtime: { url: "https://downloads.example/runtime.cjs", sha256: sha256(candidateRuntime) },
    nativeBindings: {
      [bindingKey]: { url: "https://downloads.example/runtime.node", sha256: sha256(candidateBinding) },
    },
  };
  const activeApplication = { mode: "active", close: async () => {} };

  const result = await launch({
    directory,
    localEntry: "missing-local-entry",
    fetchImpl: async (url) => url === DEFAULT_MANIFEST_URL
      ? response(manifest, { json: true })
      : response(url === manifest.runtime.url ? candidateRuntime : candidateBinding),
    requireImpl: (file) => file.includes(`runtime-1.0.0-${sha256(candidateRuntime).slice(0, 12)}`)
      ? { start: async () => { throw new Error("candidate start failed with secret-token"); } }
      : { start: async () => activeApplication },
    fallbackStart: async () => assert.fail("verified active runtime must be used"),
  });

  assert.equal(result, activeApplication);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, "active.json"), "utf8")).version, "0.4.0");
  const failed = JSON.parse(await fs.readFile(path.join(directory, "failed.json"), "utf8"));
  assert.equal(failed.version, "1.0.0");
  assert.match(failed.message, /candidate runtime failed/i);
  assert.doesNotMatch(failed.message, /secret-token/);
  await assert.rejects(fs.access(path.join(directory, "pending.json")), /ENOENT/);
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
