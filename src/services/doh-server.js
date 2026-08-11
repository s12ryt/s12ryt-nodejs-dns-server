"use strict";

const http = require("node:http");

const { minimumAnswerTtl } = require("../dns/message");
const { mediaType } = require("../dns/upstream-doh");

const MAX_DOH_BODY = 65535;
const DOH_ALLOW_METHODS = "GET, POST, OPTIONS";
const DOH_ALLOW_HEADERS = "Content-Type, Accept";

function setDohCorsHeaders(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", DOH_ALLOW_METHODS);
  response.setHeader("access-control-allow-headers", DOH_ALLOW_HEADERS);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_DOH_BODY) {
        reject(Object.assign(new Error("DNS message is too large"), { statusCode: 413 }));
        request.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function createDohService({ resolver, host = "0.0.0.0", port = 8053 } = {}) {
  if (!resolver || typeof resolver.resolve !== "function") throw new TypeError("resolver must provide resolve(wire)");
  let server;

  return {
    async start() {
      if (server) throw new Error("DoH service is already started");
      server = http.createServer(async (request, response) => {
        const url = new URL(request.url, "http://localhost");
        if (url.pathname !== "/dns-query") {
          response.writeHead(404).end();
          return;
        }
        setDohCorsHeaders(response);
        if (request.method === "OPTIONS") {
          response.writeHead(204).end();
          return;
        }

        try {
          let wire;
          if (request.method === "GET") {
            const encoded = url.searchParams.get("dns");
            if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
              response.writeHead(400).end();
              return;
            }
            wire = Buffer.from(encoded, "base64url");
          } else if (request.method === "POST") {
            if (mediaType(request.headers["content-type"]) !== "application/dns-message") {
              response.writeHead(415).end();
              return;
            }
            wire = await readBody(request);
          } else {
            response.setHeader("allow", DOH_ALLOW_METHODS);
            response.writeHead(405).end();
            return;
          }
          if (wire.length < 12 || wire.length > MAX_DOH_BODY) {
            response.writeHead(400).end();
            return;
          }
          const result = await resolver.resolve(wire, {
            transport: "doh",
            method: request.method,
            clientIp: request.socket.remoteAddress,
          });
          response.setHeader("content-type", "application/dns-message");
          response.setHeader("cache-control", `max-age=${minimumAnswerTtl(result)}`);
          response.writeHead(200).end(result);
        } catch (error) {
          if (!response.headersSent) response.writeHead(error.statusCode || 400).end();
        }
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
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    },
  };
}

module.exports = {
  DOH_ALLOW_HEADERS,
  DOH_ALLOW_METHODS,
  MAX_DOH_BODY,
  createDohService,
  readBody,
  setDohCorsHeaders,
};
