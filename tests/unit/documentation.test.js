"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");

function document(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("README links the v1 operations API deployment and benchmark manuals", () => {
  const readme = document("README.md");
  for (const file of ["docs/operations.md", "docs/api.md", "docs/deployment.md", "docs/benchmark.md"]) {
    assert.match(readme, new RegExp(`\\(${file.replace(".", "\\.")}\\)`));
  }
});

test("v1 manuals preserve recovery security and formal acceptance contracts", () => {
  const operations = document("docs/operations.md");
  assert.match(operations, /owner-only/i);
  assert.match(operations, /診斷包/);
  assert.match(operations, /crash|崩潰/i);
  assert.match(operations, /last-known-good/i);

  const api = document("docs/api.md");
  assert.match(api, /\/api\/v2\/openapi\.json/);
  assert.match(api, /Idempotency-Key/);
  assert.match(api, /Bearer/);

  const deployment = document("docs/deployment.md");
  assert.match(deployment, /Linux glibc/);
  assert.match(deployment, /Docker Compose/);
  assert.match(deployment, /systemd/);
  assert.match(deployment, /rollback|回滾/i);

  const benchmark = document("docs/benchmark.md");
  assert.match(benchmark, /100,000/);
  assert.match(benchmark, /5,000 QPS/);
  assert.match(benchmark, /1,000 RPS/);
  assert.match(benchmark, /24 小時/);
  assert.match(benchmark, /formal:false/);
  assert.match(benchmark, /npm run benchmark:release/);
});
