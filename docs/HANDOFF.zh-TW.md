# CRE8 ATP 交接文件（現行）

最後更新：2026-11-06
取代：`docs/archive/handoff-2026-11-06.zh-TW.md`（那份的「下一刀是 Kernel 部署」「60 tests passed」已過期）
**已完成：Kernel session key 授權。下一刀：使用者簽名通道**

---

## 0. 30 秒版本

CRE8 正從 **pooled vault（共享金庫＋份額）** 遷移到 **ATP（Automated Token Portfolio，每人一個 non-custodial smart account）**，架構照 Glider。

第一版只做**股票指數**：目標權重＋再平衡排程，標的是 BSC 上的 bStock，聚合器用 PancakeSwap Universal Router（付款走 Permit2）。**規則在鏈下、資產在鏈上**，靠 session key 的權限邊界連接兩者。

代價（已接受）：放棄績效費，收入改成 swap fee。

程式碼拆成三個獨立 repo：`cre8-contracts`（Foundry）、`backend`（Bun+TS+Postgres）、`db`（SQL）。

---

## 1. 現況（截至 2026-11-06）

### 1.1 已完成

| 項目 | 狀態 |
|---|---|
| AtpRegistry / AtpExecutor / PancakeV3TwapOracle | 完成，85 tests passed / 1 skipped（fork 測試需 `BSC_RPC_URL`） |
| backend API（SIWE、策略 CRUD、鏡像上鏈、enroll） | 完成，**450 pass / 4 skip / 0 fail（scripts/ 也已納入 typecheck）**，typecheck exit 0 |
| DB（8 張表、3 個 migration） | 完成 |
| Kernel v3 smart account 部署 | 完成 |
| `@zerodev/sdk` 遷移 | 完成，行為零改變（`factoryData` 904 hex 逐 byte 相同） |
| **Kernel session key 授權** | **完成**，`verify-kernel-enroll.ts` **37/37 PASSED**；session key 已實測可上鏈發 op、越權兩層被擋 |
| bundler（alto）可用性 | 完成，**v1.2.5 + `safe-mode=true`**（v1.2.8 的 SafeValidator 對 EP v0.7 是壞的） |
| EIP-7702 可行性 | 協議已啟用（BSC Pascal 2025-03-20），alto 預設支援 type-4；**決定 v1 不用** |
| anvil fork 長期可用性 | 已建 `refresh-anvil.sh`（75 分鐘保存期限的對策） |
| **帳戶注資狀態** | 完成，`POST /portfolios` 回 `gas` 物件；`scripts/fund-account.ts` |
| **sudo key 續期通路** | **已實證**：sudo key 簽的 UserOp 能安裝/撤銷權限，新 session key 立即可用（`scripts/renew-session-key.ts`） |
| **`enrollment_intents`** | 完成，把 `validUntil` 釘死以讓帳戶地址可重建（修 D-21 的孤兒帳戶 bug） |
| **續期 HTTP API** | 完成：`GET /portfolios`、`GET /portfolios/:id/renewal-params`、`POST /portfolios/:id/renewal-result`、`POST /bundler`（relay）+ CORS |
| **`cre8-app/` 前端** | 完成（Vite + TS + bun），**完整續期流程已從真實瀏覽器跑通**（見 §1.4） |

### 1.2 session key 授權（本輪完成）

`enrollPortfolio` 部署 smart account 時，**同時安裝三層權限 policy** 並把 session key 的參照寫進 DB：

- **Call**：只能呼叫 `AtpExecutor.executeRebalance`（selector `0x1b977850`）
- **Gas**：`1e18` wei 預算（⚠ 一次性、跨 op 累計、永不重置）
- **Timestamp**：`now + 365 天`

session key 由 master seed 以 `m/44'/60'/0'/0/<index>` 派生，`index = keccak256(owner, strategyId) mod 2^31-1`（純函式，不依賴 DB id，見 [decisions D-19](./decisions.zh-TW.md)）。**DB 只存派生路徑 `key_ref`，私鑰永不進 DB。**

