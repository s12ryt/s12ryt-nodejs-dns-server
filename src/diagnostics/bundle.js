"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const yazl = require("yazl");

const { redactAuditValue } = require("../admin/audit-service");

const DIAGNOSTIC_FORMAT_VERSION = 1;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function timestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function jsonBuffer(value) {
  return Buffer.from(`${JSON.stringify(redactAuditValue(value), null, 2)}\n`, "utf8");
}

function writeZip(zipFile, destination) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
    const fail = (error) => reject(error);
    zipFile.outputStream.once("error", fail);
    output.once("error", fail);
    output.once("close", resolve);
    zipFile.outputStream.pipe(output);
    zipFile.end();
  });
}

function validateLimit(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} is invalid`);
  }
  return value;
}

async function logTail(filePath, maxLines) {
  const text = await fsPromises.readFile(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean).slice(-maxLines);
  const output = lines.map((line) => {
    try {
      return JSON.stringify(redactAuditValue(JSON.parse(line)));
    } catch {
      return JSON.stringify({ malformed: true, content: "[redacted]" });
    }
  });
  return Buffer.from(`${output.join("\n")}${output.length ? "\n" : ""}`, "utf8");
}

async function logFiles(directory) {
  const logDirectory = path.join(directory, "logs");
  const entries = await fsPromises.readdir(logDirectory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isFile() && /^operations-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .slice(-3);
}

class DiagnosticBundle {
  constructor({
    directory = path.resolve("data"),
    applicationVersion = "0.0.0",
    now = () => new Date(),
    platform = null,
    getConfig,
    getRuntime = () => null,
    getStatus,
    getStorage,
    getAuditVerification,
    getEvents,
    maxEvents = 100,
    maxLogLines = 200,
  } = {}) {
    for (const [name, callback] of Object.entries({ getConfig, getStatus, getStorage, getAuditVerification, getEvents })) {
      if (typeof callback !== "function") throw new TypeError(`Diagnostic ${name} callback is required`);
    }
    this.directory = directory;
    this.outputDirectory = path.join(directory, "diagnostics");
    this.applicationVersion = applicationVersion;
    this.now = now;
    this.platform = platform || {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      abi: process.versions.modules,
      release: os.release(),
    };
    this.getConfig = getConfig;
    this.getRuntime = getRuntime;
    this.getStatus = getStatus;
    this.getStorage = getStorage;
    this.getAuditVerification = getAuditVerification;
    this.getEvents = getEvents;
    this.maxEvents = validateLimit(maxEvents, "Diagnostic event limit", 1000);
    this.maxLogLines = validateLimit(maxLogLines, "Diagnostic log line limit", 10000);
  }

  async create() {
    const createdAt = this.now();
    const fileName = `s12-diagnostic-${timestamp(createdAt)}.zip`;
    await fsPromises.mkdir(this.outputDirectory, { recursive: true, mode: 0o700 });
    const destination = path.join(this.outputDirectory, fileName);
    const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const files = new Map();
    files.set("config.json", jsonBuffer(await this.getConfig()));
    files.set("system.json", jsonBuffer({
      applicationVersion: this.applicationVersion,
      createdAt: createdAt.toISOString(),
      platform: this.platform,
      runtime: await this.getRuntime(),
      storage: await this.getStorage(),
      status: await this.getStatus(),
      audit: await this.getAuditVerification(),
    }));
    const events = await this.getEvents();
    if (!Array.isArray(events)) throw new TypeError("Diagnostic events must be an array");
    files.set("events.json", jsonBuffer(events.slice(-this.maxEvents)));
    for (const name of await logFiles(this.directory)) {
      const tailName = `logs/${name.replace(/\.jsonl$/, ".tail.jsonl")}`;
      files.set(tailName, await logTail(path.join(this.directory, "logs", name), this.maxLogLines));
    }
    const manifest = {
      formatVersion: DIAGNOSTIC_FORMAT_VERSION,
      applicationVersion: this.applicationVersion,
      createdAt: createdAt.toISOString(),
      files: [...files].map(([filePath, content]) => ({
        path: filePath,
        size: content.length,
        sha256: sha256(content),
      })),
    };
    const zipFile = new yazl.ZipFile();
    for (const [filePath, content] of files) zipFile.addBuffer(content, filePath, { mode: 0o600 });
    zipFile.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), "manifest.json", { mode: 0o600 });
    try {
      await writeZip(zipFile, temporary);
      await fsPromises.rename(temporary, destination);
      await fsPromises.chmod(destination, 0o600).catch((error) => {
        if (process.platform !== "win32") throw error;
      });
      const stat = await fsPromises.stat(destination);
      return { fileName, path: destination, size: stat.size, manifest };
    } catch (error) {
      await fsPromises.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}

module.exports = { DIAGNOSTIC_FORMAT_VERSION, DiagnosticBundle, logTail };
