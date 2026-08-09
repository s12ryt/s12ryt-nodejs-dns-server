"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const test = require("node:test");

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
      response.on("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString(),
      }));
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
