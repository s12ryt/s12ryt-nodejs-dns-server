"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { RecordStore } = require("../../src/dns/records");

test("RecordStore prefers exact records over the closest wildcard", () => {
  const store = new RecordStore([
    { name: "*.example.test", type: "A", value: "192.0.2.1", ttl: 60 },
    { name: "*.dev.example.test", type: "A", value: "192.0.2.2", ttl: 60 },
    { name: "api.dev.example.test.", type: "A", value: "192.0.2.3", ttl: 60 },
  ]);

  assert.equal(store.find("API.DEV.EXAMPLE.TEST", "A")[0].value, "192.0.2.3");
  assert.equal(store.find("web.dev.example.test", "A")[0].value, "192.0.2.2");
  assert.equal(store.find("web.example.test", "A")[0].value, "192.0.2.1");
});

test("RecordStore returns CNAME for an address query and all types for ANY", () => {
  const store = new RecordStore([
    { name: "alias.example.test", type: "CNAME", value: "example.test", ttl: 30 },
    { name: "example.test", type: "A", value: "192.0.2.4", ttl: 30 },
    { name: "example.test", type: "TXT", value: "local", ttl: 30 },
  ]);

  assert.equal(store.find("alias.example.test", "AAAA")[0].type, "CNAME");
  assert.deepEqual(store.find("example.test", "ANY").map((record) => record.type), ["A", "TXT"]);
});
