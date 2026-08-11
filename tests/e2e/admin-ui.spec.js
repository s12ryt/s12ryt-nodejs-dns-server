"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { test, expect } = require("@playwright/test");
const { ConfigStore } = require("../../src/admin/config-store");
const { createQuery, parseMessage } = require("../../src/dns/message");
const { createRuntime } = require("../../src/runtime");

const password = "correct horse battery";
let baseUrl;
let directory;
let runtime;
let setupToken;
let browserOrigin;
let browserOriginServer;

test.beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "s12-ui-"));
  const config = new ConfigStore({ directory });
  const current = await config.load();
  for (const name of ["dns", "doh", "proxy", "admin"]) {
    current[name] = { ...current[name], host: "127.0.0.1", port: 0 };
  }
  current.observability.metrics = { ...current.observability.metrics, host: "127.0.0.1", port: 0 };
  current.domains = [
    { name: "example.test", enabled: true, defaultTtl: 300, note: "父網域" },
    { name: "child.example.test", enabled: true, defaultTtl: 300, note: "子網域" },
    { name: "16516565.tw", enabled: true, defaultTtl: 300, note: "DoH CORS 驗收" },
  ];
  current.records = [
    { name: "root.example.test", type: "A", value: "192.0.2.10", ttl: 300, enabled: true },
    { name: "api.child.example.test", type: "A", value: "192.0.2.20", ttl: 300, enabled: true },
    { name: "outside.test", type: "A", value: "192.0.2.30", ttl: 300, enabled: true },
    { name: "awa.16516565.tw", type: "CNAME", value: "chatgpt.com", ttl: 300, enabled: true },
  ];
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
  const now = new Date().toISOString();
  runtime.components.storage.recordMetricSamples([{
    recordedAt: now,
    metric: "dns_queries_total",
    labels: { source: "custom", type: "A" },
    value: 7,
  }]);
  runtime.components.storage.enqueueWebhook({
    id: "ui-dead-letter",
    eventType: "upstream-error",
    payload: { upstream: "Cloudflare" },
    state: "dead-letter",
    attempts: 3,
    nextAttemptAt: now,
    createdAt: now,
    lastError: "simulated delivery failure",
  });
  baseUrl = `http://127.0.0.1:${runtime.status().services.admin.port}`;
  browserOriginServer = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>DoH cross-origin test</title>");
  });
  await new Promise((resolve) => browserOriginServer.listen(0, "127.0.0.1", resolve));
  browserOrigin = `http://127.0.0.1:${browserOriginServer.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => browserOriginServer?.close(resolve));
  await runtime?.close();
  await fs.rm(directory, { recursive: true, force: true });
});

test.describe.serial("管理介面", () => {
  async function login(page) {
    await page.goto(baseUrl);
    await page.getByLabel("密碼").fill(password);
    await page.getByRole("button", { name: "登入" }).click();
    await expect(page.getByRole("heading", { name: "系統總覽" })).toBeVisible();
  }

  test("首次設密後顯示完整健康摘要", async ({ page }) => {
    await page.goto(baseUrl);
    await expect(page.getByRole("heading", { name: "設定管理員" })).toBeVisible();
    await page.getByLabel("Setup token").fill(setupToken);
    await page.getByLabel("新密碼").fill(password);
    await page.getByRole("button", { name: "建立管理員" }).click();
    await expect(page.getByRole("heading", { name: "系統總覽" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "核心服務皆已就緒" })).toBeVisible();
    await expect(page.getByTestId("service-readiness")).toHaveText("5 / 5");
    await expect(page.getByRole("button", { name: "系統總覽" })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#recent-events").getByText("管理員設定完成", { exact: true })).toBeVisible();

    await expect(page.getByText("Cloudflare", { exact: true })).toBeVisible();
    await expect(page.getByText("Google", { exact: true })).toBeVisible();
  });

  test("瀏覽器可從其他來源讀取 DoH CNAME 回應", async ({ page }) => {
    const query = createQuery("awa.16516565.tw", "CNAME", { id: 915 });
    const dohUrl = `http://127.0.0.1:${runtime.status().services.doh.port}/dns-query`;
    await page.goto(browserOrigin);

    const result = await page.evaluate(async ({ url, wire }) => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/dns-message",
          "Content-Type": "application/dns-message",
        },
        body: new Uint8Array(wire),
      });
      return {
        status: response.status,
        responseType: response.type,
        body: Array.from(new Uint8Array(await response.arrayBuffer())),
      };
    }, { url: dohUrl, wire: Array.from(query) });

    expect(result.status).toBe(200);
    expect(result.responseType).toBe("cors");
    const message = parseMessage(Buffer.from(result.body));
    expect(message.flags.rcode).toBe(0);
    expect(message.answers[0].value).toBe("chatgpt.com");
  });

  test("可觀測性頁顯示歷史指標並管理 Webhook 重送", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "事件日誌" }).click();
    await expect(page.getByRole("heading", { name: "可觀測性" })).toBeVisible();
    await expect(page.getByRole("button", { name: "24 小時" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("metric-history")).toContainText("dns_queries_total");
    await expect(page.getByTestId("metric-history")).toContainText("7");
    await page.getByRole("button", { name: "7 天" }).click();
    await expect(page.getByRole("button", { name: "7 天" })).toHaveAttribute("aria-pressed", "true");

    await page.getByLabel("Webhook URL").fill("https://alerts.example.test/s12");
    await page.getByLabel("Webhook secret").fill("ui-owner-secret");
    await page.getByLabel("啟用 Webhook").check();
    await page.getByRole("button", { name: "儲存 Webhook" }).click();
    await expect(page.getByLabel("Webhook secret")).toHaveValue("");
    await expect(page.getByTestId("webhook-secret-state")).toHaveText("已安全儲存");
    await expect(page.locator("body")).not.toContainText("ui-owner-secret");

    const deadJob = page.getByTestId("webhook-job-ui-dead-letter");
    await expect(deadJob).toContainText("dead-letter");
    await deadJob.getByRole("button", { name: "重新傳送" }).click();
    await expect(deadJob).toContainText("pending");
  });

  test("可觀測性頁可預覽、建立、匯入、驗證及刪除敏感備份", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "事件日誌" }).click();
    await expect(page.getByRole("heading", { name: "備份與還原" })).toBeVisible();
    await expect(page.getByTestId("backup-sensitive-warning")).toContainText("明文");
    await expect(page.getByTestId("backup-sensitive-warning")).toContainText("密碼");
    await expect(page.getByTestId("backup-sensitive-warning")).toContainText("Token");

    const previewResponsePromise = page.waitForResponse((response) => response.url().endsWith("/api/backups") && response.request().method() === "POST");
    await page.getByRole("button", { name: "預覽備份內容" }).click();
    const previewResponse = await previewResponsePromise;
    expect(previewResponse.status()).toBe(200);
    await expect(page.getByTestId("backup-preview")).toContainText("config.json");
    await expect(page.getByTestId("backup-preview")).toContainText("admin.json");
    await expect(page.getByTestId("backup-preview")).toContainText("operations.sqlite");
    await expect(page.getByTestId("backup-preview")).not.toContainText("proxy-cache");

    await page.getByRole("button", { name: "建立備份" }).click();
    const manualBackup = page.locator("[data-backup-file^='s12-manual-']").first();
    await expect(manualBackup).toBeVisible();
    const manualFileName = await manualBackup.getAttribute("data-backup-file");
    expect(manualFileName).toMatch(/^s12-manual-\d{8}T\d{6}Z\.zip$/);

    const downloadPromise = page.waitForEvent("download");
    await manualBackup.getByRole("button", { name: "下載" }).click();
    const download = await downloadPromise;
    const externalArchive = path.join(directory, "external-upload.zip");
    await download.saveAs(externalArchive);

    await page.getByLabel("匯入外部 ZIP 備份").setInputFiles(externalArchive);
    await page.getByRole("button", { name: "匯入備份" }).click();
    const uploadedBackup = page.locator("[data-backup-file^='s12-upload-']").first();
    await expect(uploadedBackup).toBeVisible();
    const uploadedFileName = await uploadedBackup.getAttribute("data-backup-file");
    expect(uploadedFileName).toMatch(/^s12-upload-\d{8}T\d{6}Z\.zip$/);

    await uploadedBackup.getByRole("button", { name: "還原" }).click();
    const restoreModal = page.getByRole("dialog", { name: "還原備份" });
    await expect(restoreModal).toContainText(uploadedFileName);
    await restoreModal.getByRole("button", { name: "驗證備份" }).click();
    await expect(restoreModal).toContainText("備份驗證通過");
    await restoreModal.getByRole("button", { name: "取消" }).click();

    await uploadedBackup.getByRole("button", { name: "刪除" }).click();
    const deleteModal = page.getByRole("dialog", { name: "刪除備份" });
    await expect(deleteModal).toContainText(uploadedFileName);
    await deleteModal.getByRole("button", { name: "確認刪除" }).click();
    await expect(page.locator(`[data-backup-file='${uploadedFileName}']`)).toHaveCount(0);
  });

  test("DNS 與網域工作區提供完整 CRUD、自建 modal 與診斷", async ({ page }) => {
    await login(page);
    await expect(page.locator("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "DNS 與網域" }).click();
    await expect(page.getByRole("button", { name: "DNS 與網域" })).toHaveAttribute("aria-current", "page");

    await expect(page.getByRole("heading", { name: "請選擇網域" })).toBeVisible();
    await expect(page.getByRole("button", { name: "新增記錄" })).toBeDisabled();
    await expect(page.getByText("全部記錄", { exact: true })).toHaveCount(0);
    await expect(page.locator("#records-list")).toBeHidden();

    await page.getByRole("button", { name: "選擇網域 example.test" }).click();
    await expect(page.getByRole("button", { name: "選擇網域 example.test" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: "example.test DNS 記錄" })).toBeVisible();
    await expect(page.locator("#records-list").getByText("root.example.test", { exact: true })).toBeVisible();
    await expect(page.locator("#records-list").getByText("api.child.example.test", { exact: true })).toHaveCount(0);
    await expect(page.locator("#records-list").getByText("outside.test", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("診斷名稱")).toHaveValue("example.test");

    await page.getByRole("button", { name: "新增記錄" }).click();
    await expect(page.getByRole("dialog", { name: "新增 DNS 記錄" })).toBeVisible();
    await page.getByLabel("記錄名稱").fill("home");
    await page.getByLabel("記錄值").fill("192.0.2.88");
    await page.route("**/api/config", async (route) => {
      if (route.request().method() === "PUT") await new Promise((resolve) => setTimeout(resolve, 250));
      await route.continue();
    });
    const saveRecord = page.locator("#record-form button[value='default']");
    await saveRecord.click();
    await expect(saveRecord).toBeDisabled();
    await expect(saveRecord).toHaveText("儲存中…");
    await expect(page.getByText("home.example.test", { exact: true })).toBeVisible();
    await page.unroute("**/api/config");

    await page.getByLabel("診斷名稱").fill("home.example.test");
    await page.getByLabel("診斷類型").selectOption("A");
    await page.getByRole("button", { name: "執行 DNS 診斷" }).click();
    await expect(page.getByTestId("diagnostic-rcode")).toHaveText("NOERROR");
    await expect(page.getByTestId("diagnostic-answers")).toContainText("192.0.2.88");

    await page.getByRole("button", { name: "編輯 DNS 記錄 home.example.test" }).click();
    await expect(page.getByRole("dialog", { name: "編輯 DNS 記錄" })).toBeVisible();
    await page.getByLabel("記錄名稱").fill("edited");
    await page.getByLabel("TTL").fill("900");
    await page.getByLabel("啟用記錄").uncheck();
    await page.getByRole("button", { name: "儲存記錄" }).click();
    await expect(page.getByText("edited.example.test", { exact: true })).toBeVisible();
    await expect(page.getByText("已停用", { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "DNS 與網域" }).click();
    await expect(page.getByRole("heading", { name: "請選擇網域" })).toBeVisible();
    await page.getByRole("button", { name: "選擇網域 example.test" }).click();
    await expect(page.getByText("edited.example.test", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "刪除 DNS 記錄 edited.example.test" }).click();
    const recordConfirm = page.getByRole("dialog", { name: "刪除 DNS 記錄" });
    await expect(recordConfirm).toContainText("edited.example.test");
    await expect(recordConfirm).toContainText("192.0.2.88");
    await recordConfirm.getByRole("button", { name: "確認刪除" }).click();
    await expect(page.getByText("edited.example.test", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "選擇網域 child.example.test" }).click();
    await expect(page.locator("#records-list").getByText("api.child.example.test", { exact: true })).toBeVisible();
    await expect(page.locator("#records-list").getByText("root.example.test", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("診斷名稱")).toHaveValue("child.example.test");

    await page.getByRole("button", { name: "選擇未分組記錄" }).click();
    await expect(page.getByRole("heading", { name: "未分組 DNS 記錄" })).toBeVisible();
    await expect(page.locator("#records-list").getByText("outside.test", { exact: true })).toBeVisible();
    await expect(page.getByLabel("診斷名稱")).toHaveValue("");

    await page.getByRole("button", { name: "新增網域" }).click();
    await expect(page.getByRole("dialog", { name: "新增網域工作區" })).toBeVisible();
    await page.getByLabel("網域名稱").fill("site.example");
    await page.getByLabel("建立模式").selectOption("website");
    await page.getByLabel("IPv4 位址").fill("192.0.2.70");
    await page.getByLabel("建立 www CNAME").check();
    await page.getByLabel("內部 upstream URL").fill("http://127.0.0.1:3000");
    await page.getByRole("button", { name: "預覽變更" }).click();
    await expect(page.getByTestId("domain-preview")).toContainText("www.site.example");
    await page.getByRole("button", { name: "建立網域" }).click();
    await expect(page.getByRole("button", { name: "編輯網域 site.example" })).toBeVisible();
    await page.getByRole("button", { name: "選擇網域 site.example" }).click();
    await expect(page.locator("#records-list").getByText("www.site.example", { exact: true })).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: "test-results/admin-dns-domains.png", fullPage: true });

    await page.getByRole("button", { name: "編輯網域 site.example" }).click();
    await page.getByLabel("網域名稱").fill("renamed.example");
    await page.getByLabel("啟用網域").uncheck();
    await page.getByRole("button", { name: "儲存網域" }).click();
    await expect(page.getByRole("button", { name: "編輯網域 renamed.example" })).toBeVisible();
    await expect(page.getByRole("button", { name: "選擇網域 renamed.example" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: "renamed.example DNS 記錄" })).toBeVisible();
    await page.getByRole("button", { name: "刪除網域 renamed.example" }).click();
    const domainConfirm = page.getByRole("dialog", { name: "刪除網域工作區" });
    await expect(domainConfirm).toContainText("DNS 記錄 2 筆");
    await expect(domainConfirm).toContainText("代理站台 1 個");
    await domainConfirm.getByRole("button", { name: "刪除整個網域" }).click();
    await expect(page.getByRole("button", { name: "選擇網域 renamed.example" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "請選擇網域" })).toBeVisible();
    await expect(page.getByRole("button", { name: "新增記錄" })).toBeDisabled();
  });

  test("代理站台可透過五步精靈建立、編輯、複製、停用及刪除", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "代理站台" }).click();
    await page.getByRole("button", { name: "新增代理站台" }).click();
    const wizard = page.getByRole("dialog", { name: "新增代理站台" });
    await expect(wizard.getByText("步驟 1 / 5", { exact: true })).toBeVisible();
    await page.getByLabel("主要 Host").fill("app.test");
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(wizard.getByText("步驟 2 / 5", { exact: true })).toBeVisible();
    await page.getByLabel("路徑", { exact: true }).fill("/");
    await page.getByRole("button", { name: "下一步" }).click();
    await page.getByLabel("上游 URL（每行一個）").fill("http://192.0.2.88:9000\nhttp://192.0.2.89:9000");
    await page.getByRole("button", { name: "下一步" }).click();
    await page.getByLabel("Body 限制（MiB）").fill("12");
    await page.getByLabel("啟用代理快取").check();
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(wizard.getByText("步驟 5 / 5", { exact: true })).toBeVisible();
    await expect(wizard.getByTestId("proxy-review")).toContainText("app.test");
    await page.screenshot({ path: "test-results/admin-proxy-wizard.png", fullPage: true });
    await page.getByRole("button", { name: "建立站台" }).click();
    await expect(page.getByText("app.test", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "編輯代理站台 app.test" }).click();
    await page.getByLabel("主要 Host").fill("edited.app.test");
    await page.getByLabel("啟用站台").uncheck();
    await page.getByRole("button", { name: "下一步" }).click();
    await page.getByRole("button", { name: "下一步" }).click();
    await page.getByRole("button", { name: "下一步" }).click();
    await page.getByRole("button", { name: "下一步" }).click();
    await page.getByRole("button", { name: "儲存站台" }).click();
    await expect(page.getByText("edited.app.test", { exact: true })).toBeVisible();
    await expect(page.getByText("已停用", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "複製代理站台 edited.app.test" }).click();
    await page.getByLabel("主要 Host").fill("copy.app.test");
    await page.getByLabel("啟用站台").check();
    for (let step = 0; step < 4; step += 1) await page.getByRole("button", { name: "下一步" }).click();
    await page.getByRole("button", { name: "建立副本" }).click();
    await expect(page.getByText("copy.app.test", { exact: true })).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: "test-results/admin-proxy-sites.png", fullPage: true });
    await page.reload();
    await page.getByRole("button", { name: "代理站台" }).click();
    await expect(page.getByText("copy.app.test", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "清除所有代理快取" }).click();
    await page.getByRole("dialog", { name: "清除代理快取" }).getByRole("button", { name: "確認清除" }).click();
    await expect(page.getByText("代理快取已清除", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "刪除代理站台 edited.app.test" }).click();
    await page.getByRole("dialog", { name: "刪除代理站台" }).getByRole("button", { name: "確認刪除" }).click();
    await expect(page.getByText("edited.app.test", { exact: true })).toHaveCount(0);
  });

  test("Tunnel 確認與主題切換不使用瀏覽器原生對話框", async ({ page }) => {
    await login(page);
    await page.evaluate(() => {
      window.confirm = () => { throw new Error("native confirm must not be called"); };
      window.alert = () => { throw new Error("native alert must not be called"); };
      window.prompt = () => { throw new Error("native prompt must not be called"); };
    });

    await page.getByRole("button", { name: "Cloudflare Tunnel" }).click();
    await expect(page.getByText("Token 來源：設定檔", { exact: true })).toBeVisible();
    await page.getByLabel("Cloudflare Tunnel token").fill("ui-config-token");
    await page.getByRole("button", { name: "儲存 Token", exact: true }).click();
    await expect(page.getByLabel("Cloudflare Tunnel token")).toHaveValue("");
    await page.getByRole("button", { name: "啟動 Tunnel" }).click();
    await expect(page.getByText("運行中", { exact: true })).toBeVisible();

    await page.getByLabel("Cloudflare Tunnel token").fill("ui-replacement-token");
    await page.getByRole("button", { name: "儲存 Token", exact: true }).click();
    await expect(page.getByLabel("Cloudflare Tunnel token")).toHaveValue("");
    await expect(page.getByText("運行中", { exact: true })).toBeVisible();
    expect(runtime.config.get().tunnel.token).toBe("ui-replacement-token");

    await page.getByRole("button", { name: "清除已儲存 Token" }).click();
    await page.getByRole("dialog", { name: "清除 Tunnel Token" }).getByRole("button", { name: "確認清除" }).click();
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
    await login(page);
    await expect(page.getByRole("button", { name: "切換主題" })).toBeVisible();
    await expect(page.getByRole("button", { name: "登出" })).toBeVisible();
    await expect(page.getByRole("button", { name: "系統總覽" })).toHaveAttribute("aria-current", "page");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const navigationOverflow = await page.locator(".sidebar nav").evaluate((navigation) => navigation.scrollWidth - navigation.clientWidth);
    expect(navigationOverflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: "test-results/admin-mobile.png", fullPage: true });
    await page.getByRole("button", { name: "DNS 與網域" }).click();
    await page.getByRole("button", { name: "選擇網域 example.test" }).click();
    await expect(page.locator("#records-list").getByText("root.example.test", { exact: true })).toBeVisible();
    await page.waitForTimeout(250);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: "test-results/admin-mobile-dns.png" });
  });

  test("各驗收寬度皆可完整操作且不水平溢位", async ({ page }) => {
    await login(page);

    await page.reload();
    await expect(page.getByRole("heading", { name: "系統總覽" })).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "跳至主要內容" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();

    await page.getByRole("button", { name: "DNS 與網域" }).click();
    const addDomain = page.getByRole("button", { name: "新增網域" });
    await addDomain.click();
    const modal = page.getByRole("dialog", { name: "新增網域工作區" });
    await expect(modal.getByLabel("網域名稱")).toBeFocused();
    await modal.getByRole("button", { name: "關閉" }).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(modal.getByRole("button", { name: "建立網域" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
    await expect(addDomain).toBeFocused();

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => {
      window.__animationCalls = 0;
      const originalAnimate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        window.__animationCalls += 1;
        return originalAnimate.apply(this, args);
      };
    });
    await page.getByRole("button", { name: "代理站台" }).click();
    expect(await page.evaluate(() => window.__animationCalls)).toBe(0);

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
