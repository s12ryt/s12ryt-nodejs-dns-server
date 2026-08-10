"use strict";

const $ = (selector) => document.querySelector(selector);
const state = { csrf: null, config: null, status: null, tunnel: null, events: [] };
const titles = { overview: "系統總覽", records: "DNS 記錄", routes: "代理路由", tunnel: "Cloudflare Tunnel", events: "事件日誌" };
const serviceNames = { dns: "DNS", doh: "DoH", proxy: "Proxy", admin: "Admin" };
const eventKinds = { auth: "驗證", config: "設定", dns: "DNS", proxy: "代理", tunnel: "Tunnel", "tunnel-error": "Tunnel" };
const eventMessages = {
  "Administrator configured": "管理員設定完成",
  "Administrator signed in": "管理員已登入",
  "Configuration updated": "設定已更新",
  "Stored Tunnel token updated": "Tunnel Token 已更新",
  "Stored Tunnel token cleared": "Tunnel Token 已清除",
  "Tunnel started": "Tunnel 已啟動",
  "Tunnel stopped": "Tunnel 已停止",
  "Tunnel started automatically": "Tunnel 已自動啟動",
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
  } else {
    button.textContent = busy ? busyLabel : button.dataset.idleLabel;
  }
}

function showToast(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.setAttribute("role", error ? "alert" : "status");
  toast.hidden = false;
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
  const upstreamText = unhealthy > 0 ? `${unhealthy} 個上游需要注意` : checked === 0 ? "上游等待首次查詢" : "已檢查的上游運作正常";
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
    const details = item.latencyMs === null ? "等待首次查詢" : `${item.latencyMs} ms${item.lastError ? ` · ${item.lastError}` : ""}`;
    return `<article class="list-row"><span class="state-label ${item.healthy === false ? "danger" : item.healthy === true ? "success" : "muted-state"}"><span class="dot ${item.healthy === false ? "danger" : item.healthy === true ? "online" : ""}" aria-hidden="true"></span>${status}</span><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(details)}</small></div></article>`;
  }).join("") : empty("尚未設定上游解析器。");
  $("#recent-events").innerHTML = eventRows(state.events.slice(-5));
}

function renderRecords() {
  const records = state.config.records;
  const enabled = records.filter((record) => record.enabled !== false).length;
  $("#records-summary").textContent = `${records.length} 筆 · ${enabled} 啟用`;
  $("#records-list").innerHTML = records.length ? records.map((record) => `<article class="data-row"><div class="record-type">${escapeHtml(record.type)}</div><div class="grow"><strong>${escapeHtml(record.name)}</strong><small>${escapeHtml(record.value)}</small></div><div class="data-meta"><span>TTL ${escapeHtml(record.ttl)}</span><span class="state-chip ${record.enabled === false ? "inactive" : "active"}">${record.enabled === false ? "已停用" : "已啟用"}</span></div></article>`).join("") : empty("新增第一筆自訂 DNS 記錄。");
}

function renderRoutes() {
  const routes = state.config.routes;
  const enabled = routes.filter((route) => route.enabled !== false).length;
  $("#routes-summary").textContent = `${routes.length} 條 · ${enabled} 啟用`;
  $("#routes-list").innerHTML = routes.length ? routes.map((route) => `<article class="data-row"><div class="record-type route">HTTP</div><div class="grow"><strong>${escapeHtml(route.host)}</strong><small>${escapeHtml(route.target || `${route.scheme}://${route.dnsName}:${route.port}`)}</small></div><div class="data-meta"><span class="state-chip ${route.enabled === false ? "inactive" : "active"}">${route.enabled === false ? "已停用" : "已啟用"}</span></div></article>`).join("") : empty("新增第一條明確的 Host 路由。");
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

function setView(viewName, { focus = true } = {}) {
  document.querySelectorAll(".nav-button").forEach((button) => {
    const active = button.dataset.view === viewName;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.querySelectorAll(".view").forEach((view) => { view.hidden = view.id !== `view-${viewName}`; });
  $("#page-title").textContent = titles[viewName];
  document.title = `${titles[viewName]} · S12 DNS Server`;
  if (focus) $("#main-content").focus();
}

async function loadApplication() {
  const [config, status, tunnel, events] = await Promise.all([api("/api/config"), api("/api/status"), api("/api/tunnel"), api("/api/events")]);
  Object.assign(state, { config, status, tunnel, events });
  renderOverview();
  renderRecords();
  renderRoutes();
  renderTunnel();
  renderEvents();
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
  $("#setup-token").required = !configured;
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

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("#auth-error");
  const button = $("#auth-submit");
  error.hidden = true;
  setBusy(button, true, event.currentTarget.dataset.mode === "setup" ? "正在建立…" : "登入中…");
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
    setBusy(button, false);
  }
});

document.querySelectorAll(".nav-button").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));

