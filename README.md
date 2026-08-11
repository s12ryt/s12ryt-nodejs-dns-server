# S12 DNS Server

自架的 Node.js DNS 控制台，整合 UDP/TCP DNS、RFC 8484 DoH、自訂記錄、多上游容錯、HTTP/WebSocket 反向代理與 Cloudflare Tunnel 管理。需要 Node.js 20 以上版本；正式部署支援 Linux glibc x64／arm64，Windows 與 macOS 為盡力相容。

## 功能

- 可點選的自訂網域工作區，以及 A、AAAA、CNAME、MX、TXT、NS、SRV 記錄的完整新增、編輯、停用與刪除流程。
- Primary Zone、SOA、權威 NXDOMAIN／NODATA、delegation／glue、Zone file，以及 CNAME 完整答案鏈與多上游容錯。
- 同埠 UDP/TCP DNS，以及支援 GET、POST、瀏覽器 CORS preflight 的 `/dns-query` DoH。
- 具權重、主備池、健康檢查、斷路器、HTTP/2、排空、Shadow、持久快取、壓縮與 WebSocket 控制的 Nginx 式反向代理。
- 首次一次性 token 設密、PBKDF2、HttpOnly session、CSRF 與登入限速。
- 響應式深淺色管理介面，提供 DNS 診斷、核心服務健康摘要、全自建對話元件、即時操作回饋、鍵盤導覽，以及 cloudflared 下載、校驗、啟停與日誌。
- SQLite WAL 持久化設定歷史、聚合指標與 Webhook 工作，另提供 Prometheus、每日結構化 JSON 日誌及 24 小時／7 天／30 天趨勢。
- 完整敏感 ZIP 備份、SHA-256 manifest、每日／每週排程、外部匯入、dry-run、維護模式還原及失敗自動回滾。
- 只有 `index.js` 時可下載經 SHA-256 驗證的完整 runtime；離線時改用最後有效快取或內嵌 DNS/DoH 核心。

## 完整安裝

```bash
npm ci
npm start
```

首次啟動會在終端輸出 10 分鐘有效的一次性 setup token。開啟 `http://localhost:8081`，以該 token 建立至少 12 字元的管理密碼。

預設監聽埠：

| 服務 | 位址 |
| --- | --- |
| UDP/TCP DNS | `0.0.0.0:5354` |
| DoH | `http://0.0.0.0:8053/dns-query` |
| 反向代理 | `http://0.0.0.0:8080` |
| 管理 UI/API | `http://0.0.0.0:8081` |
| Prometheus/health | `http://127.0.0.1:9090/metrics`、`/healthz` |

設定會原子寫入 `data/config.json`。可從管理介面修改服務位址、快取、上游、網域、DNS 記錄及代理站台。

`/dns-query` 允許任何網頁來源進行無憑證的跨來源 DoH 查詢，回傳 `Access-Control-Allow-Origin: *`，並接受 `OPTIONS` preflight。非 `/dns-query` 路徑不開放 CORS；管理 API 的認證與 CSRF 邊界不受影響。

## 單檔啟動

從最新 Release 下載 `index.js` 後執行：

```bash
node index.js
```

Bootstrap 會從本倉庫最新 Release 取得 manifest，依 Node ABI／平台／架構選擇 `better-sqlite3` native binding，同時校驗 runtime 與 binding 的 SHA-256 並快取至 `data/runtime`。正式 Release 提供 Node 20、22、24 對應 ABI 的 Linux glibc x64／arm64 六組 binding。可使用 `APP_MANIFEST_URL` 指向其他 HTTPS manifest。網路不可達時會重新校驗最後有效 runtime 與 binding；沒有有效快取時啟動內嵌 fallback，提供自訂 A/AAAA、UDP/TCP DNS 與 DoH，但不提供管理介面及反向代理。

## 可觀測性

- SQLite 資料庫位於 `data/operations.sqlite`，採 WAL、schema migration、應用程式識別與 downgrade guard。設定仍以 `data/config.json` 為可攜來源。
- Prometheus 預設只監聽 loopback 的 `9090`。若要公開 metrics，應先經受信代理與網路存取控制，不要直接暴露至公網。
- 完整操作日誌位於 `data/logs/operations-YYYY-MM-DD.jsonl`，包含 client IP、DNS 名稱與代理 URL，預設保留 30 天，必須視為敏感資料。
- Webhook 告警使用 HMAC event id，工作持久化於 SQLite，採指數退避；超過 24 小時進 dead-letter，可在管理介面重送。

## 備份與還原

