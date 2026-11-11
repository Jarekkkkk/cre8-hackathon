# 操作手冊（Runbook）

最後更新：2026-11-06

從零到「跑完一次端到端驗證」的完整步驟。所有指令都假設工作目錄是 `/Users/jareklin/dev/main/cre8-protocol`。

---

## 0. 三個 repo 與工作區

| repo | 路徑 | 工具鏈 | git |
|---|---|---|---|
| cre8-contracts | `./cre8-contracts` | Foundry | 獨立 repo |
| backend | `./backend` | Bun | 獨立 repo |
| db | `./db` | SQL | 獨立 repo |

⚠ `cre8-protocol/` **本身不是 git repo**。在它底下跑 `git status` 會 `fatal: not a git repository`。要檢查改動請進各自的子目錄。

---

## 1. Postgres

```bash
docker start cre8-postgres 2>/dev/null || docker run -d --name cre8-postgres \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=cre8_atp \
  -p 5432:5432 -v cre8-postgres-data:/var/lib/postgresql/data postgres:16-alpine
```

連線字串：`postgres://postgres:postgres@127.0.0.1:5432/cre8_atp`

## 2. 只測 API（不碰鏈）

```bash
cd backend && bun install && bun run migrate && bun test
```

預期：**120 pass / 1 skip / 0 fail**，`bun run typecheck` exit 0。

> 那 1 個 skip 是鏈上整合測試，它要求 `DATABASE_URL` 與 **`RPC_URL` 都不為空**。`backend/.env` 的 `RPC_URL` 是空的，所以預設會 skip —— **這是正常的，不是失敗**。

---

## 3. anvil fork（鏈上開發環境）

### 3.1 第一次啟動

```bash
/Users/jareklin/.foundry/bin/anvil \
  --fork-url https://bsc-rpc.publicnode.com \
  --chain-id 56 --port 8545
```

⚠ **不要給 `--fork-block-number`** —— 指定舊塊號會讓 anvil 開機抓 dev account 時就 403 退出。

⚠ `--chain-id 56` 不能省。anvil 預設會把 chainId 改成 31337，而 viem client 綁了 `chain: bsc`（56），會 chain mismatch。

### 3.2 定期刷新（**每約 55 分鐘**）⚠ 最容易忘

```bash
bash backend/scripts/refresh-anvil.sh
```

腳本會：dump 當前 state → 停舊 anvil → 起新 anvil（fork 最新塊）→ loadState → 驗證 3 項 → 印出下次建議刷新時間。

**為什麼需要**：anvil 拿自己釘住的塊號去問上游，那個塊一舊就被判 archive → 冷位址查詢 403。publicnode 的窗口約 75 分鐘。詳見 [pitfalls §2.1](./pitfalls.zh-TW.md)。

**症狀**（該跑腳本了）：
```
failed to get account for 0x...: HTTP error 403 ... "Archive requests require a personal token"
```

可設定參數：`ANVIL_PORT`（預設 8545）、`BSC_RPC_URL`（預設 publicnode）、`FOUNDRY_BIN`。

### 3.3 部署自家的 Atp 合約（**大部分時候不需要**）

⚠ **不要跑 `cre8-contracts/scripts/deploy-fork.sh`。** 它每次執行都起一個**全新的** anvil fork 並覆寫 `deployments/fork.json` —— 現有 registry 與已部署帳戶會全部消失，DB 的 `strategies.onchain_id` 全部失效。

若真的需要重新部署：
```bash
cd cre8-contracts
/Users/jareklin/.foundry/bin/forge script script/DeployAtp.s.sol \
  --rpc-url http://127.0.0.1:8545 --broadcast --skip-simulation \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```
然後從 `broadcast/DeployAtp.s.sol/56/run-latest.json` 取地址（**不要硬編碼**，每次不同），並同步更新 `deployments/fork.json` 與 backend 的 `REGISTRY_ADDRESS`，還要重建 DB 的 `strategies.onchain_id`。

