"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = {
  csrf: null,
  config: null,
  status: null,
  tunnel: null,
  events: [],
  selectedDomain: null,
  metricWindow: "24h",
  metricHistory: [],
  webhookJobs: [],
  backups: [],
  backupPreview: null,
};
const titles = { overview: "系統總覽", records: "DNS 與網域", routes: "代理站台", tunnel: "Cloudflare Tunnel", events: "事件日誌" };
const serviceNames = { dns: "DNS", doh: "DoH", proxy: "Proxy", admin: "Admin" };
const eventKinds = { auth: "驗證", config: "設定", dns: "DNS", proxy: "代理", "proxy-cache": "代理快取", tunnel: "Tunnel", "tunnel-error": "Tunnel" };
const eventMessages = {
  "Administrator configured": "管理員設定完成",
  "Administrator signed in": "管理員已登入",
  "Configuration updated": "設定已更新",
  "Stored Tunnel token updated": "Tunnel Token 已更新",
  "Stored Tunnel token cleared": "Tunnel Token 已清除",
  "Tunnel started": "Tunnel 已啟動",
  "Tunnel stopped": "Tunnel 已停止",
  "Tunnel started automatically": "Tunnel 已自動啟動",
  "Proxy cache cleared": "代理快取已清除",
};
const recordHints = {
  A: ["192.0.2.10", "輸入 IPv4 位址，例如 192.0.2.10。"],
  AAAA: ["2001:db8::10", "輸入 IPv6 位址，例如 2001:db8::10。"],
  CNAME: ["target.example.com", "輸入完整的別名目標主機名稱。"],
  MX: ["10 mail.example.com", "依序輸入優先序與郵件主機名稱。"],
  TXT: ["verification=value", "輸入要發布的文字內容。"],
  NS: ["ns1.example.com", "輸入權威名稱伺服器的主機名稱。"],
  SRV: ["10 5 443 service.example.com", "依序輸入優先序、權重、埠號與目標。"],
};
const focusableSelector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
let modalReturnFocus = null;
let modalCloseCallback = null;
let siteWizard = null;

