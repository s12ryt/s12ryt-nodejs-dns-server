"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { Duplex, PassThrough } = require("node:stream");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const { ProxyCache } = require("../../src/services/proxy-cache");
const { ProxyRoutes } = require("../../src/services/proxy-routes");
const { createProxyService } = require("../../src/services/proxy-server");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function proxyRequest(port, { host, path = "/", method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: { ...headers, host },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const rawBody = Buffer.concat(chunks);
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: rawBody.toString(),
          rawBody,
        });
      });
    });
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

test("reverse proxy preserves method, path and forwarding headers", async (t) => {
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString(),
        host: request.headers.host,
        forwardedHost: request.headers["x-forwarded-host"],
        forwardedProto: request.headers["x-forwarded-proto"],
        forwardedFor: request.headers["x-forwarded-for"],
      }));
    });
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => close(upstream));

  const routes = new ProxyRoutes([{
    host: "app.example.test",
    target: `http://127.0.0.1:${upstreamAddress.port}/base/`,
  }]);
  const proxy = createProxyService({ routes, host: "127.0.0.1", port: 0, timeoutMs: 2000 });
  await proxy.start();
  t.after(() => proxy.close());

  const response = await proxyRequest(proxy.address().port, {
    host: "app.example.test",
    path: "/api?q=1",
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "payload",
  });
  assert.equal(response.status, 200);
  const received = JSON.parse(response.body);
  assert.equal(received.method, "POST");
  assert.equal(received.url, "/base/api?q=1");
  assert.equal(received.body, "payload");
  assert.equal(received.host, `127.0.0.1:${upstreamAddress.port}`);
  assert.equal(received.forwardedHost, "app.example.test");
  assert.equal(received.forwardedProto, "http");
  assert.match(received.forwardedFor, /127\.0\.0\.1/);
});

test("reverse proxy returns explicit errors for missing routes and loops", async (t) => {
  const routes = new ProxyRoutes([]);
  const proxy = createProxyService({ routes, host: "127.0.0.1", port: 0 });
  await proxy.start();
  t.after(() => proxy.close());
  assert.equal((await proxyRequest(proxy.address().port, { host: "missing.test" })).status, 404);
  assert.equal((await proxyRequest(proxy.address().port, {
    host: "missing.test",
    headers: { "x-s12-proxy-hop": "1" },
  })).status, 508);
});

test("reverse proxy forwards WebSocket upgrades and duplex bytes", async (t) => {
  const upstream = http.createServer();
  const upstreamSockets = new Set();
  upstream.on("upgrade", (_request, socket, head) => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    if (head.length) socket.write(head);
    socket.on("data", (chunk) => socket.write(chunk));
  });
  const upstreamAddress = await listen(upstream);

  const proxy = createProxyService({
    routes: new ProxyRoutes([{ host: "ws.example.test", target: `http://127.0.0.1:${upstreamAddress.port}` }]),
    host: "127.0.0.1",
    port: 0,
  });
  await proxy.start();
  t.after(async () => {
    await proxy.close();
    for (const socket of upstreamSockets) socket.destroy();
    await close(upstream);
  });

  const result = await new Promise((resolve, reject) => {
    const socket = net.connect(proxy.address().port, "127.0.0.1");
    let received = Buffer.alloc(0);
    let sentPayload = false;
    let completed = false;
    socket.once("connect", () => socket.write(
      "GET /socket HTTP/1.1\r\nHost: ws.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    ));
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (!sentPayload && received.includes(Buffer.from("\r\n\r\n"))) {
        sentPayload = true;
        socket.write("hello");
        return;
      }
      if (received.includes(Buffer.from("\r\n\r\nhello"))) {
        completed = true;
        socket.destroy();
        resolve(received.toString());
      }
    });
    socket.once("error", reject);
    socket.once("close", () => {
      if (!completed) reject(new Error(`WebSocket proxy closed early: ${received.toString()}`));
    });
    setTimeout(() => {
      if (!completed) {
        socket.destroy();
        reject(new Error(`WebSocket proxy timed out: ${received.toString()}`));
      }
    }, 2000).unref();
  });
  assert.match(result, /^HTTP\/1\.1 101/);
  assert.match(result, /\r\n\r\nhello$/);
});

