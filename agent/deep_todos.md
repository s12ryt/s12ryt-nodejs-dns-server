# 完整歷史任務

## 2026-08-10：初始完整實作

- [x] 讀取 `todos.md` 並確認工作區沒有既有程式、測試或 Git 歷史。
- [x] 逐輪確認功能範圍、協定、安全、平台、UI、發布及驗收契約。
- [x] 將確認結果寫入 `agent/question.md`。
- [x] 查核 Node.js、RFC 8484、Cloudflare Tunnel 與無障礙 UI 實作依據。
- [x] 建立 Node.js 20+ 測試基線、lint、build 與 Playwright 專案骨架。
- [x] 依 TDD 完成 DNS/DoH、自訂記錄、快取與多上游容錯。
- [x] 依 TDD 完成反向代理、管理安全/API 與 Tunnel 管理。
- [x] 依 TDD 完成響應式管理 UI 與 Playwright E2E。
- [x] 依 TDD 完成單檔 bootstrap、下載校驗、快取及離線核心。
- [x] 完成 43 項單元/整合測試、2 項 E2E、lint、build、audit 與打包驗證。
- [x] 完成 README、AGPL-3.0-or-later 授權與 CI/Release workflow。
- [x] 建立公開 GitHub 倉庫與 v0.1.0 Release。
- [x] 在全新暫存目錄僅放入 Release `index.js`，驗證其下載並校驗 runtime、建立有效 cache，且管理 API 回應 200。

## 2026-08-10：Cloudflare Tunnel token 設定檔支援

- [x] 確認環境變數優先、設定檔備援、API 去敏、更新回滾與清除語意。
- [x] 先建立 config migration、Tunnel manager、runtime、管理 API 與 UI 的失敗測試。
- [x] 在 `data/config.json` 新增 `tunnel.token`，並相容遷移 v0.1.0 設定。
- [x] 完成 token 來源切換、執行中重啟、失敗原子回滾及舊 Tunnel 恢復。
- [x] 完成不回傳明文的專用管理 API，以及 UI 儲存、狀態顯示與確認清除操作。
- [x] 完成 48 項單元/整合測試、2 項 E2E、lint、audit、LSP 與 v0.1.1 build 驗證。
- [x] 建立並驗證 v0.1.1 Release 與單檔冷啟動。

## 2026-08-10：管理介面自主 UX 疊代

- [x] 確認維持既有功能與 API，以原生 HTML/CSS/JavaScript 中度重整操作流程與總覽監控。
- [x] 盤點桌面與手機資訊層級、導覽溢位、操作回饋、事件可讀性及鍵盤可用性。
- [x] 先建立健康摘要、導覽狀態、非同步 busy、手機工具、多尺寸溢位及鍵盤焦點的 RED 測試。
- [x] 完成服務健康摘要、記錄/路由/快取統計、狀態文字、事件本地化及一致的操作回饋。
- [x] 完成桌面 icon 導覽、手機五欄底部導覽、頂部主題/登出工具與可存取的 dialog/form 控制。
- [x] 驗證 375、768、1024、1440 px 無水平溢位，以及深色、淺色、手機截圖與鍵盤 skip link。
- [x] 完成 48 項單元/整合測試、3 項 E2E、lint、audit、LSP 與 v0.1.2 build 驗證。
- [x] 建立並驗證 v0.1.2 Release，以及只有 Release `index.js` 的單檔冷啟動與 runtime digest。

## 2026-08-10：DNS 管理與 Nginx 式代理

- [x] 確認 DNS CRUD、全自建對話元件、CNAME 答案鏈、上游健康、診斷、網域工作區及 Nginx 式代理契約。
- [x] 先以測試重現 CNAME 僅回 alias、上游未探測、DNS 診斷缺失、記錄無法編輯／刪除，以及舊代理模型能力不足。
- [x] 完成 CNAME 自訂／上游追查、循環與深度防護，以及啟動時與每五分鐘的非阻塞上游健康探測。
- [x] 完成受認證與 CSRF 保護的 DNS 診斷 API，支援 A、AAAA、CNAME、MX、TXT、NS、SRV。
- [x] 完成網域工作區 migration、最長後綴歸類、相對名稱、網站範本、級聯狀態、整棵重新命名與刪除。
- [x] 完成代理站台 migration、Host aliases、exact／prefix locations、redirect、rewrite、headers、多上游與 WebSocket。
- [x] 完成 body 上限、可信代理、IP ACL、記憶體限流、持久有界 cache、Brotli／gzip 與管理清除 API。
- [x] 完成 DNS／網域／代理 UI CRUD、五步代理精靈、全自建 modal、自訂驗證、焦點鎖定及 reduced-motion。
- [x] 完成 74 項單元／整合測試、6 項 E2E、lint、audit、LSP、視覺與 v0.1.3 build 驗證。
- [x] 發布並驗證 v0.1.3 Release、GitHub CI 與單檔冷啟動；runtime SHA-256 為 `58ee2cc4a792b6fbe1e0700faeac696af56b56c71fb1a0d45e9b67af71abfcae`。

