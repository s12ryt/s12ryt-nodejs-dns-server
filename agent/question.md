# 已確認需求與驗收契約

更新日期：2026-08-10

## 2026-08-13：formal benchmark 固定牆鐘排程

- Linux glibc x64 候選 `ca4392b70ad86da07a76d582e639173e7ac09525` 已完整執行 24 小時 formal soak，但只完成 66,525 個一秒區間；DNS 與 proxy 吞吐均為目標約 84.7%，因此 `passed:false`，不得發布或與其他執行拼接。
- 根因是負載工具等待每一區間所有請求（包含少數 timeout）完成後才啟動下一區間，使慢請求拖掉後續固定發送區間，而非核心服務中斷或維運失敗。
- 已確認 formal benchmark 採固定牆鐘排程：每秒準時啟動新區間，允許前一區間的慢請求尾端短暫重疊；24 小時發送窗口結束後，必須等待所有已啟動請求與健康／維運檢查收尾。
- 固定資料量、DNS 5,000 QPS、proxy 1,000 RPS、24 小時、錯誤率、核心中斷與維運門檻均不變；修復後須從新候選 SHA 完整重跑，不得沿用失敗報告。
- Linux scale 前置驗證確認 `dnsConcurrency: 512` 在 5,500 QPS 會產生 client-side timeout；1／4／8 socket 的 10 秒診斷矩陣在 concurrency 512 都有錯誤，在 concurrency 128 都完成 55,000 次查詢且 0 error。formal benchmark 固定使用 8 個 UDP client socket 輪詢分片與總 concurrency 128，避免負載產生器自身的突發接收佇列成為瓶頸。總 QPS、2 秒 timeout、DNS 錯誤率上限 0.1% 與服務端行為均不得降低或忽略。
- 候選 `449e69f00225094a25f63935037385a84cf61cf8` 的 CI 證明固定 tick 已完整發送，但快速收尾時報告可能在 30 秒窗口前 2ms 結束，違反既有 duration 契約。已確認採「完整窗口並等待批次」：最後一個 tick 啟動後仍須等到 `startedAt + durationMs`，並同時等待所有已啟動批次；最終報告時間取兩者較晚，不放寬 duration 門檻。
- 候選 `cd23e4e6c002201e494c875d317f891d623ada61` 的 CI 再次於 29,998ms 結束，證明單次 timer wait 可能提早喚醒。固定 tick 與完整窗口都必須以 monotonic clock 反覆等待至各自 deadline，不能假設一次 timer 已涵蓋完整剩餘時間，也不得以四捨五入或放寬門檻掩蓋。
- 候選 `170e40eea239e77300a2445baba4b472626ab7ce` 的 Linux glibc x64 formal soak 從 `2026-08-13T11:47:01Z` 連續執行約 10 小時 20 分後，以 V8 heap OOM、exit 134 結束且未產生原子報告，因此判定失敗、不得發布或與其他執行拼接。主機當時仍有約 7 GiB 可用記憶體，根因是固定牆鐘排程將每個 tick Promise 永久保留到 24 小時窗口結束。
- 已確認批次生命週期採「只保留未完成批次」：以 in-flight 集合追蹤 tick，Promise 無論成功或失敗 settled 後立即解除參照；發送窗口結束時只等待當下仍未完成的 tick。固定牆鐘、完整窗口、所有已啟動工作收尾、請求數、timeout 與驗收門檻均不變，不以限制 tick、降低負載或提高 heap 取代根因修復。

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

## 2026-08-11：單機正式版 v1.0 路線

- 產品定位為可長期正式運行的單機自架 DNS／DoH／反向代理控制台，不引入多節點一致性或高可用叢集。本次必須依序完成並嚴格發布 `v0.2.0`、`v0.3.0`、`v0.4.0`、`v1.0.0`，每版各自具 migration、完整 CI、Release、單檔冷啟動及 rollback 證據，前一版通過後才進下一版。
- 既有 `config.json`、單檔 `index.js` 與資料必須可遷移；管理 API 可引入版本化 `/api/v2`。v1 API 進入唯讀相容期，不得無提示破壞既有自動化。
- 正式支援平台調整為 Linux glibc x64／arm64；Windows 與 macOS 維持盡力相容，不承諾完整 SQLite、Release native asset 或正式驗收。Docker 使用 Debian-based image，不承諾 Alpine／musl。

### v0.2.0：維運、可觀測與部署底座

