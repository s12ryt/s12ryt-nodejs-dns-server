"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const { EventLog } = require("./event-log");
const { createDomainPlan, deleteDomainTree, updateDomain } = require("./domains");
const { normalizeHost } = require("../services/proxy-routes");

const COOKIE_NAME = "s12_session";
const MAX_JSON_BODY = 1024 * 1024;
const DIAGNOSTIC_TYPES = new Set(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV"]);

function parseCookies(header) {
  return Object.fromEntries(String(header || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf("=");
    return separator === -1 ? [part, ""] : [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
  }));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      reject(Object.assign(new Error("Content-Type must be application/json"), { statusCode: 415 }));
      return;
    }
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY) {
        reject(Object.assign(new Error("Request body is too large"), { statusCode: 413 }));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(Object.assign(new Error("Request body is not valid JSON"), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, value, headers = {}) {
  const body = value === null ? "" : JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  }).end(body);
}

function sessionCookie(id, { clear = false } = {}) {
  const value = clear ? "" : encodeURIComponent(id);
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 28800}`;
}

function publicConfig(value) {
  const result = structuredClone(value);
  result.tunnel = { hasStoredToken: Boolean(value.tunnel?.token) };
  return result;
}

function redactSecret(value, secret) {
  const message = String(value);
  return secret ? message.split(secret).join("[redacted]") : message;
}

function sendStatic(response, fileName, content) {
  const contentType = fileName.endsWith(".css") ? "text/css; charset=utf-8"
    : fileName.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8";
  response.writeHead(200, {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  }).end(content);
}

function createAdminService({
  auth,
  config,
  tunnel,
  updateTunnelToken,
  clearTunnelToken,
  diagnoseDns,
  clearProxyCache,
  events = new EventLog(),
  status = () => ({}),
  staticDirectory = path.join(__dirname, "..", "web"),
  staticFiles = globalThis.__S12_WEB_ASSETS__ || null,
  host = "0.0.0.0",
  port = 8081,
} = {}) {
  if (!auth || !config || !tunnel) throw new TypeError("auth, config and tunnel are required");
  let server;

  function authorize(request) {
    const id = parseCookies(request.headers.cookie)[COOKIE_NAME];
    const session = auth.authenticate(id);
    return session ? { id, session } : null;
  }

  async function handleApi(request, response, url) {
    if (request.method === "GET" && url.pathname === "/api/bootstrap") {
      sendJson(response, 200, { configured: auth.isConfigured() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/setup") {
      try {
        const body = await readJsonBody(request);
        await auth.setup(body.token, body.password);
        const session = auth.createSession();
        events.add({ kind: "auth", message: "Administrator configured" });
        sendJson(response, 201, { username: "admin", csrf: session.csrf }, { "set-cookie": sessionCookie(session.id) });
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/login") {
      try {
        const body = await readJsonBody(request);
        if (body.username !== "admin") throw new Error("Invalid credentials");
        const session = await auth.login(request.socket.remoteAddress, body.password);
        events.add({ kind: "auth", message: "Administrator signed in" });
        sendJson(response, 200, { username: "admin", csrf: session.csrf }, { "set-cookie": sessionCookie(session.id) });
      } catch (error) {
        const statusCode = /too many/i.test(error.message) ? 429 : (error.statusCode || 401);
        sendJson(response, statusCode, { error: error.message });
      }
      return;
    }

    const authorized = authorize(request);
    if (!authorized) {
      sendJson(response, 401, { error: "Authentication required" });
      return;
    }
    if (!["GET", "HEAD"].includes(request.method)
      && !auth.validateCsrf(authorized.id, request.headers["x-csrf-token"])) {
      sendJson(response, 403, { error: "Invalid CSRF token" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/session") {
      sendJson(response, 200, { username: "admin", csrf: authorized.session.csrf });
    } else if (request.method === "POST" && url.pathname === "/api/logout") {
      auth.destroySession(authorized.id);
      sendJson(response, 204, null, { "set-cookie": sessionCookie("", { clear: true }) });
    } else if (request.method === "GET" && url.pathname === "/api/config") {
      sendJson(response, 200, publicConfig(config.get()));
    } else if (request.method === "PUT" && url.pathname === "/api/config") {
      try {
        const body = await readJsonBody(request);
        const updated = await config.update({ ...body, tunnel: config.get().tunnel });
        events.add({ kind: "config", message: "Configuration updated" });
        sendJson(response, 200, publicConfig(updated));
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (request.method === "GET" && url.pathname === "/api/status") {
      sendJson(response, 200, status());
    } else if (request.method === "GET" && url.pathname === "/api/events") {
      sendJson(response, 200, events.list());
    } else if (request.method === "DELETE" && url.pathname === "/api/proxy/cache") {
      try {
        if (typeof clearProxyCache !== "function") {
          throw Object.assign(new Error("Proxy cache controls are unavailable"), { statusCode: 501 });
        }
        const body = await readJsonBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw Object.assign(new Error("Proxy cache scope must be an object"), { statusCode: 400 });
        }
        const scope = {};
        if ("site" in body) {
          if (typeof body.site !== "string" || !body.site.trim()) {
            throw Object.assign(new Error("Proxy cache site is invalid"), { statusCode: 400 });
          }
          scope.site = normalizeHost(body.site);
        }
        if ("location" in body) {
          if (typeof body.location !== "string" || !body.location.startsWith("/")) {
            throw Object.assign(new Error("Proxy cache location is invalid"), { statusCode: 400 });
          }
          scope.location = body.location;
        }
        const result = await clearProxyCache(scope);
        events.add({ kind: "proxy-cache", message: scope.site ? `Proxy cache cleared: ${scope.site}` : "Proxy cache cleared" });
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (request.method === "POST" && url.pathname === "/api/dns/diagnose") {
      try {
        if (typeof diagnoseDns !== "function") {
          throw Object.assign(new Error("DNS diagnostics are unavailable"), { statusCode: 501 });
        }
        const body = await readJsonBody(request);
        const name = String(body.name || "").trim().replace(/\.$/, "").toLowerCase();
        const type = String(body.type || "").toUpperCase();
        if (!name) throw Object.assign(new Error("DNS name is required"), { statusCode: 400 });
        if (!DIAGNOSTIC_TYPES.has(type)) {
          throw Object.assign(new Error("Unsupported diagnostic DNS type"), { statusCode: 400 });
        }
        sendJson(response, 200, await diagnoseDns(name, type));
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (request.method === "POST" && url.pathname === "/api/domains/preview") {
      try {
        const body = await readJsonBody(request);
        sendJson(response, 200, { additions: createDomainPlan(config.get(), body).additions });
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (request.method === "POST" && url.pathname === "/api/domains") {
      try {
        const body = await readJsonBody(request);
        const plan = createDomainPlan(config.get(), body);
        const updated = await config.update(plan.config);
        events.add({ kind: "config", message: `Domain workspace created: ${plan.additions.domain.name}` });
        sendJson(response, 201, publicConfig(updated));
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (["PUT", "DELETE"].includes(request.method) && url.pathname.startsWith("/api/domains/")) {
      try {
        const domainName = decodeURIComponent(url.pathname.slice("/api/domains/".length));
        if (!domainName) throw Object.assign(new Error("Domain name is required"), { statusCode: 400 });
        const next = request.method === "PUT"
          ? updateDomain(config.get(), domainName, await readJsonBody(request))
          : deleteDomainTree(config.get(), domainName);
        const updated = await config.update(next);
        events.add({ kind: "config", message: `Domain workspace ${request.method === "PUT" ? "updated" : "deleted"}: ${domainName}` });
        sendJson(response, 200, publicConfig(updated));
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (request.method === "GET" && url.pathname === "/api/tunnel") {
      sendJson(response, 200, tunnel.status());
    } else if (request.method === "PUT" && url.pathname === "/api/tunnel/token") {
      let submittedToken = "";
      try {
        if (typeof updateTunnelToken !== "function") throw Object.assign(new Error("Tunnel token updates are unavailable"), { statusCode: 501 });
        const { token } = await readJsonBody(request);
        if (typeof token !== "string" || token.length === 0) {
          throw Object.assign(new Error("Tunnel token must be a non-empty string"), { statusCode: 400 });
        }
        submittedToken = token;
        const result = await updateTunnelToken(token);
        events.add({ kind: "tunnel", message: "Stored Tunnel token updated" });
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, error.statusCode || 503, { error: redactSecret(error.message, submittedToken) });
      }
    } else if (request.method === "DELETE" && url.pathname === "/api/tunnel/token") {
      try {
        if (typeof clearTunnelToken !== "function") throw Object.assign(new Error("Tunnel token updates are unavailable"), { statusCode: 501 });
        const result = await clearTunnelToken();
        events.add({ kind: "tunnel", message: "Stored Tunnel token cleared" });
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, error.statusCode || 503, { error: error.message });
      }
    } else if (request.method === "POST" && ["/api/tunnel/start", "/api/tunnel/stop"].includes(url.pathname)) {
      try {
        if (url.pathname.endsWith("start")) await tunnel.start();
        else await tunnel.stop();
        events.add({ kind: "tunnel", message: `Tunnel ${url.pathname.endsWith("start") ? "started" : "stopped"}` });
        sendJson(response, 200, tunnel.status());
      } catch (error) {
        sendJson(response, 503, { error: error.message });
      }
    } else {
      sendJson(response, 404, { error: "API endpoint not found" });
    }
  }

  function serveStatic(request, response, url) {
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const allowed = new Set(["index.html", "app.js", "styles.css"]);
    const fileName = allowed.has(requested) ? requested : "index.html";
    const embedded = staticFiles?.[fileName];
    if (typeof embedded === "string") {
      sendStatic(response, fileName, embedded);
      return;
    }
    const filePath = path.join(staticDirectory, fileName);
    fs.readFile(filePath, (error, content) => {
      if (error) {
        response.writeHead(404).end("Not found");
        return;
      }
      sendStatic(response, fileName, content);
    });
  }

  return {
    async start() {
      server = http.createServer((request, response) => {
        const url = new URL(request.url, "http://localhost");
        if (url.pathname.startsWith("/api/")) handleApi(request, response, url).catch(() => {
          if (!response.headersSent) sendJson(response, 500, { error: "Internal server error" });
        });
        else serveStatic(request, response, url);
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
    },
    address: () => server?.address(),
    async close() {
      if (!server) return;
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    },
  };
}

module.exports = {
  COOKIE_NAME,
  DIAGNOSTIC_TYPES,
  createAdminService,
  parseCookies,
  publicConfig,
  readJsonBody,
  sessionCookie,
};
