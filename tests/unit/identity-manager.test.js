"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AuthManager } = require("../../src/admin/auth-manager");
const { IdentityManager } = require("../../src/admin/identity-manager");
const { SqliteStore } = require("../../src/storage/sqlite-store");

test("identity manager provisions the first owner and persists revocable sessions", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-identity-"));
  const storage = new SqliteStore({ directory, now: () => new Date("2026-08-12T10:00:00.000Z") });
  storage.open();
  t.after(() => storage.close());
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const now = Date.parse("2026-08-12T10:00:00.000Z");
  const identities = new IdentityManager({ storage, now: () => now });

  assert.equal(await identities.load(), false);
  const setupToken = identities.createSetupToken();
  await identities.setup(setupToken, "correct horse battery");
  assert.equal(await identities.load(), true);
  assert.equal(storage.getUserByUsername("admin").role, "owner");

  const session = await identities.login("192.0.2.10", "admin", "correct horse battery");
  assert.equal(session.identity.username, "admin");
  assert.equal(session.identity.role, "owner");
  assert.equal(identities.authenticate(session.id).identity.id, session.identity.id);
  assert.equal(identities.validateCsrf(session.id, session.csrf), true);

  const reloaded = new IdentityManager({ storage, now: () => now });
  await reloaded.load();
  assert.equal(reloaded.authenticate(session.id).identity.username, "admin");
  reloaded.destroySession(session.id);
  assert.equal(reloaded.authenticate(session.id), null);
});

test("invitations, disabled users and custom roles enforce permissions", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-identity-"));
  const storage = new SqliteStore({ directory, now: () => new Date("2026-08-12T10:00:00.000Z") });
  storage.open();
  t.after(() => storage.close());
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const identities = new IdentityManager({ storage, now: () => Date.parse("2026-08-12T10:00:00.000Z") });
  await identities.load();
  await identities.setup(identities.createSetupToken(), "correct horse battery");
  const owner = storage.getUserByUsername("admin");

  identities.createRole(owner, { id: "dns-editor", name: "DNS editor", permissions: ["dns:read", "dns:write"] });
  const invitation = identities.createInvitation(owner, { username: "editor", role: "dns-editor", ttlMs: 3600000 });
  assert.match(invitation.token, /^s12_inv_/);
  assert.equal(JSON.stringify(storage.getInvitationByTokenHash(invitation.tokenHash)).includes(invitation.token), false);
  const editor = await identities.acceptInvitation(invitation.token, "editor secure password", "Editor");
  assert.equal(editor.role, "dns-editor");

  const session = await identities.login("192.0.2.11", "editor", "editor secure password");
  assert.equal(identities.authorize(session.id, "dns:write"), true);
  assert.equal(identities.authorize(session.id, "proxy:write"), false);
  identities.updateUser(owner, editor.id, { enabled: false });
  assert.equal(identities.authenticate(session.id), null);
});

test("API tokens are shown once, scoped, expiring, revocable and track last use", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-identity-"));
  const storage = new SqliteStore({ directory, now: () => new Date("2026-08-12T10:00:00.000Z") });
  storage.open();
  t.after(() => storage.close());
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = Date.parse("2026-08-12T10:00:00.000Z");
  const identities = new IdentityManager({ storage, now: () => now });
  await identities.load();
  await identities.setup(identities.createSetupToken(), "correct horse battery");
  const owner = storage.getUserByUsername("admin");

  const issued = identities.createApiToken(owner, {
    name: "DNS automation",
    scopes: ["dns:read", "dns:write"],
    expiresAt: "2026-08-13T10:00:00.000Z",
  });
  assert.match(issued.token, /^s12_api_/);
  assert.equal(storage.getApiTokenByHash(issued.tokenHash).tokenHash.includes(issued.token), false);
  assert.equal(identities.authenticateBearer(issued.token, "dns:write").identity.username, "admin");
  assert.equal(identities.authenticateBearer(issued.token, "proxy:write"), null);
  assert.equal(storage.getApiTokenByHash(issued.tokenHash).lastUsedAt, "2026-08-12T10:00:00.000Z");

  identities.revokeApiToken(owner, issued.id);
  assert.equal(identities.authenticateBearer(issued.token, "dns:read"), null);
  const expired = identities.createApiToken(owner, {
    name: "Expired",
    scopes: ["dns:read"],
    expiresAt: "2026-08-12T10:01:00.000Z",
  });
  now += 61000;
  assert.equal(identities.authenticateBearer(expired.token, "dns:read"), null);
});

test("legacy admin credentials migrate to the SQLite owner without changing the password", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-identity-migrate-"));
  const legacy = new AuthManager({ directory });
  await legacy.load();
  await legacy.setup(legacy.createSetupToken(), "correct horse battery");
  const storage = new SqliteStore({ directory });
  storage.open();
  t.after(() => storage.close());
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const identities = new IdentityManager({ storage, directory });
  assert.equal(await identities.load(), true);
  assert.equal(storage.getUserByUsername("admin").role, "owner");
  assert.equal((await identities.login("127.0.0.1", "admin", "correct horse battery")).identity.role, "owner");
});

test("identity management lists public records and revokes user sessions", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-identity-admin-"));
  const storage = new SqliteStore({ directory });
  storage.open();
  t.after(() => storage.close());
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const identities = new IdentityManager({ storage });
  await identities.load();
  await identities.setup(identities.createSetupToken(), "correct horse battery");
  const owner = storage.getUserByUsername("admin");
  identities.createRole(owner, { id: "dns-reader", name: "DNS reader", permissions: ["dns:read"] });
  const invitation = identities.createInvitation(owner, { username: "reader", role: "dns-reader" });
  const reader = await identities.acceptInvitation(invitation.token, "reader secure password", "Reader");
  const readerSession = await identities.login("192.0.2.30", "reader", "reader secure password");
  const token = identities.createApiToken(owner, { name: "Owner DNS", scopes: ["dns:read"] });

  assert.equal(JSON.stringify(identities.listUsers(owner)).includes("passwordHash"), false);
  assert.equal(identities.listUsers(owner).some((user) => user.username === "reader"), true);
  assert.equal(identities.listRoles(owner).some((role) => role.id === "dns-reader" && role.customRole), true);
  assert.equal(JSON.stringify(identities.listInvitations(owner)).includes("tokenHash"), false);
  assert.equal(JSON.stringify(identities.listApiTokens(owner)).includes("tokenHash"), false);
  assert.equal(identities.listApiTokens(owner).some((item) => item.id === token.id), true);
  assert.equal(identities.revokeUserSessions(owner, reader.id), 1);
  assert.equal(identities.authenticate(readerSession.id), null);
});