test("reverse proxy applies location rewrite, header rules and redirects", async (t) => {
  const upstream = http.createServer((request, response) => {
    response.setHeader("x-upstream-secret", "remove-me");
    response.end(JSON.stringify({
      url: request.url,
      site: request.headers["x-site"],
      removed: request.headers["x-remove"],
    }));
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => close(upstream));
  const routes = new ProxyRoutes([{
    host: "rules.example.test",
    aliases: ["alias.example.test"],
    locations: [
      {
        path: "/api",
        match: "prefix",
        action: "proxy",
        upstreams: [{ target: `http://127.0.0.1:${upstreamAddress.port}` }],
        rewrite: { mode: "strip-prefix" },
        requestHeaders: { set: { "x-site": "${host}" }, remove: ["x-remove"] },
        responseHeaders: { set: { "x-served-by": "s12" }, remove: ["x-upstream-secret"] },
      },
      {
        path: "/old",
        match: "exact",
        action: "redirect",
        redirect: { status: 308, location: "https://${host}/new" },
      },
    ],
  }]);
  const proxy = createProxyService({ routes, host: "127.0.0.1", port: 0 });
  await proxy.start();
  t.after(() => proxy.close());

  const proxied = await proxyRequest(proxy.address().port, {
    host: "rules.example.test",
    path: "/api/users?q=1",
    headers: { "x-remove": "client" },
  });
  assert.equal(proxied.status, 200);
  assert.deepEqual(JSON.parse(proxied.body), { url: "/users?q=1", site: "rules.example.test" });
  assert.equal(proxied.headers["x-served-by"], "s12");
  assert.equal(proxied.headers["x-upstream-secret"], undefined);

  const redirected = await proxyRequest(proxy.address().port, { host: "alias.example.test", path: "/old" });
  assert.equal(redirected.status, 308);
  assert.equal(redirected.headers.location, "https://alias.example.test/new");
});

test("reverse proxy retries safe requests on passive upstream failure", async (t) => {
  let unavailableCalls = 0;
  const unavailable = http.createServer((_request, response) => {
    unavailableCalls += 1;
    response.writeHead(503).end("unavailable");
  });
  const healthy = http.createServer((_request, response) => response.end("healthy"));
  const [unavailableAddress, healthyAddress] = await Promise.all([listen(unavailable), listen(healthy)]);
  t.after(() => Promise.all([close(unavailable), close(healthy)]));
  const routes = new ProxyRoutes([{
    host: "pool.example.test",
    locations: [{
      path: "/",
      action: "proxy",
      upstreams: [
        { target: `http://127.0.0.1:${unavailableAddress.port}` },
        { target: `http://127.0.0.1:${healthyAddress.port}` },
      ],
    }],
  }]);
  const proxy = createProxyService({ routes, host: "127.0.0.1", port: 0 });
  await proxy.start();
  t.after(() => proxy.close());

  const response = await proxyRequest(proxy.address().port, { host: "pool.example.test", path: "/resource" });
  assert.equal(response.status, 200);
  assert.equal(response.body, "healthy");
  assert.equal(unavailableCalls, 1);
});

test("reverse proxy emits passive circuit breaker transitions without duplicating steady state", async (t) => {
  let now = 1_000;
  let healthy = false;
  const events = [];
  const upstream = http.createServer((_request, response) => {
    if (healthy) response.end("healthy");
    else response.writeHead(503).end("unavailable");
  });
  const address = await listen(upstream);
  t.after(() => close(upstream));
  const routes = new ProxyRoutes([{
    host: "passive-health.test",
    locations: [{ path: "/", upstreams: [{ id: "api", target: `http://127.0.0.1:${address.port}` }] }],
  }], { poolOptions: { now: () => now, openMs: 30_000, failureThreshold: 1 } });
  const proxy = createProxyService({ routes, host: "127.0.0.1", port: 0, onEvent: (event) => events.push(event) });
  await proxy.start();
  t.after(() => proxy.close());

  assert.equal((await proxyRequest(proxy.address().port, { host: "passive-health.test" })).status, 503);
  healthy = true;
  now += 30_000;
  assert.equal((await proxyRequest(proxy.address().port, { host: "passive-health.test" })).status, 200);
  assert.deepEqual(events.filter(({ kind }) => kind === "proxy-health").map(({ source, site, location, upstream: id, previousState, state }) => (
    { source, site, location, upstream: id, previousState, state }
  )), [
    { source: "passive", site: "passive-health.test", location: "prefix:/", upstream: "api", previousState: "healthy", state: "open" },
    { source: "passive", site: "passive-health.test", location: "prefix:/", upstream: "api", previousState: "half-open", state: "healthy" },
  ]);
});

test("reverse proxy enforces body, access and rate limits before upstream work", async (t) => {
  let upstreamCalls = 0;
  const upstream = http.createServer((_request, response) => {
    upstreamCalls += 1;
    response.end("ok");
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => close(upstream));
  const target = `http://127.0.0.1:${upstreamAddress.port}`;
  const routes = new ProxyRoutes([{
    host: "secure.test",
    locations: [
      { path: "/body", match: "exact", upstreams: [{ target }], bodyLimitBytes: 4 },
      { path: "/denied", match: "exact", upstreams: [{ target }], access: { deny: ["127.0.0.1/32"] } },
      { path: "/limited", match: "exact", upstreams: [{ target }], rateLimit: { enabled: true, requests: 1, windowMs: 60000 } },
    ],
  }]);
  const events = [];
  const proxy = createProxyService({ routes, host: "127.0.0.1", port: 0, onEvent: (event) => events.push(event) });
  await proxy.start();
  t.after(() => proxy.close());

  assert.equal((await proxyRequest(proxy.address().port, { host: "secure.test", path: "/body", method: "POST", body: "12345" })).status, 413);
  assert.equal((await proxyRequest(proxy.address().port, { host: "secure.test", path: "/denied" })).status, 403);
  assert.equal((await proxyRequest(proxy.address().port, { host: "secure.test", path: "/limited" })).status, 200);
  const limited = await proxyRequest(proxy.address().port, { host: "secure.test", path: "/limited" });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"], "60");
  assert.equal(upstreamCalls, 1);
  assert.deepEqual(events.filter((event) => event.kind === "proxy").map((event) => event.statusCode), [413, 403, 200, 429]);
  assert.equal(events.filter((event) => event.kind === "proxy").every((event) => (
    event.host === "secure.test"
    && event.clientIp === "127.0.0.1"
    && event.method
    && event.url
    && Number.isFinite(event.durationMs)
  )), true);
});

test("reverse proxy serves persistent cache hits and negotiates response compression", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-proxy-cache-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let upstreamCalls = 0;
  const payload = "compressible ".repeat(120);
  const upstream = http.createServer((_request, response) => {
    upstreamCalls += 1;
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.setHeader("cache-control", "public, max-age=60");
    response.end(payload);
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => close(upstream));
  const routes = new ProxyRoutes([{
    host: "cache.test",
    locations: [{
      path: "/",
      upstreams: [{ target: `http://127.0.0.1:${upstreamAddress.port}` }],
      cache: { enabled: true, ttlSeconds: 60, maxBytes: 1024 * 1024 },
      compression: { enabled: true, minBytes: 1024 },
    }],
  }]);
  const cache = new ProxyCache({ directory, maxBytes: 1024 * 1024 });
  await cache.start();
  t.after(() => cache.close());
  const proxy = createProxyService({ routes, cache, host: "127.0.0.1", port: 0 });
  await proxy.start();
  t.after(() => proxy.close());

  const first = await proxyRequest(proxy.address().port, { host: "cache.test", path: "/asset", headers: { "accept-encoding": "br, gzip" } });
  assert.equal(first.status, 200);
  assert.equal(first.headers["content-encoding"], "br");
  assert.equal(zlib.brotliDecompressSync(first.rawBody).toString(), payload);

  const second = await proxyRequest(proxy.address().port, { host: "cache.test", path: "/asset", headers: { "accept-encoding": "gzip" } });
  assert.equal(second.status, 200);
  assert.equal(second.headers["content-encoding"], "gzip");
  assert.equal(zlib.gunzipSync(second.rawBody).toString(), payload);
  assert.equal(upstreamCalls, 1);
  assert.match(second.headers.vary, /accept-encoding/i);
  assert.equal(second.headers["content-length"], undefined);
});

test("reverse proxy uses explicit fallbacks without replaying unsafe methods by default", async (t) => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const primary = http.createServer((_request, response) => { primaryCalls += 1; response.writeHead(503).end("primary down"); });
  const fallback = http.createServer((request, response) => { fallbackCalls += 1; response.end(`fallback:${request.method}`); });
  const [primaryAddress, fallbackAddress] = await Promise.all([listen(primary), listen(fallback)]);
  t.after(() => Promise.all([close(primary), close(fallback)]));
  const routes = new ProxyRoutes([{
    host: "fallback.test",
    locations: [
      { path: "/safe", match: "exact", upstreams: [{ target: `http://127.0.0.1:${primaryAddress.port}` }], fallbackUpstreams: [{ target: `http://127.0.0.1:${fallbackAddress.port}` }] },
      { path: "/unsafe", match: "exact", upstreams: [{ target: `http://127.0.0.1:${primaryAddress.port}` }], fallbackUpstreams: [{ target: `http://127.0.0.1:${fallbackAddress.port}` }] },
      { path: "/allowed", match: "exact", upstreams: [{ target: `http://127.0.0.1:${primaryAddress.port}` }], fallbackUpstreams: [{ target: `http://127.0.0.1:${fallbackAddress.port}` }], allowUnsafeFallback: true },
    ],
  }]);
  const proxy = createProxyService({ routes, host: "127.0.0.1", port: 0 });
  await proxy.start();
  t.after(() => proxy.close());

  assert.equal((await proxyRequest(proxy.address().port, { host: "fallback.test", path: "/safe" })).body, "fallback:GET");
  const unsafe = await proxyRequest(proxy.address().port, { host: "fallback.test", path: "/unsafe", method: "POST", body: "write" });
  assert.equal(unsafe.status, 503);
  const allowed = await proxyRequest(proxy.address().port, { host: "fallback.test", path: "/allowed", method: "POST", body: "write" });
  assert.equal(allowed.body, "fallback:POST");
  assert.equal(primaryCalls, 3);
  assert.equal(fallbackCalls, 2);
});

test("reverse proxy returns maintenance responses without contacting upstreams", async (t) => {
  let upstreamCalls = 0;
  const upstream = http.createServer((_request, response) => { upstreamCalls += 1; response.end("unexpected"); });
  const address = await listen(upstream);
  t.after(() => close(upstream));
  const routes = new ProxyRoutes([{
    host: "maintenance.test",
    maintenance: { enabled: true, retryAfterSeconds: 90 },
    target: `http://127.0.0.1:${address.port}`,
  }]);
  const proxy = createProxyService({ routes, host: "127.0.0.1", port: 0 });
  await proxy.start();
  t.after(() => proxy.close());
  const response = await proxyRequest(proxy.address().port, { host: "maintenance.test" });
  assert.equal(response.status, 503);
  assert.equal(response.headers["retry-after"], "90");
  assert.equal(upstreamCalls, 0);
});

test("reverse proxy mirrors sampled traffic without delaying or leaking credentials", async (t) => {
  const shadows = [];
  let releaseShadow;
  const shadowReceived = new Promise((resolve) => { releaseShadow = resolve; });
  const primary = http.createServer((_request, response) => response.end("primary"));
  const shadow = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      shadows.push({ method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString() });
      setTimeout(() => {
        response.end("shadow");
        releaseShadow();
      }, 150);
    });
  });
  const [primaryAddress, shadowAddress] = await Promise.all([listen(primary), listen(shadow)]);
  t.after(() => Promise.all([close(primary), close(shadow)]));
  const routes = new ProxyRoutes([{
    host: "shadow.test",
    locations: [
      {
        path: "/safe",
        match: "exact",
        upstreams: [{ target: `http://127.0.0.1:${primaryAddress.port}` }],
        shadow: { target: `http://127.0.0.1:${shadowAddress.port}`, sampleRate: 1 },
      },
      {
        path: "/write",
        match: "exact",
        upstreams: [{ target: `http://127.0.0.1:${primaryAddress.port}` }],
        shadow: { target: `http://127.0.0.1:${shadowAddress.port}`, sampleRate: 1, allowUnsafeMethods: true },
      },
      {
        path: "/blocked-write",
        match: "exact",
        upstreams: [{ target: `http://127.0.0.1:${primaryAddress.port}` }],
        shadow: { target: `http://127.0.0.1:${shadowAddress.port}`, sampleRate: 1 },
      },
    ],
  }]);
  const proxy = createProxyService({ routes, host: "127.0.0.1", port: 0, random: () => 0 });
  await proxy.start();
  t.after(() => proxy.close());

  const startedAt = Date.now();
  assert.equal((await proxyRequest(proxy.address().port, {
    host: "shadow.test",
    path: "/safe",
    headers: { authorization: "Bearer secret", cookie: "session=secret", "proxy-authorization": "Basic secret" },
  })).body, "primary");
  assert.ok(Date.now() - startedAt < 140, "primary response must not wait for shadow response");
  await Promise.race([
    shadowReceived,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("shadow request was not received")), 500)),
  ]);
  assert.equal(shadows[0].headers.authorization, undefined);
  assert.equal(shadows[0].headers.cookie, undefined);
  assert.equal(shadows[0].headers["proxy-authorization"], undefined);
  assert.equal(shadows[0].headers["x-s12-shadow"], "1");

  await proxyRequest(proxy.address().port, { host: "shadow.test", path: "/blocked-write", method: "POST", body: "blocked" });
  await proxyRequest(proxy.address().port, { host: "shadow.test", path: "/write", method: "POST", body: "mirrored" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(shadows.length, 2);
  assert.equal(shadows[1].method, "POST");
  assert.equal(shadows[1].body, "mirrored");
});