驗證證據（**當時**的數字；現況是 120 pass，因為之後又加了注資功能）：
```
bun test              107 pass / 1 skip / 0 fail
bun run typecheck     exit 0
verify-kernel-enroll  35/35 PASSED, exit 0
鏈上權限              permissionConfig(permissionId) 存在、三層 policy 都在、
                      permissionId 三方一致（重建 == DB == 鏈上）
端到端（真上鏈）      session key 簽的 executeRebalance 成功（tx 0x27155988…）
越權                  alto 層先擋（AA23 reverted，無 userOpHash）；
                      繞過 alto 硬送則 status=0（tx 0x61f418e1…）
```

### 1.3 上一刀（Kernel 部署）做了什麼

enroll 現在會**真的部署一個 non-custodial Kernel v3.3 帳戶**，用它去 `AtpRegistry.enroll`，DB 寫 `account_type='KERNEL'`。

**合約零改動** —— `AtpRegistry.enroll(account, id)` 的權限是 `msg.sender == account || msg.sender == owner`（`AtpRegistry.sol:177`），operator 本來就能代為註冊。

關鍵設計：**salt 含 `strategyId`**（每人每策略一個帳戶），因為 `_enrollments` 以 account 為 key 整筆覆寫。詳見 [decisions D-01](./decisions.zh-TW.md)。

驗證證據（**當時**的數字；現況是 120 pass）：
```
bun test              83 pass / 1 skip / 0 fail
bun run typecheck     exit 0
verify-kernel-enroll  20/20 PASSED, exit 0
鏈上                  account 有 code、enrollments=1/1/false、isEnrolled=true、
                      rootValidator=0x01++validator、
                      validator.ecdsaValidatorStorage(account) = 使用者 EOA
冪等                  第二次 enroll：同 id、0 tx、0 新列
崩潰重試              刪 DB 列後重跑：成功、0 筆 deploy tx、最終 1 列
```

---

### 1.4 前端續期流程已從瀏覽器端到端跑通（本輪）

`cre8-app/` 是一個 **minimal harness**（UI 之後會被既有 UI/UX 取代），但 `POST /bundler` relay 與前端簽名 handshake 是**不會被丟掉的**部分。

實測（真實瀏覽器，dev 私鑰模式 = anvil #3）：
```
✔ SIWE 登入
✔ GET /portfolios → id 5, gas.ready true
✔ GET /portfolios/5/renewal-params → 新 key m/…/24806714, permissionId 0xf67556bf
✔ eth_sendUserOperation → 0x1800dc13…5d1488e0e
✔ userOp receipt → success: true, actualGasUsed 0x86bdb
✔ transaction receipt → status success, block 132029098
✔ POST /portfolios/5/renewal-result → ok: true
```

鏈上獨立驗證：`permissionConfig(0xf67556bf)` 存在（signer = ECDSA_SIGNER_CONTRACT）、DB `session_keys` 多一列且舊列不動。

**真實 MetaMask 已驗證通過**（2026-11-07）：

```
EIP-6963 偵測到 3 個錢包（Phantom / MetaMask / SafePal）→ 選 MetaMask
SIWE 登入           ✔
續期 UserOp 簽章    ✔ personal_sign 對 32-byte userOpHash 成功，MetaMask 未拒簽
userOpHash 與本地計算一致  ✔
tx 0xea39ec63…      status success, block 132044083
新權限 0x075d78e3   鏈上存在
新 session key      ✔ 實測能發 executeRebalance 上鏈（tx 0xbc61f99b…, status success）
越權仍被擋          ✔ 驗證期 revert，無效 op 連 mempool 都進不去
```

**所以不需要 EIP-712** —— 那個 Plan B 可以丟掉。詳見 [pitfalls §7.3](./pitfalls.zh-TW.md)。

---

### 1.5 索引器 + 排程器（本輪完成）

**索引器**（`src/drift.ts` / `pricing.ts` / `positions.ts` / `snapshot.ts` / `holdings-scan.ts`）
- 漂移宇宙 = `registry.version(strategyId, enrollment.version).assets`（**不是**全域白名單，見 D-24）
- 鏈下 TWAP 定價，與已部署 oracle **逐位相同（0 ppm）**
- Multicall3 `aggregate3` + `allowFailure`，1 次 round trip
- 未知持倉：記錄 `unknown_token_count` 供運維觀察，**不阻擋**（執行器根本賣不掉它們）

