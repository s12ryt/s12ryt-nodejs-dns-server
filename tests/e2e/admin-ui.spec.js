"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { test, expect } = require("@playwright/test");
const { ConfigStore } = require("../../src/admin/config-store");
const { createRuntime } = require("../../src/runtime");

const password = "correct horse battery";
let baseUrl;
let directory;
let runtime;
let setupToken;

test.beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-ui-"));
  const config = new ConfigStore({ directory });
  const current = await config.load();
  for (const name of ["dns", "doh", "proxy", "admin"]) {
    current[name] = { ...current[name], host: "127.0.0.1", port: 0 };
  }
  await config.update(current);
  let tunnelState = "stopped";
  let tunnelStarts = 0;
  const tunnel = {
    status: () => ({ available: true, state: tunnelState, version: "test", lastError: null, logs: [] }),
    start: async () => {
      tunnelStarts += 1;
      if (tunnelStarts === 1) {
        tunnelState = "error";
        throw new Error("simulated automatic startup failure");
      }
      tunnelState = "running";
    },
    stop: async () => { tunnelState = "stopped"; },
  };
  runtime = createRuntime({
    directory,
    tunnel,
    output: (line) => { setupToken = line.split(": ").at(-1); },
  });
  await runtime.start();
  baseUrl = `http://127.0.0.1:${runtime.status().services.admin.port}`;
});

test.afterAll(async () => {
  await runtime?.close();
  await fs.rm(directory, { recursive: true, force: true });
});

test.describe.serial("管理介面", () => {
  test("首次設密後可管理 DNS、代理、Tunnel 與主題", async ({ page }) => {
    await page.goto(baseUrl);
    await expect(page.getByRole("heading", { name: "設定管理員" })).toBeVisible();
    await page.getByLabel("Setup token").fill(setupToken);
    await page.getByLabel("新密碼").fill(password);
    await page.getByRole("button", { name: "建立管理員" }).click();
    await expect(page.getByRole("heading", { name: "系統總覽" })).toBeVisible();

    await page.getByRole("button", { name: "DNS 記錄" }).click();
    await page.getByRole("button", { name: "新增記錄" }).click();
    await page.getByLabel("記錄名稱").fill("home.test");
    await page.getByLabel("記錄值").fill("192.0.2.88");
    await page.getByRole("button", { name: "儲存記錄" }).click();
    await expect(page.getByText("home.test", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "代理路由" }).click();
    await page.getByRole("button", { name: "新增路由" }).click();
    await page.getByLabel("公開主機名").fill("app.test");
    await page.getByLabel("目標 URL").fill("http://192.0.2.88:9000");
    await page.getByRole("button", { name: "儲存路由" }).click();
    await expect(page.getByText("app.test", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Cloudflare Tunnel" }).click();
    await page.getByRole("button", { name: "啟動 Tunnel" }).click();
    await expect(page.getByText("運行中", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "切換主題" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", /light|dark/);
    await page.screenshot({ path: "test-results/admin-desktop.png", fullPage: true });
  });

  test("已設定管理員可在手機登入且頁面不水平溢位", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(baseUrl);
    await page.getByLabel("密碼").fill(password);
    await page.getByRole("button", { name: "登入" }).click();
    await expect(page.getByRole("heading", { name: "系統總覽" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: "test-results/admin-mobile.png", fullPage: true });
  });
});
