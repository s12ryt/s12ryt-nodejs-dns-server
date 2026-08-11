# 管理 API 手冊

## 發現與版本

OpenAPI 3.1 文件位於：

```text
GET /api/v2/openapi.json
```

正式整合應使用 `/api/v2`。`/api/v1/config`、`/api/v1/status`、`/api/v1/events`、`/api/v1/tunnel` 僅提供唯讀相容期，回應含 `Deprecation` 與 successor link。管理 UI 使用的未版本化 `/api/*` 保留相容，但不是新整合的首選。

## 認證與授權

- 瀏覽器使用 HttpOnly session cookie；所有寫入另需 `X-CSRF-Token`。
- 自動化使用 `Authorization: Bearer <token>`；Bearer 不使用 CSRF，但同時受使用者角色、token scope、期限與撤銷狀態限制。
- owner-only 的敏感備份下載、敏感日誌、審計匯出與診斷包不能透過自訂角色或 Bearer token 擴權。

API token 明文只在建立當次回傳，應立即轉存至可信密鑰管理系統。

## 標準錯誤

v2 錯誤格式：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Readable message",
    "requestId": "request-id"
  }
}
```

回應同時帶 `X-Request-Id`。請保存 request id，用於對照 JSON 日誌與審計紀錄。

## 分頁與過濾

列表使用 `limit` 與 `offset`，回應結構為：

```json
{
  "data": [],
  "meta": {
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 0
    }
  }
}
```

可用過濾條件依 OpenAPI path 定義，例如使用者 role/enabled 與審計 action/resource/time window。

## 冪等寫入

v2 建立或其他指定寫入必須提供 8–128 字元 `Idempotency-Key`：

```http
Idempotency-Key: deploy-2026-08-12-role-001
```

同 actor、key 與相同 method/path/body 會完整重播先前結果，並帶 `idempotency-replayed: true`。相同 key 配不同 request fingerprint 回 409；pending request 不會被平行重做；操作失敗會放棄 reservation，允許修正後重試。

## 範例

```bash
curl -H "Authorization: Bearer $S12_TOKEN" \
  "http://127.0.0.1:8081/api/v2/users?limit=50&offset=0"
```

```bash
curl -X POST \
  -H "Authorization: Bearer $S12_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: create-role-001" \
  --data '{"id":"dns-editor","name":"DNS Editor","permissions":["dns:read","dns:write"]}' \
  http://127.0.0.1:8081/api/v2/roles
```

主要v2資源包括 users、roles、DNS zones、proxy sites、Tunnel狀態、backups與audit。以實際 `/api/v2/openapi.json` 作為欄位、scope及狀態碼的機器可讀依據。
