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
