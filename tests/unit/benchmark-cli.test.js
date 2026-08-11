"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseArguments, runBenchmarkCli } = require("../../scripts/benchmark");

test("benchmark CLI accepts only explicit profiles and output paths", () => {
  assert.deepEqual(parseArguments(["--profile", "ci", "--output", "reports/ci.json"]), {
    profileName: "ci",
    outputPath: "reports/ci.json",
  });
  assert.throws(() => parseArguments(["--profile", "fast"]), /profile/i);
  assert.throws(() => parseArguments(["--profile", "release", "--duration-ms", "1000"]), /unknown argument/i);
});

test("benchmark CLI atomically persists normalized report and evaluation", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-benchmark-cli-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, "report.json");
  const result = await runBenchmarkCli({
    argv: ["--profile", "ci", "--output", outputPath],
    execute: async () => ({
      report: { formatVersion: 1, profile: "ci", formal: false },
      evaluation: { passed: true, formal: false, failures: [] },
    }),
  });
  assert.equal(result.evaluation.passed, true);
  assert.deepEqual(JSON.parse(await fs.readFile(outputPath, "utf8")), result);
  assert.deepEqual(await fs.readdir(directory), ["report.json"]);
});
