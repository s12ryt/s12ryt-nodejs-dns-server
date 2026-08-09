"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { assetName, ensureCloudflared } = require("../../src/tunnel/download");

test("assetName maps every supported platform architecture", () => {
  assert.equal(assetName("win32", "x64"), "cloudflared-windows-amd64.exe");
  assert.equal(assetName("linux", "arm64"), "cloudflared-linux-arm64");
  assert.equal(assetName("darwin", "x64"), "cloudflared-darwin-amd64.tgz");
  assert.throws(() => assetName("win32", "arm64"), /unsupported/i);
});

test("ensureCloudflared verifies GitHub digest and installs atomically", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-cloudflared-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = Buffer.from("mock cloudflared binary");
  const digest = crypto.createHash("sha256").update(binary).digest("hex");
  const calls = [];
  const result = await ensureCloudflared({
    directory,
    platform: "win32",
    arch: "x64",
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith("/latest")) return new Response(JSON.stringify({
        tag_name: "2026.7.3",
        assets: [{
          name: "cloudflared-windows-amd64.exe",
          browser_download_url: "https://downloads.test/cloudflared.exe",
          digest: `sha256:${digest}`,
        }],
      }), { headers: { "content-type": "application/json" } });
      return new Response(binary);
    },
  });

  assert.equal(result.version, "2026.7.3");
  assert.deepEqual(await fs.readFile(result.path), binary);
  assert.equal(calls.length, 2);
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
});

test("ensureCloudflared rejects a digest mismatch without installing", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-cloudflared-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fetchImpl = async (url) => url.endsWith("/latest")
    ? new Response(JSON.stringify({
      tag_name: "1.0.0",
      assets: [{ name: "cloudflared-linux-amd64", browser_download_url: "https://download.test/bin", digest: `sha256:${"0".repeat(64)}` }],
    }))
    : new Response("tampered");

  await assert.rejects(ensureCloudflared({ directory, platform: "linux", arch: "x64", fetchImpl }), /SHA-256/i);
  assert.deepEqual(await fs.readdir(directory), []);
});
