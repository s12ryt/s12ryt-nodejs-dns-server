"use strict";

const crypto = require("node:crypto");
const dgram = require("node:dgram");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const DEFAULT_MANIFEST_URL = "https://github.com/s12ryt/s12ryt-nodejs-dns-server/releases/latest/download/manifest.json";
const DNS_MESSAGE_LIMIT = 65535;

class BootstrapValidationError extends Error {}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function requireHttps(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new BootstrapValidationError(`${label} is invalid`); }
  if (url.protocol !== "https:") throw new BootstrapValidationError(`${label} must use HTTPS`);
  return url.href;
}

function nativeBindingKey({
  abi = process.versions.modules,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (!/^\d+$/.test(String(abi)) || !/^[a-z0-9]+$/i.test(platform) || !/^[a-z0-9]+$/i.test(arch)) {
    throw new BootstrapValidationError("Native binding platform is invalid");
  }
  return `node-v${abi}-${platform}-${arch}`;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(manifest.version || "")) {
    throw new BootstrapValidationError("Runtime manifest version is invalid");
  }
  if (!manifest.runtime || !/^[a-f0-9]{64}$/i.test(manifest.runtime.sha256 || "")) {
    throw new BootstrapValidationError("Runtime manifest SHA-256 is invalid");
  }
  if (!manifest.nativeBindings || typeof manifest.nativeBindings !== "object" || Array.isArray(manifest.nativeBindings)) {
    throw new BootstrapValidationError("Runtime manifest native bindings are invalid");
  }
  const nativeBindings = Object.fromEntries(Object.entries(manifest.nativeBindings).map(([key, asset]) => {
    if (!/^node-v\d+-[a-z0-9]+-[a-z0-9]+$/i.test(key)
      || !asset || !/^[a-f0-9]{64}$/i.test(asset.sha256 || "")) {
      throw new BootstrapValidationError("Runtime manifest native binding is invalid");
    }
    return [key, {
      url: requireHttps(asset.url, `Native binding ${key} URL`),
      sha256: asset.sha256.toLowerCase(),
    }];
  }));
  return {
    version: manifest.version,
    runtime: {
      url: requireHttps(manifest.runtime.url, "Runtime URL"),
      sha256: manifest.runtime.sha256.toLowerCase(),
    },
    nativeBindings,
  };
}

async function atomicWrite(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fsp.writeFile(temporary, data);
    await fsp.rename(temporary, filePath);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function validRuntimeMetadata(metadata) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(metadata?.version || "")
    || !/^[a-f0-9]{64}$/i.test(metadata?.sha256 || "")
    || metadata.nativeBinding?.key !== nativeBindingKey()
    || !/^[a-f0-9]{64}$/i.test(metadata.nativeBinding?.sha256 || "")) return false;
  const runtimeFile = `runtime-${metadata.version}`;
  const nativeFile = `better-sqlite3-${metadata.nativeBinding.key}`;
  return (metadata.file === `${runtimeFile}.cjs`
      || metadata.file === `${runtimeFile}-${metadata.sha256.slice(0, 12)}.cjs`)
    && (metadata.nativeBinding.file === `${nativeFile}.node`
      || metadata.nativeBinding.file === `${nativeFile}-${metadata.nativeBinding.sha256.slice(0, 12)}.node`);
}

async function verifiedMetadata(directory, metadataFile) {
  try {
    const metadata = JSON.parse(await fsp.readFile(path.join(directory, metadataFile), "utf8"));
    if (!validRuntimeMetadata(metadata)) return null;
    const runtimePath = path.join(directory, metadata.file);
    const nativeBindingPath = path.join(directory, metadata.nativeBinding.file);
    const [data, nativeBinding] = await Promise.all([fsp.readFile(runtimePath), fsp.readFile(nativeBindingPath)]);
    if (sha256(data) !== metadata.sha256.toLowerCase()
      || sha256(nativeBinding) !== metadata.nativeBinding.sha256.toLowerCase()) return null;
    return { path: runtimePath, nativeBindingPath, version: metadata.version, metadata };
  } catch {
    return null;
  }
}