管理介面的「可觀測性」頁可預覽、建立、下載、匯入、驗證、還原及刪除備份。排程依主機本機時區每日 03:00 建立 daily 備份，保留 7 份；週日另建立 weekly 備份，保留 4 份。

備份位於 `data/backups`，ZIP 內含 `config.json`、`admin.json`、SQLite online backup、JSON 日誌與逐檔 SHA-256 manifest，預設排除 proxy cache 與 runtime cache。**備份是明文最高敏感資產，包含密碼雜湊、Tunnel token、完整操作資料及未來 API token；只能交由主機 owner 保存，傳輸與離站保存必須另行加密。**

還原會先在維護模式外驗證 ZIP 路徑、大小、manifest、SHA 與 schema，再短暫暫停 DNS、DoH、proxy、metrics 與排程；成功後重新載入設定並恢復服務，任何檔案替換失敗會自動還原進入維護模式前的完整快照。

## Docker Compose

Docker image 使用 Debian bookworm、固定非 root UID/GID `10001`、唯讀 root filesystem、持久 data volume、健康檢查與 SIGTERM graceful stop：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f s12-dns-server
```

`docker-compose.yml` 預設將 metrics 只發布至主機 `127.0.0.1:9090`。升級前先從 UI 建立並下載備份；升級可拉取／建置新 image 後重新 `docker compose up -d`。若健康檢查失敗，切回先前 image tag並還原升級前備份。

## systemd

在 Debian/Ubuntu 類 Linux 上，以 root 從專案目錄執行：

```bash
sh deploy/systemd/install.sh
systemctl status s12-dns-server
journalctl -u s12-dns-server -f
```

安裝器建立 `s12-dns` 專用帳號、`0700` 的 `/var/lib/s12-dns-server`，將 bootstrap 放至 `/opt/s12-dns-server`，並啟用具檔案系統與核心硬化的 service。升級或回滾時先備份，再替換 `/opt/s12-dns-server/index.js` 並 `systemctl restart s12-dns-server`；若新版本健康檢查或 migration 失敗，還原舊 `index.js` 與備份。

## Cloudflare Tunnel

在 Cloudflare 建立 remotely-managed tunnel，將公開 hostname 指向本機 DoH，例如 `http://localhost:8053`。建議以環境變數提供 token：

```bash
CLOUDFLARE_TUNNEL_TOKEN=your-token node index.js
```

Windows PowerShell：

```powershell
$env:CLOUDFLARE_TUNNEL_TOKEN = "your-token"
node index.js
```

無法設定啟動環境變數的面板，可在管理介面的 Tunnel 頁儲存 token，或在服務停止時設定 `data/config.json`：

```json
{
  "tunnel": {
    "token": "your-token"
  }
}
```

`CLOUDFLARE_TUNNEL_TOKEN` 永遠優先於設定檔；環境 token 存在時，設定檔值只作備援。管理 API 與 UI 不會回傳 token 明文，只顯示目前來源及是否已有備援。若以新設定檔 token 重啟 Tunnel 失敗，服務會回滾舊值並嘗試恢復原連線，不影響 DNS、DoH、代理及管理核心。

設定檔 token 是本機明文機密。請限制 `data/config.json` 的檔案權限、備份範圍及面板檔案瀏覽權限；能使用環境變數時仍應優先使用環境變數。

## DNS 與網域管理

網域工作區不會修改註冊商、NS 或 Cloudflare DNS。它用來在 S12 內集中管理網域、相對名稱、DNS 記錄與所屬代理站台：

- DNS 頁面先選取網域，再顯示依最長後綴直接歸屬該工作區的記錄；父網域不會混入子網域工作區的記錄。
- 未屬於任何工作區的完整 FQDN 可從「未分組記錄」入口管理；未選取工作區時不開放新增記錄。
- 名稱可使用 `@`、`www`、`*`、`_service._tcp` 或工作區內的完整 FQDN。
- 子網域依最長後綴歸類；停用父網域會暫停整棵子網域及所屬 DNS／代理，但保留各子項原本的啟用狀態。
- 網域重新命名與整棵刪除會原子更新或移除相關 DNS 名稱、CNAME 目標、代理 Host 及 aliases；衝突時不會部分寫入。
- DNS 診斷支援 A、AAAA、CNAME、MX、TXT、NS、SRV，顯示 rcode、命中來源與完整答案鏈，不會修改設定。
- DNS 名稱必須精確匹配。若記錄為 `awa.example.com CNAME target.example`，查詢 `example.com` 不會自動猜測 `awa`，沒有根記錄時回 NXDOMAIN 是預期結果。
- 管理介面新增或修改已啟用記錄後會立即熱更新解析器並原子持久化，不需要重新啟動 S12。
- 每個工作區同時是可編輯的 Primary Zone，具自動遞增 SOA serial；區域內不存在名稱回 NXDOMAIN，名稱存在但類型不存在回 NODATA，兩者都帶 authority SOA。
- Zone file 支援 `$ORIGIN`、`$TTL`、SOA、A、AAAA、CNAME、MX、TXT、NS、SRV 的預覽式 merge／replace 匯入，以及穩定可重匯入的 BIND 格式匯出。
- DNS Policy 可依 exact／suffix／wildcard 名稱、qtype、client CIDR、星期、時段與 IANA 時區執行 NXDOMAIN、REFUSED、A／AAAA 或 CNAME 動作；HTTPS Hosts 清單訂閱使用 last-known-good 原子快取，更新失敗不影響解析。

