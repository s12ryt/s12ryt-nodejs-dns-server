"use strict";

const { randomUUID } = require("node:crypto");

const OPENAPI = Object.freeze({
  openapi: "3.1.0",
  info: { title: "S12 DNS Server API", version: "2.0.0" },
  paths: {
    "/api/v2/dns/zones": {
      get: { summary: "List primary DNS zones", security: [{ sessionCookie: [] }, { bearerAuth: [] }] },
      post: { summary: "Create a primary DNS zone", security: [{ sessionCookie: [] }, { bearerAuth: [] }] },
    },
    "/api/v2/proxy/sites": {
      get: { summary: "List proxy sites", security: [{ sessionCookie: [] }, { bearerAuth: [] }] },
      post: { summary: "Create a proxy site", security: [{ sessionCookie: [] }, { bearerAuth: [] }] },
    },
    "/api/v2/tunnel": { get: { summary: "Get Tunnel status", security: [{ sessionCookie: [] }, { bearerAuth: [] }] } },
    "/api/v2/backups": { get: { summary: "List backups", security: [{ sessionCookie: [] }, { bearerAuth: [] }] } },
    "/api/v2/audit": { get: { summary: "List audit entries", security: [{ sessionCookie: [] }, { bearerAuth: [] }] } },
    "/api/v2/users": { get: { summary: "List users", security: [{ sessionCookie: [] }, { bearerAuth: [] }] } },
    "/api/v2/roles": {
      get: { summary: "List roles", security: [{ sessionCookie: [] }, { bearerAuth: [] }] },
      post: {
        summary: "Create a custom role",
        security: [{ sessionCookie: [] }, { bearerAuth: [] }],
        parameters: [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 128 } }],
      },
    },
  },
  components: {
    securitySchemes: {
      sessionCookie: { type: "apiKey", in: "cookie", name: "s12_session" },
      bearerAuth: { type: "http", scheme: "bearer" },
    },
  },
});

function integerQuery(url, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw Object.assign(new Error(`${name} is invalid`), { statusCode: 400, code: "INVALID_QUERY" });
  }
  return value;
}

function errorCode(error, statusCode) {
  if (error.code) return error.code;
  if (statusCode === 409 && /different request/i.test(error.message)) return "IDEMPOTENCY_KEY_CONFLICT";
  if (statusCode === 409) return "CONFLICT";
  if (statusCode === 403) return "FORBIDDEN";
  if (statusCode === 401) return "UNAUTHORIZED";
  if (statusCode === 404) return "NOT_FOUND";
  if (statusCode === 400) return "INVALID_REQUEST";
  return "INTERNAL_ERROR";
}

function sendV2Json(sendJson, response, statusCode, value, { requestId, headers = {} } = {}) {
  sendJson(response, statusCode, value, { "x-request-id": requestId, ...headers });
}

function sendV2Error(sendJson, response, error, requestId) {
  const statusCode = error.statusCode || 500;
  sendV2Json(sendJson, response, statusCode, {
    error: { code: errorCode(error, statusCode), message: statusCode >= 500 ? "Internal server error" : error.message, requestId },
  }, { requestId });
}

function actorId(authorized) {
  return authorized.bearer ? `api-token:${authorized.token.id}` : `user:${authorized.identity.id}`;
}

function paginated(data, { limit, offset, total = data.length, requestId }) {
  return { data: data.slice(offset, offset + limit), meta: { requestId, pagination: { limit, offset, total } } };
}

async function idempotentMutation({ request, url, authorized, idempotency, readJsonBody, operation }) {
  if (!idempotency || typeof idempotency.execute !== "function") {
    throw Object.assign(new Error("Idempotency service is unavailable"), { statusCode: 501 });
  }
  const key = request.headers["idempotency-key"];
  if (!key) throw Object.assign(new Error("Idempotency-Key is required"), { statusCode: 400, code: "IDEMPOTENCY_KEY_REQUIRED" });
  const body = await readJsonBody(request);
  return idempotency.execute({
    actorId: actorId(authorized), key: String(key), method: request.method, path: url.pathname, body,
  }, () => operation(body));
}

