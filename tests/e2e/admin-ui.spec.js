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
  current.tunnel = { token: "initial-ui-token" };
  await config.update(current);
  let tunnelState = "stopped";
  let tunnelStarts = 0;
  let effectiveToken = "";
  let tokenSource = "none";
  let hasStoredToken = false;
  const tunnel = {
    status: () => ({
      available: Boolean(effectiveToken), tokenSource, hasStoredToken,
      state: tunnelState, version: "test", lastError: null, logs: [],
    }),
    configure(next) {
      effectiveToken = next.token;
      tokenSource = next.tokenSource;
      hasStoredToken = next.hasStoredToken;
    },
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
    await expect(page.getByRole("heading", { name: "核心服務皆已就緒" })).toBeVisible();
    await expect(page.getByTestId("service-readiness")).toHaveText("4 / 4");
    await expect(page.getByRole("button", { name: "系統總覽" })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#recent-events").getByText("管理員設定完成", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "DNS 記錄" }).click();
    await expect(page.getByRole("button", { name: "DNS 記錄" })).toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "新增記錄" }).click();
    await page.getByLabel("記錄名稱").fill("home.test");
    await page.getByLabel("記錄值").fill("192.0.2.88");
    await page.route("**/api/config", async (route) => {
      if (route.request().method() === "PUT") await new Promise((resolve) => setTimeout(resolve, 250));
      await route.continue();
    });
    const saveRecord = page.locator("#record-form button[value='default']");
    await saveRecord.click();
    await expect(saveRecord).toBeDisabled();
    await expect(saveRecord).toHaveText("儲存中…");
    await expect(page.getByText("home.test", { exact: true })).toBeVisible();
    await page.unroute("**/api/config");

    await page.getByRole("button", { name: "代理路由" }).click();
    await page.getByRole("button", { name: "新增路由" }).click();
    await page.getByLabel("公開主機名").fill("app.test");
    await page.getByLabel("目標 URL").fill("http://192.0.2.88:9000");
    await page.getByRole("button", { name: "儲存路由" }).click();
    await expect(page.getByText("app.test", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Cloudflare Tunnel" }).click();
    await expect(page.getByText("Token 來源：設定檔", { exact: true })).toBeVisible();
    await page.getByLabel("Cloudflare Tunnel token").fill("ui-config-token");
    await page.getByRole("button", { name: "儲存 Token", exact: true }).click();
    await expect(page.getByLabel("Cloudflare Tunnel token")).toHaveValue("");
    await page.getByRole("button", { name: "啟動 Tunnel" }).click();
    await expect(page.getByText("運行中", { exact: true })).toBeVisible();

    await page.getByLabel("Cloudflare Tunnel token").fill("ui-replacement-token");
    await page.getByRole("button", { name: "儲存 Token", exact: true }).click();
    await expect(page.getByText("運行中", { exact: true })).toBeVisible();
    expect(runtime.config.get().tunnel.token).toBe("ui-replacement-token");

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "清除已儲存 Token" }).click();
    await expect(page.getByText("尚未設定 Token", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "啟動 Tunnel" })).toBeDisabled();
    expect(runtime.config.get().tunnel.token).toBe("");

    const themeToggle = page.getByRole("button", { name: "切換主題" });
    if (await page.locator("html").getAttribute("data-theme") !== "light") await themeToggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.screenshot({ path: "test-results/admin-desktop-light.png", fullPage: true });
    await themeToggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: "test-results/admin-desktop-dark.png", fullPage: true });
  });

  test("已設定管理員可在手機登入且頁面不水平溢位", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(baseUrl);
    await page.getByLabel("密碼").fill(password);
    await page.getByRole("button", { name: "登入" }).click();
    await expect(page.getByRole("heading", { name: "系統總覽" })).toBeVisible();
    await expect(page.getByRole("button", { name: "切換主題" })).toBeVisible();
    await expect(page.getByRole("button", { name: "登出" })).toBeVisible();
    await expect(page.getByRole("button", { name: "系統總覽" })).toHaveAttribute("aria-current", "page");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const navigationOverflow = await page.locator(".sidebar nav").evaluate((navigation) => navigation.scrollWidth - navigation.clientWidth);
    expect(navigationOverflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: "test-results/admin-mobile.png", fullPage: true });
  });

  test("各驗收寬度皆可完整操作且不水平溢位", async ({ page }) => {
    await page.goto(baseUrl);
    await page.getByLabel("密碼").fill(password);
    await page.getByRole("button", { name: "登入" }).click();
    await expect(page.getByRole("heading", { name: "系統總覽" })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "系統總覽" })).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "跳至主要內容" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();

    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: width < 900 ? 812 : 900 });
      const measurements = await page.evaluate(() => ({
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        navigationOverflow: document.querySelector(".sidebar nav").scrollWidth - document.querySelector(".sidebar nav").clientWidth,
      }));
      expect(measurements.documentOverflow, `${width}px 文件不應水平溢位`).toBeLessThanOrEqual(0);
      expect(measurements.navigationOverflow, `${width}px 導覽不應需要水平捲動`).toBeLessThanOrEqual(0);
    }
  });
});
