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

## 2026-08-10：DNS 管理與解析可靠性修復

- DNS 記錄介面必須提供完整單筆 CRUD。每列右側使用具 tooltip 與可存取名稱的明確編輯、刪除圖示按鈕。
- 編輯時允許修改名稱、類型、值、TTL 與啟用狀態；儲存後原子更新 `data/config.json`、立即熱更新解析器，重新載入後仍須保留。
- 刪除前顯示應用程式自建確認 modal，清楚列出名稱、類型與值；確認後立即原子保存並生效。
- 管理介面不得呼叫瀏覽器原生 `alert()`、`confirm()` 或 `prompt()`，也不得依賴原生 `<dialog>` UI 或瀏覽器驗證泡泡。記錄、路由、Tunnel 清除與後續確認流程統一使用自建 modal、自訂繁中驗證、焦點鎖定、Esc 關閉及關閉後焦點歸還。
- 自訂 CNAME 回應 A 或 AAAA 查詢時，解析器必須繼續追查目標，回傳 CNAME 鏈及最終位址答案；目標可來自其他自訂記錄或既有 DoH 上游。
- CNAME 追查必須具循環與最大深度防護；錯誤不得造成程序崩潰，並保留既有上游 failover、快取及核心服務不中斷契約。
- Cloudflare 與 Google 上游在核心啟動後立即進行一次非阻塞健康查詢，之後每 5 分鐘重新檢查；顯示延遲與最近錯誤，探測失敗不得延遲或阻止服務啟動。
- 管理介面新增 DNS 診斷操作，支援 A、AAAA、CNAME、MX、TXT、NS、SRV；輸入名稱與類型後顯示 rcode、命中來源及完整答案鏈，不修改設定。
- 目前問題環境為 Windows 11 系統 DoH，使用公共可解析的完整 `https://<host>/dns-query`，Cloudflare Tunnel ingress 指向本機 DoH `8053`；直接開啟 endpoint 可取得預期 HTTP 400。修復需能區分 Windows 用戶端設定與 S12 解析結果。
- Web 動畫採純 CSS 與 Web Animations API，不新增前端 runtime 依賴。加入頁面切換、modal 開關、列表 CRUD、toast、健康狀態及 loading 的克制微動畫，時長約 140–240ms。
- 啟用 `prefers-reduced-motion` 時停用非必要位移、縮放與持續動畫，狀態變更仍須即時且不影響操作。
- 驗收須以 Playwright 完成新增、編輯、停用、刪除、重新載入持久化、自建 modal、Tunnel 清除、鍵盤焦點、動畫與 reduced-motion 回歸；並執行完整 test、lint、audit、build、多尺寸與深淺色視覺審查。
- 完成後版本升至 `0.1.3`，建立原子提交、推送 `main`、發布 GitHub Release，驗證 CI 及只有 Release `index.js` 的冷啟動。

## 2026-08-10：自訂網域工作區與 Nginx 式反向代理

