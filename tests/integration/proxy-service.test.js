"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
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
  const proxy = createProxyService({ routes, host: "127.0.0.1", port: 0 });
  await proxy.start();
  t.after(() => proxy.close());

  assert.equal((await proxyRequest(proxy.address().port, { host: "secure.test", path: "/body", method: "POST", body: "12345" })).status, 413);
  assert.equal((await proxyRequest(proxy.address().port, { host: "secure.test", path: "/denied" })).status, 403);
  assert.equal((await proxyRequest(proxy.address().port, { host: "secure.test", path: "/limited" })).status, 200);
  const limited = await proxyRequest(proxy.address().port, { host: "secure.test", path: "/limited" });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"], "60");
  assert.equal(upstreamCalls, 1);
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