## 2026-08-11：依網域選取管理 DNS 記錄

- [x] 確認 DNS 頁採網域 master-detail，初始不選取，並保留未分組記錄入口。
- [x] 先以 E2E 重現缺少網域選取、父子直接歸屬及選取範圍 CRUD 的行為。
- [x] 完成桌面與手機網域清單、空白提示、診斷預填，以及最長後綴直接歸屬顯示。
- [x] 完成選取網域與未分組記錄下的新增、編輯、停用、刪除及重新載入持久化。
- [x] 完成網域改名後保持選取、刪除目前網域後回空白，以及未選取時禁止新增。
- [x] 完成 74 項單元／整合測試、6 項 E2E、lint、audit、LSP 與 v0.1.4 build 驗證。
- [x] 發布並驗證 v0.1.4 Release、GitHub CI 與單檔冷啟動；runtime SHA-256 為 `8663391dbf140a31e4092f8c0b92e86cb11b569660ed91f357d9ba5890454fbf`。

## 2026-08-11：公開 DoH CORS 與 CNAME 熱更新

- [x] 以公開 endpoint、curl 與真實瀏覽器確認 `Failed to fetch` 是缺少 CORS，並確認 endpoint 本身可達。
- [x] 確認實際記錄為 `awa.16516565.tw CNAME chatgpt.com`；查詢根 `16516565.tw` 得到 NXDOMAIN 屬精確名稱語意。
- [x] 先以整合與 Playwright 測試重現 OPTIONS 405、缺少 CORS header 及瀏覽器跨來源失敗。
- [x] 完整 runtime 與內嵌 fallback 的 `/dns-query` 均支援無憑證 CORS、OPTIONS preflight，以及成功／錯誤回應一致 headers。
- [x] 補強 CNAME 設定原子更新後不重啟立即命中，且重新載入仍保留的 characterization test。
- [x] 完成 75 項單元／整合測試、7 項 E2E、lint、audit、LSP 與 v0.1.5 build 驗證。
- [x] 發布並驗證 v0.1.5 Release、GitHub CI 與單檔冷啟動；runtime SHA-256 為 `18245440925240d5f7e9feef7e3b9a0714b435802b9854eddb1745c0390e8c9a`，冷啟動 DoH preflight 回 204 與 ACAO `*`。

## 2026-08-11：v0.2.0 維運、可觀測與部署底座

- [x] 確認單機正式版 v0.2.0 至 v1.0.0 的分版契約、Linux 正式平台與量化驗收門檻。
- [x] 依 TDD 完成 better-sqlite3 WAL、schema migration、downgrade／corruption guard、設定版本及 runtime lifecycle。
- [x] 完成 runtime 與 native binding 雙 SHA bootstrap、離線 cache，及 Node 20／22／24 的 Linux x64／arm64 六資產下載與安全 tar 驗證。
- [x] 完成 Prometheus listener、SQLite 指標歷史、完整敏感 JSON 日誌、Webhook HMAC／重試／dead-letter 與管理 UI。
- [x] 完成明文敏感 ZIP 備份、manifest、online SQLite snapshot、外部有界匯入、排程保留、dry-run、維護模式還原及失敗回滾。
- [x] 完成 Docker Compose 非 root／唯讀／healthcheck／graceful stop，以及 systemd 專用帳號、權限、restart、journald與硬化設定。
- [x] 完成 126 項單元／整合測試、9 項 E2E、lint、audit、31 個 src JS LSP 與六資產 production build 驗證。
- [x] 發布並驗證 v0.2.0 Release、Linux Docker CI、六個 native assets、單檔冷啟動及 last-known-good rollback；runtime SHA-256 為 `1fef46069609a73665f7f6ca91e5414b42dc593c673dab562d5a34a6889495c5`。

## 2026-08-12：v0.3.0 DNS 與代理專業能力

