"use strict";

const { createRuntime } = require("./runtime");

async function start(options) {
  const runtime = createRuntime(options);
  await runtime.start();
  const addresses = runtime.status().services;
  console.log(`S12 DNS Server admin UI: http://${addresses.admin.host}:${addresses.admin.port}`);
  return runtime;
}

module.exports = { start };