async function verifiedCache(directory) {
  const runtime = await verifiedMetadata(directory, "active.json");
  return runtime ? { ...runtime, source: "cache" } : null;
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "s12-dns-bootstrap" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Manifest returned HTTP ${response.status}`);
  return response.json();
}

async function resolveDownloadedRuntime({
  manifestUrl = process.env.APP_MANIFEST_URL || DEFAULT_MANIFEST_URL,
  directory = path.resolve("data", "runtime"),
  fetchImpl = fetch,
} = {}) {
  const safeManifestUrl = requireHttps(manifestUrl, "Manifest URL");
  let manifest;
  try {
    manifest = validateManifest(await fetchJson(fetchImpl, safeManifestUrl));
    const bindingKey = nativeBindingKey();
    const nativeAsset = manifest.nativeBindings[bindingKey];
    if (!nativeAsset) throw new Error(`No compatible native binding for ${bindingKey}`);
    const response = await fetchImpl(manifest.runtime.url, {
      headers: { accept: "application/javascript", "user-agent": "s12-dns-bootstrap" },
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`Runtime download returned HTTP ${response.status}`);
    const runtime = Buffer.from(await response.arrayBuffer());
    if (sha256(runtime) !== manifest.runtime.sha256) throw new Error("Runtime SHA-256 verification failed");
    const nativeResponse = await fetchImpl(nativeAsset.url, {
      headers: { accept: "application/octet-stream", "user-agent": "s12-dns-bootstrap" },
      signal: AbortSignal.timeout(120000),
    });
    if (!nativeResponse.ok) throw new Error(`Native binding download returned HTTP ${nativeResponse.status}`);
    const nativeBinding = Buffer.from(await nativeResponse.arrayBuffer());
    if (sha256(nativeBinding) !== nativeAsset.sha256) throw new Error("Native binding SHA-256 verification failed");
    const file = `runtime-${manifest.version}-${manifest.runtime.sha256.slice(0, 12)}.cjs`;
    const nativeFile = `better-sqlite3-${bindingKey}-${nativeAsset.sha256.slice(0, 12)}.node`;
    const runtimePath = path.join(directory, file);
    const nativeBindingPath = path.join(directory, nativeFile);
    await atomicWrite(runtimePath, runtime);
    await atomicWrite(nativeBindingPath, nativeBinding);
    const metadata = {
      version: manifest.version,
      sha256: manifest.runtime.sha256,
      file,
      nativeBinding: { key: bindingKey, sha256: nativeAsset.sha256, file: nativeFile },
    };
    await atomicWrite(path.join(directory, "pending.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    return { path: runtimePath, nativeBindingPath, version: manifest.version, source: "download", metadata };
  } catch (error) {
    if (error instanceof BootstrapValidationError) throw error;
    return verifiedCache(directory);
  }
}

async function promoteRuntime(directory, runtime) {
  const pending = await verifiedMetadata(directory, "pending.json");
  if (!pending || pending.path !== runtime.path || pending.nativeBindingPath !== runtime.nativeBindingPath) {
    throw new BootstrapValidationError("Pending runtime verification failed");
  }
  await atomicWrite(path.join(directory, "active.json"), `${JSON.stringify(pending.metadata, null, 2)}\n`);
  await fsp.rm(path.join(directory, "pending.json"), { force: true });
}

async function recordFailedRuntime(directory, runtime) {
  await atomicWrite(path.join(directory, "failed.json"), `${JSON.stringify({
    version: runtime.version,
    failedAt: new Date().toISOString(),
    code: "START_FAILED",
    message: "Candidate runtime failed to start",
  }, null, 2)}\n`);
  await fsp.rm(path.join(directory, "pending.json"), { force: true });
}

function parseQuestion(wire) {
  if (!Buffer.isBuffer(wire) || wire.length < 17 || wire.readUInt16BE(4) !== 1) throw new Error("Invalid DNS query");
  const labels = [];
  let offset = 12;
  while (offset < wire.length) {
    const length = wire[offset];
    if (length === 0) { offset += 1; break; }
    if (length > 63 || offset + length + 1 > wire.length) throw new Error("Invalid DNS name");
    labels.push(wire.subarray(offset + 1, offset + length + 1).toString("ascii"));
    offset += length + 1;
  }
  if (offset + 4 > wire.length) throw new Error("Invalid DNS question");
  return { name: labels.join(".").toLowerCase(), type: wire.readUInt16BE(offset), questionEnd: offset + 4 };
}

function fallbackError(query, rcode = 2) {
  const response = Buffer.from(query);
  response.writeUInt16BE(0x8180 | rcode, 2);
  response.writeUInt16BE(0, 6);
  response.writeUInt16BE(0, 8);
  response.writeUInt16BE(0, 10);
  return response;
}

function customFallbackAnswer(query, records) {
  const question = parseQuestion(query);
  const typeName = question.type === 1 ? "A" : question.type === 28 ? "AAAA" : null;
  if (!typeName) return null;
  const record = records.find((item) => item.enabled !== false && String(item.name).toLowerCase() === question.name && item.type === typeName);
  if (!record) return null;
  let data;
  if (question.type === 1 && net.isIP(record.value) === 4) data = Buffer.from(record.value.split(".").map(Number));
  else if (question.type === 28 && net.isIP(record.value) === 6) {
    const halves = record.value.split("::");
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
    data = Buffer.alloc(16);
    groups.forEach((group, index) => data.writeUInt16BE(Number.parseInt(group || "0", 16), index * 2));
  } else return null;
  const headerAndQuestion = Buffer.from(query.subarray(0, question.questionEnd));
  headerAndQuestion.writeUInt16BE(0x8580, 2);
  headerAndQuestion.writeUInt16BE(1, 6);
  headerAndQuestion.writeUInt16BE(0, 8);
  headerAndQuestion.writeUInt16BE(0, 10);
  const answer = Buffer.alloc(12 + data.length);
  answer.writeUInt16BE(0xc00c, 0);
  answer.writeUInt16BE(question.type, 2);
  answer.writeUInt16BE(1, 4);
  answer.writeUInt32BE(Number(record.ttl) || 300, 6);
  answer.writeUInt16BE(data.length, 10);
  data.copy(answer, 12);
  return Buffer.concat([headerAndQuestion, answer]);
}

function loadFallbackRecords(directory) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8"));
    return Array.isArray(config.records) ? config.records : [];
  } catch { return []; }
}

async function fallbackResolve(query, records, fetchImpl) {
  try {
    const custom = customFallbackAnswer(query, records);
    if (custom) return custom;
  } catch { return fallbackError(query, 1); }
  try {
    const response = await fetchImpl("https://cloudflare-dns.com/dns-query", {
      method: "POST",
      headers: { accept: "application/dns-message", "content-type": "application/dns-message" },
      body: query,
      signal: AbortSignal.timeout(5000),
    });
    const result = Buffer.from(await response.arrayBuffer());
    if (!response.ok || result.length < 12 || result.readUInt16BE(0) !== query.readUInt16BE(0)) throw new Error("Invalid upstream response");
    return result;
  } catch { return fallbackError(query); }
}

function readRequest(request, limit = DNS_MESSAGE_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) request.destroy(new Error("Request too large"));
      else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function startFallback({
  directory = path.resolve("data"),
  host = process.env.HOST || "0.0.0.0",
  dnsPort = Number(process.env.DNS_PORT || 5354),
  dohPort = Number(process.env.DOH_PORT || 8053),
  fetchImpl = fetch,
} = {}) {
  const records = loadFallbackRecords(directory);
  const resolve = (wire) => fallbackResolve(wire, records, fetchImpl);
  const udp = dgram.createSocket(host.includes(":") ? "udp6" : "udp4");
  udp.on("message", async (wire, remote) => udp.send(await resolve(wire), remote.port, remote.address));
  await new Promise((done, reject) => { udp.once("error", reject); udp.bind(dnsPort, host, done); });
  const tcp = net.createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on("data", async (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const length = pending.readUInt16BE(0);
        if (!length || length > DNS_MESSAGE_LIMIT) return socket.destroy();
        if (pending.length < length + 2) return;
        const query = pending.subarray(2, length + 2);
        pending = pending.subarray(length + 2);
        const answer = await resolve(query);
        const prefix = Buffer.alloc(2);
        prefix.writeUInt16BE(answer.length);
        socket.write(Buffer.concat([prefix, answer]));
      }
    });
  });
  await new Promise((done, reject) => { tcp.once("error", reject); tcp.listen(udp.address().port, host, done); });
  const doh = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      let query;
      if (url.pathname !== "/dns-query") return response.writeHead(404).end();
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      response.setHeader("access-control-allow-headers", "Content-Type, Accept");
      if (request.method === "OPTIONS") return response.writeHead(204).end();
      if (request.method === "GET") query = Buffer.from(url.searchParams.get("dns") || "", "base64url");
      else if (request.method === "POST" && String(request.headers["content-type"] || "").split(";", 1)[0] === "application/dns-message") query = await readRequest(request);
      else {
        if (request.method !== "POST") response.setHeader("allow", "GET, POST, OPTIONS");
        return response.writeHead(request.method === "POST" ? 415 : 405).end();
      }
      if (query.length < 12 || query.length > DNS_MESSAGE_LIMIT) return response.writeHead(400).end();
      response.writeHead(200, { "content-type": "application/dns-message", "cache-control": "no-store" }).end(await resolve(query));
    } catch { if (!response.headersSent) response.writeHead(400).end(); }
  });
  await new Promise((done, reject) => { doh.once("error", reject); doh.listen(dohPort, host, done); });
  console.warn("S12 DNS Server is running the embedded fallback core; management and proxy services are unavailable.");
  return {
    mode: "fallback",
    addresses: { dns: udp.address(), doh: doh.address() },
    async close() {
      await Promise.all([
        new Promise((done) => udp.close(done)),
        new Promise((done) => tcp.close(done)),
        new Promise((done) => doh.close(done)),
      ]);
    },
  };
}

async function launch({
  directory = path.resolve("data", "runtime"),
  localEntry = path.join(__dirname, "src", "main.js"),
  manifestUrl = process.env.APP_MANIFEST_URL || DEFAULT_MANIFEST_URL,
  fetchImpl = fetch,
  requireImpl = require,
  fallbackStart = startFallback,
} = {}) {
  if (fs.existsSync(localEntry)) return requireImpl(localEntry).start();
  const previous = await verifiedCache(directory);
  const runtime = await resolveDownloadedRuntime({ directory, manifestUrl, fetchImpl });
  if (runtime) {
    try {
      globalThis.__S12_SQLITE_NATIVE_BINDING__ = runtime.nativeBindingPath;
      const application = await requireImpl(runtime.path).start();
      if (runtime.source === "download") await promoteRuntime(directory, runtime);
      return application;
    } catch {
      if (runtime.source !== "download") return fallbackStart();
      await recordFailedRuntime(directory, runtime);
      const rollback = previous && await verifiedCache(directory);
      if (rollback) {
        globalThis.__S12_SQLITE_NATIVE_BINDING__ = rollback.nativeBindingPath;
        return requireImpl(rollback.path).start();
      }
      return fallbackStart();
    }
  }
  return fallbackStart();
}

function installShutdownHandlers(application, {
  processRef = process,
  output = (message) => console.error(message),
} = {}) {
  if (!application || typeof application.close !== "function") throw new Error("Application close handler is required");
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await application.close();
      processRef.exitCode = 0;
    } catch (error) {
      output(`S12 DNS Server failed to stop after ${signal}: ${error.message}`);
      processRef.exitCode = 1;
    }
  };
  processRef.once("SIGTERM", shutdown);
  processRef.once("SIGINT", shutdown);
  return () => {
    processRef.removeListener("SIGTERM", shutdown);
    processRef.removeListener("SIGINT", shutdown);
  };
}

if (require.main === module) {
  launch().then((application) => {
    installShutdownHandlers(application);
  }).catch((error) => {
    console.error(`S12 DNS Server failed to start: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  BootstrapValidationError,
  DEFAULT_MANIFEST_URL,
  atomicWrite,
  installShutdownHandlers,
  launch,
  nativeBindingKey,
  promoteRuntime,
  recordFailedRuntime,
  resolveDownloadedRuntime,
  startFallback,
  validateManifest,
  verifiedCache,
};