async function api(path, options = {}) {
  const headers = { accept: "application/json", ...options.headers };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (state.csrf && !["GET", "HEAD"].includes(options.method || "GET")) headers["x-csrf-token"] = state.csrf;
  const response = await fetch(path, { ...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(body?.error || `Request failed with HTTP ${response.status}`);
  return body;
}

async function rawApi(path, options = {}) {
  const headers = { accept: "application/json", ...options.headers };
  if (state.csrf && !["GET", "HEAD"].includes(options.method || "GET")) headers["x-csrf-token"] = state.csrf;
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) throw new Error(body?.error || `Request failed with HTTP ${response.status}`);
  return body;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
}

function prefersReducedMotion() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function animateIn(element, keyframes = [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }]) {
  if (!element || prefersReducedMotion() || typeof element.animate !== "function") return;
  element.animate(keyframes, { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
}

function animateRows(container) {
  if (prefersReducedMotion()) return;
  [...container.children].slice(0, 20).forEach((row, index) => row.animate(
    [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
    { duration: 160, delay: Math.min(index * 18, 120), easing: "ease-out", fill: "backwards" },
  ));
}

function setBusy(button, busy, busyLabel) {
  if (!button) return;
  const iconOnly = button.classList.contains("icon-button");
  if (!button.dataset.idleLabel) button.dataset.idleLabel = iconOnly ? button.getAttribute("aria-label") : button.textContent.trim();
  if (!button.dataset.idleTitle) button.dataset.idleTitle = button.title;
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
  if (iconOnly) {
    button.setAttribute("aria-label", busy ? busyLabel : button.dataset.idleLabel);
    button.title = busy ? busyLabel : button.dataset.idleTitle;
  } else button.textContent = busy ? busyLabel : button.dataset.idleLabel;
}

function showToast(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.setAttribute("role", error ? "alert" : "status");
  toast.hidden = false;
  animateIn(toast, [{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }]);
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3500);
}

function empty(message) {
  return `<div class="empty-state"><strong>目前沒有資料</strong><span>${escapeHtml(message)}</span></div>`;
}

function endpoint(address) {
  if (!address) return "未啟動";
  const host = address.host.includes(":") ? `[${address.host}]` : address.host;
  return `${host}:${address.port}`;
}

function serviceCard(name, address) {
  const online = Boolean(address);
  return `<article class="metric"><div class="metric-top"><span>${escapeHtml(name)}</span><span class="state-label ${online ? "success" : "muted-state"}"><span class="dot ${online ? "online" : ""}" aria-hidden="true"></span>${online ? "在線" : "離線"}</span></div><strong>${escapeHtml(endpoint(address))}</strong><small>${online ? "正在監聽" : "尚未啟動"}</small></article>`;
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "時間未知";
  return new Intl.DateTimeFormat("zh-Hant", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function eventRows(events) {
  if (!events.length) return empty("服務事件會顯示在這裡。");
  return [...events].reverse().map((event) => {
    const timestamp = event.timestamp || "";
    const fallback = event.name ? `${event.name}${event.type ? ` · ${event.type}` : ""}${event.source ? ` · ${event.source}` : ""}` : "服務事件";
    const message = eventMessages[event.message] || event.message || fallback;
    return `<article class="list-row"><span class="event-kind">${escapeHtml(eventKinds[event.kind] || event.kind)}</span><div><strong>${escapeHtml(message)}</strong><time datetime="${escapeHtml(timestamp)}">${escapeHtml(formatTimestamp(timestamp))}</time></div></article>`;
  }).join("");
}

function healthDetails(ready, total, upstreams) {
  const unhealthy = upstreams.filter((item) => item.healthy === false).length;
  const checked = upstreams.filter((item) => item.healthy !== null).length;
  const upstreamText = unhealthy > 0 ? `${unhealthy} 個上游需要注意` : checked === 0 ? "上游等待首次檢查" : "已檢查的上游運作正常";
  const tunnelText = state.tunnel?.state === "running" ? "Tunnel 已連線" : state.tunnel?.state === "error" ? "Tunnel 需要注意" : "Tunnel 未連線";
  return `${ready}/${total} 個核心端點在線，${upstreamText}，${tunnelText}。`;
}

function renderOverview() {
  const services = Object.entries(state.status.services || {});
  const ready = services.filter(([, address]) => Boolean(address)).length;
  const total = services.length;
  const healthy = total > 0 && ready === total;
  const upstreams = state.status.upstreams || [];
  $("#health-heading").textContent = healthy ? "核心服務皆已就緒" : "核心服務需要注意";
  $("#health-detail").textContent = healthDetails(ready, total, upstreams);
  $("#health-symbol").classList.toggle("attention", !healthy);
  $("#health-symbol .dot").className = `dot ${healthy ? "online" : "danger"}`;
  $("[data-testid='service-readiness']").textContent = `${ready} / ${total}`;
  $("#record-count").textContent = state.config.records.length;
  $("#route-count").textContent = state.config.routes.length;
  $("#cache-count").textContent = state.status.cache?.entries || 0;
  $("#connection-state").classList.toggle("danger", !healthy);
  $("#connection-state .dot").className = `dot ${healthy ? "online" : "danger"}`;
  $("#connection-state .connection-copy").textContent = healthy ? "服務已連線" : "服務需注意";
  $("#service-grid").innerHTML = services.map(([name, address]) => serviceCard(serviceNames[name] || name.toUpperCase(), address)).join("");
  $("#upstream-list").innerHTML = upstreams.length ? upstreams.map((item) => {
    const status = item.healthy === false ? "異常" : item.healthy === true ? "正常" : "待檢查";
    const details = item.latencyMs === null ? "等待首次檢查" : `${item.latencyMs} ms${item.lastError ? ` · ${item.lastError}` : ""}`;
    return `<article class="list-row"><span class="state-label ${item.healthy === false ? "danger" : item.healthy === true ? "success" : "muted-state"}"><span class="dot ${item.healthy === false ? "danger" : item.healthy === true ? "online" : ""}" aria-hidden="true"></span>${status}</span><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(details)}</small></div></article>`;
  }).join("") : empty("尚未設定上游解析器。");
  $("#recent-events").innerHTML = eventRows(state.events.slice(-5));
}

function belongsTo(name, domain) {
  const normalized = String(name || "").toLowerCase().replace(/\.$/, "");
  return normalized === domain || normalized.endsWith(`.${domain}`);
}

function domainFor(name) {
  return [...(state.config.domains || [])].filter((domain) => belongsTo(name, domain.name)).sort((left, right) => right.name.length - left.name.length)[0] || null;
}

function recordValue(record) {
  if (record.type === "MX") return `${record.priority ?? record.preference ?? 0} ${record.exchange || record.value || ""}`.trim();
  if (record.type === "SRV") return `${record.priority ?? 0} ${record.weight ?? 0} ${record.port ?? 0} ${record.target || record.value || ""}`.trim();
  return String(record.value ?? record.address ?? record.target ?? "");
}

function iconButton(icon, label, action, index) {
  return `<button class="icon-button row-action" type="button" data-action="${action}" data-index="${index}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><svg class="icon" aria-hidden="true"><use href="#icon-${icon}"/></svg></button>`;
}

function renderDomains() {
  const domains = state.config.domains || [];
  const unassignedCount = state.config.records.filter((record) => !domainFor(record.name)).length;
  const unassignedSelected = state.selectedDomain === "unassigned";
  const rows = [`<article class="domain-row ${unassignedSelected ? "selected" : ""}"><button class="domain-select" type="button" data-domain-scope="unassigned" aria-label="選擇未分組記錄" aria-pressed="${unassignedSelected}"><span class="grow"><strong>未分組記錄</strong><small>${unassignedCount} 筆 DNS · 不屬於任何網域工作區</small></span></button></article>`];
  rows.push(...domains.map((domain, index) => {
    const records = state.config.records.filter((record) => domainFor(record.name)?.name === domain.name).length;
    const routes = state.config.routes.filter((route) => domainFor(route.host)?.name === domain.name).length;
    const selected = state.selectedDomain === domain.name;
    return `<article class="domain-row ${selected ? "selected" : ""}"><button class="domain-select" type="button" data-domain-scope="${escapeHtml(domain.name)}" aria-label="選擇網域 ${escapeHtml(domain.name)}" aria-pressed="${selected}"><span class="grow"><strong>${escapeHtml(domain.name)}</strong><small>${records} 筆 DNS · ${routes} 個代理${domain.note ? ` · ${escapeHtml(domain.note)}` : ""}</small></span></button><span class="state-chip ${domain.enabled === false ? "inactive" : "active"}">${domain.enabled === false ? "已停用" : "已啟用"}</span><div class="row-actions">${iconButton("edit", `編輯網域 ${domain.name}`, "edit-domain", index)}${iconButton("delete", `刪除網域 ${domain.name}`, "delete-domain", index)}</div></article>`;
  }));
  $("#domains-list").innerHTML = rows.join("");
}

function renderRecords() {
  const records = state.config.records;
  const enabled = records.filter((record) => record.enabled !== false).length;
  $("#records-summary").textContent = `${records.length} 筆 · ${enabled} 啟用`;
  if (state.selectedDomain !== "unassigned" && !state.config.domains.some((domain) => domain.name === state.selectedDomain)) state.selectedDomain = null;
  renderDomains();
  const scope = state.selectedDomain;
  const selected = Boolean(scope);
  $("#add-record").disabled = !selected;
  $("#domain-selection-empty").hidden = selected;
  $("#domain-detail-content").hidden = !selected;
  if (!selected) return;
  const visible = records.map((record, index) => ({ record, index })).filter(({ record }) => {
    const workspace = domainFor(record.name);
    return scope === "unassigned" ? !workspace : workspace?.name === scope;
  });
  const domain = scope === "unassigned" ? null : state.config.domains.find((candidate) => candidate.name === scope);
  $("#selected-domain-title").textContent = scope === "unassigned" ? "未分組 DNS 記錄" : `${scope} DNS 記錄`;
  $("#selected-records-summary").textContent = `${visible.length} 筆`;
  $("#selected-domain-note").textContent = scope === "unassigned" ? "只顯示不屬於任何網域工作區的完整 FQDN 記錄。" : (domain?.note || `預設 TTL ${domain?.defaultTtl ?? 300} 秒`);
  $("#records-list").innerHTML = visible.length ? visible.map(({ record, index }) => `<article class="data-row"><div class="record-type">${escapeHtml(record.type)}</div><div class="grow"><strong>${escapeHtml(record.name)}</strong><small>${escapeHtml(recordValue(record))}</small></div><div class="data-meta"><span>TTL ${escapeHtml(record.ttl)}</span><span class="state-chip ${record.enabled === false ? "inactive" : "active"}">${record.enabled === false ? "已停用" : "已啟用"}</span></div><div class="row-actions">${iconButton("edit", `編輯 DNS 記錄 ${record.name}`, "edit-record", index)}${iconButton("delete", `刪除 DNS 記錄 ${record.name}`, "delete-record", index)}</div></article>`).join("") : empty("此網域尚無 DNS 記錄，請新增第一筆記錄。");
  animateRows($("#records-list"));
}

function selectDomain(scope) {
  state.selectedDomain = scope;
  const diagnostic = $("#diagnostic-form");
  diagnostic.elements.name.value = scope === "unassigned" ? "" : scope;
  $("#diagnostic-result").hidden = true;
  renderRecords();
  animateIn($("#domain-detail-content"));
}

function routeSummary(route) {
  const locations = route.locations || [];
  const upstreams = locations.flatMap((location) => location.upstreams || []).map((upstream) => upstream.target || `${upstream.scheme || "http"}://${upstream.dnsName}:${upstream.port}`);
  return `${locations.length} 個 location${upstreams.length ? ` · ${upstreams.join("、")}` : " · Redirect"}`;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function renderRoutes() {
  const routes = state.config.routes;
  const enabled = routes.filter((route) => route.enabled !== false).length;
  $("#routes-summary").textContent = `${routes.length} 個 · ${enabled} 啟用`;
  const cache = state.status.proxyCache || { entries: 0, bytes: 0, maxBytes: state.config.proxy.cacheMaxBytes };
  $("#proxy-cache-status").textContent = `${formatBytes(cache.bytes)} · ${cache.entries || 0} 項 / ${formatBytes(cache.maxBytes)}`;
  $("#routes-list").innerHTML = routes.length ? routes.map((route, index) => `<article class="data-row site-row"><div class="record-type route">SITE</div><div class="grow"><strong>${escapeHtml(route.host)}</strong><small>${escapeHtml(routeSummary(route))}</small>${route.aliases?.length ? `<small>別名：${escapeHtml(route.aliases.join("、"))}</small>` : ""}</div><div class="data-meta"><span class="state-chip ${route.enabled === false ? "inactive" : "active"}">${route.enabled === false ? "已停用" : "已啟用"}</span></div><div class="row-actions">${iconButton("edit", `編輯代理站台 ${route.host}`, "edit-route", index)}${iconButton("copy", `複製代理站台 ${route.host}`, "copy-route", index)}${iconButton("delete", `刪除代理站台 ${route.host}`, "delete-route", index)}</div></article>`).join("") : empty("新增第一個明確的 Host 代理站台。");
  animateRows($("#routes-list"));
}

function tunnelLabel(value) {
  return ({ running: "運行中", starting: "啟動中", stopping: "停止中", stopped: "已停止", error: "錯誤" })[value] || "不可使用";
}

function tunnelSourceLabel(value) {
  return ({ environment: "Token 來源：環境變數", config: "Token 來源：設定檔" })[value] || "尚未設定 Token";
}

function renderTunnel() {
  const tunnel = state.tunnel;
  $("#tunnel-state").textContent = tunnelLabel(tunnel.state);
  $("#tunnel-version").textContent = tunnel.available ? (tunnel.version || "等待下載 cloudflared") : "未提供可用 Token";
  $("#tunnel-token-source").textContent = tunnelSourceLabel(tunnel.tokenSource);
  $("#tunnel-token-note").textContent = tunnel.tokenSource === "environment"
    ? (tunnel.hasStoredToken ? "設定檔備援已儲存，目前不會使用。" : "目前由環境變數提供，沒有設定檔備援。")
    : (tunnel.hasStoredToken ? "設定檔 Token 使用中；欄位留白會保留原值。" : "儲存 Token 後即可啟動 Tunnel。");
  $("#tunnel-logs").textContent = tunnel.logs?.join("\n") || tunnel.lastError || "尚無輸出";
  $("#tunnel-indicator").className = `large-indicator ${tunnel.state === "running" ? "online" : tunnel.state === "error" ? "danger" : ""}`;
  $("#tunnel-start").disabled = !tunnel.available || ["running", "starting"].includes(tunnel.state);
  $("#tunnel-stop").disabled = !["running", "starting"].includes(tunnel.state);
  $("#tunnel-token-clear").disabled = !tunnel.hasStoredToken;
}

function renderEvents() {
  $("#events-summary").textContent = `${state.events.length} 筆`;
  $("#events-list").innerHTML = eventRows(state.events);
}

function metricLabels(labels) {
  const entries = Object.entries(labels || {});
  return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(" · ") : "無標籤";
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return "未知容量";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 ** 2)).toFixed(1)} MiB`;
}

function renderBackups() {
  $("#backups-summary").textContent = `${state.backups.length} 份`;
  const preview = $("#backup-preview");
  preview.hidden = !state.backupPreview;
  preview.innerHTML = state.backupPreview ? `<strong>將包含 ${state.backupPreview.files.length} 個檔案</strong><p>${state.backupPreview.files.map(escapeHtml).join(" · ")}</p>` : "";
  $("#backups-list").innerHTML = state.backups.length ? state.backups.map((backup) => `<article class="data-row backup-row" data-backup-file="${escapeHtml(backup.fileName)}"><div class="grow"><strong>${escapeHtml(backup.fileName)}</strong><small>${escapeHtml(formatBytes(backup.size))} · ${escapeHtml(formatTimestamp(backup.modifiedAt))}</small></div><div class="row-actions"><button class="secondary" type="button" data-backup-download="${escapeHtml(backup.fileName)}">下載</button><button class="secondary" type="button" data-backup-restore="${escapeHtml(backup.fileName)}">還原</button><button class="danger-button" type="button" data-backup-delete="${escapeHtml(backup.fileName)}">刪除</button></div></article>`).join("") : empty("目前沒有伺服器備份。");
  animateRows($("#backups-list"));
}

function renderObservability() {
  $$('[data-metric-window]').forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.metricWindow === state.metricWindow)));
  const history = $("[data-testid='metric-history']");
  history.innerHTML = state.metricHistory.length ? state.metricHistory.map((sample) => `<article class="data-row metric-history-row"><div class="grow"><strong>${escapeHtml(sample.metric)}</strong><small>${escapeHtml(metricLabels(sample.labels))}</small></div><strong class="metric-value">${escapeHtml(sample.value)}</strong></article>`).join("") : empty("此時間範圍尚無持久化指標。");
  const webhook = state.config.observability?.webhook || { enabled: false, url: "", hasSecret: false };
  $("#webhook-url").value = webhook.url || "";
  $("#webhook-enabled").checked = webhook.enabled === true;
  $("#webhook-secret-state").textContent = webhook.hasSecret ? "已安全儲存" : "尚未儲存密鑰";
  $("#webhook-jobs-summary").textContent = `${state.webhookJobs.length} 筆`;
  $("#webhook-jobs").innerHTML = state.webhookJobs.length ? state.webhookJobs.map((job) => `<article class="data-row webhook-job" data-testid="webhook-job-${escapeHtml(job.id)}"><div class="grow"><strong>${escapeHtml(job.eventType)}</strong><small>${escapeHtml(job.id)} · 嘗試 ${escapeHtml(job.attempts)} 次${job.lastError ? ` · ${escapeHtml(job.lastError)}` : ""}</small><time datetime="${escapeHtml(job.createdAt)}">${escapeHtml(formatTimestamp(job.createdAt))}</time></div><span class="state-chip ${job.state === "delivered" ? "active" : job.state === "dead-letter" ? "danger" : "inactive"}">${escapeHtml(job.state)}</span>${job.state === "dead-letter" ? `<button class="secondary" type="button" data-webhook-retry="${escapeHtml(job.id)}">重新傳送</button>` : ""}</article>`).join("") : empty("目前沒有 Webhook 傳送工作。");
  animateRows(history);
  animateRows($("#webhook-jobs"));
  renderBackups();
}

async function loadMetricHistory(window = state.metricWindow) {
  state.metricWindow = window;
  state.metricHistory = await api(`/api/observability/metrics?window=${encodeURIComponent(window)}`);
  renderObservability();
}

async function loadWebhookJobs() {
  state.webhookJobs = await api("/api/observability/webhooks");
  renderObservability();
}

async function loadBackups() {
  state.backups = await api("/api/backups");
  renderBackups();
}

function setView(viewName, { focus = true } = {}) {
  $$(".nav-button").forEach((button) => {
    const active = button.dataset.view === viewName;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  $$(".view").forEach((view) => { view.hidden = view.id !== `view-${viewName}`; });
  $("#page-title").textContent = titles[viewName];
  document.title = `${titles[viewName]} · S12 DNS Server`;
  animateIn($(`#view-${viewName}`));
  if (focus) $("#main-content").focus();
}

function renderAll() {
  renderOverview();
  renderRecords();
  renderRoutes();
  renderTunnel();
  renderEvents();
  renderObservability();
}

async function loadApplication() {
  const [config, status, tunnel, events, metricHistory, webhookJobs, backups] = await Promise.all([
    api("/api/config"),
    api("/api/status"),
    api("/api/tunnel"),
    api("/api/events"),
    api("/api/observability/metrics?window=24h"),
    api("/api/observability/webhooks"),
    api("/api/backups"),
  ]);
  Object.assign(state, { config: { domains: [], ...config }, status, tunnel, events, selectedDomain: null, metricWindow: "24h", metricHistory, webhookJobs, backups, backupPreview: null });
  renderAll();
  setView("overview", { focus: false });
  $("#loading").hidden = true;
  $("#auth-view").hidden = true;
  $("#app-view").hidden = false;
}

function showAuth(configured) {
  $("#loading").hidden = true;
  $("#app-view").hidden = true;
  $("#auth-view").hidden = false;
  $("#auth-form").reset();
  $("#auth-error").hidden = true;
  $("#auth-title").textContent = configured ? "登入管理介面" : "設定管理員";
  $("#auth-copy").textContent = configured ? "使用管理員密碼繼續。" : "輸入終端顯示的 10 分鐘一次性 Token。";
  $("#token-field").hidden = configured;
  $("#password-label").textContent = configured ? "密碼" : "新密碼";
  $("#password").autocomplete = configured ? "current-password" : "new-password";
  const submit = $("#auth-submit");
  submit.textContent = configured ? "登入" : "建立管理員";
  delete submit.dataset.idleLabel;
  submit.setAttribute("aria-busy", "false");
  $("#auth-form").dataset.mode = configured ? "login" : "setup";
}

async function boot() {
  const bootstrap = await api("/api/bootstrap");
  if (!bootstrap.configured) return showAuth(false);
  try {
    const session = await api("/api/session");
    state.csrf = session.csrf;
    await loadApplication();
  } catch {
    showAuth(true);
  }
}

function modalError(message = "") {
  const element = $(".modal-error", $("#modal-body"));
  if (!element) return;
  element.textContent = message;
  element.hidden = !message;
}

function openModal({ title, eyebrow = "CONTROL", content, wide = false, initialFocus = null, onClose = null }) {
  modalReturnFocus = document.activeElement;
  modalCloseCallback = onClose;
  $("#modal-title").textContent = title;
  $("#modal-eyebrow").textContent = eyebrow;
  $("#modal-body").innerHTML = content;
  $("#modal").classList.toggle("wide-modal", wide);
  $("#modal-layer").hidden = false;
  $("#modal-layer").setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  animateIn($("#modal"), [{ opacity: 0, transform: "translateY(12px) scale(.985)" }, { opacity: 1, transform: "none" }]);
  requestAnimationFrame(() => ($(initialFocus, $("#modal")) || $(focusableSelector, $("#modal")))?.focus());
}

function closeModal() {
  if ($("#modal-layer").hidden) return;
  $("#modal-layer").hidden = true;
  $("#modal-layer").setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  $("#modal-body").replaceChildren();
  const callback = modalCloseCallback;
  modalCloseCallback = null;
  callback?.();
  modalReturnFocus?.focus?.();
  modalReturnFocus = null;
}

function trapModalFocus(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeModal();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = $$(focusableSelector, $("#modal"));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openConfirm({ title, description, confirmLabel = "確認刪除", danger = true, onConfirm }) {
  openModal({
    title,
    eyebrow: "CONFIRM ACTION",
    content: `<div class="confirm-copy">${description}</div><p class="modal-error form-message error" role="alert" hidden></p><div class="modal-actions"><button class="secondary" type="button" data-modal-cancel>取消</button><button class="${danger ? "danger-button" : "primary"}" type="button" data-modal-confirm>${escapeHtml(confirmLabel)}</button></div>`,
    initialFocus: "[data-modal-cancel]",
  });
  $("[data-modal-cancel]", $("#modal-body")).addEventListener("click", closeModal);
  $("[data-modal-confirm]", $("#modal-body")).addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setBusy(button, true, "處理中…");
    try {
      await onConfirm();
      closeModal();
    } catch (error) {
      modalError(error.message);
      setBusy(button, false);
    }
  });
}

function qualifyRecordName(input, workspace) {
  const value = input.trim().toLowerCase().replace(/\.$/, "");
  if (!value) throw new Error("請輸入記錄名稱");
  if (!workspace) throw new Error("請先選擇網域");
  if (workspace === "unassigned") {
    if (!value.includes(".")) throw new Error("未分組記錄必須使用完整 FQDN");
    return value;
  }
  if (value === "@") return workspace;
  if (value === workspace || value.endsWith(`.${workspace}`)) return value;
  return `${value}.${workspace}`;
}

function parseRecord(data, workspace) {
  const ttl = Number(data.ttl);
  if (!Number.isInteger(ttl) || ttl < 0) throw new Error("TTL 必須是大於或等於 0 的整數");
  const name = qualifyRecordName(data.name, workspace);
  const value = data.value.trim();
  if (!value) throw new Error("請輸入記錄值");
  const assigned = domainFor(name)?.name || "unassigned";
  if (assigned !== workspace) throw new Error(workspace === "unassigned" ? "此名稱已屬於既有網域工作區" : "記錄名稱必須直接歸屬目前網域");
  const base = { name, type: data.type, ttl, enabled: data.enabled === "on" };
  if (data.type === "MX") {
    const [priority, exchange, ...rest] = value.split(/\s+/);
    if (!/^\d+$/.test(priority) || !exchange || rest.length) throw new Error("MX 值格式必須是「優先序 主機名稱」");
    return { ...base, priority: Number(priority), exchange };
  }
  if (data.type === "SRV") {
    const [priority, weight, port, target, ...rest] = value.split(/\s+/);
    if (![priority, weight, port].every((part) => /^\d+$/.test(part)) || !target || rest.length) throw new Error("SRV 值格式必須是「優先序 權重 埠號 目標」");
    return { ...base, priority: Number(priority), weight: Number(weight), port: Number(port), target };
  }
  return { ...base, value };
}

function recordFormMarkup(record, editing) {
  const type = record?.type || "A";
  const [placeholder, help] = recordHints[type];
  return `<form id="record-form" class="modal-form" novalidate><div class="form-grid"><label>記錄名稱<input name="name" value="${escapeHtml(record?.name || "")}" placeholder="home.example.com" autocomplete="off"><small id="record-name-preview"></small></label><label>類型<select id="record-type" name="type">${Object.keys(recordHints).map((candidate) => `<option${candidate === type ? " selected" : ""}>${candidate}</option>`).join("")}</select></label><label class="full">記錄值<input id="record-value" name="value" value="${escapeHtml(record ? recordValue(record) : "")}" placeholder="${escapeHtml(placeholder)}" aria-describedby="record-value-help"><small id="record-value-help">${escapeHtml(help)}</small></label><label>TTL<input name="ttl" type="number" inputmode="numeric" min="0" value="${escapeHtml(record?.ttl ?? 300)}"></label><label class="check-field"><input name="enabled" type="checkbox"${record?.enabled === false ? "" : " checked"}>啟用記錄</label></div><p class="modal-error form-message error" role="alert" hidden></p><div class="modal-actions"><button class="secondary" type="button" data-modal-cancel>取消</button><button class="primary" type="submit" value="default">${editing ? "儲存記錄" : "儲存記錄"}</button></div></form>`;
}

function openRecordModal(index = null) {
  const editing = index !== null;
  const record = editing ? state.config.records[index] : null;
  const workspace = editing ? (domainFor(record.name)?.name || "unassigned") : state.selectedDomain;
  openModal({ title: editing ? "編輯 DNS 記錄" : "新增 DNS 記錄", eyebrow: "DNS RECORD", content: recordFormMarkup(record, editing), initialFocus: "[name='name']" });
  const form = $("#record-form", $("#modal-body"));
  const updateHint = () => {
    const [placeholder, help] = recordHints[$("#record-type").value];
    $("#record-value").placeholder = placeholder;
    $("#record-value-help").textContent = help;
  };
  const updatePreview = () => {
    try { $("#record-name-preview").textContent = `完整名稱：${qualifyRecordName(form.elements.name.value, workspace)}`; } catch { $("#record-name-preview").textContent = ""; }
  };
  $("#record-type").addEventListener("change", updateHint);
  form.elements.name.addEventListener("input", updatePreview);
  $("[data-modal-cancel]", form).addEventListener("click", closeModal);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    try {
      const nextRecord = parseRecord(Object.fromEntries(new FormData(form)), workspace);
      const next = structuredClone(state.config);
      if (editing) next.records[index] = nextRecord; else next.records.push(nextRecord);
      modalError();
      setBusy(button, true, "儲存中…");
      state.config = await api("/api/config", { method: "PUT", body: next });
      renderRecords();
      renderOverview();
      closeModal();
      showToast(editing ? "DNS 記錄已更新" : "DNS 記錄已儲存");
    } catch (error) {
      modalError(error.message);
      setBusy(button, false);
    }
  });
  updatePreview();
}