## 代理站台

代理不會因 DNS 記錄存在而自動公開。每個站台必須明確建立，且可設定主要 Host、精確 alias 或 `*.example.com` wildcard alias。每個站台支援精確及最長前綴 path location：

- location 可代理至一個或多個 HTTP(S) target，或由自訂 A/AAAA 記錄推導目標；也可回傳 301、302、307、308 redirect。
- rewrite 支援 strip prefix 或 replace prefix；request/response header 可使用受控 set/remove 及安全白名單變數，不執行任意表達式。
- 多上游採 smooth weighted round-robin，主動健康檢查與被動斷路器共同隔離故障；可設定明確備援池，安全方法自動切換，寫入方法需明確允許。
- HTTPS upstream 支援 pooled HTTP/2 與自動降級 HTTP/1.1；Shadow traffic 可取樣鏡像至獨立上游，剝除敏感 headers，且不等待、不重試、不影響主要回應。
- 站台維護模式回傳 503／Retry-After；站台或單一 upstream 可暫態排空、恢復及中止既有 HTTP／WebSocket 連線。WebSocket 可限制連線數、閒置時間與排空寬限。
- 管理介面顯示主動／被動健康、延遲、斷路器與 30 天 SQLite 狀態歷史，並提供站台及 upstream 排空控制。
- 每個 location 可設定 request body 上限、IP allow/deny、記憶體 rate limit、持久 proxy cache 與壓縮。預設 body 上限為 10 MiB、rate limit 與 cache 關閉。
- proxy cache 位於 `data/proxy-cache`，預設全域上限 1 GiB；遵守 `Cache-Control` 與 `Vary`，不快取含 Authorization、Cookie、Set-Cookie、private 或 no-store 的回應。
- 對可壓縮且至少 1 KiB 的未壓縮回應，依 `Accept-Encoding` 協商 Brotli 或 gzip。

本機不終止 TLS；對外 HTTPS 建議由 Cloudflare Tunnel 或其他受信任入口處理。

## 開發與驗證

```bash
npm test
npm run test:e2e
npm run lint
npm run build
```

`npm run build` 產生：

- `dist/index.js`：標準庫單檔 bootstrap。
- `dist/runtime.cjs`：包含管理 UI 的完整 runtime bundle。
- `dist/manifest.json`：版本、runtime URL 與 SHA-256。
- `dist/better-sqlite3-node-v<ABI>-<platform>-<arch>.node`：本機開發 binding；tag Release 另由 `scripts/native-bindings.js` 驗證並組裝六組正式 Linux binding。

## 安全邊界

- 管理介面預設開放區網，部署者應使用防火牆限制可信網段。
- `data/config.json` 可包含 Cloudflare Tunnel token，必須視為機密檔案並限制存取。
- 只有 direct peer 位於 `proxy.trustedProxyCidrs` 時才信任 `X-Forwarded-For`；預設只信任本機 loopback。
- 磁碟 proxy cache 可能保存上游公開回應內容；應將 `data/proxy-cache` 納入主機資料保護與容量監控。
- DNSSEC 僅透傳，不在本機驗證。
- 不支援 AXFR/IXFR、RFC 2136 動態更新或本機 TLS 憑證管理。
- 即時事件在記憶體最多保留 500 筆；完整 DNS 名稱、client IP 與代理 URL 另依可觀測性契約寫入 owner-only JSON 日誌，預設保留 30 天。

## 授權

本專案採 [GNU Affero General Public License v3.0 or later](LICENSE) 授權，SPDX：`AGPL-3.0-or-later`。
