# 維運與復原手冊

本手冊適用於單機正式部署。完整備份、敏感日誌、審計匯出與診斷包均為 **owner-only** 操作；不要把管理介面直接暴露至公網。

## 日常檢查

1. 檢查管理介面的核心服務、上游 DNS、代理健康與 Webhook dead-letter。
2. 檢查 `http://127.0.0.1:9090/healthz` 與 Prometheus `/metrics`。
3. 確認 `data/logs` 每日輪替、`data/backups` 每日／每週保留，以及磁碟與 proxy cache 容量。
4. 定期在可觀測性頁驗證審計雜湊鏈。

## 備份與還原

備份 ZIP 是明文最高敏感資產，包含設定、身分資料庫、Tunnel token 與完整操作日誌。下載後應立即放入加密儲存，並限制檔案 owner 權限。

還原前會在進入維護模式前完成：

- ZIP 路徑、重複 entry、大小與逐檔 SHA-256 驗證。
- `config.json` schema 與語意驗證。
- SQLite `quick_check`、application id、manifest schema 與 future-schema guard。

v0.2、v0.3、v0.4 的 format 1 備份可在 v1 預驗後交易式還原。還原失敗時，系統會以同檔案系統內的 rollback snapshot 恢復原設定、SQLite、日誌及舊式 `admin.json`。

## 升級與 last-known-good 回退

單檔 bootstrap 先下載候選 runtime 與 native binding，以 digest 不可變檔名保存並寫入 `pending.json`。候選完整啟動成功後才提升為 `active.json`；失敗時會留下不含原始例外或機密的 `failed.json`，重新驗證並啟動 previous **last-known-good** runtime。

升級步驟：

1. 建立並下載 owner-only 完整備份。
2. 保留目前 Release 的 `index.js` 與 `data/runtime/active.json`。
3. 更新 `index.js`，重新啟動服務。
4. 確認管理健康、DNS、DoH、proxy 與 metrics。
5. 若候選失敗，確認 active version 未改變且 `failed.json` 已去敏；若 bootstrap 本身需回滾，還原舊 `index.js` 後再啟動。

禁止用舊程式強制開啟較新的 config 或 SQLite schema，也不要手動降低 schema version。

## Crash recovery

`data/recovery/operation.json` 是 owner-only 啟動、還原或關閉 marker。若程序在操作完成前崩潰，下次啟動會：

- 記錄去敏的 `last-recovery.json`。
- 只清除 S12 精確命名的 atomic temp、未完成 backup upload、restore／rollback 目錄。
- 保留 `config.json`、受管理備份、runtime active／pending 邊界及未知隱藏檔。

若重啟後仍失敗，先停止服務，保存 `data/recovery` 與日誌，再從已驗證備份還原；不要直接刪除 SQLite WAL/SHM 或 active runtime metadata。

## 診斷包

owner 可在審計面板下載「診斷包」。ZIP 具有逐檔 SHA-256 manifest，包含去敏設定、平台/runtime/schema/integrity、服務與上游狀態、metrics snapshot、audit verification、有限事件及近期 JSON log tails。

診斷包刻意排除 SQLite、完整備份、proxy cache、Tunnel token、Webhook secret、password/token hash、session/cookie 與 API token。即使已去敏，仍應按內部資料處理，不要公開張貼。

## 優雅關閉

Docker、systemd 與直接執行均以 SIGTERM 關閉。服務依序停止排程、telemetry、health monitors、listeners、cache、SQLite 與 Tunnel，並完成 shutdown marker。不要以強制終止作為正常部署流程；只有超過部署平台的 graceful timeout 才升級處理。