function deleteRecord(index) {
  const record = state.config.records[index];
  openConfirm({
    title: "刪除 DNS 記錄",
    description: `<p>確定刪除這筆記錄？此操作會立即儲存並熱更新。</p><dl class="confirm-details"><div><dt>名稱</dt><dd>${escapeHtml(record.name)}</dd></div><div><dt>類型</dt><dd>${escapeHtml(record.type)}</dd></div><div><dt>值</dt><dd>${escapeHtml(recordValue(record))}</dd></div></dl>`,
    onConfirm: async () => {
      const next = structuredClone(state.config);
      next.records.splice(index, 1);
      state.config = await api("/api/config", { method: "PUT", body: next });
      renderRecords();
      renderOverview();
      showToast("DNS 記錄已刪除");
    },
  });
}

function domainCreateMarkup() {
  return `<form id="domain-form" class="modal-form" novalidate><div class="form-grid"><label>網域名稱<input name="name" placeholder="example.com" autocomplete="off"></label><label>建立模式<select name="mode"><option value="blank">空白工作區</option><option value="website">網站範本</option></select></label><label>預設 TTL<input name="defaultTtl" type="number" inputmode="numeric" value="300" min="0"></label><label>備註<input name="note" autocomplete="off"></label><div class="full website-fields" hidden><label>IPv4 位址<input name="ipv4" placeholder="192.0.2.10"></label><label>IPv6 位址<input name="ipv6" placeholder="2001:db8::10"></label><label>內部 upstream URL<input name="upstreamUrl" inputmode="url" placeholder="http://127.0.0.1:3000"></label><label class="check-field"><input name="createWww" type="checkbox">建立 www CNAME</label></div></div><p class="modal-error form-message error" role="alert" hidden></p><div id="domain-preview" class="review-box" data-testid="domain-preview" hidden></div><div class="modal-actions split-actions"><button class="secondary" type="button" data-modal-cancel>取消</button><div><button class="secondary" type="button" data-domain-preview>預覽變更</button><button class="primary" type="submit">建立網域</button></div></div></form>`;
}

