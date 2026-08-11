"use strict";

const OWNER_ONLY_PERMISSIONS = Object.freeze([
  "backup:download-sensitive",
  "logs:read-sensitive",
]);

const PERMISSIONS = Object.freeze([
  "audit:read",
  "backup:create",
  "backup:delete",
  "backup:download-sensitive",
  "backup:read",
  "backup:restore",
  "dns:operate",
  "dns:read",
  "dns:write",
  "logs:read",
  "logs:read-sensitive",
  "proxy:operate",
  "proxy:read",
  "proxy:write",
  "roles:read",
  "roles:write",
  "tunnel:operate",
  "tunnel:read",
  "tunnel:write",
  "users:read",
  "users:write",
]);

const VIEWER_PERMISSIONS = Object.freeze([
  "audit:read",
  "backup:read",
  "dns:read",
  "logs:read",
  "proxy:read",
  "tunnel:read",
]);

const OPERATOR_PERMISSIONS = Object.freeze([
  ...VIEWER_PERMISSIONS,
  "dns:operate",
  "proxy:operate",
  "tunnel:operate",
].sort());

const ADMIN_PERMISSIONS = Object.freeze(PERMISSIONS.filter((permission) =>
  !OWNER_ONLY_PERMISSIONS.includes(permission)).sort());

const FIXED_ROLES = Object.freeze({
  owner: Object.freeze([...PERMISSIONS]),
  admin: ADMIN_PERMISSIONS,
  operator: OPERATOR_PERMISSIONS,
  viewer: VIEWER_PERMISSIONS,
});

const ROLE_ID = /^[a-z][a-z0-9-]{1,63}$/;

function normalizeCustomRole(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Custom role must be an object");
  const id = String(value.id || "").trim().toLowerCase();
  const name = String(value.name || "").trim();
  if (!ROLE_ID.test(id) || Object.hasOwn(FIXED_ROLES, id)) throw new TypeError("Custom role id is invalid");
  if (!name || name.length > 100) throw new TypeError("Custom role name is invalid");
  if (!Array.isArray(value.permissions)) throw new TypeError("Custom role permissions must be an array");
  const permissions = [...new Set(value.permissions.map((permission) => String(permission)))].sort();
  for (const permission of permissions) {
    if (!PERMISSIONS.includes(permission)) throw new TypeError(`Unknown permission: ${permission}`);
    if (OWNER_ONLY_PERMISSIONS.includes(permission)) throw new TypeError(`Owner-only permission cannot be delegated: ${permission}`);
  }
  return { id, name, permissions };
}

function permissionsForRole(role) {
  if (typeof role === "string" && Object.hasOwn(FIXED_ROLES, role)) return new Set(FIXED_ROLES[role]);
  if (role && role.id && Object.hasOwn(FIXED_ROLES, role.id)) return new Set(FIXED_ROLES[role.id]);
  if (role && Array.isArray(role.permissions)) return new Set(role.permissions);
  return new Set();
}

function isAllowed(identity, permission) {
  if (!identity || identity.enabled === false || !PERMISSIONS.includes(permission)) return false;
  if (identity.role === "owner") return true;
  if (OWNER_ONLY_PERMISSIONS.includes(permission)) return false;
  if (Object.hasOwn(FIXED_ROLES, identity.role)) return FIXED_ROLES[identity.role].includes(permission);
  return permissionsForRole({ permissions: identity.permissions }).has(permission);
}

module.exports = {
  ADMIN_PERMISSIONS,
  FIXED_ROLES,
  OPERATOR_PERMISSIONS,
  OWNER_ONLY_PERMISSIONS,
  PERMISSIONS,
  VIEWER_PERMISSIONS,
  isAllowed,
  normalizeCustomRole,
  permissionsForRole,
};