test("reverse proxy limits, reports and aborts WebSocket connections by site", async (t) => {
  const upstream = http.createServer();
  const upstreamSockets = new Set();
  upstream.on("upgrade", (_request, socket) => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    socket.on("data", (chunk) => socket.write(chunk));
  });
  const upstreamAddress = await listen(upstream);
  const routes = new ProxyRoutes([{
    host: "limited-ws.test",
    websocket: { maxConnections: 1, idleTimeoutMs: 60_000, drainTimeoutMs: 30_000 },
    target: `http://127.0.0.1:${upstreamAddress.port}`,
  }]);
  const proxy = createProxyService({ routes, host: "127.0.0.1", port: 0 });
  await proxy.start();
  t.after(async () => {
    await proxy.close();
    for (const socket of upstreamSockets) socket.destroy();
    await close(upstream);
  });

  const connectUpgrade = () => new Promise((resolve, reject) => {
    const socket = net.connect(proxy.address().port, "127.0.0.1");
    let received = "";
    socket.once("connect", () => socket.write(
      "GET /socket HTTP/1.1\r\nHost: limited-ws.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    ));
    socket.on("data", (chunk) => {
      received += chunk.toString();
      if (received.includes("\r\n\r\n")) resolve({ socket, response: received });
    });
    socket.once("error", reject);
  });

  const first = await connectUpgrade();
  assert.match(first.response, /^HTTP\/1\.1 101/);
  const second = await connectUpgrade();
  assert.match(second.response, /^HTTP\/1\.1 503/);
  second.socket.destroy();
  const active = proxy.websocketStatus().sites[0];
  assert.equal(active.site, "limited-ws.test");
  assert.equal(active.active, 1);
  assert.equal(active.accepted, 1);
  assert.equal(active.rejected, 1);
  assert.equal(active.completed, 0);
  assert.equal(proxy.abortSite("limited-ws.test"), 1);
  await new Promise((resolve) => first.socket.once("close", resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const completed = proxy.websocketStatus().sites[0];
  assert.equal(completed.active, 0);
  assert.equal(completed.completed, 1);
  assert.ok(completed.totalDurationMs >= 0);
});

test("reverse proxy forwards HTTPS upstream traffic through a pooled HTTP/2 client", async (t) => {
  const calls = [];
  let closed = false;
  const http2Pool = {
    request(url, headers) {
      const chunks = [];
      const stream = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          calls.push({ url: url.href, headers, body: Buffer.concat(chunks).toString() });
          stream.emit("response", { ":status": 201, "content-type": "text/plain", "x-http-version": "2" });
          stream.push("h2-response");
          stream.push(null);
          callback();
        },
      });
      return { session: {}, stream };
    },
    async close() { closed = true; },
  };
  const routes = new ProxyRoutes([{
    host: "h2-proxy.example.test",
    locations: [{
      path: "/api",
      action: "proxy",
      rewrite: { mode: "strip-prefix" },
      upstreams: [{ target: "https://upstream.internal/base/", protocol: "http2" }],
    }],
  }]);
  const proxy = createProxyService({ routes, http2Pool, host: "127.0.0.1", port: 0 });
  await proxy.start();
  t.after(() => proxy.close());

  const response = await proxyRequest(proxy.address().port, {
    host: "h2-proxy.example.test",
    path: "/api/items?q=1",
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "payload",
  });
  assert.equal(response.status, 201);
  assert.equal(response.body, "h2-response");
  assert.equal(response.headers["x-http-version"], "2");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://upstream.internal/base/");
  assert.equal(calls[0].headers[":method"], "POST");
  assert.equal(calls[0].headers[":path"], "/base/items?q=1");
  assert.equal(calls[0].headers[":authority"], "upstream.internal");
  assert.equal(calls[0].body, "payload");

  await proxy.close();
  assert.equal(closed, true);
});