function openDialog(dialog, focusTarget) {
  const error = dialog.querySelector(".dialog-error");
  error.hidden = true;
  dialog.showModal();
  requestAnimationFrame(() => dialog.querySelector(focusTarget)?.focus());
}

$("#add-record").addEventListener("click", () => openDialog($("#record-dialog"), "[name='name']"));
$("#add-route").addEventListener("click", () => openDialog($("#route-dialog"), "[name='host']"));

function updateRecordHint() {
  const [placeholder, help] = recordHints[$("#record-type").value];
  $("#record-value").placeholder = placeholder;
  $("#record-value-help").textContent = help;
}

$("#record-type").addEventListener("change", updateRecordHint);

$("#record-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return $("#record-dialog").close();
  const form = event.currentTarget;
  const button = event.submitter;
  const error = form.querySelector(".dialog-error");
  const data = Object.fromEntries(new FormData(form));
  const next = structuredClone(state.config);
  next.records.push({ name: data.name, type: data.type, value: data.value, ttl: Number(data.ttl), enabled: true });
  error.hidden = true;
  form.setAttribute("aria-busy", "true");
  setBusy(button, true, "儲存中…");
  try {
    state.config = await api("/api/config", { method: "PUT", body: next });
    renderRecords();
    renderOverview();
    form.reset();
    updateRecordHint();
    $("#record-dialog").close();
    showToast("DNS 記錄已儲存");
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  } finally {
    form.removeAttribute("aria-busy");
    setBusy(button, false);
  }
});

$("#route-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return $("#route-dialog").close();
  const form = event.currentTarget;
  const button = event.submitter;
  const error = form.querySelector(".dialog-error");
  const data = Object.fromEntries(new FormData(form));
  const next = structuredClone(state.config);
  next.routes.push({ host: data.host, target: data.target, enabled: true });
  error.hidden = true;
  form.setAttribute("aria-busy", "true");
  setBusy(button, true, "儲存中…");
  try {
    state.config = await api("/api/config", { method: "PUT", body: next });
    renderRoutes();
    renderOverview();
    form.reset();
    $("#route-dialog").close();
    showToast("代理路由已儲存");
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  } finally {
    form.removeAttribute("aria-busy");
    setBusy(button, false);
  }
});

async function tunnelAction(action) {
  const button = action === "start" ? $("#tunnel-start") : $("#tunnel-stop");
  setBusy(button, true, action === "start" ? "啟動中…" : "停止中…");
  try {
    state.tunnel = await api(`/api/tunnel/${action}`, { method: "POST" });
    showToast(action === "start" ? "Tunnel 已啟動" : "Tunnel 已停止");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(button, false);
    renderTunnel();
    renderOverview();
  }
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
  form.setAttribute("aria-busy", "true");
  setBusy(button, true, "套用中…");
  try {
    state.tunnel = await api("/api/tunnel/token", { method: "PUT", body: { token } });
    form.reset();
    renderTunnel();
    renderOverview();
    showToast(state.tunnel.tokenSource === "environment" ? "備援 Token 已儲存" : "Tunnel Token 已套用");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    form.removeAttribute("aria-busy");
    setBusy(button, false);
  }
});

$("#tunnel-token-clear").addEventListener("click", async () => {
  if (!state.tunnel.hasStoredToken || !confirm("確定清除已儲存的 Tunnel Token？")) return;
  const button = $("#tunnel-token-clear");
  setBusy(button, true, "清除中…");
  try {
    state.tunnel = await api("/api/tunnel/token", { method: "DELETE" });
    $("#tunnel-token-form").reset();
    showToast("已清除儲存的 Tunnel Token");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(button, false);
    renderTunnel();
    renderOverview();
  }
});

$("#refresh-events").addEventListener("click", async () => {
  const button = $("#refresh-events");
  setBusy(button, true, "更新中…");
  try {
    state.events = await api("/api/events");
    renderEvents();
    renderOverview();
    showToast("事件已更新");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(button, false);
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
  const current = document.documentElement.dataset.theme;
  const next = current === "dark" ? "light" : "dark";
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
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(button, false);
  }
});

const savedTheme = localStorage.getItem("s12-theme");
applyTheme(savedTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
updateRecordHint();
boot().catch((error) => { $("#loading").innerHTML = `<strong>無法載入控制台</strong><span>${escapeHtml(error.message)}</span>`; });
