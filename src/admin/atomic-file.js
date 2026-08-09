"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

async function writeJsonAtomic(filePath, value, { mode = 0o600 } = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

module.exports = { readJson, writeJsonAtomic };