test("automatic HTTPS upstream protocol falls back once and remembers HTTP/1.1", async (t) => {
  let h2Calls = 0;
  let h1Calls = 0;
  const downgraded = new Set();
  const http2Pool = {
    request() {
      h2Calls += 1;
      const stream = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
      stream.on("error", () => {});
      stream.end = () => {
        queueMicrotask(() => stream.emit("error", Object.assign(new Error("ALPN did not negotiate h2"), { code: "ERR_HTTP2_ERROR" })));
        return stream;
      };
      return { session: {}, stream };
    },
    markHttp1(url) { downgraded.add(url.origin); },
    prefersHttp1(url) { return downgraded.has(url.origin); },
    async close() {},
  };
  const http1Request = (_url, _options, callback) => {
    h1Calls += 1;
    const request = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
    request.end = () => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = { "content-type": "text/plain" };
      queueMicrotask(() => {
        callback(response);
        response.end("http1-response");
      });
      return request;
    };
    return request;
  };
  const routes = new ProxyRoutes([{
    host: "auto.example.test",
    locations: [{ path: "/", action: "proxy", upstreams: [{ target: "https://legacy.internal", protocol: "auto" }] }],
  }]);
  const proxy = createProxyService({ routes, http2Pool, http1Request, host: "127.0.0.1", port: 0 });
  await proxy.start();
  t.after(() => proxy.close());

  assert.equal((await proxyRequest(proxy.address().port, { host: "auto.example.test" })).body, "http1-response");
  assert.equal((await proxyRequest(proxy.address().port, { host: "auto.example.test" })).body, "http1-response");
  assert.equal(h2Calls, 1);
  assert.equal(h1Calls, 2);
});

