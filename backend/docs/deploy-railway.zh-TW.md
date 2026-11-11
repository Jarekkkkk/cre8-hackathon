# 部署到 Railway（server + DB + 排程器）

## 為什麼要三個 service

| Service | 啟動指令 | 為什麼不能合併 |
|---|---|---|
| **api** | `bun src/index.ts` | 需要常駐、對外、healthcheck |
| **scheduler** | `bun run scripts/scheduler.ts --loop --live --interval 60 --limit 20` | **必須是獨立進程**：它會長時間佔住一輪（每輪 40–80 秒），跟 API 共用進程會拖慢請求；而且它要能被單獨重啟 |
| **db** | Railway Postgres | `DATABASE_URL` 由平台注入 |

> ⚠ scheduler 的 `--live` 是真正送交易的那個開關。部署時**先不要加**：先跑 `--loop`（dry-run）
> 看一輪的計數（`/operator` 頁面的 `last round`），確認 `claimed/executed` 符合預期再加上 `--live`。

## 環境變數（api 與 scheduler 都要）

```
DATABASE_URL=            # Railway 注入
CHAIN_ID=56              # 主網；本機 fork 是 1337
RPC_URL=                 # BSC RPC（建議付費/有 archive 的）
BUNDLER_URL=             # alto 或第三方 bundler
REGISTRY_ADDRESS=
EXECUTOR_ADDRESS=
OPERATOR_PRIVATE_KEY=    # ← secret
SESSION_KEY_MASTER_SEED= # ← secret
AUTH_DOMAIN=             # SIWE 的 domain
AUTH_URI=                # SIWE 的 uri
ENABLE_OPERATOR_REBALANCE=true
```

**Secret 放 Railway Variables（等同 secret manager），不要放進 repo**。
`.env` 已在 `.gitignore`；`backend/.env.fork` 也是。

## 排程器的健康狀態從哪裡看

`/operator` 頁面的 `scheduler` 列：

```
scheduler   [alive] · LIVE · every 60s · limit 20 · threshold 100 bps · round 137 · pid 1
last round  claimed 3  executed 2  noop 1  blocked 0  failed 0   · finished 42s ago
```

心跳落後超過 **180 秒**（`HEARTBEAT_STALE_SECONDS`）就會顯示 `stale` —— 那代表進程死了或卡住，
Railway 的 `restartPolicyType: ON_FAILURE` 會重啟它。

## ⚠ `railway up` 上傳的是「連結時的專案根目錄」，不是當前目錄

實測踩了很久：在 `.deploy/` 裡跑 `railway up`，上傳的卻是 `backend/`（`railway link` 記錄的根目錄），
於是 image 裡**永遠沒有 migration**，容器啟動時：

    ENOENT: no such file or directory, scandir '/app/migrations'

本地 `docker build` 完全正常，所以這個錯誤很容易被誤判成 Dockerfile 有問題。

正確做法（`--path-as-root` 讓 PATH 成為 archive 根）：

```bash
bun run scripts/prepare-deploy.ts                      # 產生 .deploy/（含 migrations）
railway up .deploy --path-as-root -d --service api     # 注意這三個參數
```

其他踩過的坑，一併記在這裡：

| 症狀 | 原因 |
|---|---|
| 部署到 Postgres 服務、把資料庫打掉 | `railway up` 預設部署到**已連結的服務**；建完 Postgres 後它就是唯一服務。**先 `railway add --service api`，再 `--service api`** |
| 上傳被過濾成空 | `.gitignore` 會參與上傳過濾；`.deploy/.gitignore` 若含 `.deploy/` 規則會把整個目錄排除 → 用 `--no-gitignore`，且 `prepare-deploy` 不複製 `.gitignore` |
| `railway` 一直 `Failed to set permissions on ~/.railway` | 沙箱不能寫家目錄 → `HOME=<可寫目錄> railway ...` |
| `postgres.railway.internal` 解析失敗（本地） | Railway 私有網路只在平台內可解析；migration 必須由**容器**執行，不能當本機步驟 |

## ⚠ migration 不在容器裡跑（實測踩過）

`db/migrations` 住在**隔壁的 repo**（`cre8-protocol/db`），而 Docker / Railway 的 build context
只有 `backend/` —— image 裡沒有那些 .sql。所以：

* `Dockerfile` 設 `MIGRATIONS_ENABLED=0`
* migration 是**部署步驟**，用 Railway 的 DATABASE_URL 跑：

```bash
railway run bun run src/migrate.ts      # 用服務的環境變數跑（不需要把連線字串貼出來）
# 或
DATABASE_URL=<railway-postgres-url> bun run src/migrate.ts
```

`railway run` 是首選：它把 Railway 服務的環境變數注入本地指令，連線字串不必經過終端機歷史。

## 首次部署順序

1. 建 Postgres → 拿到 `DATABASE_URL`
2. **先跑 migration**：`railway run bun run src/migrate.ts`（在 image 部署之前跑也可以，
   migration 只依賴 DB）
3. 部署 **api** → `/health` 應回 `status: ok`
4. 部署 **scheduler**，先不帶 `--live`，確認 `/operator` 的 `last round` 有數字
5. 確認無誤後把 `--live` 加上，並觀察第一輪的 `executed`

## 部署前後都要跑一次

```bash
MIGRATIONS_ENABLED=0 railway run bun run scripts/preflight.ts --strict
```

`--strict`：任何 warn 都算失敗（主網不接受「知道但先不管」）。它會檢查
RPC 的 chainId 是否與 CHILD_ID 一致、合約位址上是否真的有 code、registry owner 是不是
單一 EOA、executor.oracle 是否為零位址、DB migration 套了幾個。
