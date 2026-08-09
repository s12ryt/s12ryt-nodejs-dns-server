"use strict";

const http = require("node:http");
const https = require("node:https");

const HOP_HEADER = "x-s12-proxy-hop";

function appendForwardedFor(current, address) {
  return [current, address].filter(Boolean).join(", ");
}

function targetPath(basePath, requestUrl) {
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const incoming = requestUrl.startsWith("/") ? requestUrl : `/${requestUrl}`;
  return `${base}${incoming}` || "/";
}

function requestOptions(request, route, timeoutMs) {
  const headers = { ...request.headers };
  headers.host = route.upstreamHost || route.url.host;
  headers["x-forwarded-host"] = request.headers.host || "";
  headers["x-forwarded-proto"] = request.socket.encrypted ? "https" : "http";
  headers["x-forwarded-for"] = appendForwardedFor(headers["x-forwarded-for"], request.socket.remoteAddress);
  headers[HOP_HEADER] = "1";
  return {
    protocol: route.url.protocol,
    hostname: route.url.hostname,
    port: route.url.port || undefined,
    method: request.method,
    path: targetPath(route.url.pathname, request.url),
    headers,
    timeout: route.timeoutMs || timeoutMs,
    servername: route.url.hostname,
  };
}

function transportFor(url) {
  return url.protocol === "https:" ? https : http;
}

function createProxyService({ routes, host = "0.0.0.0", port = 8080, timeoutMs = 30000, onEvent = () => {} } = {}) {
  if (!routes || typeof routes.resolve !== "function") throw new TypeError("routes must provide resolve(host)");
  let server;
  const sockets = new Set();
  const upstreamSockets = new Set();

  function selectRoute(request, responseOrSocket) {
    if (request.headers[HOP_HEADER]) {
      if (typeof responseOrSocket.writeHead === "function") responseOrSocket.writeHead(508).end("Proxy loop detected");
      else responseOrSocket.end("HTTP/1.1 508 Loop Detected\r\nConnection: close\r\n\r\n");
      return null;
    }
    const route = routes.resolve(request.headers.host);
    if (!route) {
      if (typeof responseOrSocket.writeHead === "function") responseOrSocket.writeHead(404).end("No proxy route");
      else responseOrSocket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return null;
    }
    return route;
  }

  return {
    async start() {
      if (server) throw new Error("Proxy service is already started");
      server = http.createServer((request, response) => {
        const route = selectRoute(request, response);
        if (!route) return;
        const upstream = transportFor(route.url).request(requestOptions(request, route, timeoutMs), (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        });
        upstream.on("timeout", () => upstream.destroy(Object.assign(new Error("Proxy timeout"), { code: "ETIMEDOUT" })));
        upstream.on("error", (error) => {
          onEvent({ kind: "proxy-error", host: route.host, message: error.message });
          if (!response.headersSent) response.writeHead(error.code === "ETIMEDOUT" ? 504 : 502).end("Upstream unavailable");
          else response.destroy(error);
        });
        request.pipe(upstream);
      });

      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });

      server.on("upgrade", (request, socket, head) => {
        const route = selectRoute(request, socket);
        if (!route) return;
        const upstream = transportFor(route.url).request(requestOptions(request, route, timeoutMs));
        upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
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
        upstream.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"));
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

module.exports = { HOP_HEADER, createProxyService, requestOptions, targetPath };
