"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  FIXED_ROLES,
  OWNER_ONLY_PERMISSIONS,
  normalizeCustomRole,
  permissionsForRole,
  isAllowed,
} = require("../../src/admin/access-control");

test("fixed roles expose stable least-privilege permission sets", () => {
  assert.deepEqual(Object.keys(FIXED_ROLES), ["owner", "admin", "operator", "viewer"]);
  assert.equal(isAllowed({ role: "owner" }, "users:write"), true);
  assert.equal(isAllowed({ role: "admin" }, "dns:write"), true);
  assert.equal(isAllowed({ role: "admin" }, "backup:download-sensitive"), false);
  assert.equal(isAllowed({ role: "operator" }, "proxy:operate"), true);
  assert.equal(isAllowed({ role: "operator" }, "users:read"), false);
  assert.equal(isAllowed({ role: "viewer" }, "dns:read"), true);
  assert.equal(isAllowed({ role: "viewer" }, "dns:write"), false);
});

test("custom roles accept known permissions but can never grant owner-only access", () => {
  assert.deepEqual(OWNER_ONLY_PERMISSIONS, ["backup:download-sensitive", "logs:read-sensitive"]);
  const role = normalizeCustomRole({
    id: "dns-editor",
    name: "DNS editor",
    permissions: ["dns:write", "dns:read", "dns:write"],
  });
  assert.deepEqual(role.permissions, ["dns:read", "dns:write"]);
  assert.deepEqual(permissionsForRole(role), new Set(["dns:read", "dns:write"]));
  assert.equal(isAllowed({ role: "custom", permissions: role.permissions }, "dns:write"), true);
  assert.equal(isAllowed({ role: "custom", permissions: role.permissions }, "proxy:write"), false);

  assert.throws(() => normalizeCustomRole({
    id: "unsafe",
    name: "Unsafe",
    permissions: ["backup:download-sensitive"],
  }), /owner-only/i);
  assert.throws(() => normalizeCustomRole({ id: "bad", name: "Bad", permissions: ["root:all"] }), /unknown/i);
});

test("disabled identities are denied before role evaluation", () => {
  assert.equal(isAllowed({ role: "owner", enabled: false }, "dns:read"), false);
  assert.equal(isAllowed(null, "dns:read"), false);
});