**Anvil 的私鑰是公開測試金鑰，只用在本地 fork。** 本手冊中出現的 `0xac0974be…` 與 `0x59c6995e…` 都是公開的 anvil 預設帳號。

---

## 4. backend 接鏈

```bash
cd backend
DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/cre8_atp' \
RPC_URL='http://127.0.0.1:8545' \
OPERATOR_PRIVATE_KEY='0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' \
REGISTRY_ADDRESS='0x27739a1AD35a924F5545C7d04C2B0537069CA76C' \
EXECUTOR_ADDRESS='0x9C41696ea7FaA5470eAfb77415D063beEef83f4a' \
SESSION_KEY_MASTER_SEED='<32 bytes hex>' \
PORT=8081 AUTH_DOMAIN=localhost bun src/index.ts
```

**新增的兩個 env 只在 enroll 時用到**（`EXECUTOR_ADDRESS` 是 CallPolicy 的 target、`SESSION_KEY_MASTER_SEED` 是 session key 的 HD 派生種子）。未設時啟動不會失敗，但呼叫 `POST /portfolios` 會得到可診斷的錯誤 —— 見 [decisions D-17 / D-18](./decisions.zh-TW.md)。

⚠ **`SESSION_KEY_MASTER_SEED` 在 dev 用 env，production 必須進 KMS**。它洩漏等於所有 session key 洩漏，且**不可與 operator 私鑰共用**。

⚠ **PORT=8081**：另一個 `:8080` 的 backend 讀 `backend/.env`，那個檔沒有 `REGISTRY_ADDRESS`，所以 `rpcConfigured: false`（完全不接鏈）。驗證前先確認你打的是 8081。

健康檢查：`curl -s http://127.0.0.1:8081/health` → 應含 `"rpcConfigured":true,"db":"ok"`。

⚠ 目前的 registry 位址 `0x27739a1A…` 是**這個 anvil fork 專屬**的。fork 重啟或重新部署後必須更新，且 `fork.json` 才是權威紀錄。

---

## 5. 端到端驗證（本刀的主驗收）

```bash
cd backend
DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/cre8_atp' \
RPC_URL='http://127.0.0.1:8545' \
OPERATOR_PRIVATE_KEY='0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' \
REGISTRY_ADDRESS='0x27739a1AD35a924F5545C7d04C2B0537069CA76C' \
EXECUTOR_ADDRESS='0x9C41696ea7FaA5470eAfb77415D063beEef83f4a' \
SESSION_KEY_MASTER_SEED='0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' \
CHAIN_ID=56 VERIFY_WALLET='0x90F79bf6EB2c4f870365E785982E1f101E93b906' \
bun run scripts/verify-kernel-enroll.ts
```

⚠ **`VERIFY_WALLET` 要用「沒被 enroll 過」的錢包**。已 enroll 過的會被冪等 SELECT 命中，而那個 portfolio 可能沒有 `session_keys` 列（本刀之前的舊資料），`[5b]` 就會 FAIL。腳本預設用 anvil #2，那個已被前幾輪用掉 —— 請指定 #3（`0x90F7…b906`）或更新的。

⚠ **`SESSION_KEY_MASTER_SEED` 上面那組是 BIP32 標準測試向量**，只供驗證用，不是真隨機種子。

**成功標準：`35/35 checks PASSED`、exit 0。**

它會驗 35 項，分八段：
1. `[0]` session key env 是否齊備
2. `[1]` R1 探針：同 owner 兩次 deploy 只發 1 筆 tx
3. `[2]` 策略的鏈上事實是從 DB 讀的（不是硬編碼）
4. `[3]` `enrollPortfolio` 產生的 smart account
5. `[4]` 鏈上 `enrollments` / `isEnrolled` / `rootValidator` / `ecdsaValidatorStorage`
6. `[5]` `[5b]` DB 的 `account_type='KERNEL'`、小寫地址、以及 `session_keys` 的三層 policy 快照
7. `[6]` 冪等（第二次 enroll 0 tx / 0 列 / 0 session_keys 列）
8. `[7]` **權限真的裝上去了**：用 DB 快照重建 `initConfig` → 地址相符；不帶 `initConfig` → 地址不符；`permissionId` 三方一致（重建 == DB == 鏈上）；`permissionConfig.signer` 是簽章器**合約**（不是 session key EOA）