async function handleApiV2({
  request, response, url, authorized, auth, audit, auditMutation, config, tunnel, listBackups,
  idempotency, readJsonBody, sendJson,
}) {
  if (!url.pathname.startsWith("/api/v2/")) return false;
  const requestId = String(request.headers["x-request-id"] || randomUUID());
  try {
    if (request.method === "GET" && url.pathname === "/api/v2/dns/zones") {
      const limit = integerQuery(url, "limit", 50, { min: 1, max: 200 });
      const offset = integerQuery(url, "offset", 0);
      const zones = config.get().domains;
      sendV2Json(sendJson, response, 200, paginated(zones, { limit, offset, requestId }), { requestId });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/v2/dns/zones") {
      const result = await idempotentMutation({
        request, url, authorized, idempotency, readJsonBody,
        operation: async (body) => {
          const current = config.get();
          if (current.domains.some((zone) => zone.name === String(body.name || "").toLowerCase().replace(/\.$/, ""))) {
            throw Object.assign(new Error("DNS zone already exists"), { statusCode: 409 });
          }
          const updated = await config.update({ ...current, domains: [...current.domains, body] });
          const zone = updated.domains.find((candidate) => candidate.name === String(body.name).toLowerCase().replace(/\.$/, ""));
          auditMutation(request, authorized, { action: "zone.create", resource: `zone:${zone.name}`, after: zone, requestId });
          return { statusCode: 201, body: { data: zone, meta: { requestId, idempotencyReplayed: false } } };
        },
      });
      sendV2Json(sendJson, response, result.statusCode, result.body, {
        requestId: result.body?.meta?.requestId || requestId,
        headers: result.replayed ? { "idempotency-replayed": "true" } : {},
      });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/v2/proxy/sites") {
      const limit = integerQuery(url, "limit", 50, { min: 1, max: 200 });
      const offset = integerQuery(url, "offset", 0);
      let sites = config.get().routes;
      const enabled = url.searchParams.get("enabled");
      if (enabled !== null) {
        if (!new Set(["true", "false"]).has(enabled)) throw Object.assign(new Error("enabled is invalid"), { statusCode: 400, code: "INVALID_QUERY" });
        sites = sites.filter((site) => site.enabled === (enabled === "true"));
      }
      sendV2Json(sendJson, response, 200, paginated(sites, { limit, offset, requestId }), { requestId });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/v2/proxy/sites") {
      const result = await idempotentMutation({
        request, url, authorized, idempotency, readJsonBody,
        operation: async (body) => {
          const current = config.get();
          const host = String(body.host || "").toLowerCase().replace(/\.$/, "");
          if (current.routes.some((site) => site.host === host)) throw Object.assign(new Error("Proxy site already exists"), { statusCode: 409 });
          const updated = await config.update({ ...current, routes: [...current.routes, body] });
          const site = updated.routes.find((candidate) => candidate.host === host);
          auditMutation(request, authorized, { action: "proxy-site.create", resource: `proxy-site:${site.host}`, after: site, requestId });
          return { statusCode: 201, body: { data: site, meta: { requestId, idempotencyReplayed: false } } };
        },
      });
      sendV2Json(sendJson, response, result.statusCode, result.body, {
        requestId: result.body?.meta?.requestId || requestId,
        headers: result.replayed ? { "idempotency-replayed": "true" } : {},
      });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/v2/tunnel") {
      sendV2Json(sendJson, response, 200, { data: tunnel.status(), meta: { requestId } }, { requestId });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/v2/backups") {
      if (typeof listBackups !== "function") throw Object.assign(new Error("Backup listing is unavailable"), { statusCode: 501 });
      const limit = integerQuery(url, "limit", 50, { min: 1, max: 200 });
      const offset = integerQuery(url, "offset", 0);
      const backups = await listBackups();
      sendV2Json(sendJson, response, 200, paginated(backups, { limit, offset, requestId }), { requestId });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/v2/audit") {
      if (!audit || typeof audit.list !== "function") throw Object.assign(new Error("Audit history is unavailable"), { statusCode: 501 });
      const limit = integerQuery(url, "limit", 100, { min: 1, max: 1000 });
      const offset = integerQuery(url, "offset", 0);
      const result = audit.list({
        action: url.searchParams.get("action") || undefined,
        actorId: url.searchParams.get("actorId") || undefined,
        resource: url.searchParams.get("resource") || undefined,
        limit,
        offset,
      });
      sendV2Json(sendJson, response, 200, { data: result.items, meta: { requestId, pagination: { limit, offset, total: result.total } } }, { requestId });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/v2/users") {
      const limit = integerQuery(url, "limit", 50, { min: 1, max: 200 });
      const offset = integerQuery(url, "offset", 0);
      let users = auth.listUsers(authorized.identity);
      const role = url.searchParams.get("role");
      const enabled = url.searchParams.get("enabled");
      if (role) users = users.filter((user) => user.role === role);
      if (enabled !== null) {
        if (!new Set(["true", "false"]).has(enabled)) throw Object.assign(new Error("enabled is invalid"), { statusCode: 400, code: "INVALID_QUERY" });
        users = users.filter((user) => user.enabled === (enabled === "true"));
      }
      sendV2Json(sendJson, response, 200, {
        data: users.slice(offset, offset + limit),
        meta: { requestId, pagination: { limit, offset, total: users.length } },
      }, { requestId });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/v2/roles") {
      const roles = auth.listRoles(authorized.identity);
      sendV2Json(sendJson, response, 200, { data: roles, meta: { requestId } }, { requestId });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/v2/roles") {
      const result = await idempotentMutation({ request, url, authorized, idempotency, readJsonBody, operation: async (body) => {
        const role = auth.createRole(authorized.identity, body);
        auditMutation(request, authorized, { action: "role.create", resource: `role:${role.id}`, after: role, requestId });
        return { statusCode: 201, body: { data: { ...role, customRole: true }, meta: { requestId, idempotencyReplayed: false } } };
      } });
      sendV2Json(sendJson, response, result.statusCode, result.body, {
        requestId: result.body?.meta?.requestId || requestId,
        headers: result.replayed ? { "idempotency-replayed": "true" } : {},
      });
      return true;
    }
    throw Object.assign(new Error("API endpoint not found"), { statusCode: 404, code: "NOT_FOUND" });
  } catch (error) {
    sendV2Error(sendJson, response, error, requestId);
    return true;
  }
}

module.exports = { OPENAPI, handleApiV2, integerQuery, sendV2Error };
