"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { promisify } = require("node:util");

const { readJson, writeJsonAtomic } = require("./atomic-file");

const pbkdf2 = promisify(crypto.pbkdf2);
const ITERATIONS = 210000;
const DIGEST = "sha512";

function secret() {
  return crypto.randomBytes(32).toString("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class AuthManager {
  #credentials = null;
  #setup = null;
  #sessions = new Map();
  #failures = new Map();

  constructor({
    directory = path.resolve("data"),
    now = Date.now,
    setupTtlMs = 600000,
    idleTtlMs = 28800000,
    loginWindowMs = 900000,
    maxLoginFailures = 5,
  } = {}) {
    this.filePath = path.join(directory, "admin.json");
    this.now = now;
    this.setupTtlMs = setupTtlMs;
    this.idleTtlMs = idleTtlMs;
    this.loginWindowMs = loginWindowMs;
    this.maxLoginFailures = maxLoginFailures;
  }

  async load() {
    try {
      const stored = await readJson(this.filePath);
      if (stored.username !== "admin" || !stored.salt || !stored.hash) throw new Error("Invalid admin credentials file");
      this.#credentials = stored;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this.isConfigured();
  }

  isConfigured() {
    return this.#credentials !== null;
  }

  createSetupToken() {
    if (this.isConfigured()) throw new Error("Administrator is already configured");
    const token = secret();
    this.#setup = {
      hash: crypto.createHash("sha256").update(token).digest("hex"),
      expiresAt: this.now() + this.setupTtlMs,
    };
    return token;
  }

  async setup(token, password) {
    if (this.isConfigured()) throw new Error("Administrator is already configured");
    if (String(password).length < 12) throw new TypeError("Password must contain at least 12 characters");
    if (!this.#setup) throw new Error("Setup token is not available");
    if (this.now() > this.#setup.expiresAt) {
      this.#setup = null;
      throw new Error("Setup token has expired");
    }
    const candidate = crypto.createHash("sha256").update(String(token)).digest("hex");
    if (!safeEqual(candidate, this.#setup.hash)) throw new Error("Invalid setup token");
    const salt = crypto.randomBytes(16);
    const hash = await pbkdf2(String(password), salt, ITERATIONS, 64, DIGEST);
    const credentials = {
      username: "admin",
      salt: salt.toString("base64"),
      hash: hash.toString("base64"),
      iterations: ITERATIONS,
      digest: DIGEST,
    };
    await writeJsonAtomic(this.filePath, credentials);
    this.#credentials = credentials;
    this.#setup = null;
  }

  async verifyPassword(password) {
    if (!this.#credentials) return false;
    const salt = Buffer.from(this.#credentials.salt, "base64");
    const expected = Buffer.from(this.#credentials.hash, "base64");
    const actual = await pbkdf2(
      String(password),
      salt,
      this.#credentials.iterations,
      expected.length,
      this.#credentials.digest,
    );
    return crypto.timingSafeEqual(expected, actual);
  }

  createSession() {
    if (!this.isConfigured()) throw new Error("Administrator is not configured");
    const id = secret();
    const session = { id, csrf: secret(), lastSeen: this.now() };
    this.#sessions.set(id, session);
    return { ...session };
  }

  authenticate(id) {
    const session = this.#sessions.get(String(id));
    if (!session) return null;
    if (this.now() - session.lastSeen > this.idleTtlMs) {
      this.#sessions.delete(String(id));
      return null;
    }
    session.lastSeen = this.now();
    return { ...session };
  }

  validateCsrf(id, token) {
    const session = this.authenticate(id);
    return Boolean(session && safeEqual(session.csrf, token));
  }

  destroySession(id) {
    this.#sessions.delete(String(id));
  }

  async login(source, password) {
    const key = String(source || "unknown");
    const now = this.now();
    const previous = (this.#failures.get(key) || []).filter((time) => now - time < this.loginWindowMs);
    if (previous.length >= this.maxLoginFailures) throw new Error("Too many login attempts");
    if (!(await this.verifyPassword(password))) {
      previous.push(now);
      this.#failures.set(key, previous);
      throw new Error("Invalid credentials");
    }
    this.#failures.delete(key);
    return this.createSession();
  }
}

module.exports = { AuthManager, DIGEST, ITERATIONS, safeEqual };
