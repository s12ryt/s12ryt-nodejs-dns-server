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
