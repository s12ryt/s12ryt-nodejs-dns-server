"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { promisify } = require("node:util");

const { DIGEST, ITERATIONS, safeEqual } = require("./auth-manager");
const { FIXED_ROLES, isAllowed, normalizeCustomRole, permissionsForRole } = require("./access-control");
const { readJson } = require("./atomic-file");

const pbkdf2 = promisify(crypto.pbkdf2);
const USERNAME = /^[a-z0-9](?:[a-z0-9._-]{1,62}[a-z0-9])?$/i;

function randomSecret(prefix) {
  return `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
}

function hashSecret(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function validatePassword(password) {
  const value = String(password);
  if (value.length < 12 || value.length > 1024) throw new TypeError("Password must contain between 12 and 1024 characters");
  return value;
}

async function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = await pbkdf2(validatePassword(password), salt, ITERATIONS, 64, DIGEST);
  return `pbkdf2-${DIGEST}$${ITERATIONS}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function verifyPassword(password, encoded) {
  const [algorithm, iterations, saltValue, hashValue] = String(encoded).split("$");
  if (algorithm !== `pbkdf2-${DIGEST}` || !/^\d+$/.test(iterations) || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, "base64");
  const actual = await pbkdf2(String(password), Buffer.from(saltValue, "base64"), Number(iterations), expected.length, DIGEST);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

class IdentityManager {
  #setup = null;
  #failures = new Map();

  constructor({
    storage,
    directory = path.resolve("data"),
    now = Date.now,
    setupTtlMs = 600000,
    idleTtlMs = 28800000,
    loginWindowMs = 900000,
    maxLoginFailures = 5,
  } = {}) {
    if (!storage) throw new TypeError("Identity storage is required");
    this.storage = storage;
    this.legacyFilePath = path.join(directory, "admin.json");
    this.now = now;
    this.setupTtlMs = setupTtlMs;
    this.idleTtlMs = idleTtlMs;
    this.loginWindowMs = loginWindowMs;
    this.maxLoginFailures = maxLoginFailures;
  }

  async load() {
    if (this.storage.listUsers().length === 0) await this.#migrateLegacyAdministrator();
    return this.isConfigured();
  }

  isConfigured() {
    return this.storage.listUsers().some((user) => user.role === "owner" && user.enabled);
  }

  createSetupToken() {
    if (this.isConfigured()) throw new Error("Administrator is already configured");
    const token = randomSecret("s12_setup_");
    this.#setup = { hash: hashSecret(token), expiresAt: this.now() + this.setupTtlMs };
    return token;
  }

  async setup(token, password) {
    if (this.isConfigured()) throw new Error("Administrator is already configured");
    if (!this.#setup) throw new Error("Setup token is not available");
    if (this.now() > this.#setup.expiresAt) {
      this.#setup = null;
      throw new Error("Setup token has expired");
    }
    if (!safeEqual(hashSecret(token), this.#setup.hash)) throw new Error("Invalid setup token");
    this.storage.createUser({
      id: crypto.randomUUID(),
      username: "admin",
      displayName: "Owner",
      role: "owner",
      passwordHash: await passwordHash(password),
      enabled: true,
    });
    this.#setup = null;
  }

  createSession(user = this.storage.listUsers().find((candidate) => candidate.enabled && candidate.role === "owner"), source = "setup") {
    if (!user) throw new Error("Administrator is not configured");
    return this.#createSession(user, source);
  }

  async login(source, username, password) {
    const key = `${String(source || "unknown")}\0${String(username).toLowerCase()}`;
    const now = this.now();
    const failures = (this.#failures.get(key) || []).filter((time) => now - time < this.loginWindowMs);
    if (failures.length >= this.maxLoginFailures) throw new Error("Too many login attempts");
    const user = this.storage.getUserByUsername(String(username));
    if (!user?.enabled || !(await verifyPassword(password, user.passwordHash))) {
      failures.push(now);
      this.#failures.set(key, failures);
      throw new Error("Invalid credentials");
    }
    this.#failures.delete(key);
    return this.createSession(user, source);
  }

  authenticate(id) {
    const idHash = hashSecret(id);
    const session = this.storage.getSessionRecord(idHash);
    const now = this.now();
    if (!session || session.revokedAt || Date.parse(session.expiresAt) <= now
      || now - Date.parse(session.lastSeenAt) > this.idleTtlMs) return null;
    const user = this.#userById(session.userId);
    if (!user?.enabled) return null;
    const lastSeenAt = new Date(now).toISOString();
    this.storage.touchSession(idHash, lastSeenAt);
    return { session: { ...session, lastSeenAt }, identity: this.#identity(user) };
  }

  validateCsrf(id, token) {
    const authenticated = this.authenticate(id);
    return Boolean(authenticated && safeEqual(hashSecret(token), authenticated.session.csrfHash));
  }

  destroySession(id) {
    return this.storage.revokeSession(hashSecret(id));
  }

  authorize(id, permission) {
    const authenticated = this.authenticate(id);
    return Boolean(authenticated && isAllowed(authenticated.identity, permission));
  }

  createRole(actor, value) {
    this.#require(actor, "roles:write");
    return this.storage.createRole(normalizeCustomRole(value));
  }

  listRoles(actor) {
    this.#require(actor, "roles:read");
    const fixedNames = { owner: "Owner", admin: "Administrator", operator: "Operator", viewer: "Viewer" };
    const fixed = Object.entries(FIXED_ROLES).map(([id, permissions]) => ({
      id,
      name: fixedNames[id],
      permissions: [...permissions],
      customRole: false,
    }));
    const custom = this.storage.listRoles().map((role) => ({ ...role, customRole: true }));
    return [...fixed, ...custom];
  }

  listUsers(actor) {
    this.#require(actor, "users:read");
    return this.storage.listUsers().map((user) => this.#identity(user));
  }

  listInvitations(actor) {
    this.#require(actor, "users:read");
    return this.storage.listInvitations().map(({ tokenHash: _tokenHash, ...invitation }) => invitation);
  }

  createInvitation(actor, { username, role, ttlMs = 86400000 } = {}) {
    this.#require(actor, "users:write");
    const normalizedUsername = String(username || "").trim().toLowerCase();
    this.#validateUsername(normalizedUsername);
    this.#assertRole(role);
    if (!Number.isInteger(ttlMs) || ttlMs < 60000 || ttlMs > 7 * 86400000) throw new RangeError("Invitation lifetime is invalid");
    if (this.storage.getUserByUsername(normalizedUsername)) throw new Error(`User already exists: ${normalizedUsername}`);
    const token = randomSecret("s12_inv_");
    const tokenHash = hashSecret(token);
    const invitation = this.storage.createInvitation({
      id: crypto.randomUUID(),
      tokenHash,
      username: normalizedUsername,
      role,
      expiresAt: new Date(this.now() + ttlMs).toISOString(),
      createdBy: actor.id,
    });
    return { ...invitation, token, tokenHash };
  }

  async acceptInvitation(token, password, displayName) {
    const invitation = this.storage.getInvitationByTokenHash(hashSecret(token));
    if (!invitation || invitation.usedAt || Date.parse(invitation.expiresAt) <= this.now()) throw new Error("Invitation is invalid or expired");
    const user = this.storage.createUser({
      id: crypto.randomUUID(),
      username: invitation.username,
      displayName: String(displayName || invitation.username).trim(),
      role: invitation.role,
      passwordHash: await passwordHash(password),
      enabled: true,
    });
    this.storage.consumeInvitation(invitation.id, new Date(this.now()).toISOString());
    return this.#identity(user);
  }

  updateUser(actor, id, patch) {
    this.#require(actor, "users:write");
    const current = this.#userById(id);
    if (!current) throw new Error(`User not found: ${id}`);
    if (patch.role !== undefined) this.#assertRole(patch.role);
    const nextEnabled = patch.enabled ?? current.enabled;
    const nextRole = patch.role ?? current.role;
    if (current.role === "owner" && current.enabled && (!nextEnabled || nextRole !== "owner")) {
      const otherOwners = this.storage.listUsers().filter((user) => user.id !== id && user.enabled && user.role === "owner");
      if (otherOwners.length === 0) throw new Error("The last enabled owner cannot be removed or disabled");
    }
    const updated = this.storage.updateUser(id, patch);
    if (updated.enabled === false || updated.role !== current.role) this.storage.revokeUserSessions(id);
    return this.#identity(updated);
  }

  createApiToken(actor, { name, scopes, expiresAt = null } = {}) {
    this.#require(actor, "users:write");
    if (typeof name !== "string" || !name.trim() || name.length > 100 || !Array.isArray(scopes) || scopes.length === 0) {
      throw new TypeError("API token request is invalid");
    }
    const allowed = permissionsForRole(Object.hasOwn(FIXED_ROLES, actor.role) ? actor.role : actor);
    const normalizedScopes = [...new Set(scopes.map(String))].sort();
    if (normalizedScopes.some((scope) => !allowed.has(scope))) throw new Error("API token scope exceeds actor permissions");
    if (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt))) throw new TypeError("API token expiry is invalid");
    const token = randomSecret("s12_api_");
    const tokenHash = hashSecret(token);
    const record = this.storage.createApiToken({
      id: crypto.randomUUID(),
      userId: actor.id,
      name: name.trim(),
      tokenHash,
      scopes: normalizedScopes,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt,
    });
    return { ...record, token, tokenHash };
  }

  listApiTokens(actor) {
    this.#require(actor, "users:read");
    return this.storage.listApiTokens().map(({ tokenHash: _tokenHash, ...token }) => token);
  }

  revokeUserSessions(actor, userId) {
    this.#require(actor, "users:write");
    if (!this.#userById(userId)) throw new Error(`User not found: ${userId}`);
    return this.storage.revokeUserSessions(userId);
  }

  authenticateBearer(token, permission) {
    const record = this.storage.getApiTokenByHash(hashSecret(token));
    if (!record || record.revokedAt || (record.expiresAt && Date.parse(record.expiresAt) <= this.now())
      || (permission && !record.scopes.includes(permission))) return null;
    const user = this.#userById(record.userId);
    if (!user?.enabled) return null;
    const identity = this.#identity(user);
    if (permission && !isAllowed(identity, permission)) return null;
    this.storage.markApiTokenUsed(record.id, new Date(this.now()).toISOString());
    return { identity, token: { ...record, tokenHash: undefined } };
  }

  revokeApiToken(actor, id) {
    this.#require(actor, "users:write");
    return this.storage.revokeApiToken(id);
  }

  #createSession(user, source) {
    const id = randomSecret("s12_session_");
    const csrf = randomSecret("s12_csrf_");
    const createdAt = new Date(this.now()).toISOString();
    this.storage.createSessionRecord({
      idHash: hashSecret(id),
      userId: user.id,
      csrfHash: hashSecret(csrf),
      csrf,
      createdAt,
      lastSeenAt: createdAt,
      expiresAt: new Date(this.now() + this.idleTtlMs).toISOString(),
      sourceIp: String(source || "unknown"),
    });
    return { id, csrf, identity: this.#identity(user) };
  }

  #identity(user) {
    const custom = Object.hasOwn(FIXED_ROLES, user.role)
      ? null : this.storage.listRoles().find((role) => role.id === user.role);
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      roleId: user.role,
      customRole: Boolean(custom),
      permissions: [...permissionsForRole(custom || user.role)].sort(),
      enabled: user.enabled,
    };
  }

  #userById(id) {
    return this.storage.listUsers().find((user) => user.id === id) || null;
  }

  #assertRole(role) {
    if (Object.hasOwn(FIXED_ROLES, role)) return;
    if (!this.storage.listRoles().some((candidate) => candidate.id === role)) throw new Error(`Unknown role: ${role}`);
  }

  #validateUsername(username) {
    if (!USERNAME.test(username)) throw new TypeError("Username is invalid");
  }

  #require(actor, permission) {
    if (!isAllowed(actor, permission)) throw new Error(`Permission denied: ${permission}`);
  }

  async #migrateLegacyAdministrator() {
    let legacy;
    try {
      legacy = await readJson(this.legacyFilePath);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (legacy.username !== "admin" || !legacy.salt || !legacy.hash
      || !Number.isInteger(legacy.iterations) || legacy.iterations < 1 || legacy.digest !== DIGEST) {
      throw new Error("Invalid legacy administrator credentials file");
    }
    this.storage.createUser({
      id: crypto.randomUUID(),
      username: "admin",
      displayName: "Owner",
      role: "owner",
      passwordHash: `pbkdf2-${DIGEST}$${legacy.iterations}$${legacy.salt}$${legacy.hash}`,
      enabled: true,
    });
  }
}

module.exports = {
  IdentityManager,
  USERNAME,
  hashSecret,
  passwordHash,
  validatePassword,
  verifyPassword,
};