function domainPayload(form) {
  const data = Object.fromEntries(new FormData(form));
  const name = data.name.trim().toLowerCase().replace(/\.$/, "");
  const defaultTtl = Number(data.defaultTtl);
  if (!name) throw new Error("請輸入網域名稱");
  if (!Number.isInteger(defaultTtl) || defaultTtl < 0) throw new Error("預設 TTL 必須是大於或等於 0 的整數");
  const payload = { name, defaultTtl, note: data.note || "", enabled: true };
  if (data.mode === "website") payload.website = { ipv4: data.ipv4 || "", ipv6: data.ipv6 || "", createWww: data.createWww === "on", upstreamUrl: data.upstreamUrl || "" };
  return payload;
}

function previewDomain(additions) {
  const records = additions.records.map((record) => `${record.type} ${record.name} → ${recordValue(record)}`);
  const routes = additions.routes.map((route) => `代理 ${route.host} → ${route.target}`);
  return `<strong>將建立 ${escapeHtml(additions.domain.name)}</strong><ul>${[...records, ...routes].map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li>空白工作區，不新增記錄或代理</li>"}</ul>`;
}

function openCreateDomainModal() {
  openModal({ title: "新增網域工作區", eyebrow: "DOMAIN WORKSPACE", content: domainCreateMarkup(), wide: true, initialFocus: "[name='name']" });
  const form = $("#domain-form", $("#modal-body"));
  const fields = $(".website-fields", form);
  form.elements.mode.addEventListener("change", () => { fields.hidden = form.elements.mode.value !== "website"; });
  $("[data-modal-cancel]", form).addEventListener("click", closeModal);
  $("[data-domain-preview]", form).addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      const payload = domainPayload(form);
      modalError();
      setBusy(button, true, "預覽中…");
      const result = await api("/api/domains/preview", { method: "POST", body: payload });
      $("#domain-preview").innerHTML = previewDomain(result.additions);
      $("#domain-preview").hidden = false;
      animateIn($("#domain-preview"));
    } catch (error) {
      modalError(error.message);
    } finally { setBusy(button, false); }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    try {
      const payload = domainPayload(form);
      modalError();
      setBusy(button, true, "建立中…");
      state.config = await api("/api/domains", { method: "POST", body: payload });
      renderRecords();
      renderRoutes();
      renderOverview();
      closeModal();
      showToast("網域工作區已建立");
    } catch (error) {
      modalError(error.message);
      setBusy(button, false);
    }
  });
}