test("proxy service drains a site, rejects new work and aborts remaining connections after grace", async (t) => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("started");
    setTimeout(() => response.end("finished"), 250).unref();
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => close(upstream));
  const routes = new ProxyRoutes([{
    host: "draining.example.test",
    websocket: { drainTimeoutMs: 1000 },
    target: `http://127.0.0.1:${upstreamAddress.port}`,
  }]);
  const scheduled = [];
  const proxy = createProxyService({
    routes,
    host: "127.0.0.1",
    port: 0,
    schedule(callback, delay) {
      const timer = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
      scheduled.push(timer);
      return timer;
    },
    cancel() {},
  });
  await proxy.start();
  t.after(() => proxy.close());

  const active = http.request({
    hostname: "127.0.0.1",
    port: proxy.address().port,
    path: "/slow",
    headers: { host: "draining.example.test" },
  });
  const activeClosed = new Promise((resolve) => active.once("close", resolve));
  active.on("response", (response) => response.resume());
  active.on("error", () => {});
  active.end();
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(proxy.drainSite("draining.example.test"), true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 1000);
  assert.equal(scheduled[0].unrefCalled, true);
  assert.equal((await proxyRequest(proxy.address().port, { host: "draining.example.test" })).status, 503);
  scheduled[0].callback();
  await activeClosed;
  assert.equal(proxy.drainStatus().sites[0].draining, true);
  assert.equal(proxy.resumeSite("draining.example.test"), true);
  assert.equal(proxy.drainStatus().sites[0].draining, false);
});
