"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildResponse,
  createQuery,
  decodeName,
  minimumAnswerTtl,
  parseMessage,
} = require("../../src/dns/message");

test("createQuery preserves the question, recursion flag, and DNSSEC EDNS option", () => {
  const wire = createQuery("www.example.test", "AAAA", {
    id: 0x1234,
    dnssecOk: true,
  });

  const message = parseMessage(wire);

  assert.equal(message.id, 0x1234);
  assert.equal(message.flags.rd, true);
  assert.deepEqual(message.questions, [
    { name: "www.example.test", type: "AAAA", class: "IN" },
  ]);
  assert.equal(message.additionals.length, 1);
  assert.equal(message.additionals[0].type, "OPT");
  assert.equal(message.additionals[0].udpPayloadSize, 1232);
  assert.equal(message.additionals[0].dnssecOk, true);
});

test("decodeName rejects cyclic compression pointers", () => {
  const cyclicName = Buffer.from([0xc0, 0x00]);

  assert.throws(
    () => decodeName(cyclicName, 0),
    /compression pointer loop/i,
  );
});

test("buildResponse encodes every supported custom record type", () => {
  const query = createQuery("example.test", "ANY", { id: 7, edns: false });
  const wire = buildResponse(query, [
    { name: "example.test", type: "A", ttl: 120, value: "192.0.2.10" },
    { name: "example.test", type: "AAAA", ttl: 110, value: "2001:db8::10" },
    { name: "www.example.test", type: "CNAME", ttl: 100, value: "example.test" },
    { name: "example.test", type: "MX", ttl: 90, priority: 10, exchange: "mail.example.test" },
    { name: "example.test", type: "TXT", ttl: 80, value: "self-hosted dns" },
    { name: "example.test", type: "NS", ttl: 70, value: "ns1.example.test" },
    { name: "_http._tcp.example.test", type: "SRV", ttl: 60, priority: 1, weight: 5, port: 8080, target: "www.example.test" },
  ], { authoritative: true });

  const message = parseMessage(wire);

  assert.equal(message.flags.qr, true);
  assert.equal(message.flags.aa, true);
  assert.equal(message.flags.rcode, 0);
  assert.equal(message.answers[0].address, "192.0.2.10");
  assert.equal(message.answers[1].address, "2001:db8:0:0:0:0:0:10");
  assert.equal(message.answers[2].value, "example.test");
  assert.deepEqual(
    { priority: message.answers[3].priority, exchange: message.answers[3].exchange },
    { priority: 10, exchange: "mail.example.test" },
  );
  assert.equal(message.answers[4].value, "self-hosted dns");
  assert.equal(message.answers[5].value, "ns1.example.test");
  assert.deepEqual(
    {
      priority: message.answers[6].priority,
      weight: message.answers[6].weight,
      port: message.answers[6].port,
      target: message.answers[6].target,
    },
    { priority: 1, weight: 5, port: 8080, target: "www.example.test" },
  );
  assert.equal(minimumAnswerTtl(wire), 60);
});
