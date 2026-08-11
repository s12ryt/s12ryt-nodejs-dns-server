"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { validateConfig } = require("../../src/admin/config-store");
const { createBenchmarkConfig } = require("../../src/benchmark/dataset");

test("release benchmark dataset contains 100000 valid records and 1000 proxy sites deterministically", () => {
  const first = createBenchmarkConfig({ records: 100000, proxySites: 1000, upstreamUrl: "http://127.0.0.1:19090" });
  const second = createBenchmarkConfig({ records: 100000, proxySites: 1000, upstreamUrl: "http://127.0.0.1:19090" });
  assert.equal(first.records.length, 100000);
  assert.equal(first.routes.length, 1000);
  assert.deepEqual(first, second);
  assert.equal(first.domains[0].name, "benchmark.test");
  assert.equal(first.records[0].id, "00000000-0000-4000-8000-000000000000");
  assert.equal(first.records[99999].name, "r99999.benchmark.test");
  assert.equal(first.routes[999].host, "site-999.benchmark.test");
  const validated = validateConfig(first);
  assert.equal(validated.records.length, 100000);
  assert.equal(validated.routes.length, 1000);
});

test("benchmark dataset rejects unsafe or meaningless sizes", () => {
  assert.throws(() => createBenchmarkConfig({ records: 0, proxySites: 1 }), /record/i);
  assert.throws(() => createBenchmarkConfig({ records: 1, proxySites: 0 }), /proxy/i);
  assert.throws(() => createBenchmarkConfig({ records: 1, proxySites: 1, upstreamUrl: "file:///tmp/socket" }), /upstream/i);
});
