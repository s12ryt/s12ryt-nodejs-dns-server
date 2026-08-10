# 已確認需求與驗收契約

更新日期：2026-08-10

## 產品目標

- 從零建立可自架的 Node.js DNS 服務，產品名稱暫以 `S12 DNS Server` 顯示。
- 完整核心包含 UDP/TCP DNS、DNS-over-HTTPS、自訂域名解析、多上游容錯、類 Nginx 反向代理、Cloudflare Tunnel 管理，以及精美管理介面。
- 部署端只保留 `index.js` 也能啟動：連網時從本專案 GitHub Release 下載完整 runtime，完成 SHA-256 校驗及原子快取後執行；網路不可達時沿用最後有效快取，沒有快取時啟動內嵌的最小 DNS/DoH 核心。

## 平台與預設服務

- 支援 Node.js 20+，目標平台為 Windows、Linux、macOS。
- 預設埠皆可由設定覆寫：DNS UDP/TCP `5354`、DoH `8053`、HTTP 反向代理 `8080`、管理 UI/API `8081`。
- 管理 UI 預設監聽區網位址；其他服務監聽位址亦須可設定。
- 公開 DoH 的 TLS 由 Cloudflare Tunnel 終止，本機首版不管理 HTTPS 憑證。

## DNS 與 DoH

- 自訂記錄支援 `A`、`AAAA`、`CNAME`、`MX`、`TXT`、`NS`、`SRV`、TTL、精確名稱與 `*.example.com` 萬用名稱。
- 自訂記錄優先於上游；未命中時依序轉送至 Cloudflare DoH 與 Google DoH。
- 只有逾時、HTTP 5xx、網路錯誤或無效 DNS 訊息才切換下一個上游；狀態需顯示延遲及最近錯誤。
- 上游成功回應採有界 TTL 快取，具最大項目數及 TTL 上下限；錯誤回應不快取。
- DoH endpoint 為 `/dns-query`，支援 RFC 8484 GET `dns=` 與 POST `application/dns-message`。
- UDP/TCP DNS 支援標準查詢與 EDNS 相容轉送。DNSSEC 資料可透傳，但不在本機驗證簽章。

## 反向代理

- 依 HTTP `Host` 選擇路由。
- 路由可指定完整 `http://` 或 `https://` target URL，也可指定 scheme/port 並從自訂 `A`/`AAAA` 記錄取得目標位址。
- 沒有代理路由時，不因存在 DNS 記錄而自動公開服務。
- 支援一般 HTTP、HTTPS 上游、WebSocket、標準轉送標頭、逾時、停用路由及代理迴圈防護。

## 管理安全與資料

- 固定單一管理帳號 `admin`。
- 首次啟動時在終端顯示 10 分鐘有效的一次性 setup token；必須提供該 token 才能建立管理密碼，使用後立即失效。
- 密碼至少 12 字元，以 PBKDF2 雜湊保存。
- 登入採 HttpOnly、SameSite session cookie，具 CSRF 防護、每來源登入速率限制及 8 小時閒置到期。
- 管理介面可即時編輯 DNS 記錄、代理路由與一般設定；更新需驗證、原子寫入 `data/config.json` 並立即生效。
- 管理員雜湊及 cloudflared/runtime 快取保存於本機 `data` 目錄。
- 即時日誌只在記憶體保留最近 500 筆，不將 DNS 查詢內容永久寫檔。

## 管理 UI

- 必須包含：總覽與服務健康、上游狀態、DNS 記錄編輯、代理路由編輯、Tunnel 下載與控制、即時查詢日誌。
- 桌面與手機均可使用，支援系統深淺色及手動切換。
- UI 必須有完整載入、空白、錯誤、成功及停用狀態，鍵盤可操作且具清楚焦點。

## Cloudflare Tunnel

