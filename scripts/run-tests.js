"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const scope = process.argv[2] || "all";
const roots = scope === "all"
  ? [path.join("tests", "unit"), path.join("tests", "integration")]
  : [path.join("tests", scope)];

function collect(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return collect(filePath);
      return entry.isFile() && entry.name.endsWith(".test.js") ? [filePath] : [];
    });
}

const files = roots.flatMap(collect).sort();
if (files.length === 0) {
  console.error(`No ${scope} test files found.`);
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
}
