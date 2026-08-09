"use strict";

const $ = (selector) => document.querySelector(selector);
const state = { csrf: null, config: null, status: null, tunnel: null, events: [] };
const titles = { overview: "系統總覽", records: "DNS 記錄", routes: "代理路由", tunnel: "Cloudflare Tunnel", events: "事件日誌" };

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

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

function showToast(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3000);
}

function empty(message) {
  return `<div class="empty-state"><strong>目前沒有資料</strong><span>${escapeHtml(message)}</span></div>`;
}

function serviceCard(name, address) {
  const online = Boolean(address);
  const endpoint = online ? `${address.host}:${address.port}` : "未啟動";
  return `<article class="metric"><div class="metric-top"><span>${escapeHtml(name)}</span><span class="dot ${online ? "online" : ""}"></span></div><strong>${escapeHtml(endpoint)}</strong><small>${online ? "Listening" : "Offline"}</small></article>`;
}

function eventRows(events) {
  if (!events.length) return empty("服務事件會顯示在這裡。");
  return [...events].reverse().map((event) => `<article class="list-row"><span class="event-kind">${escapeHtml(event.kind)}</span><div><strong>${escapeHtml(event.message || event.name || "Service event")}</strong><small>${escapeHtml(event.timestamp || "")}</small></div></article>`).join("");
}

function renderOverview() {
  $("#service-grid").innerHTML = Object.entries(state.status.services).map(([name, address]) => serviceCard(name.toUpperCase(), address)).join("");
  const upstreams = state.status.upstreams || [];
  $("#upstream-list").innerHTML = upstreams.length ? upstreams.map((item) => `<article class="list-row"><span class="dot ${item.healthy === false ? "danger" : "online"}"></span><div><strong>${escapeHtml(item.name)}</strong><small>${item.latencyMs === null ? "等待首次查詢" : `${item.latencyMs} ms`}${item.lastError ? ` · ${escapeHtml(item.lastError)}` : ""}</small></div></article>`).join("") : empty("尚未設定上游解析器。");
  $("#recent-events").innerHTML = eventRows(state.events.slice(-5));
}

function renderRecords() {
  $("#records-list").innerHTML = state.config.records.length ? state.config.records.map((record) => `<article class="data-row"><div class="record-type">${escapeHtml(record.type)}</div><div class="grow"><strong>${escapeHtml(record.name)}</strong><small>${escapeHtml(record.value)}</small></div><div class="data-meta"><span>TTL ${escapeHtml(record.ttl)}</span><span>${record.enabled === false ? "停用" : "啟用"}</span></div></article>`).join("") : empty("新增第一筆自訂 DNS 記錄。");
}

function renderRoutes() {
  $("#routes-list").innerHTML = state.config.routes.length ? state.config.routes.map((route) => `<article class="data-row"><div class="record-type route">HTTP</div><div class="grow"><strong>${escapeHtml(route.host)}</strong><small>${escapeHtml(route.target || `${route.scheme}://${route.dnsName}:${route.port}`)}</small></div><div class="data-meta"><span>${route.enabled === false ? "停用" : "啟用"}</span></div></article>`).join("") : empty("新增第一條明確的 Host 路由。");
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
  $("#tunnel-version").textContent = tunnel.available ? (tunnel.version || "等待下載 cloudflared") : "";
  $("#tunnel-token-source").textContent = tunnelSourceLabel(tunnel.tokenSource);
  $("#tunnel-token-note").textContent = tunnel.tokenSource === "environment"
    ? (tunnel.hasStoredToken ? "設定檔備援已儲存" : "沒有設定檔備援")
    : (tunnel.hasStoredToken ? "設定檔 Token 使用中" : "");
  $("#tunnel-logs").textContent = tunnel.logs?.join("\n") || tunnel.lastError || "尚無輸出";
  $("#tunnel-indicator").className = `large-indicator ${tunnel.state === "running" ? "online" : tunnel.state === "error" ? "danger" : ""}`;
  $("#tunnel-start").disabled = !tunnel.available || ["running", "starting"].includes(tunnel.state);
  $("#tunnel-stop").disabled = !["running", "starting"].includes(tunnel.state);
  $("#tunnel-token-clear").disabled = !tunnel.hasStoredToken;
}

function renderEvents() {
  $("#events-list").innerHTML = eventRows(state.events);
}

async function loadApplication() {
  const [config, status, tunnel, events] = await Promise.all([api("/api/config"), api("/api/status"), api("/api/tunnel"), api("/api/events")]);
  Object.assign(state, { config, status, tunnel, events });
  renderOverview();
  renderRecords();
  renderRoutes();
  renderTunnel();
  renderEvents();
  $("#loading").hidden = true;
  $("#auth-view").hidden = true;
  $("#app-view").hidden = false;
}

function showAuth(configured) {
  $("#loading").hidden = true;
  $("#app-view").hidden = true;
  $("#auth-view").hidden = false;
  $("#auth-title").textContent = configured ? "登入管理介面" : "設定管理員";
  $("#auth-copy").textContent = configured ? "使用管理員密碼繼續。" : "輸入終端顯示的 10 分鐘一次性 Token。";
  $("#token-field").hidden = configured;
  $("#setup-token").required = !configured;
  $("#password-label").textContent = configured ? "密碼" : "新密碼";
  $("#password").autocomplete = configured ? "current-password" : "new-password";
  $("#auth-submit").textContent = configured ? "登入" : "建立管理員";
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

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("#auth-error");
  const button = $("#auth-submit");
  error.hidden = true;
  button.disabled = true;
  try {
    const setup = event.currentTarget.dataset.mode === "setup";
    const result = await api(setup ? "/api/setup" : "/api/login", {
      method: "POST",
      body: setup ? { token: $("#setup-token").value, password: $("#password").value } : { username: "admin", password: $("#password").value },
    });
    state.csrf = result.csrf;
    await loadApplication();
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});

document.querySelectorAll(".nav-button").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".nav-button").forEach((item) => item.classList.toggle("active", item === button));
  document.querySelectorAll(".view").forEach((view) => { view.hidden = view.id !== `view-${button.dataset.view}`; });
  $("#page-title").textContent = titles[button.dataset.view];
  $("#main-content").focus();
}));

