# 部署、升級與回滾手冊

正式支援平台為 **Linux glibc** x64／arm64，Node.js 20、22、24。Windows與macOS屬盡力相容；Alpine/musl不在正式驗收範圍。

## Docker Compose

映像基於Debian bookworm，使用固定非root UID/GID 10001、唯讀root filesystem、`no-new-privileges`、drop all capabilities、持久data volume、健康檢查及SIGTERM graceful stop。

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f s12-dns-server
```

metrics預設只發布到主機`127.0.0.1:9090`。部署平台必須保存data volume；不要把`data`放入容器暫存層。

## systemd

```bash
sudo sh deploy/systemd/install.sh
systemctl status s12-dns-server
journalctl -u s12-dns-server -f
```

安裝器建立`s12-dns`專用帳號、`0700`資料目錄與硬化service。bootstrap程式由root管理，runtime與操作資料由專用帳號存取。

## 面板單檔

從Release只下載`index.js`並執行：

```bash
node index.js
```

bootstrap依Node ABI／平台／架構下載SHA-256驗證的runtime與better-sqlite3 binding。正式Release提供ABI115/127/137 × Linux x64/arm64六組binding。

## 升級

1. 建立owner-only完整備份並離站保存。
2. 記錄目前tag、runtime digest與`data/runtime/active.json`。
3. Docker替換image tag；systemd／面板替換`index.js`。
4. 以SIGTERM停止舊程序，啟動新版本。
5. 驗證health、DNS/DoH、proxy、metrics、audit chain及備份dry-run。

候選runtime成功啟動前不會覆蓋active。若候選失敗，bootstrap自動回到last-known-good並留下去敏failed metadata。

## Rollback／回滾

應用程式回滾與資料還原是兩個步驟：

1. 還原上一個image tag或舊`index.js`。
2. 若新版本已完成資料migration，舊程式會因downgrade guard拒絕啟動；不得手改schema，應使用升級前備份交易式還原。
3. 重新啟動並驗證health與核心服務。

Docker Compose範例：

```bash
docker compose down --timeout 30
# 將 image/build 切回已驗證版本
docker compose up -d
```

systemd範例：

```bash
systemctl stop s12-dns-server
# 還原舊 /opt/s12-dns-server/index.js 或套件
systemctl start s12-dns-server
```

GitHub tag Release流程會在Linux Node20執行index-only cold start、不可達manifest下的LKG rollback及兩次SIGTERM；一般CI另實際建置並啟動唯讀Debian容器。