function openEditDomainModal(index) {
  const domain = state.config.domains[index];
  const content = `<form id="domain-edit-form" class="modal-form" novalidate><div class="form-grid"><label>網域名稱<input name="name" value="${escapeHtml(domain.name)}" autocomplete="off"></label><label>預設 TTL<input name="defaultTtl" type="number" inputmode="numeric" min="0" value="${escapeHtml(domain.defaultTtl)}"></label><label class="full">備註<input name="note" value="${escapeHtml(domain.note || "")}"></label><label class="check-field"><input name="enabled" type="checkbox"${domain.enabled === false ? "" : " checked"}>啟用網域</label></div><p class="modal-error form-message error" role="alert" hidden></p><div class="modal-actions"><button class="secondary" type="button" data-modal-cancel>取消</button><button class="primary" type="submit">儲存網域</button></div></form>`;
  openModal({ title: "編輯網域工作區", eyebrow: "DOMAIN WORKSPACE", content, initialFocus: "[name='name']" });
  const form = $("#domain-edit-form", $("#modal-body"));
  $("[data-modal-cancel]", form).addEventListener("click", closeModal);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const defaultTtl = Number(data.defaultTtl);
    if (!data.name.trim()) return modalError("請輸入網域名稱");
    if (!Number.isInteger(defaultTtl) || defaultTtl < 0) return modalError("預設 TTL 必須是大於或等於 0 的整數");
    const button = event.submitter;
    setBusy(button, true, "儲存中…");
    try {
      state.config = await api(`/api/domains/${encodeURIComponent(domain.name)}`, { method: "PUT", body: { name: data.name, defaultTtl, note: data.note || "", enabled: data.enabled === "on" } });
      if (state.selectedDomain === domain.name) state.selectedDomain = data.name.trim().toLowerCase().replace(/\.$/, "");
      renderRecords();
      renderRoutes();
      renderOverview();
      closeModal();
      showToast("網域工作區已更新");
    } catch (error) {
      modalError(error.message);
      setBusy(button, false);
    }
  });
}

function deleteDomain(index) {
  const domain = state.config.domains[index];
  const records = state.config.records.filter((record) => belongsTo(record.name, domain.name)).length;
  const routes = state.config.routes.filter((route) => belongsTo(route.host, domain.name)).length;
  const domains = state.config.domains.filter((candidate) => belongsTo(candidate.name, domain.name)).length;
  openConfirm({
    title: "刪除網域工作區",
    confirmLabel: "刪除整個網域",
    description: `<p>這會原子刪除 <strong>${escapeHtml(domain.name)}</strong> 的整棵工作區及所屬項目。</p><dl class="confirm-details"><div><dt>網域工作區</dt><dd>${domains} 個</dd></div><div><dt>DNS</dt><dd>DNS 記錄 ${records} 筆</dd></div><div><dt>代理</dt><dd>代理站台 ${routes} 個</dd></div></dl>`,
    onConfirm: async () => {
      state.config = await api(`/api/domains/${encodeURIComponent(domain.name)}`, { method: "DELETE" });
      if (state.selectedDomain !== "unassigned" && belongsTo(state.selectedDomain, domain.name)) state.selectedDomain = null;
      renderRecords();
      renderRoutes();
      renderOverview();
      showToast("網域工作區已刪除");
    },
  });
}

function locationDefaults(location = {}) {
  const upstreams = location.upstreams?.map((upstream) => upstream.target || "").filter(Boolean) || ["http://127.0.0.1:3000"];
  return {
    path: location.path || "/", match: location.match || "prefix", action: location.action || "proxy",
    upstreams, redirectStatus: location.redirect?.status || 302, redirectLocation: location.redirect?.location || "https://${host}${path}",
    rewriteMode: location.rewrite?.mode || "none", rewriteValue: location.rewrite?.value || "/",
    bodyLimitMiB: Math.max(1, Math.round((location.bodyLimitBytes || 10 * 1024 * 1024) / 1024 / 1024)),
    cacheEnabled: Boolean(location.cache?.enabled), cacheTtl: location.cache?.ttlSeconds || 60,
    compressionEnabled: location.compression?.enabled !== false,
    allow: (location.access?.allow || []).join("\n"), deny: (location.access?.deny || []).join("\n"),
    rateEnabled: Boolean(location.rateLimit?.enabled), rateRequests: location.rateLimit?.requests || 60,
    requestSet: Object.entries(location.requestHeaders?.set || {}).map(([name, value]) => `${name}=${value}`).join("\n"),
    requestRemove: (location.requestHeaders?.remove || []).join(", "),
    responseSet: Object.entries(location.responseHeaders?.set || {}).map(([name, value]) => `${name}=${value}`).join("\n"),
    responseRemove: (location.responseHeaders?.remove || []).join(", "),
  };
}

function wizardFromRoute(route, mode, index) {
  return {
    mode, index, step: 1,
    draft: {
      host: mode === "clone" ? `copy.${route?.host || ""}`.replace(/\.$/, "") : route?.host || "",
      aliases: (route?.aliases || []).join("\n"), enabled: mode === "clone" ? true : route?.enabled !== false,
      locations: route?.locations?.map(locationDefaults) || [locationDefaults()],
    },
  };
}