- 保留 `config.json` 作可攜設定來源，新增 `better-sqlite3` 保存歷史 metrics、完整操作／查詢／代理日誌索引、設定版本、備份 metadata、告警工作與後續帳號資料；Release 與 bootstrap 必須處理 Linux x64／arm64 native assets、SHA-256、離線 cache 及 rollback。
- 新增完整可攜明文備份，包含設定、SQLite、Tunnel token、帳號與後續 API token 資料，預設不含 proxy cache。備份採 ZIP 封裝並內含 manifest、schema metadata 與逐檔 SHA-256；備份檔是最高敏感資產，UI／文件必須警告並限制權限。伺服器保存於 `data/backups`，管理 UI 可建立、列出、下載、刪除，並可從既有備份或上傳外部 ZIP 還原。外部上傳 API 採 `application/zip` 原始 body，檔名由 `X-Backup-Filename` 傳入，必須以有界串流寫入暫存檔後驗證；備份與還原 UI 整合至既有可觀測性頁，維持五個主導覽。外部檔案必須先完整驗證路徑、manifest、SHA 與 schema，通過後才進入維護模式。排程依主機本機時區每日 03:00 執行，保留每日 7 份，週日另保留每週 4 份。支援 dry-run、原子還原及失敗自動回滾，允許還原期間短暫停機。
- 新增只監聽 `127.0.0.1` 獨立埠的 Prometheus `/metrics`，涵蓋 DNS、DoH、proxy、cache、upstream、runtime、backup 與 alert；允許明確修改 bind address，不與公開 DoH 共用。
- 新增完整 client IP、qname、URL 的結構化 JSON 日誌，按日輪替並保留 30 天。完整日誌與備份下載僅 owner 可用；admin 只能查看聚合與去敏事件。
- 管理 UI 顯示 SQLite 聚合的 24 小時、7 天、30 天流量、延遲、錯誤與容量趨勢。
- Webhook 告警必須使用 HMAC 簽名與唯一 event id，工作持久化，採指數退避重試最多 24 小時，失敗進 dead-letter 並可由 UI 重送。
- 正式部署產物包含 Docker Compose（非 root、volume、healthcheck、graceful stop、升級／回滾）、Linux systemd（專用使用者、權限、restart policy、journald）及面板單檔啟動。

### v0.3.0：DNS 與代理專業能力