- [x] 完成 SOA wire、Primary Zone migration、`YYYYMMDDnn` serial、NXDOMAIN／NODATA authority SOA、wildcard、delegation 與 glue。
- [x] 完成 record UUID、原子批次 CRUD，以及可預覽 merge／replace 的 BIND Zone file 匯入與穩定匯出。
- [x] 完成 DNS Policy 的名稱、qtype、client CIDR、星期／時段／時區條件與 NXDOMAIN／REFUSED／A／AAAA／CNAME 動作。
- [x] 完成 HTTPS Hosts 清單訂閱、last-known-good 原子快取、非阻塞更新、管理 API 與 UI。
- [x] 完成 smooth weighted RR、主動健康、被動斷路器、明確備援、維護模式、排空與 30 天 SQLite 健康歷史。
- [x] 完成 pooled HTTP/2 與自動 HTTP/1.1 降級、非阻塞 Shadow traffic、WebSocket 限制／統計／中止。
- [x] 完成進階代理五步精靈、站台與 upstream 運行控制、健康歷史及完整自建 UI 流程。
- [x] 完成 179 項單元／整合測試、12 項 E2E、lint、audit、37 個 src JS LSP 與 v0.3.0 build 驗證。
- [x] 發布並驗證 v0.3.0 Release、Linux CI、六個 native assets、單檔冷啟動及 last-known-good rollback；runtime SHA-256 為 `42840d0c438d9aaac07a04818c24e22513e438345113e2b81ea813564019df9f`。

## 2026-08-12：v0.4.0 身分、API 與防竄改審計

- [x] 完成 SQLite schema v6，以及角色、使用者、邀請、持久 session、scoped API token、審計鏈與 idempotency 儲存。
- [x] 完成 owner／admin／operator／viewer 固定角色、自訂角色與不可委派 owner-only 敏感權限。
- [x] 完成 legacy admin migration、多使用者邀請／停用、session 撤銷、API token expiry／revoke／last-used。
- [x] 完成 Cookie／Bearer 共用 RBAC、身分管理 API，以及角色、邀請、token 與審計管理 UI。
- [x] 完成 REST API v2 OpenAPI、標準錯誤、分頁／過濾、主要 DNS／proxy／Tunnel／backup／audit 資源，以及冪等寫入。
- [x] 完成 API v1 唯讀相容入口，以及 config、backup、Webhook、proxy cache、Tunnel與身分 mutation 審計。
- [x] 完成 202 項單元／整合測試、14 項 E2E、lint、audit、LSP 與 v0.4.0 build 驗證；並修復備份建立結果缺少 archive size 導致審計失敗的回歸；runtime SHA-256 為 `20d859cd03614ea6bceb66cf89692794d850d499d5d162e91e33b64ebf61f28b`。
- [x] 發布並驗證 v0.4.0 Release、Linux CI、六個 native assets、單檔冷啟動及 last-known-good rollback；tag CI run `31536728312` 全綠，runtime SHA-256 為 `20d859cd03614ea6bceb66cf89692794d850d499d5d162e91e33b64ebf61f28b`。

## 2026-08-12：v1.0.0 穩定化與正式驗收

- [x] 完成候選 runtime pending／promotion／去敏失敗證據，以及候選啟動失敗時重新驗證 previous last-known-good 的交易式回退。
- [x] 完成 v0.2／v0.3／v0.4 format 1 備份的 config 與 SQLite maintenance 前預檢、future schema guard及交易式rollback。
- [x] 完成 startup／restore／shutdown crash marker、精確白名單temp recovery與去敏recovery report。
- [x] 完成 owner-only去敏診斷ZIP、manifest逐檔SHA、管理API與瀏覽器下載流程。
- [x] 完成 deterministic 100,000 records／1,000 sites資料集、真UDP DNS與HTTP proxy負載、CI／scale／release profiles、原子JSON報告與CI artifact閘門。
- [x] 完成維運／API／部署／benchmark正式手冊；修復formal soak延遲樣本無界累積造成的V8 OOM與突發發送模型，完成227項Node測試、14項E2E、lint、audit、50個src JS與bootstrap／scripts LSP及v1.0.0 build，runtime SHA-256為`d375e7e476346b27e3c1a71c9caa081f2b9fb61efba9d216d231490369c17b55`。
- [x] 判定候選`ca4392b`完整24小時formal soak因序列區間只啟動66,525 ticks而失敗；依TDD改為固定牆鐘排程，並以8個UDP client sockets與總concurrency 128通過Linux scale前置閘門（DNS 5,500.00 QPS／0 error、proxy 1,100.00 RPS／0 error）。
- [ ] 在Linux glibc x64執行100,000 records、1,000 sites、DNS 5,000 QPS、proxy 1,000 RPS與24小時不中斷formal soak，並保存`formal:true`報告。
- [ ] 發布並驗證v1.0.0 Release、Linux CI、六個native assets、單檔冷啟動及last-known-good rollback。