function headerRules(value) {
  const set = {};
  for (const line of String(value || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("Header 規則必須使用 name=value 格式");
    set[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return set;
}

function wizardLocationMarkup(location, index, step) {
  const suffix = index === 0 ? "" : ` ${index + 1}`;
  if (step === 2) return `<section class="wizard-location" data-location="${index}"><div class="wizard-location-heading"><strong>Location ${index + 1}</strong>${index ? `<button class="text-button danger-text" type="button" data-remove-location="${index}">移除</button>` : ""}</div><div class="form-grid"><label>路徑${suffix}<input name="path-${index}" value="${escapeHtml(location.path)}"></label><label>比對方式${suffix}<select name="match-${index}"><option value="prefix"${location.match === "prefix" ? " selected" : ""}>最長前綴</option><option value="exact"${location.match === "exact" ? " selected" : ""}>精確路徑</option></select></label><label>動作${suffix}<select name="action-${index}"><option value="proxy"${location.action === "proxy" ? " selected" : ""}>反向代理</option><option value="redirect"${location.action === "redirect" ? " selected" : ""}>重新導向</option></select></label></div></section>`;
  if (step === 3) return `<section class="wizard-location" data-location="${index}"><strong>Location ${index + 1} · ${escapeHtml(location.path)}</strong><div class="form-grid"><label class="full">${index === 0 ? "上游 URL（每行一個）" : `Location ${index + 1} 上游 URL`}<textarea name="upstreams-${index}" rows="4">${escapeHtml(location.upstreams.join("\n"))}</textarea></label><label>Rewrite<select name="rewrite-${index}"><option value="none"${location.rewriteMode === "none" ? " selected" : ""}>不改寫</option><option value="strip-prefix"${location.rewriteMode === "strip-prefix" ? " selected" : ""}>移除前綴</option><option value="replace-prefix"${location.rewriteMode === "replace-prefix" ? " selected" : ""}>替換前綴</option></select></label><label>替換前綴<input name="rewrite-value-${index}" value="${escapeHtml(location.rewriteValue)}"></label><label>Redirect 狀態<select name="redirect-status-${index}">${[301, 302, 307, 308].map((status) => `<option${status === location.redirectStatus ? " selected" : ""}>${status}</option>`).join("")}</select></label><label>Redirect URL<input name="redirect-location-${index}" value="${escapeHtml(location.redirectLocation)}"></label></div></section>`;
  return `<section class="wizard-location" data-location="${index}"><strong>Location ${index + 1} · ${escapeHtml(location.path)}</strong><div class="form-grid"><label>${index === 0 ? "Body 限制（MiB）" : `Location ${index + 1} Body 限制（MiB）`}<input name="body-${index}" type="number" min="1" value="${location.bodyLimitMiB}"></label><label class="check-field"><input name="cache-${index}" type="checkbox"${location.cacheEnabled ? " checked" : ""}>${index === 0 ? "啟用代理快取" : `Location ${index + 1} 啟用快取`}</label><label>快取 TTL（秒）<input name="cache-ttl-${index}" type="number" min="1" value="${location.cacheTtl}"></label><label class="check-field"><input name="compression-${index}" type="checkbox"${location.compressionEnabled ? " checked" : ""}>啟用 Brotli / gzip</label><label>允許 CIDR（每行一個）<textarea name="allow-${index}" rows="2">${escapeHtml(location.allow)}</textarea></label><label>拒絕 CIDR（每行一個）<textarea name="deny-${index}" rows="2">${escapeHtml(location.deny)}</textarea></label><label class="check-field"><input name="rate-${index}" type="checkbox"${location.rateEnabled ? " checked" : ""}>啟用記憶體限流</label><label>每分鐘請求數<input name="rate-requests-${index}" type="number" min="1" value="${location.rateRequests}"></label><label>Request headers（name=value）<textarea name="request-set-${index}" rows="2">${escapeHtml(location.requestSet)}</textarea></label><label>移除 request headers<input name="request-remove-${index}" value="${escapeHtml(location.requestRemove)}"></label><label>Response headers（name=value）<textarea name="response-set-${index}" rows="2">${escapeHtml(location.responseSet)}</textarea></label><label>移除 response headers<input name="response-remove-${index}" value="${escapeHtml(location.responseRemove)}"></label></div></section>`;
}

function renderSiteWizard() {
  const { step, draft, mode } = siteWizard;
  let content;
  if (step === 1) content = `<div class="form-grid"><label>主要 Host<input name="host" value="${escapeHtml(draft.host)}" autocomplete="off"></label><label class="check-field"><input name="enabled" type="checkbox"${draft.enabled ? " checked" : ""}>啟用站台</label><label class="full">Host aliases（每行一個）<textarea name="aliases" rows="3" placeholder="www.example.com&#10;*.example.com">${escapeHtml(draft.aliases)}</textarea></label></div>`;
  else if (step === 2) content = `${draft.locations.map((location, index) => wizardLocationMarkup(location, index, step)).join("")}<button class="secondary" type="button" data-add-location>新增 Location</button>`;
  else if (step === 3 || step === 4) content = draft.locations.map((location, index) => wizardLocationMarkup(location, index, step)).join("");
  else content = `<div class="review-box" data-testid="proxy-review"><strong>${escapeHtml(draft.host)}</strong><p>${draft.enabled ? "站台啟用" : "站台停用"} · ${draft.locations.length} 個 Location</p>${draft.locations.map((location) => `<div><code>${escapeHtml(location.match)} ${escapeHtml(location.path)}</code><span>${escapeHtml(location.action === "redirect" ? `${location.redirectStatus} ${location.redirectLocation}` : location.upstreams.join("、"))}</span></div>`).join("")}</div>`;
  const finalLabel = mode === "edit" ? "儲存站台" : mode === "clone" ? "建立副本" : "建立站台";
  $("#modal-body").innerHTML = `<div class="wizard-progress"><span>步驟 ${step} / 5</span><div>${[1, 2, 3, 4, 5].map((number) => `<i class="${number <= step ? "active" : ""}"></i>`).join("")}</div></div><form id="site-wizard-form" class="modal-form" novalidate>${content}<p class="modal-error form-message error" role="alert" hidden></p><div class="modal-actions split-actions"><button class="secondary" type="button" data-modal-cancel>取消</button><div>${step > 1 ? "<button class=\"secondary\" type=\"button\" data-wizard-back>上一步</button>" : ""}<button class="primary" type="submit">${step === 5 ? finalLabel : "下一步"}</button></div></div></form>`;
  const form = $("#site-wizard-form");
  $("[data-modal-cancel]", form).addEventListener("click", closeModal);
  $("[data-wizard-back]", form)?.addEventListener("click", () => { siteWizard.step -= 1; renderSiteWizard(); });
  $("[data-add-location]", form)?.addEventListener("click", () => {
    collectWizardStep(form);
    siteWizard.draft.locations.push(locationDefaults());
    renderSiteWizard();
  });
  $$('[data-remove-location]', form).forEach((button) => button.addEventListener("click", () => {
    collectWizardStep(form);
    siteWizard.draft.locations.splice(Number(button.dataset.removeLocation), 1);
    renderSiteWizard();
  }));
  form.addEventListener("submit", handleSiteWizardSubmit);
  requestAnimationFrame(() => $(focusableSelector, form)?.focus());
}

function lines(value) {
  return String(value || "").split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

function collectWizardStep(form) {
  const { step, draft } = siteWizard;
  if (step === 1) {
    draft.host = form.elements.host.value.trim().toLowerCase();
    draft.aliases = form.elements.aliases.value;
    draft.enabled = form.elements.enabled.checked;
    if (!draft.host) throw new Error("請輸入主要 Host");
  } else if (step === 2) {
    draft.locations.forEach((location, index) => {
      location.path = form.elements[`path-${index}`].value.trim();
      location.match = form.elements[`match-${index}`].value;
      location.action = form.elements[`action-${index}`].value;
      if (!location.path.startsWith("/")) throw new Error("Location 路徑必須以 / 開頭");
    });
  } else if (step === 3) {
    draft.locations.forEach((location, index) => {
      location.upstreams = lines(form.elements[`upstreams-${index}`].value);
      location.rewriteMode = form.elements[`rewrite-${index}`].value;
      location.rewriteValue = form.elements[`rewrite-value-${index}`].value;
      location.redirectStatus = Number(form.elements[`redirect-status-${index}`].value);
      location.redirectLocation = form.elements[`redirect-location-${index}`].value;
      if (location.action === "proxy" && !location.upstreams.length) throw new Error(`Location ${location.path} 至少需要一個 upstream`);
      for (const target of location.upstreams) {
        try { if (!["http:", "https:"].includes(new URL(target).protocol)) throw new Error(); } catch { throw new Error(`Upstream URL 無效：${target}`); }
      }
      if (location.action === "redirect" && !location.redirectLocation) throw new Error("Redirect URL 不可留白");
    });
  } else if (step === 4) {
    draft.locations.forEach((location, index) => {
      location.bodyLimitMiB = Number(form.elements[`body-${index}`].value);
      location.cacheEnabled = form.elements[`cache-${index}`].checked;
      location.cacheTtl = Number(form.elements[`cache-ttl-${index}`].value);
      location.compressionEnabled = form.elements[`compression-${index}`].checked;
      location.allow = form.elements[`allow-${index}`].value;
      location.deny = form.elements[`deny-${index}`].value;
      location.rateEnabled = form.elements[`rate-${index}`].checked;
      location.rateRequests = Number(form.elements[`rate-requests-${index}`].value);
      location.requestSet = form.elements[`request-set-${index}`].value;
      location.requestRemove = form.elements[`request-remove-${index}`].value;
      location.responseSet = form.elements[`response-set-${index}`].value;
      location.responseRemove = form.elements[`response-remove-${index}`].value;
      if (!Number.isInteger(location.bodyLimitMiB) || location.bodyLimitMiB < 1) throw new Error("Body 限制必須是正整數 MiB");
      if (!Number.isInteger(location.cacheTtl) || location.cacheTtl < 1) throw new Error("快取 TTL 必須是正整數");
      headerRules(location.requestSet);
      headerRules(location.responseSet);
    });
  }
}

function wizardRoute() {
  const { draft } = siteWizard;
  return {
    host: draft.host,
    aliases: lines(draft.aliases),
    enabled: draft.enabled,
    locations: draft.locations.map((location) => ({
      path: location.path,
      match: location.match,
      action: location.action,
      requestHeaders: { set: headerRules(location.requestSet), remove: lines(location.requestRemove) },
      responseHeaders: { set: headerRules(location.responseSet), remove: lines(location.responseRemove) },
      bodyLimitBytes: location.bodyLimitMiB * 1024 * 1024,
      access: { allow: lines(location.allow), deny: lines(location.deny) },
      rateLimit: { enabled: location.rateEnabled, requests: location.rateRequests, windowMs: 60000 },
      cache: { enabled: location.cacheEnabled, ttlSeconds: location.cacheTtl, maxBytes: 100 * 1024 * 1024 },
      compression: { enabled: location.compressionEnabled, minBytes: 1024 },
      ...(location.action === "redirect" ? { redirect: { status: location.redirectStatus, location: location.redirectLocation } } : {
        upstreams: location.upstreams.map((target) => ({ target, enabled: true })),
        rewrite: { mode: location.rewriteMode, ...(location.rewriteMode === "replace-prefix" ? { value: location.rewriteValue } : {}) },
      }),
    })),
  };
}

async function handleSiteWizardSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    if (siteWizard.step < 5) {
      collectWizardStep(form);
      siteWizard.step += 1;
      renderSiteWizard();
      return;
    }
    const button = event.submitter;
    const next = structuredClone(state.config);
    const route = wizardRoute();
    if (siteWizard.mode === "edit") next.routes[siteWizard.index] = route; else next.routes.push(route);
    modalError();
    setBusy(button, true, "儲存中…");
    state.config = await api("/api/config", { method: "PUT", body: next });
    state.status = await api("/api/status");
    renderRoutes();
    renderOverview();
    closeModal();
    showToast(siteWizard.mode === "edit" ? "代理站台已更新" : "代理站台已建立");
  } catch (error) {
    modalError(error.message);
  }
}

function openSiteWizard(mode = "create", index = null) {
  const route = index === null ? null : state.config.routes[index];
  siteWizard = wizardFromRoute(route, mode, index);
  const title = mode === "edit" ? "編輯代理站台" : mode === "clone" ? "複製代理站台" : "新增代理站台";
  openModal({ title, eyebrow: "PROXY SITE WIZARD", content: "", wide: true, onClose: () => { siteWizard = null; } });
  renderSiteWizard();
}

function deleteRoute(index) {
  const route = state.config.routes[index];
  openConfirm({
    title: "刪除代理站台",
    description: `<p>確定刪除代理站台 <strong>${escapeHtml(route.host)}</strong>？DNS 記錄不會被刪除。</p>`,
    onConfirm: async () => {
      const next = structuredClone(state.config);
      next.routes.splice(index, 1);
      state.config = await api("/api/config", { method: "PUT", body: next });
      renderRoutes();
      renderOverview();
      showToast("代理站台已刪除");
    },
  });
}

async function tunnelAction(action) {
  const button = action === "start" ? $("#tunnel-start") : $("#tunnel-stop");
  setBusy(button, true, action === "start" ? "啟動中…" : "停止中…");
  try {
    state.tunnel = await api(`/api/tunnel/${action}`, { method: "POST" });
    showToast(action === "start" ? "Tunnel 已啟動" : "Tunnel 已停止");
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(button, false); renderTunnel(); renderOverview(); }
}

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = $("#auth-error");
  const button = $("#auth-submit");
  const setup = form.dataset.mode === "setup";
  const password = $("#password").value;
  if (password.length < 12 || (setup && !$("#setup-token").value.trim())) {
    error.textContent = setup && !$("#setup-token").value.trim() ? "請輸入 Setup token" : "密碼至少需要 12 個字元";
    error.hidden = false;
    return;
  }
  error.hidden = true;
  setBusy(button, true, setup ? "正在建立…" : "登入中…");
  try {
    const result = await api(setup ? "/api/setup" : "/api/login", { method: "POST", body: setup ? { token: $("#setup-token").value, password } : { username: "admin", password } });
    state.csrf = result.csrf;
    await loadApplication();
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  } finally { setBusy(button, false); }
});