- 現有 domain workspace 自動升級為 primary zone，既有 records 保持相容視圖。每 zone 具可編輯 SOA、預設值、自動 serial、批次 CRUD、標準 zone file 匯入／匯出。
- SOA serial 採主機本機時區的 `YYYYMMDDnn`：新 Zone 以當日 `00` 起始；同日異動逐次遞增，跨日跳至新日期 `00`。單日超過 99 次後仍持續單調加一，不因格式尾碼超過兩位而拒絕合法更新。
- 該 Zone 的 DNS 記錄新增、修改、刪除、啟停，以及會影響權威回應的 Zone／SOA 設定變更，均由伺服器自動增加 serial；代理、Tunnel、可觀測性等非權威設定不得造成 serial 變動。
- 每筆 DNS 記錄新增伺服器產生且持久化的 UUID v4 `id`；舊記錄 migration 自動補齊，既有 name/type/value 相容視圖不變。批次編輯與刪除以穩定 id 定位，不再依賴陣列位置。
- Zone file 匯入支援常用 BIND 語法：`$ORIGIN`、`$TTL`、註解、多行括號、owner 省略，以及 SOA、A、AAAA、CNAME、MX、TXT、NS、SRV；未知 directive／type 或不屬於目標 Zone 的名稱必須拒絕，不得靜默略過。
- 匯入先完整解析與預覽，提交時可選原子「合併」或「取代」該 Zone 直接歸屬記錄。合併時完全相同的 owner/type/rdata/TTL 略過；CNAME 共存等語意衝突使整批失敗，不留下部分更新。
- 匯入 SOA serial 高於目前值時採用匯入值，否則依自動 serial 策略增加，確保永不倒退。Zone 匯出採固定排序、可再次匯入 S12 或 BIND 類工具的標準 BIND 文字。
- Zone file 管理 API 以原始文字傳輸：匯入接受 `text/dns` 或 `text/plain` 本文，合併／取代模式由 query 指定；匯出回傳 `text/dns` attachment，方便瀏覽器下載與 CLI 直接使用。
- Zone 內記錄批次新增、修改、刪除皆採整批原子語意；任一筆驗證、識別碼或 DNS 語意衝突時全部不寫入，成功時整批只觸發一次 SOA serial 更新。
- 批次 CRUD 的 JSON 本文採三組陣列：`create` 放新記錄、`update` 放 `{ id, record }`、`delete` 放記錄 ID；三組可同時使用，後端必須先完成全部驗證再一次提交。
- 管理 UI 的 Zone file 匯入同時提供檔案載入與可直接編輯／貼上的文字區；使用者必須先取得預覽結果，再選擇合併或取代提交，未重新預覽的異動內容不得直接匯入。
- SOA 與 Zone 預設值使用獨立的全自建「Zone 設定」modal；選取 primary zone 後顯示目前 serial，modal 可編輯 mname、rname、refresh、retry、expire、minimum 與預設 TTL，並沿用自訂繁中驗證、焦點鎖定及 reduced-motion 契約。
- 完成權威 DNS 語意：正確 NXDOMAIN／NODATA、authority SOA、delegation、glue 與 wildcard。v1.0 不要求 DNSSEC signing／validation、AXFR／IXFR、NOTIFY 或 TSIG。
- DNS policy 支援 exact／suffix／wildcard 名稱、qtype、client CIDR、星期與時段、遠端清單訂閱；清單下載需驗證並原子替換，失敗保留舊版。動作包含 NXDOMAIN、REFUSED、`0.0.0.0`／`::`、自訂 CNAME／IP redirect。
- DNS policy 多規則同時命中時，以數字較小的 `priority` 優先；相同 priority 依設定中的穩定順序取第一條，不合併多個動作。
- DNS policy 的星期與時段可由每條規則指定 IANA 時區；未指定時使用主機本機時區。跨午夜時段必須以該規則時區正確判定。
- 遠端 policy 清單接受每行純網域或 Hosts 格式（例如 `0.0.0.0 blocked.example`），允許註解；每個訂閱綁定單一 action 與 priority，展開後與本地規則使用相同排序規則。格式或下載驗證失敗時不得替換最後有效版本。
- 遠端清單的每個網域只作 exact 匹配，不自動涵蓋子網域。同 priority 時本地 rules 先於 subscriptions；訂閱之間依設定順序，再依清單網域的穩定順序。
- 訂閱只接受 HTTPS。核心啟動時先載入最後有效快取，立即提供解析，再於背景非阻塞更新；預設每 6 小時更新，可設定 5 分鐘至 7 天。單次下載最多 10 MiB、最多 1,000,000 個唯一網域，超限、格式錯誤或網路失敗均保留舊快取且不得阻止 DNS 啟動。
- `config.json` 使用頂層 `dnsPolicy: { rules: [], subscriptions: [] }` 保存 DNS Policy；不得把解析政策混入只負責 listener host／port 的 `dns` 區段。舊設定 migration 必須補空結構並原子落盤。
- 代理在既有 location／rewrite／headers／cache／compression／WebSocket 上新增：可設定 path／interval／timeout／期望狀態的主動健康檢查、active+passive health 歷史、weighted round-robin、維護與 graceful drain、circuit breaker／half-open／fallback response、HTTP/2 HTTPS upstream 連線池、非阻塞 shadow traffic，以及 WebSocket idle timeout／最大連線／統計／逐站台中止。
- 主動健康檢查預設使用 `GET /healthz`，每 10 秒執行、2 秒 timeout，HTTP 200–399 視為成功；連續 2 次失敗才摘除，連續 2 次成功才恢復。每個 upstream 可覆寫健康 path、interval、timeout 與成功狀態範圍。
- upstream `weight` 範圍為 1–100，使用 smooth weighted round-robin。circuit breaker 連續 5 次失敗後開路 30 秒，half-open 階段只允許 1 個探測請求；成功關閉、失敗重新開路。只有主 pool 全部不可用時才使用 location 明確設定的 fallback upstream。
- GET／HEAD／OPTIONS 可自動使用 fallback；POST／PUT／PATCH／DELETE 只有 location 明確設定 `allowUnsafeFallback` 且 request body 可安全重播時才可使用，避免重複寫入。
- 站台 `maintenance` 是持久化設定，啟用時新請求回 HTTP 503 並可設定 `Retry-After`。upstream `draining` 是不寫入 config 的暫態操作狀態；停止接收新 HTTP／WebSocket，既有連線最多等待 30 秒後中止。管理端可逐站台立即中止既有連線。
- 排空同時支援整個站台及單一 location upstream；開始排空後立即停止向該範圍分派新 HTTP／WebSocket，30 秒寬限到期後自動中止仍存在的連線。管理 API 使用明確資源路徑，提供站台與 upstream 的 drain／resume，以及站台 abort 操作，並由管理 UI 顯示與控制暫態狀態。
- HTTPS upstream 可逐一設定 `protocol: http1 | http2 | auto`，預設 `auto`；HTTP/2 使用可重用連線池。shadow traffic 由 location 明確設定 target、sample rate 與 timeout，非阻塞且不影響主回應、不重試；預設只鏡像 GET／HEAD／OPTIONS，移除 Authorization、Cookie、Proxy-Authorization，body 上限 1 MiB，寫入方法必須另行明確允許。
- WebSocket 每站台預設最多 1,000 條連線、idle timeout 5 分鐘；超限回 503，閒置連線關閉。統計 active／accepted／rejected／duration／bytes，並提供逐站台中止操作。
- active／passive upstream 健康資料在 SQLite 保留 30 天：保存狀態轉換與探測摘要，管理 UI 顯示目前狀態、延遲、成功率及近期轉換；不得因健康歷史寫入失敗中斷代理核心。
- S12 仍不在本機終止 TLS；公開 HTTPS 與憑證持續由 Cloudflare、Caddy、Nginx 或其他受信入口處理。

