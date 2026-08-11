"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const { buildRelease } = require("../../scripts/build");
const { NATIVE_TARGETS } = require("../../scripts/native-bindings");
const { DEFAULT_CONFIG } = require("../../src/admin/config-store");
const { nativeBindingKey } = require("../../index");

const execFileAsync = promisify(execFile);

test("release build emits a loadable runtime, standalone bootstrap and verified manifest", async (t) => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-build-"));
  t.after(() => fs.rm(outputDirectory, { recursive: true, force: true }));

  const result = await buildRelease({
    projectDirectory: path.resolve(__dirname, "../.."),
    outputDirectory,
  });
  const runtime = await fs.readFile(path.join(outputDirectory, "runtime.cjs"));
  const bootstrap = await fs.readFile(path.join(outputDirectory, "index.js"), "utf8");
  const manifest = JSON.parse(await fs.readFile(path.join(outputDirectory, "manifest.json"), "utf8"));

  assert.match(bootstrap, /DEFAULT_MANIFEST_URL/);
  assert.equal(manifest.version, "1.0.0");
  assert.equal(
    manifest.runtime.url,
    "https://github.com/s12ryt/s12ryt-nodejs-dns-server/releases/download/v1.0.0/runtime.cjs",
  );
  assert.equal(manifest.runtime.sha256, crypto.createHash("sha256").update(runtime).digest("hex"));
  assert.equal(result.runtimeSha256, manifest.runtime.sha256);
  const bindingKey = nativeBindingKey();
  const nativeAsset = manifest.nativeBindings[bindingKey];
  assert.equal(nativeAsset.url, `https://github.com/s12ryt/s12ryt-nodejs-dns-server/releases/download/v1.0.0/better-sqlite3-${bindingKey}.node`);
  const nativeBinding = await fs.readFile(path.join(outputDirectory, `better-sqlite3-${bindingKey}.node`));
  assert.equal(nativeAsset.sha256, crypto.createHash("sha256").update(nativeBinding).digest("hex"));

  const dataDirectory = path.join(outputDirectory, "data");
  await fs.mkdir(dataDirectory);
  await fs.writeFile(path.join(dataDirectory, "config.json"), JSON.stringify({
    ...structuredClone(DEFAULT_CONFIG),
    dns: { host: "127.0.0.1", port: 0 },
    doh: { host: "127.0.0.1", port: 0 },
    proxy: { host: "127.0.0.1", port: 0, timeoutMs: 30000 },
    admin: { host: "127.0.0.1", port: 0 },
  }));
  const childScript = `
    const runtime = require(process.argv[1]);
    (async () => {
      if (typeof runtime.start !== "function") throw new Error("Runtime start export is missing");
      const application = await runtime.start({
        directory: process.argv[2],
        output: () => {},
        tunnel: {
          status: () => ({ available: false, state: "stopped", logs: [] }),
          start: async () => {},
          stop: async () => {},
        },
      });
      try {
        const admin = application.status().services.admin;
        const page = await fetch("http://127.0.0.1:" + admin.port + "/");
        const body = await page.text();
        if (page.status !== 200 || !body.includes("S12 DNS Server")) {
          throw new Error("Built administration UI did not respond correctly");
        }
      } finally {
        await application.close();
      }
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  await execFileAsync(process.execPath, ["-e", childScript, path.join(outputDirectory, "runtime.cjs"), dataDirectory], {
    timeout: 30_000,
  });
});

test("production release build includes every supported Linux native binding", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "s12-production-build-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nativeBindingsDirectory = path.join(root, "native");
  const outputDirectory = path.join(root, "dist");
  await fs.mkdir(nativeBindingsDirectory);
  for (const target of NATIVE_TARGETS) {
    await fs.writeFile(
      path.join(nativeBindingsDirectory, `better-sqlite3-${target.key}.node`),
      Buffer.from(`production:${target.key}`),
    );
  }

  const result = await buildRelease({
    projectDirectory: path.resolve(__dirname, "../.."),
    outputDirectory,
    nativeBindingsDirectory,
    requireProductionBindings: true,
  });

  assert.deepEqual(Object.keys(result.manifest.nativeBindings).sort(), NATIVE_TARGETS.map((target) => target.key).sort());
  for (const target of NATIVE_TARGETS) {
    const fileName = `better-sqlite3-${target.key}.node`;
    const bytes = await fs.readFile(path.join(outputDirectory, fileName));
    assert.equal(bytes.toString(), `production:${target.key}`);
    assert.equal(
      result.manifest.nativeBindings[target.key].url,
      `https://github.com/s12ryt/s12ryt-nodejs-dns-server/releases/download/v1.0.0/${fileName}`,
    );
    assert.equal(
      result.manifest.nativeBindings[target.key].sha256,
      crypto.createHash("sha256").update(bytes).digest("hex"),
    );
  }
});

test("tag release workflow downloads and publishes all Linux native bindings", async () => {
  const workflow = await fs.readFile(path.resolve(__dirname, "../../.github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /node scripts\/native-bindings\.js/);
  assert.match(workflow, /S12_NATIVE_BINDINGS_DIRECTORY/);
  assert.match(workflow, /dist\/better-sqlite3-\*\.node/);
});