$$(".nav-button").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
$("#modal-close").addEventListener("click", closeModal);
$("#modal-layer").addEventListener("keydown", trapModalFocus);
$$("[data-modal-dismiss]").forEach((element) => element.addEventListener("click", closeModal));
$("#add-record").addEventListener("click", () => openRecordModal());
$("#add-domain").addEventListener("click", openCreateDomainModal);
$("#add-route").addEventListener("click", () => openSiteWizard("create"));

$("#records-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const index = Number(button.dataset.index);
  if (button.dataset.action === "edit-record") openRecordModal(index);
  else if (button.dataset.action === "delete-record") deleteRecord(index);
});

$("#domains-list").addEventListener("click", (event) => {
  const selector = event.target.closest("[data-domain-scope]");
  if (selector) {
    selectDomain(selector.dataset.domainScope);
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const index = Number(button.dataset.index);
  if (button.dataset.action === "edit-domain") openEditDomainModal(index);
  else if (button.dataset.action === "delete-domain") deleteDomain(index);
});

$("#routes-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const index = Number(button.dataset.index);
  if (button.dataset.action === "edit-route") openSiteWizard("edit", index);
  else if (button.dataset.action === "copy-route") openSiteWizard("clone", index);
  else if (button.dataset.action === "delete-route") deleteRoute(index);
});

$("#diagnostic-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = event.submitter;
  const error = $(".form-message", form);
  const name = form.elements.name.value.trim();
  if (!name) {
    error.textContent = "請輸入診斷名稱";
    error.hidden = false;
    return;
  }
  error.hidden = true;
  setBusy(button, true, "診斷中…");
  try {
    const result = await api("/api/dns/diagnose", { method: "POST", body: { name, type: form.elements.type.value } });
    $("[data-testid='diagnostic-rcode']").textContent = result.rcode;
    $("[data-testid='diagnostic-sources']").textContent = result.sources.join(" → ") || "無";
    $("[data-testid='diagnostic-answers']").textContent = result.answers.length ? result.answers.map((answer) => `${answer.type} ${answer.name} ${recordValue(answer)}`).join("\n") : "沒有答案";
    $("#diagnostic-result").hidden = false;
    animateIn($("#diagnostic-result"));
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  } finally { setBusy(button, false); }
});

$("#clear-proxy-cache").addEventListener("click", () => openConfirm({
  title: "清除代理快取",
  description: "<p>確定清除所有站台的磁碟代理快取？進行中的請求不受影響。</p>",
  confirmLabel: "確認清除",
  danger: false,
  onConfirm: async () => {
    state.status.proxyCache = await api("/api/proxy/cache", { method: "DELETE", body: {} });
    renderRoutes();
    showToast("代理快取已清除");
  },
}));