⚠ `[7]` 那段的判讀方式很容易寫錯，見 [pitfalls §3.8](./pitfalls.zh-TW.md)。

⚠ 若 R1a 失敗且錯誤是 `HTTP error 403 ... Archive requests`，那不是程式問題 —— 是 fork 過期了，跑 §3.2 的刷新。

### 其他驗證指令

```bash
# golden vector 回歸檢查（不需寫檔，只比對）
cd backend && bun run scripts/gen-kernel-golden.ts --check
# 預期 14/14 checks passed、exit 0

# 單元測試
cd backend && bun test && bun run typecheck

# 合約測試（需 BSC_RPC_URL 才有 fork 測試）
cd cre8-contracts && forge test
```

---

## 5.5 帳戶注資（session key 能不能動的前提）

**UserOp 的 gas 由 `sender`（smart account）自己付，不是簽名者付。** 所以帳戶沒有 BNB 就發不出任何 op，錯誤會是 `AA21 didn't pay prefund` 或 `Smart Account does not have sufficient funds` —— 對使用者毫無意義。見 [pitfalls §3.10](./pitfalls.zh-TW.md)。

### 查「現在能不能動」

`POST /portfolios`（以及冪等重打）的回應帶一個 `gas` 物件：

```json
"gas": {
  "address": "0x2b08…d042",        // ← 把 BNB 打到這裡（= smart account，不是 session key）
  "balanceWei": "999695781000000000",
  "minimumWei": "10000000000000000", // 0.01 BNB
  "ready": true,
  "shortfallWei": "0",               // ready 時為 "0"，否則就是還差多少
  "estimatedOps": 3998,              // 用當前 gas price 估算還能跑幾次
  "gasPriceKnown": true              // false = gas price 取不到，estimatedOps 是「未知」不是「跑不了」
}
```

`ready` 只看餘額是否 ≥ `minimumWei`，與 gas price 無關。`minimumWei` 由 `MIN_SESSION_GAS_WEI` 控制（預設 `1e16` = 0.01 BNB ≈ 33 次 op）。

### 本地注資（dev 用）

```bash
cd backend
OPERATOR_PRIVATE_KEY='0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' \
RPC_URL='http://127.0.0.1:8545' \
bun run scripts/fund-account.ts 0x2b082fadf8f3d620eaa242a9e36817af8640d042 0.05
```

它會印出轉帳前後餘額與 estimatedOps，未達門檻時 exit 1。

⚠ **這是 dev 工具。生產環境的注資必須由使用者自己發起** —— 否則就不是 non-custodial 了。

### 成本參考

實測一次 op 約 **0.0003 BNB**（gasUsed ≈ 250,000、BSC 有效 gas price ≈ 1.22 gwei）。存 1 BNB 約 3300 次。

⚠ **但存超過 1 BNB 的部分用不到** —— session key 的 GasPolicy 預算是 `1e18` wei（= 1 BNB 的 gas）且永不重置，會先被它擋。

---

## 5.6 Session key 續期（內部工具）

⚠ **這是內部運維工具，不是使用者介面。** 它需要帳戶的 **sudo owner 私鑰**（`SUDO_PRIVATE_KEY`），所以在 dev/fork 之外不能用 —— 生產環境必須走使用者自己的錢包簽名（尚未實作，見 [HANDOFF §3.2](./HANDOFF.zh-TW.md)）。

```bash
cd backend
SUDO_PRIVATE_KEY='<帳戶 owner 的私鑰>' \
OPERATOR_PRIVATE_KEY='0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' \
RPC_URL='http://127.0.0.1:8545' \
SESSION_KEY_MASTER_SEED='<seed>' \
bun run scripts/renew-session-key.ts --account 0x… --strategy-id 11 [--revoke-only 0x…]
```

