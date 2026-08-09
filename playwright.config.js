"use strict";

const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  reporter: "line",
});
