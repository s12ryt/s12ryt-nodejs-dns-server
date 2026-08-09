"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const esbuild = require("esbuild");

const REPOSITORY = "s12ryt/s12ryt-nodejs-dns-server";
const WEB_FILES = ["index.html", "app.js", "styles.css"];

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function readWebAssets(projectDirectory) {
  return Object.fromEntries(await Promise.all(WEB_FILES.map(async (fileName) => [
    fileName,
    await fs.readFile(path.join(projectDirectory, "src", "web", fileName), "utf8"),
  ])));
}

async function buildRelease({
  projectDirectory = path.resolve(__dirname, ".."),
  outputDirectory = path.join(projectDirectory, "dist"),
} = {}) {
  const packageJson = JSON.parse(await fs.readFile(path.join(projectDirectory, "package.json"), "utf8"));
  const webAssets = await readWebAssets(projectDirectory);
  await fs.rm(outputDirectory, { recursive: true, force: true });
  await fs.mkdir(outputDirectory, { recursive: true });

  const runtimePath = path.join(outputDirectory, "runtime.cjs");
  await esbuild.build({
    entryPoints: [path.join(projectDirectory, "src", "main.js")],
    outfile: runtimePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    define: {
      "globalThis.__S12_WEB_ASSETS__": JSON.stringify(webAssets),
    },
  });

  await fs.copyFile(path.join(projectDirectory, "index.js"), path.join(outputDirectory, "index.js"));
  const runtime = await fs.readFile(runtimePath);
  const runtimeSha256 = sha256(runtime);
  const manifest = {
    version: packageJson.version,
    runtime: {
      url: `https://github.com/${REPOSITORY}/releases/download/v${packageJson.version}/runtime.cjs`,
      sha256: runtimeSha256,
    },
  };
  await fs.writeFile(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { outputDirectory, runtimePath, runtimeSha256, manifest };
}

if (require.main === module) {
  buildRelease().then((result) => {
    console.log(`Built runtime ${result.manifest.version} (${result.runtimeSha256})`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { buildRelease, readWebAssets };