### v0.4.0：多使用者、RBAC 與 API v2

- 內建 owner、admin、operator、viewer 四級角色，並支援依 DNS、proxy、Tunnel、backup、users、audit 等細部權限建立自訂角色。
- 新增多使用者、邀請／停用、session 撤銷、密碼政策、scoped API token、到期、撤銷與 last-used；敏感完整日誌及備份下載固定只允許 owner，不可由自訂角色擴張。
- 新增 REST `/api/v2`、OpenAPI、分頁、過濾、標準錯誤、idempotency key，以及具 scopes／expiry／revoke 的 bearer token。既有 v1 API 在相容期只讀。
- 操作審計保存 actor、action、resource、before／after、requestId、IP，採 hash chain 偵測刪改，保留 365 天並可由 owner 匯出。

### v1.0.0：穩定化與量化驗收

- 完成所有 migration／downgrade guard、設定與資料 schema version、備份跨版本還原、升級失敗回滾、崩潰恢復、優雅關閉、診斷包、使用手冊、OpenAPI 與部署手冊。
- 單機驗收規模為 100,000 DNS records、1,000 proxy sites、DNS 5,000 QPS、proxy 1,000 RPS、24 小時 soak；設定更新、metrics、log rotation、backup 與告警不得造成核心服務中斷。
- 全階段維持 TDD：每項新行為先具預期原因的 RED，再以最小 GREEN 實作並受測試保護重構。每版執行完整 unit／integration／E2E、lint、audit、LSP、build、migration、壓力／穩定性與安全審查。
- 單檔 bootstrap 下載的新 runtime 與 native binding 先保存為 `pending` 候選，不得覆寫最後成功的 `active` metadata。候選 `require` 或 `start()` 失敗時，記錄失敗版本與去敏錯誤，立即重新驗證並啟動上一個 active；只有候選成功啟動後才原子提升為 active。沒有可用 active 時才進入內嵌 fallback。
- active runtime、config 與 SQLite 均拒絕由較舊程式開啟較新的 schema，不作破壞性自動降版。v0.2.0、v0.3.0、v0.4.0 格式 1 備份必須可由 v1 預先完整驗證後交易式還原；未來 schema、損壞檔案或校驗不符須在進入維護模式前拒絕。
- 啟動與維護操作使用 owner-only 崩潰標記；不完整啟動、還原或關閉在下次啟動時可辨識，先執行 SQLite integrity、config schema、runtime cache 與暫存檔清理，再提供核心服務。恢復失敗不得覆寫最後可用資料。
- owner-only 診斷包採 ZIP＋manifest＋逐檔 SHA-256，包含去敏 config、runtime／平台／schema／integrity、服務與上游狀態、metrics 摘要、審計鏈驗證、最近有限事件與日誌尾端；不得包含 Tunnel token、密碼或 token hash、session／cookie、API token、Webhook secret或完整備份內容。
- 量化工具固定輸出 JSON 報告與通過門檻。功能正確性先以可縮短的 CI profile 驗證；正式 v1 Release 必須另有 Linux glibc x64 的 100,000 records／1,000 sites、DNS 5,000 QPS、proxy 1,000 RPS 與 24 小時 soak 證據，未達門檻不得發布 v1.0.0。
