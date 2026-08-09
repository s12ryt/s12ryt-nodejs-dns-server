"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AuthManager } = require("../../src/admin/auth-manager");

test("setup token expires, is one-time, and establishes an idle session with CSRF", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-auth-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = 1_000_000;
  const auth = new AuthManager({ directory, now: () => now, setupTtlMs: 600_000, idleTtlMs: 28_800_000 });
  await auth.load();
  const token = auth.createSetupToken();

  await assert.rejects(auth.setup("wrong", "correct horse battery"), /token/i);
  await auth.setup(token, "correct horse battery");
  await assert.rejects(auth.setup(token, "another secure password"), /already configured|token/i);
  assert.equal(await auth.verifyPassword("correct horse battery"), true);
  assert.equal(await auth.verifyPassword("incorrect password"), false);

  const session = auth.createSession();
  assert.equal(auth.authenticate(session.id).csrf, session.csrf);
  assert.equal(auth.validateCsrf(session.id, session.csrf), true);
  assert.equal(auth.validateCsrf(session.id, "wrong"), false);
  now += 28_800_001;
  assert.equal(auth.authenticate(session.id), null);
});

test("setup rejects short passwords and expired tokens", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-auth-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = 5_000;
  const auth = new AuthManager({ directory, now: () => now, setupTtlMs: 100 });
  await auth.load();
  const token = auth.createSetupToken();
  await assert.rejects(auth.setup(token, "too short"), /12/);
  now += 101;
  await assert.rejects(auth.setup(token, "long enough password"), /expired/i);
});

test("login rate limiting blocks repeated failures by source", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-auth-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const auth = new AuthManager({ directory, maxLoginFailures: 3 });
  await auth.load();
  await auth.setup(auth.createSetupToken(), "correct horse battery");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(auth.login("192.0.2.1", "bad password"), /credentials/i);
  }
  await assert.rejects(auth.login("192.0.2.1", "correct horse battery"), /too many/i);
  const session = await auth.login("192.0.2.2", "correct horse battery");
  assert.ok(session.id);
});
