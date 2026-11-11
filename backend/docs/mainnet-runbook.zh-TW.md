# 主網上線 Runbook

> 這份文件回答一個問題：**什麼時候需要你動手**。
> 每一步都寫清楚「我做什麼」與「你需要做什麼」。沒寫「需要你」的步驟，我自己做完。

---

## 階段 0 · 本地可完成（不需要你）

| 項目 | 狀態 |
|---|---|
| 起飛前檢查腳本 `scripts/preflight.ts` | ✅ 完成 |
| Dockerfile + railway.json | ✅ 完成 |
| migration 0018（scheduler_status） | ✅ 完成 |
| 文件（pitfalls / decisions / mainnet-todo） | ✅ 完成 |

做完這階段，你會得到一支可以在任何環境跑的檢查：

```bash
bun run scripts/preflight.ts          # 開發環境：warn 不擋
bun run scripts/preflight.ts --strict # 主網：任何 warn 都算失敗
```

**實測（本機 1337 fork）**：`16 ok · 1 warn · 0 fail`

---

## 階段 1 · 需要你：建立 Railway 專案與 Postgres

### 你需要做

1. Railway → New Project → **Deploy PostgreSQL**
2. 從 Postgres 服務的 Variables 複製 `DATABASE_URL`
3. 把 `DATABASE_URL` 貼給我（或直接填進 Railway 的 Variables）

### 為什麼需要你

Railway 的登入與計費綁在你帳號上，我無法代辦。

### 我在你完成後做

- 確認 `DATABASE_URL` 可用
- 跑 `bun run src/migrate.ts` 套用 18 個 migration
- 回報 schema 是否完整

**這個階段還不要設定 secrets** —— 等 api 服務建好再一次填，避免填兩次。

---

## 階段 2 · 需要你：建立 api 服務（我第一次需要你貼東西）

### 你需要做

1. Railway → New Service → **Deploy from GitHub repo** → 選 `cre8-protocol/backend`
2. Railway 會自動讀 `railway.json` 與 `Dockerfile`（我已放好，不用改設定）
3. **先不要 deploy** —— 先把下列 Variables 填進去（見下面清單）

### Variables 清單（api 服務）

必填：

```
DATABASE_URL          （階段 1 拿到的，Railway 會自動引用）
CHAIN_ID=56
RPC_URL=<BSC 主網 RPC>          ← 要付費/有 archive 的
BUNDLER_URL=<主網 bundler>
REGISTRY_ADDRESS=<部署後拿到>
EXECUTOR_ADDRESS=<部署後拿到>
OPERATOR_PRIVATE_KEY=0x...      ← secret
SESSION_KEY_MASTER_SEED=0x...   ← secret（32 bytes 隨機）
AUTH_DOMAIN=<你的網域>
AUTH_URI=https://<你的網域>
ENABLE_OPERATOR_REBALANCE=true
```

選填（有預設值）：

```
PORT=8081                       （Railway 會注入 $PORT，程式會讀）
MIN_SESSION_GAS_WEI=...         （預設見 src/config.ts）
```

### 我需要你提供給我的（只有這兩項是秘密）

| 項目 | 用途 | 你可以怎麼做 |
|---|---|---|
| `SESSION_KEY_MASTER_SEED` | 派生所有 session key | **你自己產生**（見下方指令），只貼給我或直接填 Railway |
| `OPERATOR_PRIVATE_KEY` | 部署合約、approve、初始 enroll | 建議用**新錢包**，只放少量 BNB |

產生 seed：

```bash
openssl rand -hex 32 | sed 's/^/0x/'
```

### 我會在你完成後做

- 跑 `bun run scripts/preflight.ts --strict`
- 回報每一項檢查結果，包含 `registry owner` 與 `executor.oracle` 是否正確

---

## 階段 3 · 需要你：部署合約到 BSC 主網

### 你需要做

1. 確認營運錢包有足夠 BNB（部署 + 後續 approve，建議先放 0.5 BNB）
2. 告訴我「可以部署了」

### 我會做

```bash
cd cre8-contracts
forge script script/DeployAtp.s.sol --rpc-url $RPC_URL --broadcast --verify
```

拿到 `REGISTRY_ADDRESS` 與 `EXECUTOR_ADDRESS` 後，填回 Railway Variables，
然後再跑一次 `preflight --strict`。

### ⚠ 這一步之前，我會先跟你確認兩件事

1. **pool fee tier** —— 主網的 TSLAB/SPCXB/BTCB/ETH 對 WBNB 的池子是否存在、fee 是多少
   （fork 上我們用 2500/2500/500/500，主網可能不同）
2. **是否先跑測試網**（BSC testnet）—— 如果池子不存在，主網部署完會發現沒有流動性可用

---

## 階段 4 · 需要你：建立 scheduler 服務

### 你需要做

1. Railway → New Service → 同一個 repo，但 **Command 改成**：

```
bun run scripts/scheduler.ts --loop --interval 60 --limit 20
```

（**先不要加 `--live`**）

2. Variables 與 api 服務**完全相同**（可以直接 duplicate service）

### 我會做

- 確認 `/operator` 頁面的 `scheduler` 顯示 `alive · dry-run`
- 看 `last round` 的 `claimed` 數字是否合理
- 確認無誤後，**你**把 `--live` 加上去

### 為什麼最後一步要你做

`--live` 是真的會送交易、動真錢的開關。這個切換應該由你決定時機，不是我。

---

## 階段 5 · 第一筆真錢（需要你）

### 你需要做

1. 準備一個**乾淨的測試錢包**，放 20 USDT + 0.05 BNB
2. 用那個錢包連上線上的前端，走一次 deposit

### 我會做

- 盯著 `/operator` 的 `Recent activity`
- 對帳：deposit 金額、swap 後的持倉、gas 消耗
- 確認 `drift` 收斂到門檻內

### 驗收標準

```
✓ deposit 上鏈且金額正確
✓ 第一次 rebalance 自動觸發（或在你按 Run round 後執行）
✓ 五檔持倉的 current bps 都貼近 target bps
✓ gas 消耗在預期內（< 0.005 BNB / 輪）
✓ 沒有 critical alert
```

---

## 需要你動手的總表

| 階段 | 你的動作 | 大約時間 |
|---|---|---|
| 1 | 建 Railway project + Postgres，給我 `DATABASE_URL` | 5 分鐘 |
| 2 | 建 api service，填 Variables（含兩個 secret） | 10 分鐘 |
| 3 | 確認營運錢包有 BNB，說「可以部署」 | 2 分鐘 |
| 4 | 建 scheduler service（先不 `--live`），確認後自己加 `--live` | 10 分鐘 |
| 5 | 用測試錢包走一次 deposit | 5 分鐘 |

其餘（migration、preflight、部署合約、對帳、debug）我做。

---

## 卡住時怎麼辦

| 症狀 | 看哪裡 |
|---|---|
| api 起不來 | Railway 的 Deploy Logs；`preflight` 的 `config 載入` 那行 |
| `signature invalid` | `preflight` 的 `RPC 的 chainId` —— 不一致時 UserOp 簽章會無聲失敗 |
| `V3TooLittleReceived` | oracle 綁到了沒有流動性的池子（見 pitfalls §oracle-pool） |
| 排程器顯示 `stale` | 心跳落後 > 180 秒；看 scheduler 服務的 log |
| 錢到了但沒配置 | `next_run_at` 還沒到（24 小時）；用 `/operator` 的 `Run round` |
