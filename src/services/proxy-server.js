"use strict";

const http = require("node:http");
const https = require("node:https");
const { randomUUID } = require("node:crypto");
const { promisify } = require("node:util");
const zlib = require("node:zlib");

const { Http2SessionPool } = require("./proxy-http2");
const { normalizeHost } = require("./proxy-routes");
const {
  MemoryRateLimiter,
  isClientAllowed,
  isIpInCidrs,
  normalizeIp,
  resolveClientIp,
} = require("./proxy-security");

const HOP_HEADER = "x-s12-proxy-hop";
const SAFE_RETRY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const DEFAULT_TRUSTED_PROXY_CIDRS = Object.freeze(["127.0.0.1/32", "::1/128"]);
const MAX_CACHE_CAPTURE_BYTES = 32 * 1024 * 1024;
const SHADOW_HEADER = "x-s12-shadow";
const SHADOW_SENSITIVE_HEADERS = Object.freeze(["authorization", "cookie", "proxy-authorization"]);
const HTTP2_FORBIDDEN_HEADERS = Object.freeze(["connection", "host", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"]);
const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

function appendForwardedFor(current, address) {
  return [current, address].filter(Boolean).join(", ");
}

function targetPath(basePath, requestUrl) {
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const incoming = requestUrl.startsWith("/") ? requestUrl : `/${requestUrl}`;
  return `${base}${incoming}` || "/";
}

function expandTemplate(template, context) {
  return String(template).replace(/\$\{([^}]+)\}/g, (_match, name) => String(context[name] ?? ""));
}

function rewriteRequestPath(requestUrl, location, rewrite = { mode: "none" }) {
  const parsed = new URL(requestUrl || "/", "http://proxy.local");
  if (rewrite.mode === "strip-prefix") {
    parsed.pathname = parsed.pathname.slice(location.path.length) || "/";
    if (!parsed.pathname.startsWith("/")) parsed.pathname = `/${parsed.pathname}`;
  } else if (rewrite.mode === "replace-prefix") {
    const suffix = parsed.pathname.slice(location.path.length);
    parsed.pathname = `${rewrite.value}${suffix}` || "/";
  }
  return `${parsed.pathname}${parsed.search}`;
}

function applyHeaderRules(headers, rules, context) {
  const result = { ...headers };
  for (const name of rules?.remove || []) delete result[name];
  for (const [name, value] of Object.entries(rules?.set || {})) result[name] = expandTemplate(value, context);
  return result;
}

function requestContext(request, trustedProxyCidrs = DEFAULT_TRUSTED_PROXY_CIDRS) {
  const peerIp = normalizeIp(request.socket.remoteAddress);
  const trustedPeer = isIpInCidrs(peerIp, trustedProxyCidrs);
  return {
    host: normalizeHost(request.headers.host),
    clientIp: resolveClientIp(peerIp, request.headers["x-forwarded-for"], trustedProxyCidrs),
    peerIp,
    trustedPeer,
    scheme: request.socket.encrypted ? "https" : "http",
    requestId: String(request.headers["x-request-id"] || randomUUID()),
    path: request.url || "/",
  };
}

function requestOptions(request, route, timeoutMs, context = requestContext(request)) {
  const rewritten = rewriteRequestPath(request.url, route.location, route.rewrite);
  const forwarded = { ...request.headers };
  forwarded.host = route.upstreamHost || route.url.host;
  forwarded["x-forwarded-host"] = request.headers.host || "";
  forwarded["x-forwarded-proto"] = context.scheme;
  forwarded["x-forwarded-for"] = context.trustedPeer
    ? appendForwardedFor(forwarded["x-forwarded-for"], context.peerIp)
    : context.clientIp;
  forwarded["x-request-id"] = context.requestId;
  forwarded[HOP_HEADER] = "1";
  const headers = applyHeaderRules(forwarded, route.requestHeaders, context);
  return {
    protocol: route.url.protocol,
    hostname: route.url.hostname,
    port: route.url.port || undefined,
    method: request.method,
    path: targetPath(route.url.pathname, rewritten),
    headers,
    timeout: route.timeoutMs || timeoutMs,
    servername: route.url.hostname,
  };
}

function transportFor(url) {
  return url.protocol === "https:" ? https : http;
}

function http2Headers(options) {
  const headers = {
    ":method": options.method,
    ":scheme": "https",
    ":authority": options.headers.host || options.hostname,
    ":path": options.path,
    ...options.headers,
  };
  for (const name of HTTP2_FORBIDDEN_HEADERS) delete headers[name];
  return headers;
}

function responseHeadersFromHttp2(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith(":")));
}

