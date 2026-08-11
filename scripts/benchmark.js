"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

const { BENCHMARK_PROFILES } = require("../src/benchmark/profile");
const { executeBenchmark } = require("../src/benchmark/command");

function parseArguments(argv) {
  let profileName;
  let outputPath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--profile") profileName = argv[++index];
    else if (argument === "--output") outputPath = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!BENCHMARK_PROFILES[profileName]) throw new Error("Benchmark profile must be ci or release");
  if (outputPath !== undefined && (!outputPath || typeof outputPath !== "string")) {
    throw new Error("Benchmark output path is invalid");
  }
  return { profileName, outputPath: outputPath || `benchmark-results/${profileName}.json` };
}

async function atomicJson(destination, value) {
  const resolved = path.resolve(destination);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, resolved);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function runBenchmarkCli({ argv = process.argv.slice(2), execute = executeBenchmark } = {}) {
  const options = parseArguments(argv);
  const result = await execute({ profileName: options.profileName });
  await atomicJson(options.outputPath, result);
  return result;
}

if (require.main === module) {
  runBenchmarkCli().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.evaluation.passed) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { atomicJson, parseArguments, runBenchmarkCli };
