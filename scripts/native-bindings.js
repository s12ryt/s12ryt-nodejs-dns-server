"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const BETTER_SQLITE3_VERSION = "12.6.2";
const RELEASE_URL = `https://api.github.com/repos/WiseLibs/better-sqlite3/releases/tags/v${BETTER_SQLITE3_VERSION}`;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_BINDING_BYTES = 32 * 1024 * 1024;

const NATIVE_TARGETS = Object.freeze(["115", "127", "137"].flatMap((abi) => ["x64", "arm64"].map((arch) => Object.freeze({
  abi,
  platform: "linux",
  arch,
  key: `node-v${abi}-linux-${arch}`,
  assetName: `better-sqlite3-v${BETTER_SQLITE3_VERSION}-node-v${abi}-linux-${arch}.tar.gz`,
}))));

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function safeTarPath(name) {
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  const parts = name.split("/");
  return !parts.some((part) => !part || part === "." || part === "..");
}

function tarChecksum(header) {
  let total = 0;
  for (let index = 0; index < header.length; index += 1) {
    total += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return total;
}

function parseOctal(header, start, length) {
  const text = header.subarray(start, start + length).toString("ascii").replace(/\0.*$/, "").trim();
  const value = Number.parseInt(text || "0", 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid native binding tar archive");
  return value;
}

function extractNativeBinding(compressedArchive) {
  if (!Buffer.isBuffer(compressedArchive) || compressedArchive.length > MAX_ARCHIVE_BYTES) {
    throw new Error("Native binding archive exceeds the size limit");
  }
  const archive = zlib.gunzipSync(compressedArchive, { maxOutputLength: MAX_ARCHIVE_BYTES });
  let binding = null;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (!safeTarPath(name)) throw new Error("Unsafe path in native binding tar archive");
    const storedChecksum = parseOctal(header, 148, 8);
    if (storedChecksum !== tarChecksum(header)) throw new Error("Invalid native binding tar checksum");
    const size = parseOctal(header, 124, 12);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (size > MAX_BINDING_BYTES || bodyEnd > archive.length) throw new Error("Invalid native binding tar entry size");
    const type = header[156];
    const isBinding = name === "build/Release/better_sqlite3.node"
      || name.endsWith("/build/Release/better_sqlite3.node");
    if ((type === 0 || type === 0x30) && isBinding) {
      if (binding) throw new Error("Multiple duplicate native bindings in archive");
      binding = Buffer.from(archive.subarray(bodyStart, bodyEnd));
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  if (!binding) throw new Error("Native binding is missing from archive");
  return binding;
}

async function responseBytes(response, label) {
  if (!response?.ok) throw new Error(`${label} returned HTTP ${response?.status ?? "unknown"}`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_ARCHIVE_BYTES) throw new Error(`${label} exceeds the size limit`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error(`${label} exceeds the size limit`);
  return bytes;
}

async function downloadNativeBindings({
  outputDirectory,
  fetchImpl = fetch,
  releaseUrl = RELEASE_URL,
} = {}) {
  if (!outputDirectory) throw new Error("Native binding output directory is required");
  const releaseResponse = await fetchImpl(releaseUrl, {
    headers: { accept: "application/vnd.github+json", "user-agent": "s12-dns-release" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!releaseResponse.ok) throw new Error(`better-sqlite3 release API returned HTTP ${releaseResponse.status}`);
  const release = await releaseResponse.json();
  if (release.tag_name !== `v${BETTER_SQLITE3_VERSION}` || !Array.isArray(release.assets)) {
    throw new Error("better-sqlite3 release metadata is invalid");
  }
  const selected = NATIVE_TARGETS.map((target) => {
    const asset = release.assets.find((candidate) => candidate.name === target.assetName);
    if (!asset?.browser_download_url || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest || "")) {
      throw new Error(`Native release asset or SHA-256 is missing: ${target.assetName}`);
    }
    if (new URL(asset.browser_download_url).protocol !== "https:") throw new Error("Native binding URL must use HTTPS");
    return { target, asset };
  });

  const binaries = [];
  for (const { target, asset } of selected) {
    const archive = await responseBytes(await fetchImpl(asset.browser_download_url, {
      headers: { accept: "application/octet-stream", "user-agent": "s12-dns-release" },
      signal: AbortSignal.timeout(120_000),
    }), target.assetName);
    if (sha256(archive) !== asset.digest.slice(7).toLowerCase()) {
      throw new Error(`Native binding SHA-256 verification failed: ${target.assetName}`);
    }
    binaries.push({ target, binary: extractNativeBinding(archive) });
  }

  await fs.mkdir(outputDirectory, { recursive: true });
  const temporaryFiles = [];
  try {
    for (const { target, binary } of binaries) {
      const fileName = `better-sqlite3-${target.key}.node`;
      const targetPath = path.join(outputDirectory, fileName);
      const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
      await fs.writeFile(temporaryPath, binary, { mode: 0o644, flag: "wx" });
      temporaryFiles.push({ temporaryPath, targetPath, target, binary, fileName });
    }
    for (const file of temporaryFiles) await fs.rename(file.temporaryPath, file.targetPath);
  } catch (error) {
    await Promise.all(temporaryFiles.flatMap((file) => [
      fs.rm(file.temporaryPath, { force: true }),
      fs.rm(file.targetPath, { force: true }),
    ]));
    throw error;
  }
  return Object.fromEntries(temporaryFiles.map(({ target, binary, fileName, targetPath }) => [target.key, {
    fileName,
    path: targetPath,
    sha256: sha256(binary),
  }]));
}

if (require.main === module) {
  const outputDirectory = path.resolve(process.argv[2] || "dist");
  downloadNativeBindings({ outputDirectory }).then((bindings) => {
    console.log(`Downloaded ${Object.keys(bindings).length} better-sqlite3 native bindings`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  BETTER_SQLITE3_VERSION,
  MAX_ARCHIVE_BYTES,
  NATIVE_TARGETS,
  RELEASE_URL,
  downloadNativeBindings,
  extractNativeBinding,
  sha256,
};