$("#add-record").addEventListener("click", () => $("#record-dialog").showModal());
$("#add-route").addEventListener("click", () => $("#route-dialog").showModal());

$("#record-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return $("#record-dialog").close();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const next = structuredClone(state.config);
  next.records.push({ name: data.name, type: data.type, value: data.value, ttl: Number(data.ttl), enabled: true });
  try {
    state.config = await api("/api/config", { method: "PUT", body: next });
    renderRecords();
    form.reset();
    $("#record-dialog").close();
    showToast("DNS 記錄已儲存");
  } catch (error) {
    const target = form.querySelector(".dialog-error");
    target.textContent = error.message;
    target.hidden = false;
  }
});

$("#route-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return $("#route-dialog").close();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const next = structuredClone(state.config);
  next.routes.push({ host: data.host, target: data.target, enabled: true });
  try {
    state.config = await api("/api/config", { method: "PUT", body: next });
    renderRoutes();
    form.reset();
    $("#route-dialog").close();
    showToast("代理路由已儲存");
  } catch (error) {
    const target = form.querySelector(".dialog-error");
    target.textContent = error.message;
    target.hidden = false;
  }
});

async function tunnelAction(action) {
  try {
    state.tunnel = await api(`/api/tunnel/${action}`, { method: "POST" });
    renderTunnel();
    showToast(action === "start" ? "Tunnel 已啟動" : "Tunnel 已停止");
  } catch (error) { showToast(error.message, true); }
}

$("#tunnel-start").addEventListener("click", () => tunnelAction("start"));
$("#tunnel-stop").addEventListener("click", () => tunnelAction("stop"));
$("#tunnel-token-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const token = $("#tunnel-token").value;
  if (token.length === 0) {
    showToast("Token 未變更");
    return;
  }
  const button = $("#tunnel-token-save");
  button.disabled = true;
  try {
    state.tunnel = await api("/api/tunnel/token", { method: "PUT", body: { token } });
    form.reset();
    renderTunnel();
    showToast(state.tunnel.tokenSource === "environment" ? "備援 Token 已儲存" : "Tunnel Token 已套用");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});
$("#tunnel-token-clear").addEventListener("click", async () => {
  if (!state.tunnel.hasStoredToken || !confirm("確定清除已儲存的 Tunnel Token？")) return;
  const button = $("#tunnel-token-clear");
  button.disabled = true;
  try {
    state.tunnel = await api("/api/tunnel/token", { method: "DELETE" });
    $("#tunnel-token-form").reset();
    renderTunnel();
    showToast("已清除儲存的 Tunnel Token");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = !state.tunnel.hasStoredToken;
  }
});
$("#refresh-events").addEventListener("click", async () => { state.events = await api("/api/events"); renderEvents(); });
$("#theme-toggle").addEventListener("click", () => {
  const current = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("s12-theme", next);
});
$("#logout").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }); state.csrf = null; showAuth(true); });

const savedTheme = localStorage.getItem("s12-theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
boot().catch((error) => { $("#loading").innerHTML = `<strong>無法載入控制台</strong><span>${escapeHtml(error.message)}</span>`; });