$("#tunnel-start").addEventListener("click", () => tunnelAction("start"));
$("#tunnel-stop").addEventListener("click", () => tunnelAction("stop"));
$("#tunnel-token-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const token = $("#tunnel-token").value;
  if (!token) return showToast("Token 未變更");
  const button = $("#tunnel-token-save");
  setBusy(button, true, "套用中…");
  try {
    state.tunnel = await api("/api/tunnel/token", { method: "PUT", body: { token } });
    form.reset();
    renderTunnel();
    renderOverview();
    showToast(state.tunnel.tokenSource === "environment" ? "備援 Token 已儲存" : "Tunnel Token 已套用");
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(button, false); }
});

$("#tunnel-token-clear").addEventListener("click", () => {
  if (!state.tunnel.hasStoredToken) return;
  openConfirm({
    title: "清除 Tunnel Token",
    description: "<p>確定清除已儲存的 Tunnel Token？若沒有環境變數 Token，正在運行的 Tunnel 將停止。</p>",
    confirmLabel: "確認清除",
    onConfirm: async () => {
      state.tunnel = await api("/api/tunnel/token", { method: "DELETE" });
      $("#tunnel-token-form").reset();
      renderTunnel();
      renderOverview();
      showToast("已清除儲存的 Tunnel Token");
    },
  });
});

$("#refresh-events").addEventListener("click", async () => {
  const button = $("#refresh-events");
  setBusy(button, true, "更新中…");
  try {
    state.events = await api("/api/events");
    renderEvents();
    renderOverview();
    showToast("事件已更新");
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(button, false); }
});

$("#metric-window").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-metric-window]");
  if (!button || button.dataset.metricWindow === state.metricWindow) return;
  $$('[data-metric-window]').forEach((candidate) => { candidate.disabled = true; });
  try {
    await loadMetricHistory(button.dataset.metricWindow);
  } catch (error) { showToast(error.message, true); }
  finally { $$('[data-metric-window]').forEach((candidate) => { candidate.disabled = false; }); }
});

$("#webhook-config-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = event.submitter;
  const error = $(".form-message", form);
  const url = form.elements.url.value.trim();
  const secret = form.elements.secret.value;
  if (!secret) {
    error.textContent = "請輸入新的 Webhook secret";
    error.hidden = false;
    return;
  }
  if (form.elements.enabled.checked && !url.startsWith("https://")) {
    error.textContent = "啟用 Webhook 時 URL 必須使用 HTTPS";
    error.hidden = false;
    return;
  }
  error.hidden = true;
  setBusy(button, true, "儲存中…");
  try {
    const webhook = await api("/api/observability/webhook", { method: "PUT", body: { enabled: form.elements.enabled.checked, url, secret } });
    state.config.observability.webhook = webhook;
    form.elements.secret.value = "";
    renderObservability();
    showToast("Webhook 設定已更新");
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  } finally { setBusy(button, false); }
});

$("#refresh-webhooks").addEventListener("click", async (event) => {
  setBusy(event.currentTarget, true, "更新中…");
  try {
    await loadWebhookJobs();
    showToast("Webhook 傳送狀態已更新");
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(event.currentTarget, false); }
});

$("#webhook-jobs").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-webhook-retry]");
  if (!button) return;
  setBusy(button, true, "排程中…");
  try {
    const updated = await api(`/api/observability/webhooks/${encodeURIComponent(button.dataset.webhookRetry)}/retry`, { method: "POST" });
    state.webhookJobs = state.webhookJobs.map((job) => job.id === updated.id ? updated : job);
    renderObservability();
    showToast("Webhook 已重新排程");
  } catch (error) { showToast(error.message, true); }
});

$("#refresh-backups").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true, "更新中…");
  try {
    await loadBackups();
    showToast("備份清單已更新");
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(button, false); }
});

$("#preview-backup").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true, "檢查中…");
  try {
    state.backupPreview = await api("/api/backups", { method: "POST", body: { dryRun: true } });
    renderBackups();
    showToast("備份內容預覽已完成");
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(button, false); }
});

$("#create-backup").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true, "建立中…");
  try {
    await api("/api/backups", { method: "POST", body: { dryRun: false } });
    await loadBackups();
    showToast("敏感備份已建立");
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(button, false); }
});

function uploadBackupFileName() {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `s12-upload-${timestamp}.zip`;
}

$("#import-backup").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const input = $("#backup-upload");
  const file = input.files[0];
  if (!file) return showToast("請先選擇 ZIP 備份", true);
  setBusy(button, true, "匯入中…");
  try {
    await rawApi("/api/backups/upload", { method: "POST", headers: { "content-type": "application/zip", "x-backup-filename": uploadBackupFileName() }, body: file });
    input.value = "";
    await loadBackups();
    showToast("外部備份已驗證並匯入");
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(button, false); }
});

$("#backups-list").addEventListener("click", (event) => {
  const download = event.target.closest("[data-backup-download]");
  if (download) {
    const anchor = document.createElement("a");
    anchor.href = `/api/backups/${encodeURIComponent(download.dataset.backupDownload)}/download`;
    anchor.download = download.dataset.backupDownload;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return;
  }
  const restore = event.target.closest("[data-backup-restore]");
  if (restore) {
    const fileName = restore.dataset.backupRestore;
    openModal({
      title: "還原備份",
      eyebrow: "DISASTER RECOVERY",
      content: `<div class="confirm-copy"><p>將驗證 <strong>${escapeHtml(fileName)}</strong> 的 manifest、檔案雜湊及 schema。正式還原會短暫停止公開服務。</p></div><p class="backup-validation" role="status"></p><p class="modal-error form-message error" role="alert" hidden></p><div class="modal-actions"><button class="secondary" type="button" data-modal-cancel>取消</button><button class="secondary" type="button" data-backup-validate>驗證備份</button><button class="danger-button" type="button" data-backup-apply>進入維護模式並還原</button></div>`,
      initialFocus: "[data-modal-cancel]",
    });
    $("[data-modal-cancel]", $("#modal-body")).addEventListener("click", closeModal);
    $("[data-backup-validate]", $("#modal-body")).addEventListener("click", async (validationEvent) => {
      const button = validationEvent.currentTarget;
      setBusy(button, true, "驗證中…");
      try {
        await api(`/api/backups/${encodeURIComponent(fileName)}/restore`, { method: "POST", body: { dryRun: true } });
        $(".backup-validation", $("#modal-body")).textContent = "備份驗證通過";
      } catch (error) { modalError(error.message); }
      finally { setBusy(button, false); }
    });
    $("[data-backup-apply]", $("#modal-body")).addEventListener("click", async (restoreEvent) => {
      const button = restoreEvent.currentTarget;
      setBusy(button, true, "還原中…");
      try {
        await api(`/api/backups/${encodeURIComponent(fileName)}/restore`, { method: "POST", body: { dryRun: false } });
        closeModal();
        await loadApplication();
        showToast("備份已還原");
      } catch (error) { modalError(error.message); setBusy(button, false); }
    });
    return;
  }
  const deletion = event.target.closest("[data-backup-delete]");
  if (deletion) {
    const fileName = deletion.dataset.backupDelete;
    openConfirm({
      title: "刪除備份",
      description: `<p>確定要永久刪除 <strong>${escapeHtml(fileName)}</strong>？此操作無法復原。</p>`,
      onConfirm: async () => {
        await api(`/api/backups/${encodeURIComponent(fileName)}`, { method: "DELETE" });
        state.backups = state.backups.filter((backup) => backup.fileName !== fileName);
        renderBackups();
        showToast("備份已刪除");
      },
    });
  }
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const button = $("#theme-toggle");
  button.setAttribute("aria-pressed", String(theme === "dark"));
  button.setAttribute("aria-label", `切換主題，目前為${theme === "dark" ? "深色" : "淺色"}`);
  button.title = `切換為${theme === "dark" ? "淺色" : "深色"}主題`;
}

$("#theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  localStorage.setItem("s12-theme", next);
});

$("#logout").addEventListener("click", async () => {
  const button = $("#logout");
  setBusy(button, true, "登出中…");
  try {
    await api("/api/logout", { method: "POST" });
    state.csrf = null;
    showAuth(true);
    showToast("已安全登出");
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(button, false); }
});

const savedTheme = localStorage.getItem("s12-theme");
applyTheme(savedTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
boot().catch((error) => { $("#loading").innerHTML = `<strong>無法載入控制台</strong><span>${escapeHtml(error.message)}</span>`; });
