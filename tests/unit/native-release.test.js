"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const {
  BETTER_SQLITE3_VERSION,
  NATIVE_TARGETS,
  downloadNativeBindings,
  extractNativeBinding,
} = require("../../scripts/native-bindings");

function tarEntry(name, body) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

function tarGzip(entries) {
  return zlib.gzipSync(Buffer.concat([
    ...entries.map(([name, body]) => tarEntry(name, body)),
    Buffer.alloc(1024),
  ]));
}

test("native release targets cover Linux glibc x64 and arm64 for Node 20, 22 and 24", () => {
  assert.equal(BETTER_SQLITE3_VERSION, "12.6.2");
  assert.deepEqual(NATIVE_TARGETS.map(({ abi, platform, arch, key }) => ({ abi, platform, arch, key })), [
    { abi: "115", platform: "linux", arch: "x64", key: "node-v115-linux-x64" },
    { abi: "115", platform: "linux", arch: "arm64", key: "node-v115-linux-arm64" },
    { abi: "127", platform: "linux", arch: "x64", key: "node-v127-linux-x64" },
    { abi: "127", platform: "linux", arch: "arm64", key: "node-v127-linux-arm64" },
    { abi: "137", platform: "linux", arch: "x64", key: "node-v137-linux-x64" },
    { abi: "137", platform: "linux", arch: "arm64", key: "node-v137-linux-arm64" },
  ]);
  for (const target of NATIVE_TARGETS) {
    assert.equal(target.assetName, `better-sqlite3-v12.6.2-node-v${target.abi}-linux-${target.arch}.tar.gz`);
  }
});

test("downloadNativeBindings verifies release digests and emits six atomic binding assets", async (t) => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-native-release-"));
  t.after(() => fs.rm(outputDirectory, { recursive: true, force: true }));
  const archives = new Map();
  const assets = NATIVE_TARGETS.map((target) => {
    const binary = Buffer.from(`binding:${target.key}`);
    const archive = tarGzip([["package/build/Release/better_sqlite3.node", binary]]);
    archives.set(`https://downloads.test/${target.assetName}`, archive);
    return {
      name: target.assetName,
      browser_download_url: `https://downloads.test/${target.assetName}`,
      digest: `sha256:${crypto.createHash("sha256").update(archive).digest("hex")}`,
    };
  });
  const calls = [];
  const result = await downloadNativeBindings({
    outputDirectory,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith("/releases/tags/v12.6.2")) {
        return new Response(JSON.stringify({ tag_name: "v12.6.2", assets }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(archives.get(url));
    },
  });

  assert.equal(calls.length, 7);
  assert.deepEqual(Object.keys(result).sort(), NATIVE_TARGETS.map((target) => target.key).sort());
  for (const target of NATIVE_TARGETS) {
    const descriptor = result[target.key];
    const fileName = `better-sqlite3-${target.key}.node`;
    const binary = await fs.readFile(path.join(outputDirectory, fileName));
    assert.equal(binary.toString(), `binding:${target.key}`);
    assert.equal(descriptor.fileName, fileName);
    assert.equal(descriptor.sha256, crypto.createHash("sha256").update(binary).digest("hex"));
  }
  assert.deepEqual((await fs.readdir(outputDirectory)).filter((name) => name.includes(".tmp")), []);
});

test("native tar extraction rejects traversal, duplicate bindings and missing binaries", () => {
  const binding = Buffer.from("binding");
  assert.throws(
    () => extractNativeBinding(tarGzip([["../build/Release/better_sqlite3.node", binding]])),
    /unsafe|path|archive/i,
  );
  assert.throws(
    () => extractNativeBinding(tarGzip([
      ["a/build/Release/better_sqlite3.node", binding],
      ["b/build/Release/better_sqlite3.node", binding],
    ])),
    /duplicate|multiple/i,
  );
  assert.throws(() => extractNativeBinding(tarGzip([["README.md", Buffer.from("none")]])), /missing/i);
});

test("native tar extraction accepts the exact path used by official release archives", () => {
  const binding = Buffer.from("official-binding");
  assert.deepEqual(
    extractNativeBinding(tarGzip([["build/Release/better_sqlite3.node", binding]])),
    binding,
  );
});

test("downloadNativeBindings rejects missing metadata and digest mismatches without partial output", async (t) => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-native-release-"));
  t.after(() => fs.rm(outputDirectory, { recursive: true, force: true }));
  const first = NATIVE_TARGETS[0];
  const archive = tarGzip([["build/Release/better_sqlite3.node", Buffer.from("binding")]]);
  const fetchImpl = async (url) => url.endsWith("/releases/tags/v12.6.2")
    ? new Response(JSON.stringify({
      tag_name: "v12.6.2",
      assets: [{
        name: first.assetName,
        browser_download_url: `https://downloads.test/${first.assetName}`,
        digest: `sha256:${"0".repeat(64)}`,
      }],
    }))
    : new Response(archive);

  await assert.rejects(downloadNativeBindings({ outputDirectory, fetchImpl }), /missing|SHA-256/i);
  assert.deepEqual(await fs.readdir(outputDirectory), []);
});
