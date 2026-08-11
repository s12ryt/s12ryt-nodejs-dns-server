"use strict";

const http = require("node:http");

function createMetricsService({ registry, host = "127.0.0.1", port = 9090 } = {}) {
  if (!registry || typeof registry.toPrometheus !== "function") {
    throw new TypeError("Metrics registry must provide toPrometheus()");
  }
  let server;

  return {
    async start() {
      if (server) throw new Error("Metrics service is already started");
      server = http.createServer((request, response) => {
        const url = new URL(request.url, "http://localhost");
        if (request.method === "GET" && url.pathname === "/metrics") {
          response.writeHead(200, {
            "content-type": "text/plain; version=0.0.4; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          }).end(registry.toPrometheus());
          return;
        }
        if (request.method === "GET" && url.pathname === "/healthz") {
          response.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          }).end('{"status":"ok"}');
          return;
        }
        response.writeHead(404).end();
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
      const closing = server;
      server = undefined;
      await new Promise((resolve, reject) => closing.close((error) => error ? reject(error) : resolve()));
    },
  };
}

module.exports = { createMetricsService };
