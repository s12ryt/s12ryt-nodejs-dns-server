"use strict";

const { DEFAULT_CONFIG } = require("../admin/config-store");

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`Benchmark ${name} count is invalid`);
  }
  return value;
}

function recordId(index) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function recordAddress(index) {
  return `10.${Math.floor(index / 65536) % 256}.${Math.floor(index / 256) % 256}.${index % 256}`;
}

function createBenchmarkConfig({ records, proxySites, upstreamUrl = "http://127.0.0.1:19090" } = {}) {
  positiveInteger(records, "record", 1000000);
  positiveInteger(proxySites, "proxy site", 100000);
  let target;
  try { target = new URL(upstreamUrl); } catch { throw new TypeError("Benchmark upstream URL is invalid"); }
  if (!["http:", "https:"].includes(target.protocol)) throw new TypeError("Benchmark upstream URL is invalid");
  const config = structuredClone(DEFAULT_CONFIG);
  config.domains = [{ name: "benchmark.test", enabled: true, defaultTtl: 300, note: "Generated benchmark zone" }];
  config.records = Array.from({ length: records }, (_, index) => ({
    id: recordId(index),
    name: `r${index}.benchmark.test`,
    type: "A",
    value: recordAddress(index),
    ttl: 300,
    enabled: true,
  }));
  config.routes = Array.from({ length: proxySites }, (_, index) => ({
    host: `site-${index}.benchmark.test`,
    aliases: [],
    enabled: true,
    locations: [{
      path: "/",
      match: "prefix",
      action: "proxy",
      upstreams: [{ id: "upstream-0", target: target.href, enabled: true, weight: 1 }],
    }],
  }));
  return config;
}

module.exports = { createBenchmarkConfig, recordAddress, recordId };