- Cloudflare Tunnel token 可保存於 `data/config.json` 的 `tunnel.token`；預設為空字串，非空設定接受任何字串內容。
- `CLOUDFLARE_TUNNEL_TOKEN` 的優先級高於 `tunnel.token`。環境變數存在時，config token 僅作備援；UI 可更新或清除備援值，但目前連線不切換或重啟。
- 管理 API 與 UI 永不回傳已儲存或環境變數 token 的明文，只顯示是否已設定及目前來源。UI 的空白 token 輸入代表保留既有值，並提供需確認的獨立清除操作。
- 沒有環境 token 時，UI 更新 config token 必須立即套用：若 Tunnel 正在運行，先停止再以新 token 啟動。新 token 啟動失敗時，原子回滾舊 config token，並嘗試恢復舊 Tunnel；失敗不得中斷 DNS/DoH/代理/管理核心。
- 沒有環境 token 時，清除 config token 必須停止正在運行的 Tunnel，將狀態改為不可使用，並原子保存空字串。
- 有 token 時隨完整服務自動下載、校驗並啟動官方 `cloudflared`；失敗不得阻止 DNS/DoH/代理/管理核心服務啟動。
- UI 可檢視下載進度、版本、狀態、最近日誌，並手動啟動或停止。
- 自動化驗收使用模擬 cloudflared 程序，不要求本次提供真實 Cloudflare token 或公開 hostname。

## 單檔啟動與發布

- GitHub 目標為公開倉庫 `s12ryt/s12ryt-nodejs-dns-server`，授權採 `AGPL-3.0-or-later`。
- `index.js` 的預設 manifest 指向該倉庫最新 Release；允許以 `APP_MANIFEST_URL` 覆寫。
- manifest 與 runtime 必須走 HTTPS、包含版本及 SHA-256；下載路徑需防目錄穿越，檔案需原子寫入。
- 開發目錄存在本機完整 runtime 時可直接使用；只有 `index.js` 時則走下載、最後有效快取、離線核心的降級順序。
- 專案需提供可重現的 runtime bundle 與 manifest 產生指令。

## 明確不在首版範圍

- DNSSEC 本機驗證。
- AXFR/IXFR zone transfer。
- RFC 2136 動態 DNS 更新。
- 本機 TLS 憑證申請或終止。
- 多使用者、角色或權限系統。
- 永久查詢日誌與長期統計資料庫。

## 驗收標準

- 使用 Node.js 內建 test runner 完成單元及整合測試，涵蓋 DNS 封包、自訂記錄、TTL 快取、多上游容錯、UDP/TCP、DoH、代理、驗證、設定、bootstrap 與 Tunnel 管理。
- Tunnel token 測試必須涵蓋 config 持久化、環境變數優先、API 不洩漏、UI 儲存/清除、即時重啟、失敗回滾及核心服務不中斷。
- 新行為先有因缺少該行為而失敗的 RED 測試，再以最小實作達成 GREEN。
- 使用 Playwright 驗證首次設密、登入、DNS/代理編輯、Tunnel 狀態、主題切換及手機/桌面響應式畫面，並檢查無明顯重疊或水平溢位。
- 執行完整測試、lint、build、Release bundle/manifest 校驗及僅保留 `index.js` 的下載啟動測試。
- 建立 Git 歷史、推送公開 GitHub 倉庫並建立可供 `index.js` 下載的 Release。

## 2026-08-10：管理介面自主 UX 疊代

- 維持所有既有功能、管理 API、單檔 runtime、發布與資料契約，不新增產品功能。
- 保留原生 HTML、CSS、JavaScript 實作，不加入新的 runtime 或前端框架依賴。
- 採中度介面重整，保留既有主要資訊架構；可調整版面、視覺層級、元件、文案及互動細節。
- 優先改善完整操作流程與總覽監控，包括資訊掃描效率、表單操作、狀態回饋、手機操作及鍵盤可用性。
- 自主疊代需先以既有測試建立行為基線；高風險而未受保護的 UX 行為先補 characterization 或回歸測試。
- 驗收需包含既有 E2E 全數通過、針對 UX 改善新增回歸測試，以及 375、768、1024、1440 px 寬度的無水平溢位檢查。
- 深色與淺色模式皆需檢查可讀性、焦點狀態、載入/空白/錯誤/成功/停用狀態，並產出桌面與手機截圖供人工審查。
