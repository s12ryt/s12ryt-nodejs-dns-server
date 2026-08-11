"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildRelease } = require("../../scripts/build");
const { DEFAULT_CONFIG } = require("../../src/admin/config-store");

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

  const builtRuntime = require(path.join(outputDirectory, "runtime.cjs"));
  assert.equal(typeof builtRuntime.start, "function");
  assert.match(bootstrap, /DEFAULT_MANIFEST_URL/);
  assert.equal(manifest.version, "0.1.5");
  assert.equal(
    manifest.runtime.url,
    "https://github.com/s12ryt/s12ryt-nodejs-dns-server/releases/download/v0.1.5/runtime.cjs",
  );
  assert.equal(manifest.runtime.sha256, crypto.createHash("sha256").update(runtime).digest("hex"));
  assert.equal(result.runtimeSha256, manifest.runtime.sha256);

  const dataDirectory = path.join(outputDirectory, "data");
  await fs.mkdir(dataDirectory);
  await fs.writeFile(path.join(dataDirectory, "config.json"), JSON.stringify({
    ...structuredClone(DEFAULT_CONFIG),
    dns: { host: "127.0.0.1", port: 0 },
    doh: { host: "127.0.0.1", port: 0 },
    proxy: { host: "127.0.0.1", port: 0, timeoutMs: 30000 },
    admin: { host: "127.0.0.1", port: 0 },
  }));
  const application = await builtRuntime.start({
    directory: dataDirectory,
    output: () => {},
    tunnel: {
      status: () => ({ available: false, state: "stopped", logs: [] }),
      start: async () => {},
      stop: async () => {},
    },
  });
  t.after(() => application.close());
  const admin = application.status().services.admin;
  const page = await fetch(`http://127.0.0.1:${admin.port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /S12 DNS Server/);
});
