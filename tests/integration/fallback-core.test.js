"use strict";

const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { startFallback } = require("../../index");
const { createQuery, parseMessage } = require("../../src/dns/message");

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
        socket.end();
        resolve(pending.subarray(2, pending.readUInt16BE(0) + 2));
      }
    });
    socket.once("error", reject);
  });
}

test("embedded fallback serves configured records over UDP, TCP and RFC 8484 DoH", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-fallback-"));
  await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({
    records: [{ name: "offline.test", type: "A", value: "192.0.2.44", ttl: 90 }],
  }));
  let upstreamCalls = 0;
  const service = await startFallback({
    directory,
    host: "127.0.0.1",
    dnsPort: 0,
    dohPort: 0,
    fetchImpl: async () => {
      upstreamCalls += 1;
      throw new Error("offline");
    },
  });
  t.after(async () => {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const dnsPort = service.addresses.dns.port;
  const dohBase = `http://127.0.0.1:${service.addresses.doh.port}/dns-query`;
  const query = createQuery("offline.test", "A", { id: 701 });
  const responses = [
    await udpQuery(dnsPort, query),
    await tcpQuery(dnsPort, query),
  ];

  const getResponse = await fetch(`${dohBase}?dns=${query.toString("base64url")}`, {
    headers: { accept: "application/dns-message" },
  });
  const postResponse = await fetch(dohBase, {
    method: "POST",
    headers: { "content-type": "application/dns-message" },
    body: query,
  });
  assert.equal(getResponse.status, 200);
  assert.equal(postResponse.status, 200);
  responses.push(
    Buffer.from(await getResponse.arrayBuffer()),
    Buffer.from(await postResponse.arrayBuffer()),
  );

  for (const wire of responses) {
    const message = parseMessage(wire);
    assert.equal(message.answers[0].address, "192.0.2.44");
    assert.equal(message.answers[0].ttl, 90);
  }
  assert.equal(upstreamCalls, 0);
});
