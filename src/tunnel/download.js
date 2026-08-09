"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { promisify } = require("node:util");

const { readJson, writeJsonAtomic } = require("../admin/atomic-file");

const gunzip = promisify(zlib.gunzip);
const RELEASE_URL = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";

function assetName(platform = process.platform, arch = process.arch) {
  const architecture = { x64: "amd64", arm64: "arm64" }[arch];
  const suffix = {
    win32: architecture === "amd64" ? `windows-${architecture}.exe` : null,
    linux: architecture ? `linux-${architecture}` : null,
    darwin: architecture ? `darwin-${architecture}.tgz` : null,
  }[platform];
  if (!suffix) throw new Error(`Unsupported cloudflared platform: ${platform}/${arch}`);
  return `cloudflared-${suffix}`;
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function extractTarFile(archive, expectedBasename = "cloudflared") {
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > archive.length) {
      throw new Error("Invalid cloudflared tar archive");
    }
    if (path.posix.basename(name) === expectedBasename) return Buffer.from(archive.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("cloudflared binary is missing from archive");
}

async function responseBytes(response, label) {
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function cachedBinary(directory, executableName) {
  try {
    const metadata = await readJson(path.join(directory, "cloudflared.json"));
    const executablePath = path.join(directory, executableName);
    const binary = await fs.readFile(executablePath);
    if (sha256(binary) !== metadata.binarySha256) return null;
    return { path: executablePath, version: metadata.version };
  } catch {
    return null;
  }
}

async function ensureCloudflared({
  directory = path.resolve("data", "cloudflared"),
  platform = process.platform,
  arch = process.arch,
  fetchImpl = fetch,
} = {}) {
  await fs.mkdir(directory, { recursive: true });
  const executableName = platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const cached = await cachedBinary(directory, executableName);
  if (cached) return cached;

  const releaseResponse = await fetchImpl(RELEASE_URL, {
    headers: { accept: "application/vnd.github+json", "user-agent": "s12-dns-server" },
    signal: AbortSignal.timeout(15000),
  });
  if (!releaseResponse.ok) throw new Error(`Cloudflared release API returned HTTP ${releaseResponse.status}`);
  const release = await releaseResponse.json();
  const wantedName = assetName(platform, arch);
  const asset = release.assets?.find((candidate) => candidate.name === wantedName);
  if (!asset || !asset.browser_download_url || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest || "")) {
    throw new Error(`Cloudflared release asset or SHA-256 digest is missing: ${wantedName}`);
  }
  if (new URL(asset.browser_download_url).protocol !== "https:") throw new Error("Cloudflared download URL must use HTTPS");

  const download = await responseBytes(await fetchImpl(asset.browser_download_url, {
    headers: { "user-agent": "s12-dns-server" },
    signal: AbortSignal.timeout(120000),
  }), "Cloudflared download");
  const expectedDigest = asset.digest.slice(7).toLowerCase();
  if (sha256(download) !== expectedDigest) throw new Error("Cloudflared SHA-256 verification failed");
  const binary = platform === "darwin" ? extractTarFile(await gunzip(download)) : download;

  const executablePath = path.join(directory, executableName);
  const temporary = `${executablePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, binary, { mode: 0o755 });
    await fs.rename(temporary, executablePath);
    if (platform !== "win32") await fs.chmod(executablePath, 0o755);
    await writeJsonAtomic(path.join(directory, "cloudflared.json"), {
      version: release.tag_name,
      asset: wantedName,
      binarySha256: sha256(binary),
    });
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    await fs.rm(executablePath, { force: true }).catch(() => {});
    throw error;
  }
  return { path: executablePath, version: release.tag_name };
}

module.exports = { RELEASE_URL, assetName, ensureCloudflared, extractTarFile, sha256 };