**再平衡**（`src/rebalance-plan.ts` + `scripts/execute-rebalance.ts`）
- `noop`/`blocked`/`ready` 三分，**型別上不可能回空 steps**
- `amountIn` 兩次向下截斷 + 夾到持倉；`minGross` 逐字對齊合約 `_minGross`
- `deadline` 用**塊時間**不是牆鐘

**排程器**（`src/scheduler.ts` + `scripts/scheduler.ts`）
- `FOR UPDATE SKIP LOCKED` 認領，**live 在同一 transaction 內推進 `next_run_at`**（防重複執行）
- `dryRun` 預設 true；**dry-run 不推進 `next_run_at`**（否則監控會把真正的再平衡延後一整個 interval）
- 四條前置檢查（帳戶是 KERNEL / key 鏈上已安裝 / seed 派生相符 / allowance+餘額），**dry-run 也跑**
- 自動由新到舊逐把驗 session key，跳過沒安裝的

**實測（本機 fork，session key 真的換幣）**
```
手動觸發  tx 0x5d74693d…  drift 5000 → 1 bps
排程器    tx 0x2e6c0b8a…  drift 2501 → 1 bps
          operations state=confirmed attempts=1
          SwapExecuted 1 筆（== steps 數）
          WBNB −250064641256153007 (== amountIn) / USDT +173671864767889195047 (== net)
          用的 key = 0xf67556bf（已安裝），不是最新的 0x7db20115（未安裝）
```

**未驗 / 已知缺口**
1. **多資產（>2）**：現有 oracle 釘死一個 pool，規劃器對 `targets.length !== 2` 回 `blocked` → 等 D-23（per-call oracle）
2. **流動性與拆單**：`NVDAB/USDT` 的 USDT 端約 207k，oracle 的 `maxSlippageBps` 是 100（1%）→ 較大的投組**必然** `BelowFloor`，拆單是硬需求不是最佳化
3. **無人值守缺兩樣營運面**：~~沒有告警~~（**已補：`scheduler_alerts` + `/health` degraded + `--alerts`**）、session key 續期是手動的（且 `renew-session-key.ts` 對續期過的帳戶會 throw，見 `pitfalls §8.21`）、`backend/.env` 現在已補齊
4. **真實 BSC 未驗**：本輪全部是本機 fork 的模擬狀態
5. **多輪收斂未驗**：每次都只跑一輪

---

### 1.6 多資產再平衡（D-23，本輪完成）

**問題**：`AtpExecutor` 只有一個 immutable oracle，而 `PancakeV3TwapOracle` 釘死一個 pool → 只能再平衡 WBNB↔USDT，股票指數根本執行不了。

**解法**：新增 `AtpMultiPoolOracle`（router），內部持有「asset → per-pair `PancakeV3TwapOracle`」對照表，`previewSwap` 純轉發。**`AtpExecutor` 一行未改**。

- bytecode 普查：`STATICCALL 3`、**`CALL`/`CALLCODE`/`DELEGATECALL`/`SELFDESTRUCT` 各 0** → 它物理上無法搬資金
- 加新標的 = 部署 1 個 per-pair oracle + 1 筆 `setOracle`，**executor 不用重部署**

**順手修掉一個真 bug**（`pitfalls §8.14`）：`PancakeV3TwapOracle` 的 pair 檢查是單邊的，陌生代幣 + USDT 會用 token1 的價格報價 → floor 可能被算低。

**實測（3 資產，真鏈）**
```
新帳戶 0xb008dcff…（新策略 = 新 salt = 新地址）
tx 0x5cc9aff8… block 132164357 success gasUsed 773884
SwapExecuted 2 筆（WBNB→USDT 388414465242697445、USDT→NVDAB 135355485280000000000）
漂移 2689 → 2 bps（WBNB +2 / NVDAB −2 / USDT 0）
nonce key 0x0002 ++ permissionId 0xe95382df → 證明是 permission validator 不是 sudo
負向對照 WBNB.transfer → InvalidCallData() 0x1c49f4d1
```

**三個會咬人的發現**
1. **`enroll` 必須由 registry owner 或帳戶自己發**（`AtpRegistry.sol:177`）→ 生產環境 owner 是 multisig 時，這個路徑會直接擋住 enroll
2. **Kernel nonce key 佈局**：2 bytes `validationType`（`0x0002` = permission）+ 4 bytes `permissionId`，其餘補 0
3. **hub 模式下 USDT 是「先收後付」**，淨變化可以很小甚至為負。任何「USDT 必須增加」的斷言在多資產下都是錯的