- 新增持久化的自訂網域工作區。網域保存名稱、啟用狀態、預設 TTL 與備註；底層 DNS `records` 與代理 `routes` 維持可相容的設定契約，舊設定必須自動遷移且不得遺失。
- DNS 主導覽整合為「DNS 與網域」。網域詳情集中管理所屬 DNS 記錄、代理站台與 DNS 診斷，並保留全部及未分組記錄的管理入口。
- 既有記錄與代理依名稱的最長網域後綴自動歸類，允許建立更具體的子網域工作區。網域內可輸入 `@`、相對名稱或完整 FQDN，介面須顯示正規化後的完整名稱，並拒絕不屬於目前工作區的名稱。
- 新增網域可選空白工作區或網站範本。網站範本分別收集對外 A/AAAA 位址、是否建立 `www` CNAME，以及內部 upstream URL；提交前預覽將建立的 DNS 記錄與代理設定。
- 停用父網域時，其所有子網域、所屬 DNS 記錄及代理站台均停止提供服務，重新啟用後保留各子項原有啟用狀態。刪除父網域時，自建確認 modal 必須列出受影響範圍，確認後原子刪除整棵子網域、記錄與代理。
- 網域重新命名時，原子改寫該網域、所有子網域工作區、所屬 DNS 名稱及代理 Host/別名的舊後綴；任何重複名稱或目標衝突都必須使整次更新失敗且不留下部分變更。
- 本次只管理 S12 本機的網域、DNS、代理與診斷，不串接 Cloudflare DNS、註冊商 API，不代為修改 NS，也不保存外部 DNS 供應商憑證。
- 反向代理改為完整站台 CRUD：新增、編輯、複製、停用與刪除，並管理主要 Host、精確別名、`*.example.com` 萬用別名、locations、多上游、headers、rewrite/redirect、存取限制、磁碟快取與壓縮。不得提供會接收所有未匹配 Host 的 default server。
- 舊版單一 route 自動遷移為該 Host 的 `/` 最長前綴 location，原有 target、DNS 派生目標、停用狀態及 timeout 行為必須保持相容。
- Location 使用可預測優先序：精確路徑優先，其次最長前綴；不支援 regex 或任意腳本。每個 location 為 proxy 或 redirect，rewrite 僅支援 strip prefix／replace prefix，redirect 僅支援 `301`、`302`、`307`、`308`。
- Request/response header 可新增、覆寫或移除；值可使用靜態字串及經白名單驗證的 `host`、`clientIp`、`scheme`、`requestId` 等安全變數，不執行任意表達式。
- 多上游採健康節點等權 round-robin。連線錯誤、逾時及 `502`、`503`、`504` 觸發被動暫停；GET、HEAD、OPTIONS 可依序重試其餘上游，POST、PUT、PATCH、DELETE 僅能在尚未送出 request body 時重試，避免重複寫入。
- 每個 location 可設定 request body 上限、IP allow/deny 與記憶體 rate limit。真實來源 IP 只有在直接連線來源符合全域 `trustedProxyCidrs` 時才採用 `X-Forwarded-For`，否則使用 socket IP。
- 保守預設為 request body 上限 10 MiB、rate limit 關閉、`trustedProxyCidrs` 僅 `127.0.0.1/32` 與 `::1/128`；所有值可由管理 UI 修改並經嚴格驗證。
- 磁碟代理快取預設關閉，位置為 `data/proxy-cache`，全域硬上限預設 1 GiB。啟用時只安全快取 GET/HEAD，遵循 `Cache-Control` 與 `Vary`，略過 Authorization、Cookie、Set-Cookie、private、no-store，採原子寫入及 LRU 淘汰；UI 顯示用量並可清除單一站台或全部快取。
- 壓縮預設對大於等於 1 KiB、可壓縮且上游尚未編碼的內容啟用 gzip/brotli；必須依用戶端 `Accept-Encoding` 協商，不得重複壓縮或破壞 `Content-Length`／`Vary`。
- 本機仍不終止 TLS；公開 HTTPS 繼續由 Cloudflare Tunnel 或其他受信任入口處理。
- 代理站台編輯器使用完全自建的大型分步 modal：桌面寬版置中、手機全螢幕，依序編輯基本主機、locations、上游與改寫、headers／安全／快取、最終預覽；步驟間保留草稿，具自訂繁中驗證、焦點鎖定、Esc 關閉與焦點歸還。
- 網域與代理 CRUD、列表狀態、modal 及步驟切換沿用純 CSS 與 Web Animations API 微動畫，並遵守既有 `prefers-reduced-motion` 契約。
- 驗收必須涵蓋舊設定遷移、網域新增／改名／停用／串聯刪除、相對與 FQDN 記錄、網站範本、代理完整 CRUD、Host/別名/萬用匹配、location 優先序、rewrite/redirect、header、WebSocket、多上游重試安全、IP/限流/body 限制、持久快取／淘汰／清除、壓縮、熱更新、重新載入持久化與多尺寸自建 modal E2E。

## 2026-08-11：依網域選取管理 DNS 記錄

