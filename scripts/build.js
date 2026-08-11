"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const esbuild = require("esbuild");
const { nativeBindingKey } = require("../index");
const { NATIVE_TARGETS } = require("./native-bindings");

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

async function collectNativeBindings({ nativeBindingsDirectory, requireProductionBindings }) {
  if (!nativeBindingsDirectory) {
    if (requireProductionBindings) throw new Error("Production native bindings directory is required");
    const bindingKey = nativeBindingKey();
    const packageDirectory = path.dirname(path.dirname(require.resolve("better-sqlite3")));
    const source = path.join(packageDirectory, "build", "Release", "better_sqlite3.node");
    return [{ key: bindingKey, source }];
  }
  const bindings = [];
  for (const target of NATIVE_TARGETS) {
    const source = path.join(nativeBindingsDirectory, `better-sqlite3-${target.key}.node`);
    try {
      const stat = await fs.stat(source);
      if (!stat.isFile() || stat.size === 0) throw new Error("empty");
      bindings.push({ key: target.key, source });
    } catch {
      if (requireProductionBindings) throw new Error(`Production native binding is missing: ${target.key}`);
    }
  }
  if (bindings.length === 0) throw new Error("No native bindings were found");
  return bindings;
}

async function buildRelease({
  projectDirectory = path.resolve(__dirname, ".."),
  outputDirectory = path.join(projectDirectory, "dist"),
  nativeBindingsDirectory = process.env.S12_NATIVE_BINDINGS_DIRECTORY || null,
  requireProductionBindings = Boolean(process.env.S12_NATIVE_BINDINGS_DIRECTORY),
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
  const bindings = await collectNativeBindings({ nativeBindingsDirectory, requireProductionBindings });
  const nativePaths = [];
  const nativeBindings = {};
  for (const binding of bindings) {
    const nativeFile = `better-sqlite3-${binding.key}.node`;
    const nativePath = path.join(outputDirectory, nativeFile);
    await fs.copyFile(binding.source, nativePath);
    const nativeBinding = await fs.readFile(nativePath);
    nativePaths.push(nativePath);
    nativeBindings[binding.key] = {
      url: `https://github.com/${REPOSITORY}/releases/download/v${packageJson.version}/${nativeFile}`,
      sha256: sha256(nativeBinding),
    };
  }
  const runtime = await fs.readFile(runtimePath);
  const runtimeSha256 = sha256(runtime);
  const manifest = {
    version: packageJson.version,
    runtime: {
      url: `https://github.com/${REPOSITORY}/releases/download/v${packageJson.version}/runtime.cjs`,
      sha256: runtimeSha256,
    },
    nativeBindings,
  };
  await fs.writeFile(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { outputDirectory, runtimePath, runtimeSha256, nativePath: nativePaths[0], nativePaths, manifest };
}

if (require.main === module) {
  buildRelease().then((result) => {
    console.log(`Built runtime ${result.manifest.version} (${result.runtimeSha256})`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { buildRelease, collectNativeBindings, readWebAssets };
