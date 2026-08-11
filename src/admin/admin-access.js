"use strict";

function accessForRequest(method, pathname) {
  const verb = String(method).toUpperCase();
  const path = String(pathname);
  if (["/api/bootstrap", "/api/setup", "/api/login"].includes(path)) return null;
  if (path === "/api/v2/openapi.json" && verb === "GET") return null;
  if (path === "/api/v1/config") return { permission: "dns:read" };
  if (path === "/api/v1/status") return {};
  if (path === "/api/v1/events") return { permission: "logs:read" };
  if (path === "/api/v1/tunnel") return { permission: "tunnel:read" };
  if (/^\/api\/invitations\/[^/]+\/accept$/.test(path) && verb === "POST") return null;
  if (["/api/session", "/api/logout", "/api/status"].includes(path)) return {};
  if (path === "/api/config") return verb === "GET" ? { permission: "dns:read" } : { administratorOnly: true };
  if (path === "/api/events") return { permission: "logs:read" };
  if (path === "/api/audit/export") return { permission: "audit:read", ownerOnly: true };
  if (path === "/api/audit" || path === "/api/audit/verify") return { permission: "audit:read" };
  if (path === "/api/v2/users" && verb === "GET") return { permission: "users:read" };
  if (path === "/api/v2/roles") return { permission: verb === "GET" ? "roles:read" : "roles:write" };
  if (path === "/api/v2/dns/zones") return { permission: verb === "GET" ? "dns:read" : "dns:write" };
  if (path === "/api/v2/proxy/sites") return { permission: verb === "GET" ? "proxy:read" : "proxy:write" };
  if (path === "/api/v2/tunnel" && verb === "GET") return { permission: "tunnel:read" };
  if (path === "/api/v2/backups" && verb === "GET") return { permission: "backup:read" };
  if (path === "/api/v2/audit" && verb === "GET") return { permission: "audit:read" };
  if (path === "/api/users" && verb === "GET") return { permission: "users:read" };
  if (path === "/api/users/invitations") return { permission: verb === "GET" ? "users:read" : "users:write" };
  if (/^\/api\/users\/[^/]+(?:\/sessions\/revoke)?$/.test(path)) return { permission: "users:write" };
  if (path === "/api/roles") return { permission: verb === "GET" ? "roles:read" : "roles:write" };
  if (path === "/api/tokens") return { permission: verb === "GET" ? "users:read" : "users:write" };
  if (/^\/api\/tokens\/[^/]+$/.test(path)) return { permission: "users:write" };

  if (path === "/api/backups") {
    if (verb === "GET") return { permission: "backup:read" };
    if (verb === "POST") return { permission: "backup:create" };
  }
  if (path === "/api/backups/upload") return { permission: "backup:create" };
  if (/^\/api\/backups\/[^/]+\/download$/.test(path)) return { permission: "backup:download-sensitive" };
  if (/^\/api\/backups\/[^/]+\/restore$/.test(path)) return { permission: "backup:restore" };
  if (/^\/api\/backups\/[^/]+$/.test(path) && verb === "DELETE") return { permission: "backup:delete" };

  if (path === "/api/observability/metrics" || path === "/api/observability/webhooks") {
    return { permission: "logs:read" };
  }
  if (path === "/api/observability/webhook" || /^\/api\/observability\/webhooks\/[^/]+\/retry$/.test(path)) {
    return { administratorOnly: true };
  }

  if (path === "/api/proxy/operations" || path === "/api/proxy/health-history") return { permission: "proxy:read" };
  if (path === "/api/proxy/cache" && verb === "DELETE") return { permission: "proxy:operate" };
  if (/^\/api\/proxy\/sites\//.test(path)) return { permission: "proxy:operate" };

  if (path === "/api/dns/diagnose") return { permission: "dns:read" };
  if (path === "/api/dns/policy/subscriptions" && verb === "GET") return { permission: "dns:read" };
  if (/^\/api\/dns\/policy\/subscriptions\/[^/]+\/refresh$/.test(path)) return { permission: "dns:operate" };
  if (/^\/api\/zones\/[^/]+\/export$/.test(path)) return { permission: "dns:read" };
  if (/^\/api\/zones\/[^/]+\/(?:import|records\/batch)$/.test(path)) return { permission: "dns:write" };
  if (path === "/api/domains/preview") return { permission: "dns:write" };
  if (path === "/api/domains" && verb === "POST") return { permission: "dns:write" };
  if (/^\/api\/domains\/[^/]+$/.test(path)) return { permission: "dns:write" };

  if (path === "/api/tunnel" && verb === "GET") return { permission: "tunnel:read" };
  if (path === "/api/tunnel/token") return { permission: "tunnel:write" };
  if (["/api/tunnel/start", "/api/tunnel/stop"].includes(path)) return { permission: "tunnel:operate" };
  return undefined;
}

module.exports = { accessForRequest };
