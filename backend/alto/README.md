# alto bundler（自架於 Railway）

```
Railway service: alto
URL:             https://alto-production-c309.up.railway.app
image:           ghcr.io/pimlicolabs/alto:v1.2.5
```

## 為什麼 pin v1.2.5

v1.2.8 的 `SafeValidator` 對 EntryPoint v0.7 **是壞的**：它用零 error 條目的
`pimlicoSimulationsAbi` 做 `decodeErrorResult`，導致任何 UserOp 都失敗。
v1.2.8 + `safe-mode=false` 雖然能跑，但那等於用「不強制 ERC-4337 規則」的環境驗證護欄 ——
實測 v1.2.5 + `safe-mode=true` 能正確擋下偽造簽章（`AA23 reverted - 0x8baa579f`，OZ `ECDSA.InvalidSignature()`）。
完整驗證見 `spike/alto/V125-VERDICT.md`。

## 為什麼用 entrypoint 轉參數而不掛 config 檔

Railway 的 image 部署沒有地方放檔案，而 v1.2.5 的 `--config` 需要實際路徑。
`entrypoint.sh` 把環境變數轉成 CLI flags（v1.2.5 全部支援），機密留在 Railway Variables。

## 部署

```bash
cd backend
railway up ../alto --path-as-root -d --service alto --no-gitignore
```

⚠ `--path-as-root` 必要：`railway up` 預設上傳「連結時的專案根目錄」。

## 環境變數

| 變數 | 說明 |
|---|---|
| `RPC_URL` | BSC 主網 RPC |
| `EXECUTOR_PRIVATE_KEY` | 送 bundle 的錢包（需 BNB）。**目前與部署者共用，正式前要拆開** |
| `SAFE_MODE` | 預設 `true`；關掉等於不強制 ERC-4337 驗證規則 |
| `MIN_EXECUTOR_BALANCE` | refill 門檻，預設 0.02 BNB（BSC 上 1 BNB 太高） |

## 已知限制

* `--deploy-simulations-contract` 會在啟動時部署一個 helper 合約（花一點 gas）
* publicnode 對 archive 查詢需要 token，某些 debug 端點會 403