---

## 2. 這個系統長什麼樣

### 五層架構

```
⑤ 應用層   策略 = 指數定義（資產＋權重＋排程＋費率＋版本）
④ 執行層   鏈下 keeper（policy engine）＋ 簽名
③ 結算層   EntryPoint v0.7 + bundler（alto）+ paymaster + eRPC
② 授權層   session key（Kernel permissions / SmartSession, ERC-7579）
① 帳戶層   Kernel v3.3 smart account（每人每策略一個）
```

### 四條核心不變式

1. **規則在鏈下，資產在鏈上**，中間只靠 session key 的權限邊界
2. **合約側唯一搬錢點是 Executor**；session key 只能呼叫它
3. **每筆 swap 的淨產出（扣費後）≥ oracle 地板**：`minGross = ceil(oracleFloor / (1 − swapFeeBps/10000))`
4. **策略是資料不是邏輯**：改權重／排程 = 發新版本，使用者不需重簽

### 收費模型

| 費 | 扣在哪 | 誰拿 |
|---|---|---|
| pool fee（0.05%／0.25%／1%） | swap 內，池子自己扣 | LP |
| 我們的 swap fee（30–300 bps） | swap 後、輸出側，Executor 切 | 我們（admin-only 可改） |
| infra fee／訂閱 | **暫緩**（原計畫走 x402 離線） | — |

---

## 3. 待辦（建議順序）

### 3.1 ⚠ session key 上線後的已知限制（三面牆）

這些不是 bug，是**設計時就知道的代價**。它們全部指向同一件事：**我們沒有使用者簽名通道**。

| 限制 | 後果 | 出處 |
|---|---|---|
| **Timestamp 到期**（1 年） | 到期後 portfolio 失去執行能力，**從後端無法修復** | [D-15](./decisions.zh-TW.md) |
| **GasPolicy 預算耗盡**（`1e18` wei，約 3000 筆） | 用完權限**永久沉默失效**，永不重置 | [D-14](./decisions.zh-TW.md)、[pitfalls §3.4](./pitfalls.zh-TW.md) |
| **權限在部署那刻定型** | 要改權限 = 換帳戶（既有帳戶無法升級） | [D-13](./decisions.zh-TW.md) |

另外兩件要在做遷移前記得：

- **舊資料不會被回填**：這次改動前建立的 KERNEL portfolio 是「沒安裝權限」的帳戶，而冪等 SELECT 會直接回它們 → 永遠不會升級。目前沒有生產使用者，但未來做遷移時要處理。
- **enroll 不注資**：session key 發 op 的 gas 由**帳戶自己付**。新帳戶沒 BNB 就送不出 op —— 上線前必須解決注資流程。
- **timestamp policy 的「時間比較」未實測**：只確認它被安裝在鏈上（permissionId 含它且三方一致）。真的要驗得把 anvil 時間推過 `validUntil`，會污染共用的 fork，故暫緩。

### 3.2 下一刀：使用者簽名通道

**這一個決策會同時解掉上面三面牆**，以及 EIP-1271 SIWE。

選項未定：WalletConnect（最貼近既有錢包）／嵌入式錢包（Privy、Dynamic，UX 最好但要引入供應商）／本地 CLI（最快但體驗最差）。見 [decisions 待決-1](./decisions.zh-TW.md)。

### 3.3 之後