### 它做什麼

1. 用 sudo key 簽一筆 UserOp，讓帳戶**自呼叫** `installValidations(...)` + `grantAccess(...)`
   （因為 `Kernel.sol` 的 `onlyEntryPointOrSelfOrRoot`，帳戶呼叫自己時 `msg.sender == address(this)` 才過）
2. 產生**新的** session key（新索引）與新 `validUntil` → 新的 `permissionId`
3. 驗證鏈上 `permissionConfig(新 id)` 存在且三層 policy 都在
4. 可選 `--revoke-only <permissionId>` 撤銷舊權限

### 關鍵性質

- **續期是疊加，不是取代。** 舊權限會留著直到它自己的 `validUntil` 到期（無害）。要立刻失效必須明確撤銷。
- **`permissionId` 每次都不一樣**（隨 session key、`validUntil`、policy 順序改變），不可寫死。
- **不要重新推導帳戶地址** —— 用 `createKernelAccount({ address })` 吃 DB 的權威值。原因見 [pitfalls §4.7](./pitfalls.zh-TW.md)。

### 已實證（在 anvil fork 上）

```
sudo key 簽的續期 op    tx 0x36cc409b…  success  gasUsed 569481
新 session key 執行     tx 0xb7eec44c…  success  ← 續期真的生效
撤銷舊權限              tx 0xaa3e30db…  success  → signer=0x0
```

---

## 6. alto（bundler，做 session key 才需要）

⚠ **必須用 v1.2.5**，v1.2.8 的 SafeValidator 對 EP v0.7 是壞的（見 [pitfalls §1.1](./pitfalls.zh-TW.md)）。

### 6.1 取 image

`docker pull ghcr.io/pimlicolabs/alto:v1.2.5` 會被拒（`denied: denied`，docker daemon 端問題，換乾淨 `DOCKER_CONFIG` 也一樣）。用附帶腳本：

```bash
cd spike/alto
ALTO_TAG=v1.2.5 python3 fetch-image.py     # 抓匿名 token → OCI manifest → blobs → docker-archive
docker load -i alto-v1.2.5-arm64.tar
```

### 6.2 啟動

設定檔 `spike/alto/alto-config-125.json`，關鍵欄位：

| 欄位 | 值 | 說明 |
|---|---|---|
| `rpc-url` | `http://host.docker.internal:8545` | **容器內 `127.0.0.1` 連不到 host** |
| `entrypoints` | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | EP v0.7 |
| `executor-private-keys` | anvil acct0 私鑰 | 必要 |
| `utility-private-key` | 同上 | refill 用 |
| `safe-mode` | **`true`** | 驗證規則必須開啟 |
| `port` | 3001 | 避開舊的 3000 |

```bash
docker run -d --name alto-125 -p 127.0.0.1:3001:3001 \
  -v "$PWD/spike/alto/alto-config-125.json:/cfg/alto-config-125.json:ro" \
  ghcr.io/pimlicolabs/alto:v1.2.5 --config /cfg/alto-config-125.json
```

確認：`curl -s -X POST http://127.0.0.1:3001 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_supportedEntryPoints","params":[]}'`

⚠ v1.2.5 **沒有** `network-name` / `enable-cors` / `block-time`（那是 v1.2.8 才有的鍵）。把 v1.2.8 的設定檔直接餵 v1.2.5 會帶進無效鍵。

### 6.3 送 op 與驗證

```bash
cd spike/alto && bun run send-userop-125.ts
```

⚠ **判斷 op 有沒有被接受要看 body 裡有沒有 `userOpHash`，不是看 HTTP 狀態碼。** JSON-RPC 的錯誤放在 body 的 `error` 物件裡，HTTP 仍是 200。

⚠ 無 paymaster，首次 op 會被 `Smart Account does not have sufficient funds` 擋 → 要先給 counterfactual 地址注資（腳本已冪等處理）。

---

## 7. 常見故障排除

