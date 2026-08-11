"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");

test("package exposes distinct CI smoke and 24 hour formal benchmark commands", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(pkg.scripts["benchmark:ci"], /--profile ci/);
  assert.match(pkg.scripts["benchmark:scale"], /--profile scale/);
  assert.match(pkg.scripts["benchmark:release"], /--profile release/);
});

test("CI runs and preserves non-formal smoke evidence before release", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /^  benchmark-smoke:/m);
  assert.match(workflow, /npm run benchmark:ci/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /benchmark-ci\.json/);
  assert.match(workflow, /^  benchmark-scale:/m);
  assert.match(workflow, /npm run benchmark:scale/);
  assert.match(workflow, /benchmark-scale\.json/);
  assert.match(workflow, /needs: \[test, e2e, deployment, benchmark-smoke, benchmark-scale\]/);
});
