# 操作紀錄

## 2026-08-10

- 讀取 `todos.md`：確認目標為 Node.js 自建 DNS、DoH、Cloudflare Tunnel、自訂解析、反向代理及單一 `index.js` 啟動。
- 掃描工作區：除 `todos.md` 外無其他檔案，且不是 Git 倉庫。
- 載入全端架構、UI/UX 與 Git 操作指引；未使用代理委派。
- 透過需求問答確認平台、功能、安全、資料、協定邊界、UI、測試、GitHub 與授權條款。
- 建立 `agent/question.md`、`agent/deep_todos.md`、`agent/項目表.md` 與本操作紀錄。
- 依 RED → GREEN → REFACTOR 完成 DNS wire codec、記錄比對、TTL/LRU 快取、解析政策與 DoH 上游。
- 完成 UDP/TCP DNS、RFC 8484 DoH、HTTP/WebSocket 反向代理及其整合測試。
- 完成原子設定、PBKDF2 管理認證、session/CSRF/登入限流、管理 API 與 bounded event log。
- 完成 cloudflared 平台資產辨識、SHA-256 校驗、原子安裝、程序與日誌管理；Tunnel 失敗不阻止核心服務。
- 完成 runtime 組裝、設定熱更新、響應式深淺色管理 UI 與桌面/手機 Playwright E2E。
- 完成標準庫單檔 `index.js`：Release manifest/runtime 下載、SHA-256、last-known-good cache 與離線 DNS/DoH fallback。
- 完成 esbuild 單檔 runtime 與 UI 資產內嵌；產生版本化 manifest。
- 回歸結果：Node 單元/整合 43/43、Playwright 2/2、ESLint、build、npm audit、npm pack 與全專案 LSP 均通過。
- 初始化本機 Git `main`，依功能與直接測試規劃原子提交；GitHub 倉庫與 Release 尚待建立。
- 建立公開倉庫 `https://github.com/s12ryt/s12ryt-nodejs-dns-server`，推送原子提交至 `main`。
- 建立 `v0.1.0` Release，資產包含 `index.js`、`runtime.cjs`、`manifest.json`；GitHub asset digest 與本機 build digest 相符。
- 由全新暫存目錄只下載 Release `index.js` 冷啟動：初始目錄僅一檔，成功下載 runtime 0.1.0、驗證 SHA-256 `d57645836c934d53229d3ffa2e97f80f640ea67dee8ca1d2e074a99c94ca154a`、建立 active cache，管理 API 回應 HTTP 200。
- 冷啟動第一次發現較早驗收遺留的孤立 `node index.js` 佔用 UDP/TCP 5354；確認父程序已消失且管理 API 不可達後終止該 PID，再完成驗收。
- 依新需求確認 Cloudflare Tunnel token 可保存於 `data/config.json`，環境變數優先，管理 API/UI 永不回傳明文。
- 先以 9/9 既有相關測試建立基線，再新增 config migration、manager 去敏、runtime 更新/回滾、API 與 UI 儲存/清除的 RED 測試。
- 完成 `tunnel.token` 持久化與 v0.1.0 設定 migration；Token 在 manager 內改為私有狀態，公開 status 僅含來源與是否已儲存。
- 完成運行中 token 切換、失敗後原子回滾與舊 Tunnel 恢復；環境 token 存在時僅更新 config 備援，不重啟有效連線。
- 完成專用 `PUT/DELETE /api/tunnel/token`、一般 config API secret 保留與回應去敏，以及管理 UI 的密碼輸入、來源狀態、儲存與確認清除。
- 回歸結果：Node 單元/整合 48/48、Playwright 2/2、ESLint、npm audit 與相關 LSP 均通過；版本升至 0.1.1，build runtime SHA-256 為 `73e98a7b163e30ebf0965217b2b686599a9f80ced0e32e8b09ed01ded191db8a`。
- 推送 9 個 Cloudflare Tunnel token 原子提交並建立 `v0.1.1` tag；GitHub Actions 的 Node 20/22/24、Playwright 與 release jobs 全部成功。
- `v0.1.1` Release 發布 `index.js`、`runtime.cjs`、`manifest.json`；GitHub runtime asset digest 與本機 build/manifest 相符。
- 由全新暫存目錄只下載 Release `index.js` 冷啟動，管理 API 回應 HTTP 200，active cache 為 `runtime-0.1.1.cjs` 且 SHA-256 為 `73e98a7b163e30ebf0965217b2b686599a9f80ced0e32e8b09ed01ded191db8a`；驗收程序已清理。
- 依自主 UX 疊代需求，維持原生 HTML/CSS/JavaScript 與既有公開契約，盤點並改善總覽監控、完整操作流程、手機導覽及鍵盤使用。
- 先建立健康摘要、`aria-current`、表單 busy、手機主題/登出、375/768/1024/1440 無溢位、深淺色截圖及 skip link 的 RED 測試。
- 完成核心服務健康摘要、記錄/路由/快取統計、可讀狀態、繁中事件與時間、統一非同步回饋、SVG 圖示及響應式五欄底部導覽。
- 修正 icon-only busy 狀態不應移除 SVG，並為 dialog、導覽、主題切換及 skip link 補齊可存取名稱與焦點行為。
- 回歸結果：Node 單元/整合 48/48、Playwright 3/3、ESLint、npm audit、JS LSP 與 v0.1.2 build 契約均通過；CSS 僅保留 `[hidden]` 與 reduced-motion 必要 `!important` 提示。
- 推送 7 個 UX 與版本化原子提交並建立 `v0.1.2` tag；GitHub Actions 的 main、Node 20/22/24、Playwright 與 release jobs 全部成功。
- `v0.1.2` Release 發布 `index.js`、`runtime.cjs`、`manifest.json`；由起初只有 Release `index.js` 的全新暫存目錄冷啟動，管理 API 回應 HTTP 200，active cache 為 `runtime-0.1.2.cjs`，本機計算與 Release digest 均為 `5431086c07baae696912b26c578c19fc68dc7d10002fd65d304c1e8191738b4f`。
