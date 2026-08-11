"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { readJson, writeJsonAtomic } = require("../admin/atomic-file");

const OPERATIONS = new Set(["startup", "restore", "shutdown"]);
const ATOMIC_TEMPORARY = /^.+\.\d+\.[0-9a-f]{12}\.tmp$/;
const RESTORE_TEMPORARY = /^.+\.\d+\.[0-9a-f]{12}\.restore$/;
const UPLOAD_TEMPORARY = /^\..+\.\d+\.[0-9a-f]{12}\.tmp-upload$/;
const RECOVERY_DIRECTORY = /^\.(?:restore|rollback)-[a-zA-Z0-9-]+$/;

function validateMarker(marker) {
  if (!marker || marker.formatVersion !== 1 || !OPERATIONS.has(marker.operation)
    || typeof marker.startedAt !== "string" || !Number.isFinite(Date.parse(marker.startedAt))
    || !Number.isInteger(marker.processId) || marker.processId < 0) {
    throw new Error("Recovery operation marker is invalid");
  }
  return {
    formatVersion: 1,
    operation: marker.operation,
    startedAt: marker.startedAt,
    processId: marker.processId,
  };
}

class RecoveryManager {
  constructor({
    directory = path.resolve("data"),
    now = () => new Date(),
    processId = process.pid,
  } = {}) {
    this.directory = directory;
    this.recoveryDirectory = path.join(directory, "recovery");
    this.markerPath = path.join(this.recoveryDirectory, "operation.json");
    this.reportPath = path.join(this.recoveryDirectory, "last-recovery.json");
    this.now = now;
    this.processId = processId;
  }

  async begin(operation) {
    if (!OPERATIONS.has(operation)) throw new TypeError("Recovery operation is invalid");
    const current = await this.#readMarker();
    if (current) throw new Error(`Recovery operation ${current.operation} is already in progress`);
    const marker = {
      formatVersion: 1,
      operation,
      startedAt: this.now().toISOString(),
      processId: this.processId,
    };
    await writeJsonAtomic(this.markerPath, marker);
    return marker;
  }

  async complete(operation) {
    const marker = await this.#readMarker();
    if (!marker) return;
    if (marker.operation !== operation) {
      throw new Error(`Cannot complete ${operation}; ${marker.operation} is in progress`);
    }
    await fs.rm(this.markerPath, { force: true });
  }

  async recover() {
    const interrupted = await this.#readMarker();
    if (!interrupted) return { recovered: false, interrupted: null, removed: [] };
    const removed = await this.#removeManagedTemporaryArtifacts();
    const report = {
      recovered: true,
      interrupted,
      removed,
      completedAt: this.now().toISOString(),
    };
    await writeJsonAtomic(this.reportPath, report);
    await fs.rm(this.markerPath, { force: true });
    return report;
  }

  async #readMarker() {
    try {
      return validateMarker(await readJson(this.markerPath));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async #removeManagedTemporaryArtifacts() {
    const removed = [];
    await this.#removeMatches(this.directory, (entry) => (
      (entry.isDirectory() && RECOVERY_DIRECTORY.test(entry.name))
      || (entry.isFile() && (ATOMIC_TEMPORARY.test(entry.name) || RESTORE_TEMPORARY.test(entry.name)))
    ), removed, "");
    await this.#removeMatches(path.join(this.directory, "backups"), (entry) => (
      entry.isFile() && (ATOMIC_TEMPORARY.test(entry.name) || UPLOAD_TEMPORARY.test(entry.name))
    ), removed, "backups");
    await this.#removeMatches(path.join(this.directory, "runtime"), (entry) => (
      entry.isFile() && ATOMIC_TEMPORARY.test(entry.name)
    ), removed, "runtime");
    return removed;
  }

  async #removeMatches(directory, predicate, removed, prefix) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!predicate(entry)) continue;
      await fs.rm(path.join(directory, entry.name), { recursive: entry.isDirectory(), force: true });
      removed.push(prefix ? `${prefix}/${entry.name}` : entry.name);
    }
  }
}

module.exports = { OPERATIONS, RecoveryManager, validateMarker };
