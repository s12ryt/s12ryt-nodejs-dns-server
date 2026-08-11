"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");

test("Docker deployment is Debian based, non-root, persistent and health checked", async () => {
  const [dockerfile, compose] = await Promise.all([
    fs.readFile(path.join(ROOT, "Dockerfile"), "utf8"),
    fs.readFile(path.join(ROOT, "docker-compose.yml"), "utf8"),
  ]);

  assert.match(dockerfile, /^FROM node:20-bookworm-slim/m);
  assert.match(dockerfile, /groupadd[^\n]+s12/);
  assert.match(dockerfile, /useradd[^\n]+s12/);
  assert.match(dockerfile, /^USER s12$/m);
  assert.match(dockerfile, /^STOPSIGNAL SIGTERM$/m);
  assert.match(dockerfile, /^VOLUME \["\/app\/data"\]$/m);
  assert.match(dockerfile, /HEALTHCHECK[^\n]*--interval=/);
  assert.match(dockerfile, /127\.0\.0\.1:8081\/api\/bootstrap/);
  assert.doesNotMatch(dockerfile, /alpine/i);

  assert.match(compose, /read_only:\s*true/);
  assert.match(compose, /user:\s*["']?10001:10001/);
  assert.match(compose, /stop_grace_period:\s*30s/);
  assert.match(compose, /restart:\s*unless-stopped/);
  assert.match(compose, /s12-data:\/app\/data/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:[\s\S]*- ALL/);
});

test("CI builds and health checks the production container before publishing", async () => {
  const workflow = await fs.readFile(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(workflow, /^  deployment:$/m);
  assert.match(workflow, /docker build --tag s12-dns-server:test/);
  assert.match(workflow, /docker inspect[^\n]+\.State\.Health\.Status/);
  assert.match(workflow, /docker stop --time 30 s12-dns-test/);
  const releaseNeeds = workflow.match(/^  release:\r?\n[\s\S]*?^    needs: \[([^\]]+)\]/m)?.[1]
    .split(",")
    .map((value) => value.trim())
    .sort();
  assert.deepEqual(releaseNeeds, ["benchmark-scale", "benchmark-smoke", "deployment", "e2e", "test"]);
});

test("CI verifies Linux index-only cold start and last-known-good rollback after release", async () => {
  const workflow = await fs.readFile(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(workflow, /^  release-verification:$/m);
  assert.match(workflow, /needs: release/);
  assert.match(workflow, /gh release download[^\n]+--pattern index\.js/);
  assert.match(workflow, /INITIAL_FILES/);
  assert.match(workflow, /data\/runtime\/active\.json/);
  assert.match(workflow, /node-v115-linux-x64/);
  assert.match(workflow, /127\.0\.0\.1:8081\/api\/bootstrap/);
  assert.match(workflow, /APP_MANIFEST_URL=https:\/\/127\.0\.0\.1:9\/manifest\.json/);
  assert.match(workflow, /kill -TERM/);
});
