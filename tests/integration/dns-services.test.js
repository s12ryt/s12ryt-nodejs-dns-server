"use strict";

const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const net = require("node:net");
const test = require("node:test");

const { createQuery, parseMessage } = require("../../src/dns/message");
const { RecordStore } = require("../../src/dns/records");
const { createResolver } = require("../../src/dns/resolver");
const { createDnsService } = require("../../src/services/dns-server");
const { createDohService } = require("../../src/services/doh-server");

function resolverFixture() {
  return createResolver({
    records: new RecordStore([{ name: "home.test", type: "A", value: "192.0.2.80", ttl: 120 }]),
  });
}

function udpQuery(port, wire) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", reject);
    socket.once("message", (message) => {
      socket.close();
      resolve(message);
    });
    socket.send(wire, port, "127.0.0.1");
  });
}

function tcpQuery(port, wire) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let pending = Buffer.alloc(0);
    socket.once("connect", () => {
      const prefix = Buffer.alloc(2);
      prefix.writeUInt16BE(wire.length);
      socket.write(Buffer.concat([prefix, wire]));
    });
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length >= 2 && pending.length >= pending.readUInt16BE(0) + 2) {
        const response = pending.subarray(2, 2 + pending.readUInt16BE(0));
        socket.end();
        resolve(response);
      }
    });
    socket.once("error", reject);
  });
}

test("UDP and TCP DNS listeners resolve the same custom record", async (t) => {
  const service = createDnsService({ resolver: resolverFixture(), host: "127.0.0.1", port: 0 });
  await service.start();
  t.after(() => service.close());
  const port = service.address().udp.port;

  for (const response of [
    await udpQuery(port, createQuery("home.test", "A", { id: 101 })),
    await tcpQuery(port, createQuery("home.test", "A", { id: 102 })),
  ]) {
    const parsed = parseMessage(response);
    assert.equal(parsed.answers[0].address, "192.0.2.80");
    assert.equal(parsed.flags.aa, true);
  }
});

test("DoH listener supports RFC 8484 GET and POST and rejects invalid requests", async (t) => {
  const service = createDohService({ resolver: resolverFixture(), host: "127.0.0.1", port: 0 });
  await service.start();
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.address().port}/dns-query`;
  const query = createQuery("home.test", "A", { id: 201 });

  const getResponse = await fetch(`${base}?dns=${query.toString("base64url")}`, {
    headers: { accept: "application/dns-message" },
  });
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.headers.get("content-type"), "application/dns-message");
  assert.equal(getResponse.headers.get("access-control-allow-origin"), "*");
  assert.equal(parseMessage(Buffer.from(await getResponse.arrayBuffer())).answers[0].address, "192.0.2.80");

  const postResponse = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/dns-message" },
    body: query,
  });
  assert.equal(postResponse.status, 200);
  assert.equal(postResponse.headers.get("access-control-allow-origin"), "*");
  assert.equal(parseMessage(Buffer.from(await postResponse.arrayBuffer())).answers[0].address, "192.0.2.80");

  const preflight = await fetch(base, {
    method: "OPTIONS",
    headers: {
      Origin: "https://diagnostic.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type, Accept",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.match(preflight.headers.get("access-control-allow-methods"), /GET/);
  assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);
  assert.match(preflight.headers.get("access-control-allow-methods"), /OPTIONS/);
  assert.match(preflight.headers.get("access-control-allow-headers"), /Content-Type/i);
  assert.match(preflight.headers.get("access-control-allow-headers"), /Accept/i);

  const malformed = await fetch(`${base}?dns=not-valid-wire`);
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get("access-control-allow-origin"), "*");

  const unsupportedMethod = await fetch(base, { method: "PUT" });
  assert.equal(unsupportedMethod.status, 405);
  assert.equal(unsupportedMethod.headers.get("access-control-allow-origin"), "*");

  const unsupportedMedia = await fetch(base, { method: "POST", body: query });
  assert.equal(unsupportedMedia.status, 415);
  assert.equal(unsupportedMedia.headers.get("access-control-allow-origin"), "*");

  const missing = await fetch("http://127.0.0.1:" + service.address().port + "/missing", {
    headers: { Origin: "https://diagnostic.example" },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("access-control-allow-origin"), null);
});
