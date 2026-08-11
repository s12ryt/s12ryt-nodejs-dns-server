"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { accessForRequest } = require("../../src/admin/admin-access");

test("admin routes map to stable least-privilege access requirements", () => {
  assert.equal(accessForRequest("GET", "/api/bootstrap"), null);
  assert.deepEqual(accessForRequest("GET", "/api/config"), { permission: "dns:read" });
  assert.deepEqual(accessForRequest("PUT", "/api/config"), { administratorOnly: true });
  assert.deepEqual(accessForRequest("POST", "/api/dns/diagnose"), { permission: "dns:read" });
  assert.deepEqual(accessForRequest("POST", "/api/zones/example.test/records/batch"), { permission: "dns:write" });
  assert.deepEqual(accessForRequest("GET", "/api/proxy/operations"), { permission: "proxy:read" });
  assert.deepEqual(accessForRequest("POST", "/api/proxy/sites/app.test/drain"), { permission: "proxy:operate" });
  assert.deepEqual(accessForRequest("GET", "/api/backups/s12-manual-20260812T010000Z.zip/download"), {
    permission: "backup:download-sensitive",
  });
  assert.deepEqual(accessForRequest("POST", "/api/tunnel/start"), { permission: "tunnel:operate" });
  assert.deepEqual(accessForRequest("GET", "/api/events"), { permission: "logs:read" });
  assert.deepEqual(accessForRequest("GET", "/api/users"), { permission: "users:read" });
  assert.deepEqual(accessForRequest("POST", "/api/users/invitations"), { permission: "users:write" });
  assert.deepEqual(accessForRequest("POST", "/api/invitations/token/accept"), null);
  assert.deepEqual(accessForRequest("POST", "/api/roles"), { permission: "roles:write" });
  assert.deepEqual(accessForRequest("DELETE", "/api/tokens/id"), { permission: "users:write" });
  assert.equal(accessForRequest("GET", "/api/not-found"), undefined);
});
