"use strict";

const http = require("node:http");
const https = require("node:https");
const { randomUUID } = require("node:crypto");
const { promisify } = require("node:util");
const zlib = require("node:zlib");

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
  onEvent = () => {},
} = {}) {
  if (!routes || typeof routes.resolve !== "function") throw new TypeError("routes must provide resolve(host, path)");
  let server;
  const sockets = new Set();
  const upstreamSockets = new Set();

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

  async function handleHttpRequest(request, response, initialRoute) {
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

    const attempt = (route) => {
      const upstream = transportFor(route.url).request(requestOptions(request, route, timeoutMs, context), (upstreamResponse) => {
        const status = upstreamResponse.statusCode || 502;
        if (RETRYABLE_STATUSES.has(status)) {
          routes.markFailure(route);
          if (safeToRetry) {
            const next = routes.resolve(request.headers.host, request.url);
            if (next && !next.unavailable && !next.redirect) {
              upstreamResponse.resume();
              attempt(next);
              return;
            }
          }
        } else {
          routes.markSuccess(route);
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
      });
      upstream.on("timeout", () => upstream.destroy(Object.assign(new Error("Proxy timeout"), { code: "ETIMEDOUT" })));
      upstream.on("error", (error) => {
        routes.markFailure(route);
        onEvent({ kind: "proxy-error", host: route.host, message: error.message });
        if (safeToRetry && !response.headersSent) {
          const next = routes.resolve(request.headers.host, request.url);
          if (next && !next.unavailable && !next.redirect) {
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
        handleHttpRequest(request, response, route).catch((error) => {
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
        const upstream = transportFor(route.url).request(requestOptions(request, route, timeoutMs, context));
        upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
          routes.markSuccess(route);
          upstreamSockets.add(upstreamSocket);
          upstreamSocket.once("close", () => upstreamSockets.delete(upstreamSocket));
          const status = `HTTP/${upstreamResponse.httpVersion} ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}\r\n`;
          const headers = upstreamResponse.rawHeaders.reduce((text, value, index) => text + (index % 2 ? `${value}\r\n` : `${value}: `), "");
          socket.write(`${status}${headers}\r\n`);
          if (upstreamHead.length) socket.write(upstreamHead);
          if (head.length) upstreamSocket.write(head);
          upstreamSocket.pipe(socket).pipe(upstreamSocket);
        });
        upstream.on("timeout", () => upstream.destroy());
        upstream.on("error", () => {
          routes.markFailure(route);
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
    async close() {
      if (!server) return;
      for (const socket of sockets) socket.destroy();
      for (const socket of upstreamSockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      sockets.clear();
      upstreamSockets.clear();
      server = undefined;
    },
  };
}

module.exports = {
  HOP_HEADER,
  SAFE_RETRY_METHODS,
  RETRYABLE_STATUSES,
  DEFAULT_TRUSTED_PROXY_CIDRS,
  MAX_CACHE_CAPTURE_BYTES,
  applyHeaderRules,
  createProxyService,
  collectRequestBody,
  encodeBufferedResponse,
  expandTemplate,
  requestOptions,
  requestContext,
  negotiatedEncoding,
  rewriteRequestPath,
  targetPath,
};