| # | 項目 | 說明 |
|---|---|---|
| 1 | 排程器 + 索引器 | 讀鏈、算漂移、觸發 `executeRebalance`。⚠ 注意 **op 成功 ≠ 真的換了幣**（[pitfalls §3.5](./pitfalls.zh-TW.md)） |
| 2 | ~~enroll 注資流程~~ | **已完成**：`POST /portfolios` 回 `gas` 狀態（`ready` / `shortfallWei` / `estimatedOps`），本地用 `scripts/fund-account.ts`。見 [D-20](./decisions.zh-TW.md) 與 [runbook §5.5](./runbook.zh-TW.md) |
| 3 | EIP-1271／ERC-6492 | SIWE 目前只認 EOA；smart account 簽名要 `verifySiweMessage` + RPC |
| 4 | 舊 portfolio 的權限回填 | 見 §3.1，需要一個遷移腳本或 re-enroll 流程 |
| 5 | deploy 腳本補地址 pin | `DeployAtp.s.sol` 與 `deploy-fork.sh` 各有一份 hardcoded pin，雙份來源會漂移 |
| 6 | `GET /strategies/:id/versions` | 補了就能讓 201 帶 `Location` |
| 7 | 真實 mainnet 部署 | 同一份 deploy script 換 `--rpc-url` 與 funded 帳戶。那時再一併買 keyed RPC（D-16） |
| 8 | R2 併發雙開 | 見 [D-12](./decisions.zh-TW.md)，已決定延後 |
| 9 | `scripts/` 納入 typecheck | `tsconfig` 只 include `src/**` 與 `test/**`，腳本壞掉不會被抓到（[pitfalls §5.2](./pitfalls.zh-TW.md)） |
| 10 | Kernel 版本升級策略 | 目前凍結 v3.3。升級會讓所有新帳戶地址改變，見 [decisions 待決-2](./decisions.zh-TW.md) |

---

## 4. 動手前先確認綠燈

```bash
cd backend && bun test
```

預期 **450 pass / 4 skip / 0 fail（scripts/ 也已納入 typecheck）**。那 1 個 skip 是鏈上整合測試（要求 `RPC_URL` 非空），**是正常的**。

要跑鏈上驗證請照 [runbook §3.2 與 §5](./runbook.zh-TW.md)。

---

## 5. 文件導覽

| 想知道什麼 | 看哪份 |
|---|---|
| 為什麼要遷移、五層架構、時程 | [atp-pivot-plan.zh-TW.md](./atp-pivot-plan.zh-TW.md) |
| Executor 的介面規格 | [atp-pivot-executor-spec.zh-TW.md](./atp-pivot-executor-spec.zh-TW.md) |
| **為什麼做成現在這樣** | [decisions.zh-TW.md](./decisions.zh-TW.md) |
| **踩過哪些坑（先看這份）** | [pitfalls.zh-TW.md](./pitfalls.zh-TW.md) |
| 怎麼跑起來、故障排除 | [runbook.zh-TW.md](./runbook.zh-TW.md) |
| 2026-11-06 當時的交接（歷史） | [archive/handoff-2026-11-06.zh-TW.md](./archive/handoff-2026-11-06.zh-TW.md) |
| 舊 pooled vault 架構（**已廢棄**，只作對照） | [archive/legacy-vault/](./archive/legacy-vault/) |

### 三個 repo 的權威來源

| 位置 | 內容 |
|---|---|
| `cre8-contracts/src/atp/*.sol` | 合約實作（最終權威） |
| `cre8-contracts/test/atp/*.t.sol` | 單測＋fork 測試 |
| `cre8-contracts/deployments/fork.json` | fork 部署地址紀錄 |
| `backend/src/*.ts` | 後端實作 |
| `backend/src/addresses.ts` | 協議常數的程式碼內單一來源 |
| `backend/README.md` | 後端完整說明（API、校驗規則、env、runbook） |
| `db/migrations/*.sql` | schema（單一事實來源） |
| `db/README.md` | schema 概觀與 JSON 形狀 |
| `spike/` | 本輪 spike 產物（評估用，**不在任何 repo 的版控內**，可安全刪除） |

---

## 6. 給接手者的第一句話

> 先讀 [decisions](./decisions.zh-TW.md) 與 [pitfalls](./pitfalls.zh-TW.md) —— 那兩份會省掉你最多時間。然後跑 `cd backend && bun test` 確認 450 pass 綠燈。要動鏈之前先讀 [runbook §3.2](./runbook.zh-TW.md)（anvil 有 75 分鐘保存期限）。

一個提醒：**這個專案過去一段時間最大的教訓是「讀程式碼得出的結論必須用實測驗證」。** 本輪至少三次，從原始碼推出的判斷被鏈上實測推翻（MetaFactory 行為、safer-mode 根因、anvil 頭塊落點）。詳見 [pitfalls 附錄](./pitfalls.zh-TW.md)。
