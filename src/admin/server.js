"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const { EventLog } = require("./event-log");
const { classifyDomain, createDomainPlan, deleteDomainTree, normalizeDomainName, updateDomain } = require("./domains");
const { exportZoneFile, parseZoneFile, planZoneImport, planZoneRecordBatch } = require("../dns/zone-file");
const { normalizeHost } = require("../services/proxy-routes");

const COOKIE_NAME = "s12_session";
const MAX_JSON_BODY = 1024 * 1024;
const MAX_ZONE_BODY = 8 * 1024 * 1024;
const DIAGNOSTIC_TYPES = new Set(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV"]);
const METRIC_WINDOWS = new Set(["24h", "7d", "30d"]);
const WEBHOOK_STATES = new Set(["pending", "delivered", "dead-letter"]);
const BACKUP_FILE_PATTERN = /^s12-[a-z][a-z0-9-]*-\d{8}T\d{6}Z\.zip$/;
const POLICY_SUBSCRIPTION_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i;

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

function readZoneBody(request) {
  return new Promise((resolve, reject) => {
    const contentType = String(request.headers["content-type"] || "").toLowerCase().split(";", 1)[0].trim();
    if (!new Set(["text/dns", "text/plain"]).has(contentType)) {
      reject(Object.assign(new Error("Content-Type must be text/dns or text/plain"), { statusCode: 415 }));
      return;
    }
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_ZONE_BODY) reject(Object.assign(new Error("Zone file is too large"), { statusCode: 413 }));
      else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
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

function sendZoneFile(response, domainName, content) {
  response.writeHead(200, {
    "content-type": "text/dns; charset=utf-8",
    "content-disposition": `attachment; filename="${domainName}.zone"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  }).end(content);
}

function sessionCookie(id, { clear = false } = {}) {
  const value = clear ? "" : encodeURIComponent(id);
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 28800}`;
}

function publicConfig(value) {
  const result = structuredClone(value);
  result.tunnel = { hasStoredToken: Boolean(value.tunnel?.token) };
  const webhook = value.observability?.webhook;
  if (webhook) {
    result.observability.webhook = {
      enabled: webhook.enabled,
      url: webhook.url,
      hasSecret: Boolean(webhook.secret),
    };
  }
  return result;
}

function publicWebhook(value) {
  return {
    enabled: Boolean(value?.enabled),
    url: String(value?.url || ""),
    hasSecret: Boolean(value?.secret),
  };
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

function backupFileName(pathname) {
  const value = decodeURIComponent(pathname);
  if (!BACKUP_FILE_PATTERN.test(value)) {
    throw Object.assign(new Error("Backup file name is invalid"), { statusCode: 400 });
  }
  return value;
}

async function sendBackupDownload(response, descriptor) {
  if (!descriptor || typeof descriptor.path !== "string" || !descriptor.path) {
    throw Object.assign(new Error("Backup download is unavailable"), { statusCode: 404 });
  }
  const fileName = backupFileName(descriptor.fileName);
  const stat = await fs.promises.stat(descriptor.path);
  response.writeHead(200, {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="${fileName}"`,
    "content-length": stat.size,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(descriptor.path);
    stream.once("error", reject);
    response.once("error", reject);
    response.once("finish", resolve);
    stream.pipe(response);
  });
}

function createAdminService({
  auth,
  config,
  tunnel,
  updateTunnelToken,
  clearTunnelToken,
  diagnoseDns,
  clearProxyCache,
  getProxyOperations,
  getProxyHealthHistory,
  drainProxySite,
  resumeProxySite,
  abortProxySite,
  drainProxyUpstream,
  resumeProxyUpstream,
  getMetricHistory,
  listWebhookJobs,
  retryWebhookJob,
  updateWebhookConfig,
  listBackups,
  createBackup,
  importBackup,
  getBackupDownload,
  deleteBackup,
  restoreBackup,
  listPolicySubscriptions,
  refreshPolicySubscription,
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
        const current = config.get();
        const updated = await config.update({
          ...body,
          tunnel: current.tunnel,
          observability: {
            ...body.observability,
            webhook: current.observability.webhook,
          },
        });
        events.add({ kind: "config", message: "Configuration updated" });
        sendJson(response, 200, publicConfig(updated));
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (request.method === "GET" && url.pathname === "/api/dns/policy/subscriptions") {
      if (typeof listPolicySubscriptions !== "function") {
        sendJson(response, 501, { error: "DNS policy subscriptions are unavailable" });
      } else sendJson(response, 200, await listPolicySubscriptions());
    } else if (request.method === "POST"
      && url.pathname.startsWith("/api/dns/policy/subscriptions/")
      && url.pathname.endsWith("/refresh")) {
      try {
        if (typeof refreshPolicySubscription !== "function") {
          throw Object.assign(new Error("DNS policy subscriptions are unavailable"), { statusCode: 501 });
        }
        const encoded = url.pathname.slice("/api/dns/policy/subscriptions/".length, -"/refresh".length);
        const id = decodeURIComponent(encoded);
        if (!POLICY_SUBSCRIPTION_ID.test(id)) throw new TypeError("DNS policy subscription id is invalid");
        const result = await refreshPolicySubscription(id);
        events.add({ kind: "dns-policy-subscription", message: `DNS policy subscription refreshed: ${id}` });
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (request.method === "GET" && url.pathname === "/api/status") {
      sendJson(response, 200, status());
    } else if (request.method === "GET" && url.pathname === "/api/events") {
      sendJson(response, 200, events.list());
    } else if (url.pathname === "/api/backups" && request.method === "GET") {
      try {
        if (typeof listBackups !== "function") throw Object.assign(new Error("Backups are unavailable"), { statusCode: 501 });
        sendJson(response, 200, await listBackups());
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (url.pathname === "/api/backups" && request.method === "POST") {
      try {
        if (typeof createBackup !== "function") throw Object.assign(new Error("Backup creation is unavailable"), { statusCode: 501 });
        const body = await readJsonBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)
          || (body.dryRun !== undefined && typeof body.dryRun !== "boolean")) {
          throw Object.assign(new Error("Backup request is invalid"), { statusCode: 400 });
        }
        const dryRun = body.dryRun === true;
        const result = await createBackup({ kind: "manual", dryRun });
        events.add({ kind: "backup", message: dryRun ? "Backup dry-run completed" : "Manual backup created" });
        sendJson(response, dryRun ? 200 : 201, result);
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (url.pathname === "/api/backups/upload" && request.method === "POST") {
      try {
        if (typeof importBackup !== "function") throw Object.assign(new Error("Backup imports are unavailable"), { statusCode: 501 });
        if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/zip")) {
          throw Object.assign(new Error("Content-Type must be application/zip"), { statusCode: 415 });
        }
        const fileName = backupFileName(String(request.headers["x-backup-filename"] || ""));
        const result = await importBackup(request, { fileName });
        events.add({ kind: "backup", message: "External backup imported" });
        sendJson(response, 201, result);
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (url.pathname.startsWith("/api/backups/") && request.method === "GET" && url.pathname.endsWith("/download")) {
      try {
        if (typeof getBackupDownload !== "function") throw Object.assign(new Error("Backup downloads are unavailable"), { statusCode: 501 });
        const encoded = url.pathname.slice("/api/backups/".length, -"/download".length);
        const fileName = backupFileName(encoded);
        await sendBackupDownload(response, await getBackupDownload(fileName));
      } catch (error) {
        if (!response.headersSent) sendJson(response, error.code === "ENOENT" ? 404 : (error.statusCode || 400), { error: error.message });
        else response.destroy();
      }
    } else if (url.pathname.startsWith("/api/backups/") && request.method === "POST" && url.pathname.endsWith("/restore")) {
      try {
        if (typeof restoreBackup !== "function") throw Object.assign(new Error("Backup restore is unavailable"), { statusCode: 501 });
        const encoded = url.pathname.slice("/api/backups/".length, -"/restore".length);
        const fileName = backupFileName(encoded);
        const body = await readJsonBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)
          || (body.dryRun !== undefined && typeof body.dryRun !== "boolean")) {
          throw Object.assign(new Error("Backup restore request is invalid"), { statusCode: 400 });
        }
        const dryRun = body.dryRun === true;
        const result = await restoreBackup(fileName, { dryRun });
        events.add({ kind: "backup", message: dryRun ? "Backup restore dry-run completed" : "Backup restored" });
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (url.pathname.startsWith("/api/backups/") && request.method === "DELETE") {
      try {
        if (typeof deleteBackup !== "function") throw Object.assign(new Error("Backup deletion is unavailable"), { statusCode: 501 });
        const fileName = backupFileName(url.pathname.slice("/api/backups/".length));
        const result = await deleteBackup(fileName);
        events.add({ kind: "backup", message: "Backup deleted" });
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (request.method === "GET" && url.pathname === "/api/observability/metrics") {
      try {
        if (typeof getMetricHistory !== "function") {
          throw Object.assign(new Error("Metric history is unavailable"), { statusCode: 501 });
        }
        const window = url.searchParams.get("window") || "24h";
        if (!METRIC_WINDOWS.has(window)) {
          throw Object.assign(new Error("Metric history window is invalid"), { statusCode: 400 });
        }
        sendJson(response, 200, await getMetricHistory(window));
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (request.method === "GET" && url.pathname === "/api/observability/webhooks") {
      try {
        if (typeof listWebhookJobs !== "function") {
          throw Object.assign(new Error("Webhook history is unavailable"), { statusCode: 501 });
        }
        const state = url.searchParams.get("state") || undefined;
        if (state !== undefined && !WEBHOOK_STATES.has(state)) {
          throw Object.assign(new Error("Webhook state is invalid"), { statusCode: 400 });
        }
        sendJson(response, 200, await listWebhookJobs({ state }));
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (request.method === "POST"
      && url.pathname.startsWith("/api/observability/webhooks/")
      && url.pathname.endsWith("/retry")) {
      try {
        if (typeof retryWebhookJob !== "function") {
          throw Object.assign(new Error("Webhook retries are unavailable"), { statusCode: 501 });
        }
        const encodedId = url.pathname.slice("/api/observability/webhooks/".length, -"/retry".length);
        const id = decodeURIComponent(encodedId);
        if (!id || id.includes("/")) {
          throw Object.assign(new Error("Webhook job id is invalid"), { statusCode: 400 });
        }
        const result = await retryWebhookJob(id);
        events.add({ kind: "webhook", message: `Webhook retry requested: ${id}` });
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (request.method === "PUT" && url.pathname === "/api/observability/webhook") {
      let submittedSecret = "";
      try {
        if (typeof updateWebhookConfig !== "function") {
          throw Object.assign(new Error("Webhook configuration is unavailable"), { statusCode: 501 });
        }
        const body = await readJsonBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw Object.assign(new Error("Webhook configuration must be an object"), { statusCode: 400 });
        }
        const enabled = body.enabled === true;
        const webhookUrl = String(body.url || "").trim();
        submittedSecret = typeof body.secret === "string" ? body.secret : "";
        if (enabled && new URL(webhookUrl).protocol !== "https:") {
          throw Object.assign(new Error("Webhook endpoint must use HTTPS"), { statusCode: 400 });
        }
        if (!submittedSecret) {
          throw Object.assign(new Error("Webhook secret must be a non-empty string"), { statusCode: 400 });
        }
        const result = await updateWebhookConfig({ enabled, url: webhookUrl, secret: submittedSecret });
        events.add({ kind: "config", message: "Webhook configuration updated" });
        sendJson(response, 200, publicWebhook(result));
      } catch (error) {
        const statusCode = error instanceof TypeError ? 400 : (error.statusCode || 400);
        sendJson(response, statusCode, { error: redactSecret(error.message, submittedSecret) });
      }
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
    } else if (request.method === "GET" && url.pathname === "/api/proxy/operations") {
      if (typeof getProxyOperations !== "function") sendJson(response, 501, { error: "Proxy operations are unavailable" });
      else sendJson(response, 200, await getProxyOperations());
    } else if (request.method === "GET" && url.pathname === "/api/proxy/health-history") {
      try {
        if (typeof getProxyHealthHistory !== "function") {
          throw Object.assign(new Error("Proxy health history is unavailable"), { statusCode: 501 });
        }
        const window = url.searchParams.get("window") || "24h";
        if (!METRIC_WINDOWS.has(window)) {
          throw Object.assign(new Error("Proxy health history window is invalid"), { statusCode: 400 });
        }
        const requestedSite = url.searchParams.get("site");
        const site = requestedSite ? normalizeHost(requestedSite) : undefined;
        sendJson(response, 200, await getProxyHealthHistory({ window, site }));
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (request.method === "POST" && /^\/api\/proxy\/sites\/[^/]+\/(drain|resume|abort)$/.test(url.pathname)) {
      try {
        const match = url.pathname.match(/^\/api\/proxy\/sites\/([^/]+)\/(drain|resume|abort)$/);
        const host = normalizeHost(decodeURIComponent(match[1]));
        if (!host) throw new TypeError("Proxy site host is invalid");
        const callbacks = { drain: drainProxySite, resume: resumeProxySite, abort: abortProxySite };
        const callback = callbacks[match[2]];
        if (typeof callback !== "function") throw Object.assign(new Error("Proxy operation is unavailable"), { statusCode: 501 });
        const result = await callback(host);
        if (result === false) throw Object.assign(new Error(`Proxy site not found: ${host}`), { statusCode: 404 });
        events.add({ kind: "proxy-operation", message: `Proxy site ${match[2]}: ${host}` });
        sendJson(response, 200, match[2] === "abort" ? { host, aborted: result } : { host, draining: match[2] === "drain" });
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (request.method === "POST"
      && /^\/api\/proxy\/sites\/[^/]+\/locations\/[^/]+\/upstreams\/[^/]+\/(drain|resume)$/.test(url.pathname)) {
      try {
        const match = url.pathname.match(/^\/api\/proxy\/sites\/([^/]+)\/locations\/([^/]+)\/upstreams\/([^/]+)\/(drain|resume)$/);
        const scope = {
          host: normalizeHost(decodeURIComponent(match[1])),
          location: decodeURIComponent(match[2]),
          id: decodeURIComponent(match[3]),
          fallback: url.searchParams.get("fallback") === "true",
        };
        if (!scope.host || !/^(exact|prefix):\//.test(scope.location)
          || !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i.test(scope.id)) {
          throw new TypeError("Proxy upstream scope is invalid");
        }
        const callback = match[4] === "drain" ? drainProxyUpstream : resumeProxyUpstream;
        if (typeof callback !== "function") throw Object.assign(new Error("Proxy upstream operation is unavailable"), { statusCode: 501 });
        if (!await callback(scope)) throw Object.assign(new Error("Proxy upstream not found"), { statusCode: 404 });
        events.add({ kind: "proxy-operation", message: `Proxy upstream ${match[4]}: ${scope.host}/${scope.id}` });
        sendJson(response, 200, { ...scope, draining: match[4] === "drain" });
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (request.method === "GET" && url.pathname.startsWith("/api/zones/") && url.pathname.endsWith("/export")) {
      try {
        const encoded = url.pathname.slice("/api/zones/".length, -"/export".length);
        const domainName = normalizeDomainName(decodeURIComponent(encoded));
        const current = config.get();
        const domain = current.domains.find((candidate) => candidate.name === domainName);
        if (!domain) throw Object.assign(new Error(`Unknown zone: ${domainName}`), { statusCode: 404 });
        const records = current.records.filter((record) => classifyDomain(current.domains, record.name)?.name === domainName);
        sendZoneFile(response, domainName, exportZoneFile({ domain, records }));
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (request.method === "POST" && url.pathname.startsWith("/api/zones/") && url.pathname.endsWith("/import")) {
      try {
        const encoded = url.pathname.slice("/api/zones/".length, -"/import".length);
        const domainName = normalizeDomainName(decodeURIComponent(encoded));
        const mode = url.searchParams.get("mode");
        const preview = url.searchParams.get("preview") === "true";
        const parsed = parseZoneFile(await readZoneBody(request), { origin: domainName });
        const plan = planZoneImport(config.get(), domainName, parsed, { mode });
        if (preview) {
          sendJson(response, 200, { summary: plan.summary });
        } else {
          const soaSerials = parsed.soa ? { [domainName]: parsed.soa.serial } : {};
          const updated = await config.update(plan.config, { soaSerials });
          events.add({ kind: "config", message: `Zone file imported: ${domainName}` });
          sendJson(response, 200, { summary: plan.summary, config: publicConfig(updated) });
        }
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    } else if (request.method === "POST" && url.pathname.startsWith("/api/zones/") && url.pathname.endsWith("/records/batch")) {
      try {
        const encoded = url.pathname.slice("/api/zones/".length, -"/records/batch".length);
        const domainName = normalizeDomainName(decodeURIComponent(encoded));
        const plan = planZoneRecordBatch(config.get(), domainName, await readJsonBody(request));
        const updated = await config.update(plan.config);
        events.add({ kind: "config", message: `Zone records updated: ${domainName}` });
        sendJson(response, 200, { summary: plan.summary, config: publicConfig(updated) });
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
  BACKUP_FILE_PATTERN,
  DIAGNOSTIC_TYPES,
  METRIC_WINDOWS,
  WEBHOOK_STATES,
  createAdminService,
  parseCookies,
  backupFileName,
  publicConfig,
  publicWebhook,
  readJsonBody,
  sessionCookie,
};
