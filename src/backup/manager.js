"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");

const yauzl = require("yauzl");
const yazl = require("yazl");

const BACKUP_FORMAT_VERSION = 1;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const BACKUP_FILE_PATTERN = /^s12-[a-z][a-z0-9-]*-\d{8}T\d{6}Z\.zip$/;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function safeEntryName(name) {
  if (typeof name !== "string" || !name || name.includes("\\") || name.includes("\0")) return false;
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return false;
  return !name.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function portableEntryName(name) {
  return ["admin.json", "config.json", "operations.sqlite"].includes(name)
    || /^logs\/[^/]+\.jsonl$/.test(name);
}

async function atomicReplaceFile(source, destination) {
  await fsPromises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.restore`;
  try {
    await fsPromises.copyFile(source, temporary);
    await fsPromises.chmod(temporary, 0o600).catch((error) => {
      if (process.platform !== "win32") throw error;
    });
    await fsPromises.rename(temporary, destination);
  } catch (error) {
    await fsPromises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function listLogFiles(directory) {
  const logDirectory = path.join(directory, "logs");
  const entries = await fsPromises.readdir(logDirectory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => `logs/${entry.name}`)
    .sort();
}

async function existingPortableFiles(directory) {
  const files = [];
  for (const name of ["admin.json", "config.json"]) {
    try {
      const stat = await fsPromises.stat(path.join(directory, name));
      if (stat.isFile()) files.push(name);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  files.push(...await listLogFiles(directory), "operations.sqlite");
  return files.sort();
}

function archiveTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function writeZip(zipFile, destination) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destination, { mode: 0o600 });
    const fail = (error) => reject(error);
    zipFile.outputStream.once("error", fail);
    output.once("error", fail);
    output.once("close", resolve);
    zipFile.outputStream.pipe(output);
    zipFile.end();
  });
}

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, {
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true,
    }, (error, zipFile) => error ? reject(error) : resolve(zipFile));
  });
}

function readEntry(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      let size = 0;
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_ENTRY_BYTES) stream.destroy(new Error("Backup entry exceeds the size limit"));
        else chunks.push(chunk);
      });
      stream.once("error", reject);
      stream.once("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function readZip(filePath) {
  const zipFile = await openZip(filePath);
  const files = {};
  const names = new Set();
  let totalSize = 0;
  try {
    return await new Promise((resolve, reject) => {
      const fail = (error) => {
        zipFile.close();
        reject(error);
      };
      zipFile.once("error", fail);
      zipFile.once("end", () => resolve(files));
      zipFile.on("entry", async (entry) => {
        try {
          const name = entry.fileName;
          if (!safeEntryName(name) || names.has(name) || name.endsWith("/")) {
            throw new Error(`Unsafe or duplicate backup entry: ${name}`);
          }
          names.add(name);
          totalSize += entry.uncompressedSize;
          if (entry.uncompressedSize > MAX_ENTRY_BYTES || totalSize > MAX_ARCHIVE_BYTES) {
            throw new Error("Backup archive exceeds the size limit");
          }
          files[name] = await readEntry(zipFile, entry);
          zipFile.readEntry();
        } catch (error) {
          fail(error);
        }
      });
      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }
}

class BackupManager {
  constructor({
    directory = path.resolve("data"),
    storage,
    now = () => new Date(),
    applicationVersion = "0.0.0",
    maintenance = {},
    replaceFile = atomicReplaceFile,
    maxArchiveBytes = MAX_ARCHIVE_BYTES,
  } = {}) {
    if (!storage || typeof storage.backupTo !== "function") throw new TypeError("Backup storage is required");
    if (!Number.isSafeInteger(maxArchiveBytes) || maxArchiveBytes < 1 || maxArchiveBytes > MAX_ARCHIVE_BYTES) {
      throw new RangeError("Backup archive size limit is invalid");
    }
    this.directory = directory;
    this.backupDirectory = path.join(directory, "backups");
    this.storage = storage;
    this.now = now;
    this.applicationVersion = applicationVersion;
    this.maintenance = {
      enter: maintenance.enter || (async () => {}),
      reload: maintenance.reload || (async () => {}),
      exit: maintenance.exit || (async () => {}),
    };
    this.replaceFile = replaceFile;
    this.maxArchiveBytes = maxArchiveBytes;
  }

  async create({ kind = "manual", dryRun = false } = {}) {
    if (!/^[a-z][a-z0-9-]*$/.test(kind)) throw new TypeError("Backup kind is invalid");
    const files = await existingPortableFiles(this.directory);
    if (dryRun) return { dryRun: true, files };

    await fsPromises.mkdir(this.backupDirectory, { recursive: true, mode: 0o700 });
    const createdAt = this.now();
    const fileName = `s12-${kind}-${archiveTimestamp(createdAt)}.zip`;
    const destination = path.join(this.backupDirectory, fileName);
    const temporaryArchive = `${destination}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const databaseSnapshot = path.join(this.backupDirectory, `.operations-${process.pid}-${crypto.randomBytes(6).toString("hex")}.sqlite`);

    try {
      await this.storage.backupTo(databaseSnapshot);
      const archiveFiles = files.map((name) => ({
        name,
        source: name === "operations.sqlite" ? databaseSnapshot : path.join(this.directory, ...name.split("/")),
      }));
      const manifestFiles = [];
      for (const file of archiveFiles) {
        const stat = await fsPromises.stat(file.source);
        manifestFiles.push({ path: file.name, size: stat.size, sha256: await sha256File(file.source) });
      }
      const manifest = {
        formatVersion: BACKUP_FORMAT_VERSION,
        applicationVersion: this.applicationVersion,
        databaseSchemaVersion: this.storage.status().schemaVersion,
        createdAt: createdAt.toISOString(),
        kind,
        files: manifestFiles,
      };
      const zipFile = new yazl.ZipFile();
      for (const file of archiveFiles) zipFile.addFile(file.source, file.name, { mode: 0o600 });
      zipFile.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"), "manifest.json", { mode: 0o600 });
      await writeZip(zipFile, temporaryArchive);
      await fsPromises.rename(temporaryArchive, destination);
      await fsPromises.chmod(destination, 0o600).catch((error) => {
        if (process.platform !== "win32") throw error;
      });
      const archiveStat = await fsPromises.stat(destination);
      return { dryRun: false, fileName, path: destination, size: archiveStat.size, manifest };
    } catch (error) {
      await fsPromises.rm(temporaryArchive, { force: true }).catch(() => {});
      throw error;
    } finally {
      await fsPromises.rm(databaseSnapshot, { force: true }).catch(() => {});
    }
  }

  async inspect(filePath) {
    const entries = await readZip(filePath);
    const manifestBuffer = entries["manifest.json"];
    if (!manifestBuffer) throw new Error("Backup manifest is missing");
    let manifest;
    try {
      manifest = JSON.parse(manifestBuffer.toString("utf8"));
    } catch {
      throw new Error("Backup manifest is invalid");
    }
    if (manifest.formatVersion !== BACKUP_FORMAT_VERSION || !Array.isArray(manifest.files)
      || !Number.isSafeInteger(manifest.databaseSchemaVersion) || manifest.databaseSchemaVersion < 1) {
      throw new Error("Backup manifest format is unsupported");
    }
    const supportedSchemaVersion = this.storage.status().schemaVersion;
    if (manifest.databaseSchemaVersion > supportedSchemaVersion) {
      throw new Error(`Backup uses newer database schema ${manifest.databaseSchemaVersion}; this runtime supports ${supportedSchemaVersion}`);
    }
    const files = {};
    const declared = new Set();
    for (const descriptor of manifest.files) {
      if (!descriptor || !safeEntryName(descriptor.path) || declared.has(descriptor.path)
        || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0
        || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) {
        throw new Error("Backup manifest file entry is invalid");
      }
      declared.add(descriptor.path);
      const content = entries[descriptor.path];
      if (!content || content.length !== descriptor.size || sha256(content) !== descriptor.sha256) {
        throw new Error(`Backup file verification failed: ${descriptor.path}`);
      }
      files[descriptor.path] = content;
    }
    const extra = Object.keys(entries).filter((name) => name !== "manifest.json" && !declared.has(name));
    if (extra.length > 0) throw new Error(`Backup contains undeclared files: ${extra.join(", ")}`);
    return { manifest, files };
  }

  async importArchive(stream, { fileName } = {}) {
    if (!stream || typeof stream[Symbol.asyncIterator] !== "function") throw new TypeError("Backup upload stream is required");
    if (typeof fileName !== "string" || !BACKUP_FILE_PATTERN.test(fileName)) {
      throw new TypeError("Invalid backup file name");
    }
    await fsPromises.mkdir(this.backupDirectory, { recursive: true, mode: 0o700 });
    const destination = path.join(this.backupDirectory, fileName);
    const temporary = path.join(this.backupDirectory, `.${fileName}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp-upload`);
    let handle;
    try {
      await fsPromises.access(destination).then(() => {
        throw Object.assign(new Error(`Backup already exists: ${fileName}`), { statusCode: 409 });
      }).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      handle = await fsPromises.open(temporary, "wx", 0o600);
      let size = 0;
      for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += chunk.length;
        if (size > this.maxArchiveBytes) throw Object.assign(new Error("Backup archive is too large"), { statusCode: 413 });
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      const archive = await this.inspect(temporary);
      await fsPromises.rename(temporary, destination);
      await fsPromises.chmod(destination, 0o600).catch((error) => {
        if (process.platform !== "win32") throw error;
      });
      return { fileName, path: destination, size, manifest: archive.manifest };
    } catch (error) {
      await handle?.close().catch(() => {});
      await fsPromises.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async restore(filePath, { dryRun = false } = {}) {
    const archive = await this.inspect(filePath);
    const names = Object.keys(archive.files).sort();
    for (const required of ["config.json", "operations.sqlite"]) {
      if (!names.includes(required)) throw new Error(`Backup is missing required file: ${required}`);
    }
    if (names.some((name) => !portableEntryName(name))) {
      throw new Error("Backup contains a file that cannot be restored");
    }
    if (dryRun) {
      return { dryRun: true, files: names, manifest: archive.manifest };
    }

    const operationId = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    const stagingDirectory = path.join(this.directory, `.restore-${operationId}`);
    const rollbackDirectory = path.join(this.directory, `.rollback-${operationId}`);
    let enteredMaintenance = false;
    try {
      await this.#writeStaging(stagingDirectory, archive.files);
      await this.#snapshotCurrent(rollbackDirectory);
      await this.maintenance.enter();
      enteredMaintenance = true;
      this.storage.close?.();
      try {
        await this.#applyStaging(stagingDirectory, names);
        this.storage.open?.();
        await this.maintenance.reload();
      } catch (error) {
        this.storage.close?.();
        await this.#restoreRollback(rollbackDirectory);
        this.storage.open?.();
        await this.maintenance.reload();
        throw error;
      }
      return { restored: true, files: names, manifest: archive.manifest };
    } finally {
      if (enteredMaintenance) await this.maintenance.exit();
      await fsPromises.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
      await fsPromises.rm(rollbackDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }

  async list() {
    const entries = await fsPromises.readdir(this.backupDirectory, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const backups = [];
    for (const entry of entries) {
      if (!entry.isFile() || !BACKUP_FILE_PATTERN.test(entry.name)) continue;
      const filePath = path.join(this.backupDirectory, entry.name);
      const stat = await fsPromises.stat(filePath);
      backups.push({ fileName: entry.name, path: filePath, size: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
    return backups.sort((left, right) => right.fileName.localeCompare(left.fileName));
  }

  async delete(fileName) {
    if (typeof fileName !== "string" || !BACKUP_FILE_PATTERN.test(fileName)) {
      throw new TypeError("Invalid backup file name");
    }
    const filePath = path.join(this.backupDirectory, fileName);
    try {
      await fsPromises.rm(filePath);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`Backup not found: ${fileName}`);
      throw error;
    }
    return { fileName, deleted: true };
  }

  async prune({ kind, keep }) {
    if (typeof kind !== "string" || !/^[a-z][a-z0-9-]*$/.test(kind)) throw new TypeError("Backup kind is invalid");
    if (!Number.isInteger(keep) || keep < 0 || keep > 10000) throw new RangeError("Backup retention is invalid");
    const prefix = `s12-${kind}-`;
    const matching = (await this.list()).filter((item) => item.fileName.startsWith(prefix));
    const deleted = [];
    for (const item of matching.slice(keep)) {
      await this.delete(item.fileName);
      deleted.push(item.fileName);
    }
    return { kind, keep, deleted };
  }

  async #writeStaging(stagingDirectory, files) {
    await fsPromises.mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
    for (const [name, content] of Object.entries(files)) {
      const destination = path.join(stagingDirectory, ...name.split("/"));
      await fsPromises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fsPromises.writeFile(destination, content, { mode: 0o600 });
    }
  }

  async #snapshotCurrent(rollbackDirectory) {
    await fsPromises.mkdir(rollbackDirectory, { recursive: true, mode: 0o700 });
    for (const name of ["admin.json", "config.json", "operations.sqlite", "logs"]) {
      const source = path.join(this.directory, name);
      const destination = path.join(rollbackDirectory, name);
      try {
        await fsPromises.cp(source, destination, { recursive: true, force: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  async #applyStaging(stagingDirectory, names) {
    await fsPromises.rm(path.join(this.directory, "logs"), { recursive: true, force: true });
    if (!names.includes("admin.json")) {
      await fsPromises.rm(path.join(this.directory, "admin.json"), { force: true });
    }
    for (const name of names) {
      const source = path.join(stagingDirectory, ...name.split("/"));
      const destination = path.join(this.directory, ...name.split("/"));
      await this.replaceFile(source, destination);
    }
    await Promise.all([
      fsPromises.rm(path.join(this.directory, "operations.sqlite-wal"), { force: true }),
      fsPromises.rm(path.join(this.directory, "operations.sqlite-shm"), { force: true }),
    ]);
  }

  async #restoreRollback(rollbackDirectory) {
    for (const name of ["admin.json", "config.json", "operations.sqlite", "operations.sqlite-wal", "operations.sqlite-shm", "logs"]) {
      await fsPromises.rm(path.join(this.directory, name), { recursive: true, force: true });
    }
    for (const name of ["admin.json", "config.json", "operations.sqlite", "logs"]) {
      const source = path.join(rollbackDirectory, name);
      const destination = path.join(this.directory, name);
      try {
        await fsPromises.cp(source, destination, { recursive: true, force: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}

module.exports = {
  BACKUP_FORMAT_VERSION,
  BackupManager,
  MAX_ARCHIVE_BYTES,
  MAX_ENTRY_BYTES,
  portableEntryName,
  safeEntryName,
};