function collectRequestBody(request, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      request.resume();
      reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        chunks.length = 0;
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => {
      if (!settled) resolve(Buffer.concat(chunks, size));
    });
    request.once("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function appendVary(current, value) {
  const values = String(current || "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!values.some((entry) => entry.toLowerCase() === value.toLowerCase())) values.push(value);
  return values.join(", ");
}

function negotiatedEncoding(request, headers, policy, bodyLength) {
  if (!policy?.enabled || headers["content-encoding"] || bodyLength < policy.minBytes) return null;
  const type = String(headers["content-type"] || "").toLowerCase();
  if (!/^(text\/|application\/(json|javascript|xml|svg\+xml|wasm)|image\/svg\+xml)/.test(type)) return null;
  const accepted = String(request.headers["accept-encoding"] || "").toLowerCase();
  const quality = (name) => {
    const match = accepted.split(",").map((entry) => entry.trim()).find((entry) => entry.split(";", 1)[0].trim() === name);
    if (!match) return 0;
    const q = match.match(/;\s*q=([0-9.]+)/)?.[1];
    return q === undefined ? 1 : Number(q);
  };
  if (quality("br") > 0) return "br";
  if (quality("gzip") > 0) return "gzip";
  return null;
}

async function encodeBufferedResponse(request, headers, body, policy) {
  const encoding = negotiatedEncoding(request, headers, policy, body.length);
  if (!encoding) return { headers, body };
  const encoded = encoding === "br" ? await brotliCompress(body) : await gzip(body);
  const nextHeaders = { ...headers, "content-encoding": encoding, vary: appendVary(headers.vary, "Accept-Encoding") };
  delete nextHeaders["content-length"];
  return { headers: nextHeaders, body: encoded };
}

async function sendBufferedResponse(response, request, route, cached) {
  const adjusted = applyHeaderRules(cached.headers, route.responseHeaders, requestContext(request));
  const encoded = await encodeBufferedResponse(request, adjusted, cached.body, route.location.compression);
  response.writeHead(cached.status, encoded.headers);
  response.end(request.method === "HEAD" ? undefined : encoded.body);
}

function createProxyService({
  routes,
  cache,
  host = "0.0.0.0",
  port = 8080,
  timeoutMs = 30000,
  trustedProxyCidrs = DEFAULT_TRUSTED_PROXY_CIDRS,
  rateLimiter = new MemoryRateLimiter(),
  http2Pool = new Http2SessionPool(),
  http1Request = (url, options, callback) => transportFor(url).request(options, callback),
  schedule = setTimeout,
  cancel = clearTimeout,
  random = Math.random,
  onEvent = () => {},
} = {}) {
  if (!routes || typeof routes.resolve !== "function") throw new TypeError("routes must provide resolve(host, path)");
  let server;
  const sockets = new Set();
  const upstreamSockets = new Set();
  const websocketConnections = new Map();
  const websocketStats = new Map();
  const activeHttp = new Map();
  const drainTimers = new Map();

  function recordPassiveTransition(transition, details = {}) {
    if (!transition) return;
    onEvent({
      kind: "proxy-health",
      source: "passive",
      healthy: transition.state === "healthy",
      checkedAt: new Date().toISOString(),
      ...transition,
      ...details,
    });
  }

  function siteWebsocketStats(site) {
    if (!websocketStats.has(site)) {
      websocketStats.set(site, {
        site,
        active: 0,
        accepted: 0,
        rejected: 0,
        completed: 0,
        bytesFromClient: 0,
        bytesFromUpstream: 0,
        totalDurationMs: 0,
      });
    }
    return websocketStats.get(site);
  }

  function trackHttp(request, response, route) {
    const entry = { request, response, route };
    if (!activeHttp.has(route.host)) activeHttp.set(route.host, new Set());
    activeHttp.get(route.host).add(entry);
    const remove = () => activeHttp.get(route.host)?.delete(entry);
    response.once("finish", remove);
    response.once("close", remove);
    return entry;
  }

  function upstreamRequest(request, route, context, callback, forceHttp1 = false) {
    const options = requestOptions(request, route, timeoutMs, context);
    const useHttp2 = route._upstream?.protocol === "http2"
      || (route._upstream?.protocol === "auto" && !forceHttp1 && !http2Pool.prefersHttp1?.(route.url));
    if (useHttp2) {
      const { stream } = http2Pool.request(route.url, http2Headers(options));
      stream.once("response", (headers) => {
        stream.statusCode = Number(headers[":status"] || 502);
        stream.headers = responseHeadersFromHttp2(headers);
        callback(stream);
      });
      stream.setTimeout?.(options.timeout, () => stream.destroy(Object.assign(new Error("Proxy timeout"), { code: "ETIMEDOUT" })));
      return stream;
    }
    return http1Request(route.url, options, callback);
  }

  function dispatchShadow(request, route, body, context) {
    const shadow = route.location.shadow;
    if (!shadow || random() >= shadow.sampleRate || body.length > shadow.maxBodyBytes) return;
    if (!SAFE_RETRY_METHODS.has(request.method) && !shadow.allowUnsafeMethods) return;
    const target = new URL(shadow.target);
    const rewritten = rewriteRequestPath(request.url, route.location, route.rewrite);
    const headers = { ...request.headers, host: target.host, [SHADOW_HEADER]: "1", "x-request-id": context.requestId };
    for (const name of SHADOW_SENSITIVE_HEADERS) delete headers[name];
    const startedAt = process.hrtime.bigint();
    const shadowRequest = transportFor(target).request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: request.method,
      path: targetPath(target.pathname, rewritten),
      headers,
      timeout: shadow.timeoutMs,
      servername: target.hostname,
    }, (shadowResponse) => {
      shadowResponse.resume();
      shadowResponse.once("end", () => onEvent({
        kind: "proxy-shadow",
        host: route.host,
        statusCode: shadowResponse.statusCode || 0,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      }));
    });
    shadowRequest.once("timeout", () => shadowRequest.destroy(Object.assign(new Error("Shadow timeout"), { code: "ETIMEDOUT" })));
    shadowRequest.once("error", (error) => onEvent({ kind: "proxy-shadow-error", host: route.host, message: error.message }));
    shadowRequest.end(body);
  }

  function writeSelectionError(responseOrSocket, status, message) {
    if (typeof responseOrSocket.writeHead === "function") responseOrSocket.writeHead(status).end(message);
    else responseOrSocket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  }

  function selectRoute(request, responseOrSocket) {
    if (request.headers[HOP_HEADER]) {
      writeSelectionError(responseOrSocket, 508, "Proxy loop detected");
      return null;
    }
    const route = routes.resolve(request.headers.host, request.url);
    if (!route) {
      writeSelectionError(responseOrSocket, 404, "No proxy route");
      return null;
    }
    if (route.maintenance) {
      const headers = { "retry-after": String(route.retryAfterSeconds) };
      if (typeof responseOrSocket.writeHead === "function") {
        responseOrSocket.writeHead(503, headers).end("Site under maintenance");
      } else {
        responseOrSocket.end(`HTTP/1.1 503 Service Unavailable\r\nRetry-After: ${route.retryAfterSeconds}\r\nConnection: close\r\n\r\n`);
      }
      return null;
    }
    if (route.draining) {
      const headers = { "retry-after": String(route.retryAfterSeconds) };
      if (typeof responseOrSocket.writeHead === "function") responseOrSocket.writeHead(503, headers).end("Site is draining");
      else responseOrSocket.end(`HTTP/1.1 503 Service Unavailable\r\nRetry-After: ${route.retryAfterSeconds}\r\nConnection: close\r\n\r\n`);
      return null;
    }
    if (route.unavailable) {
      writeSelectionError(responseOrSocket, 503, "No healthy upstream");
      return null;
    }
    return route;
  }

  function handleRedirect(request, responseOrSocket, route, context) {
    if (!route.redirect) return false;
    const location = expandTemplate(route.redirect.location, context);
    if (typeof responseOrSocket.writeHead === "function") {
      responseOrSocket.writeHead(route.redirect.status, { location }).end();
    } else {
      responseOrSocket.end(`HTTP/1.1 ${route.redirect.status} Redirect\r\nLocation: ${location}\r\nConnection: close\r\n\r\n`);
    }
    return true;
  }

  async function handleHttpRequest(request, response, initialRoute, activeRequest) {
    const context = requestContext(request, trustedProxyCidrs);
    if (!isClientAllowed(context.clientIp, initialRoute.location.access)) {
      request.resume();
      response.writeHead(403).end("Client address denied");
      return;
    }
    if (initialRoute.location.rateLimit.enabled) {
      const rate = rateLimiter.consume(
        `${initialRoute.host}:${initialRoute.location.match}:${initialRoute.location.path}:${context.clientIp}`,
        initialRoute.location.rateLimit,
      );
      if (!rate.allowed) {
        request.resume();
        response.writeHead(429, { "retry-after": String(Math.ceil(rate.retryAfterMs / 1000)) }).end("Rate limit exceeded");
        return;
      }
    }
    if (handleRedirect(request, response, initialRoute, context)) {
      request.resume();
      return;
    }
    let body;
    try {
      body = await collectRequestBody(request, initialRoute.location.bodyLimitBytes);
    } catch (error) {
      if (!response.headersSent) response.writeHead(error.statusCode || 400).end(error.message);
      return;
    }
    dispatchShadow(request, initialRoute, body, context);

    if (cache && initialRoute.location.cache.enabled) {
      try {
        const cached = await cache.get({
          site: initialRoute.host,
          location: `${initialRoute.location.match}:${initialRoute.location.path}`,
          request: { method: request.method, host: context.host, url: request.url, headers: request.headers },
        });
        if (cached) {
          await sendBufferedResponse(response, request, initialRoute, cached);
          return;
        }
      } catch (error) {
        onEvent({ kind: "proxy-cache-error", host: initialRoute.host, message: error.message });
      }
    }
    const safeToRetry = SAFE_RETRY_METHODS.has(request.method);
    const fallbackAllowed = safeToRetry || initialRoute.location.allowUnsafeFallback;

    const nextAttempt = (failedRoute) => {
      const primary = routes.resolve(request.headers.host, request.url);
      if (primary && !primary.unavailable && !primary.redirect && !primary.maintenance
        && primary._upstream !== failedRoute._upstream) return primary;
      if (!fallbackAllowed || failedRoute.fallback) return null;
      const fallback = routes.resolveFallback?.(request.headers.host, request.url);
      return fallback && !fallback.unavailable && !fallback.redirect && !fallback.maintenance ? fallback : null;
    };

    const attempt = (route, forceHttp1 = false) => {
      if (activeRequest) activeRequest.route = route;
      const upstream = upstreamRequest(request, route, context, (upstreamResponse) => {
        const status = upstreamResponse.statusCode || 502;
        if (RETRYABLE_STATUSES.has(status)) {
          recordPassiveTransition(routes.markFailure(route), { statusCode: status });
          if (safeToRetry || route.location.allowUnsafeFallback) {
            const next = nextAttempt(route);
            if (next) {
              upstreamResponse.resume();
              attempt(next);
              return;
            }
          }
        } else {
          recordPassiveTransition(routes.markSuccess(route), { statusCode: status });
        }
        const headers = applyHeaderRules(upstreamResponse.headers, route.responseHeaders, context);
        const contentLength = Number(headers["content-length"]);
        const encoding = negotiatedEncoding(request, headers, route.location.compression, Number.isFinite(contentLength) ? contentLength : 0);
        const outputHeaders = encoding
          ? { ...headers, "content-encoding": encoding, vary: appendVary(headers.vary, "Accept-Encoding") }
          : { ...headers };
        if (encoding) delete outputHeaders["content-length"];
        response.writeHead(status, outputHeaders);

        const cacheChunks = [];
        let cacheBytes = 0;
        let capture = Boolean(cache && route.location.cache.enabled && request.method === "GET");
        const captureLimit = Math.min(route.location.cache.maxBytes, MAX_CACHE_CAPTURE_BYTES);
        const writer = encoding === "br" ? zlib.createBrotliCompress() : encoding === "gzip" ? zlib.createGzip() : response;
        if (writer !== response) {
          writer.once("error", (error) => response.destroy(error));
          writer.pipe(response);
        }
        upstreamResponse.on("data", (chunk) => {
          if (capture) {
            cacheBytes += chunk.length;
            if (cacheBytes <= captureLimit) cacheChunks.push(chunk);
            else {
              capture = false;
              cacheChunks.length = 0;
            }
          }
          if (!writer.write(chunk)) upstreamResponse.pause();
        });
        writer.on("drain", () => upstreamResponse.resume());
        upstreamResponse.once("end", async () => {
          if (capture) {
            try {
              await cache.put({
                site: route.host,
                location: `${route.location.match}:${route.location.path}`,
                request: { method: request.method, host: context.host, url: request.url, headers: request.headers },
                response: { status, headers, body: Buffer.concat(cacheChunks, cacheBytes) },
                policy: route.location.cache,
              });
            } catch (error) {
              onEvent({ kind: "proxy-cache-error", host: route.host, message: error.message });
            }
          }
          writer.end();
        });
      }, forceHttp1);
      upstream.on("timeout", () => upstream.destroy(Object.assign(new Error("Proxy timeout"), { code: "ETIMEDOUT" })));
      upstream.on("error", (error) => {
        if (route._upstream?.protocol === "auto" && !forceHttp1 && !response.headersSent) {
          http2Pool.markHttp1?.(route.url);
          attempt(route, true);
          return;
        }
        recordPassiveTransition(routes.markFailure(route), { error: error.message });
        onEvent({ kind: "proxy-error", host: route.host, message: error.message });
        if ((safeToRetry || route.location.allowUnsafeFallback) && !response.headersSent) {
          const next = nextAttempt(route);
          if (next) {
            attempt(next);
            return;
          }
        }
        if (!response.headersSent) response.writeHead(error.code === "ETIMEDOUT" ? 504 : 502).end("Upstream unavailable");
        else response.destroy(error);
      });
      upstream.end(body);
    };

    attempt(initialRoute);
  }

  return {
    async start() {
      if (server) throw new Error("Proxy service is already started");
      server = http.createServer((request, response) => {
        const startedAt = process.hrtime.bigint();
        let context;
        try {
          context = requestContext(request, trustedProxyCidrs);
        } catch {
          context = { host: "invalid", clientIp: normalizeIp(request.socket.remoteAddress) || "unknown" };
        }
        response.once("finish", () => {
          onEvent({
            kind: "proxy",
            host: context.host,
            clientIp: context.clientIp,
            method: request.method,
            url: request.url,
            statusCode: response.statusCode,
            durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
          });
        });
        const route = selectRoute(request, response);
        if (!route) return;
        const activeRequest = trackHttp(request, response, route);
        handleHttpRequest(request, response, route, activeRequest).catch((error) => {
          onEvent({ kind: "proxy-error", host: route.host, message: error.message });
          if (!response.headersSent) response.writeHead(500).end("Proxy request failed");
          else response.destroy(error);
        });
      });

      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });

      server.on("upgrade", (request, socket, head) => {
        const route = selectRoute(request, socket);
        if (!route) return;
        const context = requestContext(request);
        if (handleRedirect(request, socket, route, context)) return;
        const stats = siteWebsocketStats(route.host);
        if (stats.active >= route.site.websocket.maxConnections) {
          stats.rejected += 1;
          onEvent({ kind: "proxy-websocket-rejected", host: route.host, reason: "connection-limit" });
          socket.end("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\n\r\n");
          return;
        }
        const upstream = transportFor(route.url).request(requestOptions(request, route, timeoutMs, context));
        upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
          recordPassiveTransition(routes.markSuccess(route), { statusCode: upstreamResponse.statusCode });
          upstreamSockets.add(upstreamSocket);
          upstreamSocket.once("close", () => upstreamSockets.delete(upstreamSocket));
          const status = `HTTP/${upstreamResponse.httpVersion} ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}\r\n`;
          const headers = upstreamResponse.rawHeaders.reduce((text, value, index) => text + (index % 2 ? `${value}\r\n` : `${value}: `), "");
          socket.write(`${status}${headers}\r\n`);
          if (upstreamHead.length) socket.write(upstreamHead);
          if (head.length) upstreamSocket.write(head);
          const connection = {
            client: socket,
            upstream: upstreamSocket,
            startedAt: process.hrtime.bigint(),
            bytesFromClient: head.length,
            bytesFromUpstream: upstreamHead.length,
            closed: false,
          };
          if (!websocketConnections.has(route.host)) websocketConnections.set(route.host, new Set());
          websocketConnections.get(route.host).add(connection);
          stats.active += 1;
          stats.accepted += 1;
          socket.on("data", (chunk) => { connection.bytesFromClient += chunk.length; });
          upstreamSocket.on("data", (chunk) => { connection.bytesFromUpstream += chunk.length; });
          const finalize = () => {
            if (connection.closed) return;
            connection.closed = true;
            websocketConnections.get(route.host)?.delete(connection);
            stats.active = Math.max(0, stats.active - 1);
            stats.completed += 1;
            stats.bytesFromClient += connection.bytesFromClient;
            stats.bytesFromUpstream += connection.bytesFromUpstream;
            const durationMs = Number(process.hrtime.bigint() - connection.startedAt) / 1e6;
            stats.totalDurationMs += durationMs;
            onEvent({
              kind: "proxy-websocket",
              host: route.host,
              durationMs,
              bytesFromClient: connection.bytesFromClient,
              bytesFromUpstream: connection.bytesFromUpstream,
            });
          };
          socket.once("close", finalize);
          upstreamSocket.once("close", finalize);
          socket.setTimeout(route.site.websocket.idleTimeoutMs, () => {
            socket.destroy();
            upstreamSocket.destroy();
          });
          upstreamSocket.setTimeout(route.site.websocket.idleTimeoutMs, () => {
            upstreamSocket.destroy();
            socket.destroy();
          });
          upstreamSocket.pipe(socket).pipe(upstreamSocket);
        });
        upstream.on("timeout", () => upstream.destroy());
        upstream.on("error", () => {
          recordPassiveTransition(routes.markFailure(route), { error: "WebSocket upstream unavailable" });
          socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        });
        upstream.end();
      });

      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
    },
    address() {
      return server?.address();
    },
    websocketStatus() {
      return { sites: [...websocketStats.values()].map((value) => ({ ...value })).sort((left, right) => left.site.localeCompare(right.site)) };
    },
    drainStatus() {
      return routes.drainStatus?.() || { sites: [] };
    },
    drainSite(host) {
      const site = normalizeHost(host);
      if (!routes.setSiteDraining?.(site, true)) return false;
      if (drainTimers.has(`site:${site}`)) cancel(drainTimers.get(`site:${site}`));
      const timer = schedule(() => this.abortSite(site), routes.siteDrainTimeout?.(site) || 30_000);
      timer?.unref?.();
      drainTimers.set(`site:${site}`, timer);
      return true;
    },
    resumeSite(host) {
      const site = normalizeHost(host);
      const timer = drainTimers.get(`site:${site}`);
      if (timer) cancel(timer);
      drainTimers.delete(`site:${site}`);
      return routes.setSiteDraining?.(site, false) || false;
    },
    drainUpstream(scope) {
      if (!routes.setUpstreamDraining?.(scope, true)) return false;
      const key = `upstream:${normalizeHost(scope.host)}:${scope.location}:${Boolean(scope.fallback)}:${scope.id}`;
      if (drainTimers.has(key)) cancel(drainTimers.get(key));
      const timer = schedule(() => {
        for (const entry of activeHttp.get(normalizeHost(scope.host)) || []) {
          const route = entry.route;
          const location = `${route.location.match}:${route.location.path}`;
          if (location === scope.location && route._upstream?.id === scope.id && Boolean(route.fallback) === Boolean(scope.fallback)) {
            entry.request.socket.destroy();
          }
        }
      }, scope.timeoutMs || 30_000);
      timer?.unref?.();
      drainTimers.set(key, timer);
      return true;
    },
    resumeUpstream(scope) {
      const key = `upstream:${normalizeHost(scope.host)}:${scope.location}:${Boolean(scope.fallback)}:${scope.id}`;
      const timer = drainTimers.get(key);
      if (timer) cancel(timer);
      drainTimers.delete(key);
      return routes.setUpstreamDraining?.(scope, false) || false;
    },
    abortSite(host) {
      const site = normalizeHost(host);
      const connections = [...(websocketConnections.get(site) || [])];
      for (const connection of connections) {
        connection.client.destroy();
        connection.upstream.destroy();
      }
      const requests = [...(activeHttp.get(site) || [])];
      for (const entry of requests) entry.request.socket.destroy();
      return connections.length + requests.length;
    },
    async close() {
      if (!server) {
        await http2Pool.close?.();
        return;
      }
      for (const socket of sockets) socket.destroy();
      for (const socket of upstreamSockets) socket.destroy();
      for (const timer of drainTimers.values()) cancel(timer);
      drainTimers.clear();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      sockets.clear();
      upstreamSockets.clear();
      server = undefined;
      await http2Pool.close?.();
    },
  };
}

module.exports = {
  HOP_HEADER,
  SAFE_RETRY_METHODS,
  RETRYABLE_STATUSES,
  DEFAULT_TRUSTED_PROXY_CIDRS,
  MAX_CACHE_CAPTURE_BYTES,
  SHADOW_HEADER,
  SHADOW_SENSITIVE_HEADERS,
  HTTP2_FORBIDDEN_HEADERS,
  applyHeaderRules,
  createProxyService,
  collectRequestBody,
  encodeBufferedResponse,
  expandTemplate,
  requestOptions,
  http2Headers,
  requestContext,
  negotiatedEncoding,
  rewriteRequestPath,
  targetPath,
};