- DNS 配置頁改為 master-detail 流程：桌面使用可點選的網域清單，手機使用同一網域選擇區；必須先選取網域，右側才顯示該網域的 DNS 記錄及新增、編輯、刪除操作。
- 初次進入 DNS 配置頁時不自動選取、不記住上次選取，顯示明確的「請選擇網域」空白狀態；未選取時不得開啟新增記錄流程。
- 選取網域後只顯示依最長網域後綴直接歸屬該工作區的記錄；更具體的子網域工作區記錄只在選取該子網域時顯示，不得於父網域重複出現。
- 移除跨網域的「全部記錄」入口；保留可選取的「未分組記錄」入口，供不屬於任何工作區的既有記錄完整新增、編輯及刪除。
- 正式網域下新增記錄時自動以目前網域為上下文，接受 `@`、相對名稱及該網域內 FQDN，並沿用既有完整名稱預覽與越界拒絕；「未分組記錄」新增時要求輸入完整 FQDN。
- 網域重新命名成功後維持選取重新命名後的新網域；刪除目前網域後回到未選取空白狀態，不自動跳至其他網域。
- DNS 診斷在選取正式網域後自動帶入該網域根名稱，但仍允許改成該網域內其他完整名稱；選取「未分組記錄」時不自動填入名稱。
- 保留既有網域 CRUD、自建 modal、自訂繁中驗證、鍵盤焦點、微動畫、深淺色及 reduced-motion 契約，不新增前端 runtime 依賴。
- 驗收必須以 Playwright 覆蓋初始空白、網域選取、父子網域直接歸屬、未分組入口、選取後的記錄新增／編輯／刪除與重新載入持久化、重新命名續選、刪除回空白、診斷預填，以及 375、768、1024、1440 px 無水平溢位；另執行完整 test、lint、audit、build 與深淺色視覺審查。
- 完成後建立原子提交、推送 `main`，發布下一個 patch 版本並驗證 GitHub CI、Release 資產及只有 Release `index.js` 的冷啟動。

## 2026-08-11：公開 DoH 瀏覽器 CORS 與 CNAME 熱更新

- 公開 `/dns-query` 必須允許任何網頁來源以瀏覽器 JavaScript 執行無憑證 DoH 查詢，回傳 `Access-Control-Allow-Origin: *`，不得啟用 cookie 或 credential 型跨來源存取。
- DoH endpoint 必須接受 CORS preflight `OPTIONS`，宣告 `GET`、`POST`、`OPTIONS` 及 `Content-Type`、`Accept` request headers；preflight 不得進入 DNS resolver。
- `/dns-query` 的成功與錯誤回應均須帶一致 CORS 標頭，讓瀏覽器可讀取 HTTP 400、405、415 等協定錯誤，而不是只得到 `Failed to fetch`。
- 完整 runtime 與只有 `index.js` 時的內嵌 fallback DoH 必須維持一致 CORS 行為；非 `/dns-query` 路徑不得因此成為跨來源 API。
- `16516565.tw` 工作區中的實際自訂記錄是 `awa.16516565.tw CNAME chatgpt.com`；驗收查詢名稱必須使用 `awa.16516565.tw`。未建立根記錄時，查詢 `16516565.tw` 得到 NXDOMAIN 屬預期行為，不得自動猜測或改寫查詢名稱。
- 新增或修改已啟用 CNAME 後，ConfigStore 原子保存與 runtime hot reload 必須讓 resolver／DoH 立即命中，不需要重新啟動程序；重新載入設定後仍須保留。
- RED 測試須先證明目前 `OPTIONS` 回 405、缺少 CORS response headers，以及瀏覽器跨來源 fetch 失敗；GREEN 後以整合測試與 Playwright 真實跨來源 fetch 驗證。
- 完成後執行完整 test、E2E、lint、audit、LSP、build，建立原子提交並推送 `main`，發布 `v0.1.5`，驗證 GitHub CI、Release 資產與只有 Release `index.js` 的冷啟動。