| 症狀 | 真正的原因 | 動作 |
|---|---|---|
| `HTTP error 403 ... Archive requests` | fork 區塊變舊了 | `bash backend/scripts/refresh-anvil.sh` |
| `AbiErrorSignatureNotFoundError: selector 0x99410554` | alto v1.2.8 的 SafeValidator 壞了 | 改用 v1.2.5 |
| `InvalidSelector` on `owner()` | Kernel v3.3 沒有這個 view | 用 `rootValidator()` + `validator.ecdsaValidatorStorage(account)` |
| `invalid byte sequence` / `unbound variable` in shell | macOS 內建 bash 3.2 | 用 `tr` 轉大小寫；變數別緊接全形標點 |
| `bash: /bin/ps: Operation not permitted` | 沙箱限制 | 用 `pgrep -fl` |
| `23405 duplicate key` on `smart_accounts` | 冪等查詢選錯列（已修）或併發雙開（未修） | 見 [pitfalls §5.1](./pitfalls.zh-TW.md)、[decisions D-12](./decisions.zh-TW.md) |
| `bun install` 失敗 `~/.bun/install/cache` EPERM | 沙箱擋不住的家目錄快取 | `BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache bun add ...` |
| 合約查得到但新地址回 `0x` | 可能是「無 fork」版 anvil | 見 [pitfalls §2.2](./pitfalls.zh-TW.md) |

---

## 8. 目前的固定常數（BSC chainId 56）

全部經 RPC 實測有 code：

| 項目 | 地址 |
|---|---|
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| Kernel MetaFactory | `0xd703aaE79538628d27099B8c4f621bE4CCd142d5` |
| Kernel v3.3 KernelFactory | `0x2577507b78c2008Ff367261CB6285d44ba5eF2E9` |
| Kernel v3.3 impl | `0xd6CEDDe84be40893d153Be9d467CD6aD37875b28` |
| ECDSA validator（v3.1+） | `0x845ADb2C711129d4f3966735eD98a9F09fC4cE57` |
| Permit2 | `0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768` |
| PancakeSwap Universal Router | `0x1A0A18AC4BECDDbd6389559687d1A73d8927E416` |

**自家部署（這個 fork 專屬，fork 重啟就失效）**。權威紀錄在 `cre8-contracts/deployments/fork.json`。

| 角色 | 地址 | 備註 |
|---|---|---|
| registry | `0x27739a1AD35a924F5545C7d04C2B0537069CA76C` | 未變 |
| **executor（現行）** | `0x9C41696ea7FaA5470eAfb77415D063beEef83f4a` | oracle = multiPoolOracle |
| **oracle router** | `0x132cDfCe34d385f783dAB7F011B2E66E78A2f87f` | `AtpMultiPoolOracle`，numeraire = USDT |
| per-pair oracle | `0x535111F60a9cB7C3b95A17fB8d1dd2D17275DBFE` | WBNB/USDT |
| per-pair oracle | `0x12Ce4542B25fe53a3c606dd7783513357b6D838d` | NVDAB/USDT |
| ~~executor v1~~ | ~~`0x60691760815C69d32c1f68146FA11669F62A4b38`~~ | 舊，oracle 釘死 WBNB/USDT，**只支援單一 pair** |
| ~~oracle v1~~ | ~~`0x3D79c9BE8c087097Cbb1A8Be0D2714cf8BA95B84`~~ | 舊，且 `previewSwap` 有單邊檢查的 bug（`pitfalls §8.14`） |

⚠ **換 executor 會讓所有 session key 的 CallPolicy 失效**（target 釘在地址上），見 `pitfalls §8.15`。切換 `EXECUTOR_ADDRESS` 前必須先重建權限。

⚠ `spike/anvil/baseline.json` 現在記錄 **13 個合約**（含 router 與 2 個 per-pair oracle）。`refresh-anvil.sh` 摘要標題仍寫「9 合約」，實際印 13/13。

協議常數在程式碼裡的單一來源是 `backend/src/addresses.ts`；**不放 env**，理由見 [decisions D-05](./decisions.zh-TW.md)。
