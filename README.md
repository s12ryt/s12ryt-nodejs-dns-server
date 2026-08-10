# S12 DNS Server

自架的 Node.js DNS 控制台，整合 UDP/TCP DNS、RFC 8484 DoH、自訂記錄、多上游容錯、HTTP/WebSocket 反向代理與 Cloudflare Tunnel 管理。支援 Node.js 20 以上版本，以及 Windows、Linux、macOS。

## 功能

- 自訂 A、AAAA、CNAME、MX、TXT、NS、SRV 記錄、TTL、精確名稱與萬用名稱。
- Cloudflare、Google DoH 依序容錯，以及有界 LRU/TTL 快取。
- 同埠 UDP/TCP DNS 與 `/dns-query` DoH GET/POST。
- 依 Host 路由至 HTTP(S) URL，或由自訂 A/AAAA 記錄推導目標；支援 WebSocket。
- 首次一次性 token 設密、PBKDF2、HttpOnly session、CSRF 與登入限速。
- 響應式深淺色管理介面，提供核心服務健康摘要、即時操作回饋、鍵盤導覽，以及 cloudflared 下載、校驗、啟停與日誌。
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

設定會原子寫入 `data/config.json`。可從管理介面修改服務位址、快取、上游、DNS 記錄及代理路由。

## 單檔啟動

從最新 Release 下載 `index.js` 後執行：

```bash
node index.js
```

Bootstrap 會從本倉庫最新 Release 取得 manifest，校驗完整 runtime 的 SHA-256 並快取至 `data/runtime`。可使用 `APP_MANIFEST_URL` 指向其他 HTTPS manifest。網路不可達時會重新校驗最後快取；沒有有效快取時啟動內嵌 fallback，提供自訂 A/AAAA、UDP/TCP DNS 與 DoH，但不提供管理介面及反向代理。

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

## 代理路由

代理不會因 DNS 記錄存在而自動公開。每個 Host 必須明確建立 route，可使用：

- 完整 target：`http://127.0.0.1:3000` 或 `https://service.internal`。
- DNS 派生：指定 `dnsName`、`scheme` 及 `port`，目標 IP 由自訂 A/AAAA 記錄取得。

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

## 安全邊界

- 管理介面預設開放區網，部署者應使用防火牆限制可信網段。
- `data/config.json` 可包含 Cloudflare Tunnel token，必須視為機密檔案並限制存取。
- DNSSEC 僅透傳，不在本機驗證。
- 不支援 AXFR/IXFR、RFC 2136 動態更新或本機 TLS 憑證管理。
- 即時事件只保留於記憶體，最多 500 筆；不永久保存 DNS 查詢內容。

## 授權

本專案採 [GNU Affero General Public License v3.0 or later](LICENSE) 授權，SPDX：`AGPL-3.0-or-later`。
