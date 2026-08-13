# 效能與24小時驗收手冊

## 固定門檻

v1正式門檻為：

- 100,000 DNS records。
- 1,000 proxy sites。
- DNS 5,000 QPS。
- proxy 1,000 RPS。
- 24 小時 soak。
- DNS與proxy error rate各不超過0.1%。
- core interruption為0，維運設定替換至少執行一次且失敗為0。

正式證據只接受Linux glibc x64與release profile。Windows短測、一般CI smoke與scale profile的`formal:false`即使passed也不能替代正式驗收。

## Profiles

| Profile | Dataset | Target | Duration | Formal |
| --- | --- | --- | --- | --- |
| `ci` | 1,000 records / 100 sites | 500 QPS / 100 RPS | 30秒 | `formal:false` |
| `scale` | 100,000 / 1,000 | 5,000 / 1,000 | 30秒 | `formal:false` |
| `release` | 100,000 / 1,000 | 5,000 / 1,000 | 24 小時 | `formal:true` |

## 執行

CI smoke：

```bash
npm run benchmark:ci
```

正式規模短測：

```bash
npm run benchmark:scale
```

正式v1驗收：

```bash
npm run benchmark:release
```

release duration由程式固定，不能用環境變數縮短後仍標示formal。命令依固定牆鐘每秒啟動負載區間，將請求均勻分散於區間內，並以10%發送headroom補償timer與收尾誤差；前一區間的慢尾端可短暫重疊，發送窗口結束後才等待全部已啟動工作收尾。DNS負載使用8個UDP client socket輪詢分片與總concurrency 128，避免負載產生器自身的突發接收佇列成為瓶頸。延遲採固定大小的1ms直方圖計算p95，記憶體不會隨24小時請求數成長。輸出使用owner-mode原子JSON寫入`benchmark-results`。

## 報告判讀

報告包含environment、dataset、DNS/proxy requests/errors/throughput/p95、soak duration、core interruptions、operational runs/failures與`formal`。`passed:true`只表示該profile門檻通過；只有release報告同時`formal:true`、Linux glibc x64、24小時與所有固定門檻通過，才可作v1 Release正式證據。

正式報告應隨Release保存，並記錄硬體、Node版本、commit、tag及runtime digest。任何中斷、維運失敗、未達QPS/RPS、超過error rate或不足24小時均必須重跑完整驗收，不得拼接多次短測。

## 失敗處理

第一次v1候選formal soak在Linux運行約11小時25分後，因負載工具把每筆延遲永久保存在陣列而觸發V8 heap OOM。該次執行沒有原子報告，已明確判定失敗且不得與後續結果拼接。修復以固定60,002個bucket的直方圖取代無界陣列，100,000,000筆合成樣本的heap增量驗證為4,280 bytes；同時將每秒請求平滑發送，避免UDP突發丟包。修復後Linux scale profile達DNS 5,073.79 QPS、proxy 1,014.76 RPS、DNS錯誤率0.0455%、核心中斷0，通過重新啟動24小時formal soak的前置閘門。

第二次候選`ca4392b70ad86da07a76d582e639173e7ac09525`完整運行24小時並產生原子報告，但序列等待每一秒區間收尾，僅啟動66,525個區間，造成DNS 4,234.78 QPS、proxy 846.96 RPS且DNS錯誤率0.221389%，因此`passed:false`且不得發布。固定牆鐘排程修復後，以1／4／8 socket和concurrency 128／512的Linux診斷矩陣確認高錯誤來自client concurrency 512；固定8 socket與總concurrency 128的30秒scale前置閘門完成DNS 165,000次、0 error、5,500.00 QPS、p95 25ms，以及proxy 33,000次、0 error、1,100.00 RPS、p95 18ms，核心中斷與維運失敗均為0。
