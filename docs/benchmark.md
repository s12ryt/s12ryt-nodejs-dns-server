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

release duration由程式固定，不能用環境變數縮短後仍標示formal。命令以5%發送headroom補償排程誤差，輸出owner-mode原子JSON到`benchmark-results`。

## 報告判讀

報告包含environment、dataset、DNS/proxy requests/errors/throughput/p95、soak duration、core interruptions、operational runs/failures與`formal`。`passed:true`只表示該profile門檻通過；只有release報告同時`formal:true`、Linux glibc x64、24小時與所有固定門檻通過，才可作v1 Release正式證據。

正式報告應隨Release保存，並記錄硬體、Node版本、commit、tag及runtime digest。任何中斷、維運失敗、未達QPS/RPS、超過error rate或不足24小時均必須重跑完整驗收，不得拼接多次短測。
