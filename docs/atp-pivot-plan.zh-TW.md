<!--
  來源：bnb-agent-vaults/docs/atp-pivot-plan.zh-TW.md
  複製日期：2026-11-06
  狀態：歷史設計文件，內容反映 2026-11-06 當時的規劃。
        實作進度與後續決策請看 docs/HANDOFF.zh-TW.md 與 docs/decisions.zh-TW.md。
  ⚠ 本檔為原樣複製，未經修訂；若與現況衝突，以 docs/HANDOFF.zh-TW.md 為準。
-->

# ATP 架構遷移計畫（ATP Pivot Plan）

決策日期：2026-11-06
狀態：草案（未實作）
來源：產品與架構對話共識（Joooe 定案）

## 0. TL;DR

把 CRE8 從 pooled vault（共享金庫＋份額＋NAV）改寫成 **ATP（Automated Token Portfolio）**：
每人一個 non-custodial smart account，架構照 Glider 的分層。

- **第一版策略**：股票指數（目標權重 ＋ 排程／漂移再平衡 ＋ swap）。
- **聚合器**：PancakeSwap（Unified Swap API 離線報價 ＋ Universal Router 鏈上執行）；1inch 暫不接。
- **收費**：兩層 —— pool fee（swap 內）＋ 我們的 swap fee（輸出側，admin-only 可改）；
  infra fee 與訂閱走 **x402 離線**，不進合約。
- **合約面最小化**：只自寫 **Registry ＋ Executor**，其餘採用成熟開源件。
- **標的**：BSC 友好 bStock、PancakeSwap 上較深的池。
- **鏈**：先 BSC testnet（97），再主網（56）。

## 1. 為什麼遷移

pooled vault 的核心包袱是「集中式失敗」：單一合約 bug、單一 curator，一池可以被一次交易掏空，
加上份額／NAV 會計與「基金」的監管定位。ATP 把資產留在使用者自己的錢包，平台只做
「權重 ＋ 排程」的執行與分發，監管上更接近自助投資工具。

代價（已接受）：**放棄績效費**（0–20% 建立人 + 10% 平台）與 8 種規則交易裡屬於池化的部分；
收入改為 swap fee（30–300 bps 可自訂）＋ x402 離線訂閱/infra fee。

## 2. 目標架構（5 層）

```
┌─────────────────────────────────────────────────────────────┐
│ ⑤ 應用層   策略 = 指數定義（資產＋權重＋排程＋費率＋版本）      │
│            來源：fund-builder 的 rebalance/rotate/exit 規則    │
├─────────────────────────────────────────────────────────────┤
│ ④ 執行層   鏈下 keeper（policy engine）＋ KMS 簽名            │
│            來源：execution/strategy-v3（observer/plans/…）    │
├─────────────────────────────────────────────────────────────┤
│ ③ 結算層   EntryPoint v0.7 ＋ alto/ultra-relay bundler       │
│            ＋ verifying-paymaster ＋ eRPC                     │
├─────────────────────────────────────────────────────────────┤
│ ② 授權層   session key（Kernel permissions / SmartSession）   │
├─────────────────────────────────────────────────────────────┤
│ ① 帳戶層   Kernel v3 smart account（每人一個）                 │
└─────────────────────────────────────────────────────────────┘
```

| 層 | 職責 | 元件 |
| --- | --- | --- |
| ① 帳戶 | 資產在哪、誰是主人 | ZeroDev Kernel v3（EVM） |
| ② 授權 | agent 能做什麼、做多少、到何時 | session key／SmartSession（ERC-7579） |
| ③ 結算 | 打包、付 gas、上鏈 | EntryPoint v0.7 ＋ alto/ultra-relay ＋ verifying-paymaster ＋ eRPC |
| ④ 執行 | 決定「現在該不該動、怎麼動」 | 鏈下 keeper ＋ KMS |
| ⑤ 應用 | 策略定義與 API | 權重＋排程（資料）＋ B2B 風格 API |

## 3. 核心不變式（安全邊界）

1. **規則在鏈下，資產在鏈上**，中間只靠 session key 的權限邊界。
2. **合約側唯一搬錢點是 Executor**；session key 只能呼叫它，不能任意簽名任意 calldata。
3. **每筆 swap 的淨產出（扣費後）≥ oracle 地板**（fee 併進 minOut 反推，見 §5.4）。
4. **策略是資料不是邏輯**：改權重／排程 = 發新版本，不需使用者簽名；
   只有 enroll、withdraw、add-chain、rotate-key 要使用者重新簽名。
5. **損失有上界**：session key 綁「合約白名單＋函式＋金額上限＋到期」，可隨時撤銷。

## 4. 退休 / 重用 / 新建

### 4.1 退休（pooled vault 專屬，不搬）

- `src/composite/` 的份額、NAV、join 份額搜尋、exit partition/claim、lot 帳本、per-holder 成本
- 績效費、存入費的整套會計
- 8 種 play 裡屬池化的部分（dips/range/trend/lp/carry 的共享部位）

### 4.2 重用

| 現有 | 新架構落點 |
| --- | --- |
| `execution/strategy-v3` keeper：observer／market-data／ticks／plans／ethereum.mjs | ④ 執行層決策＋簽名前準備 |
| `fund-builder.ts` 的 rebalance（drift 1–50pp 每日檢查／月季、權重 custom/equal/cap≤20%）、rotate（Top N、30/90/180 天）、exit（fund SL/TP＋重啟） | ⑤ 指數策略參數 → strategy version |
| `MandatePoolTwapFeed`＋`MandateScopeSwapAdapter` 的價格地板 | Executor 的 oracle 地板（§5.4） |
| `@x402/core`（web/package.json 既有依賴） | 訂閱與 infra fee（§6.4） |
| `web/lib/access-store.ts`＋Postgres（`pg`） | 使用者／存取／credits |
| 29 條現貨路由（spot-templates） | swap 白名單宇宙 |
| Safe/4337 claim wrapper | 提款帳戶信封參考（部分） |

### 4.3 新建

- 合約：Registry ＋ Executor（§5）
- 後端：KMS 簽名、排程器、索引器、兩段式 API、x402 收費（§6）
- DB：strategies／portfolios／session_keys／operations／positions／performance（§7）

## 5. 智慧合約工作

### 5.1 採用的開源件（不寫，只部署＋設定）

| 元件 | 來源 | 備註 |
| --- | --- | --- |
| EntryPoint v0.7 | eth-infinitism/account-abstraction | 已部署多鏈 |
| Kernel v3 | zerodevapp/kernel | 模組化帳戶 |
| SmartSession | erc7579/smartsessions | session key 模組（ERC-7579） |
| verifying-paymaster | glider-fi/verifying-paymaster | EntryPoint v0.7，Forge |
| alto / ultra-relay | glider-fi/alto、glider-fi/ultra-relay | bundler（GPL-3.0） |
| eRPC | glider-fi/erpc-railway-deployment | RPC 負載平衡 |

授權注意：alto／ultra-relay 是 **GPL-3.0**，自架沒問題；若把修改過的 bundler 當產品散佈要查義務。

### 5.2 Portfolio Registry（輕量）

把「指數」變成可執行、可被 session key 引用的鏈上紀錄：

```solidity
struct Strategy {
    address owner;        // provider
    string  name;
    bool    isPublic;
    uint16  swapFeeBps;   // admin-only 可改（§5.4）
}
struct Version {
    address[] assets;     // 白名單資產（bStock）
    uint16[]  weightsBps; // 合計 10000
    uint8     cadence;    // interval|cron 的編碼，或存 calldata hash
    string    changeLog;
    uint64    activeAt;
}
// portfolio: account -> (strategyId, version, scheduleState, enrolledAt)
```

用途：(a) session key 權限綁「只能對 registry 的白名單策略執行」；(b) provider 改權重 = 發新 version，
跟隨者下一輪再平衡生效（Glider 語義）。**權重是資料不是邏輯。**

### 5.3 Executor（唯一搬錢合約，swap-only）

session key 只能呼叫它。第一版只支援「賣超配 A → 買低配 B」，多腿由 bundler 打包成一個 userOp
（batching），鏈上仍是 N 個 swap。

```solidity
struct SwapStep {
    address tokenIn;        // 從使用者 smart account 拉（先 approve）
    address tokenOut;
    uint256 amountIn;
    uint256 amountOutMin;   // agent 從報價填，但鏈上仍以 minGross 覆核（§5.4）
    bytes   commands;       // Universal Router 的 commands
    bytes[] inputs;         // Universal Router 的 inputs
}

function executeRebalance(
    address account,
    uint256 strategyId,
    uint256 version,
    SwapStep[] calldata steps,
    uint256 deadline
) external
    // 每個 step 前驗證（鏈上）：
    // 1. msg.sender 是 account 的有效 session key
    // 2. (strategyId, version) 在 registry 是 active
    // 3. tokenIn/tokenOut 都在該 version 白名單資產內
    // 4. commands/inputs 的目標合約 == pinned Universal Router
    // 5. grossOutput >= minGross（fee 併入，見 §5.4）
    // 6. block.timestamp <= deadline
```

- Universal Router 的 `recipient` 設成 **Executor 自己** → 收到全額 tokenOut → 同交易內切：
  `fee = output × swapFeeBps / 10000` 轉 fee recipient，`output − fee` 轉回使用者帳戶。
- 不接 1inch、不做借貸、不做 LP、不做多部位（第一版）。

### 5.4 收費與 minOut 反推（核心）

兩層費，位置不同：

| 費 | 扣在哪 | 誰拿 |
| --- | --- | --- |
| pool fee（0.05%／0.25%／1%） | swap 內，池子自己扣 | LP |
| 我們的 swap fee（自訂 bps） | swap 後、輸出側，Executor 切 | 我們 |

aggregator 回傳的 `grossOutput` **已扣過 pool fee**。我們的 fee 是再從 gross 多扣一層：

```
netOutput = grossOutput × (1 − swapFeeBps/10000)
```

**minOut 反推（fee 併入，保護算在 net 上）**：

```
oracleFloor = oracleCost × (1 − maxSlippageBps)       // TWAP 地板
minGross    = ceil( oracleFloor / (1 − swapFeeBps/10000) )   // 向上取整
require( grossOutput ≥ minGross )
```

- `oracleCost` 來自 `MandatePoolTwapFeed`（30–90 分鐘 TWAP），沿用既有讀取。
- 這是**獨立於 agent 給的 minOut** 的第二道地板：就算 agent 被偷、填 `amountOutMin=0`，
  鏈上仍以 oracle 價擋住 sandwich，且扣完費後使用者仍 ≥ 地板。
- 直接搬 `MandateScopeSwapAdapter.sol` 現有做法：`minimum = quoted × (10000−maxSlippageBps)/10000`、
  `maxSlippageBps ≤ 100` 且 `maxSlippageBps×100 > poolFee`、出場不被缺進場 TWAP 卡住。
- **值不值得成交**：沿用 `minimumOrder`／dust 邏輯，一筆 swap 的淨收益要 > pool fee＋swap fee 才做，否則跳過。

`swapFeeBps` 由 registry 存、**admin-only**（多簽/admin key）改，前端與使用者改不到——
對照 Glider：`swapBps` 由 `fees:write` scope 控制、只放伺服器端。

**路由排序不變**：fee 是「單一輸出 token 的均勻百分比」，對每條候選路由同比例折扣，排序不變，
所以聚合器選的 gross 最優路由仍是 net 最優。此性質只在「比例費＋單一 tokenOut」成立，
改 flat/per-hop 費會破，第一版不碰。

### 5.5 部署與測試

- Foundry 0.8.37、viaIR、optimizer 200、Cancun（沿用 repo 規範）。
- 通過 `scripts/check-contract-sizes.mjs`（EIP-170／3860 閘門）。
- 單元 ＋ BSC fork（讀 `BSC_RPC_URL`）＋ fuzz/invariant（repo 規則）。
- 每筆 BSC 交易 < 16,777,216 gas。
- 部署：testnet 97 → mainnet 56；地址 pin 進 deploy config，逐鏈核對。

## 6. 後端工作

### 6.1 服務清單

| 服務 | 職責 | 基礎 |
| --- | --- | --- |
| Signer（KMS） | 用 agent key 簽 userOp；key 不可導出、可 HSM | 新建（取代 keeper 的 EOA 熱錢包） |
| Scheduler | 每個 strategy 的 cadence 到點 → 觸發 rebalance | 新建（cron，離線） |
| Policy engine | 讀價、算漂移、決定「賣誰買誰、多少」 | **重用 keeper** |
| Bundler | 打包 userOp 上鏈 | 自架 alto/ultra-relay |
| Paymaster | 代付 gas | 自架 verifying-paymaster |
| Indexer | 讀存款、部位、成交、績效 | 新建（複用 observer 讀取） |
| API | enroll／fund／automate／withdraw | 新建（兩段式簽名） |
| x402 收費 | 訂閱＋infra fee | **重用 `@x402/core`** |

### 6.2 兩段式簽名流程（抄 Glider）

- **Enroll**：後端產生 EIP-712（綁錢包＋帳戶 index＋鏈＋預期地址＋flowId）→ 使用者簽 → 後端回簽名 →
  驗證 → 建 smart account＋發 session key。**只簽一次。**
- **Withdraw／add-chain／rotate-key**：兩段式，使用者**重新簽名**。
- **Deposit**：轉帳到 smart account 地址，不簽名。
- **Rebalance**：agent 用 session key 簽 userOp，使用者零動作。

### 6.3 冪等與狀態機

- 每個 write 有 `operationId`，狀態機 `accepted → running → completed/failed/cancelled`。
- 排程器每次從 DB 讀 `nextDueAt/lastRebalanceAt`，不自己存排程狀態。
- enroll/withdraw 用 `idempotency_key`，重試不回放副作用。

### 6.4 x402 收費（離線）

- 訂閱與 infra fee 走 x402（HTTP-402 機器付款）：按次／按週期，使用者錢包簽名付款。
- 收在 API 層、離線、不動資金 → **不進合約、不進 chain、不需份額/NAV**。
- 合約側因此只有 Registry＋Executor，無 Fee 模組。

## 7. 資料庫工作（Postgres，`pg` 已在用）

| 表 | 關鍵欄位 | 對應 Glider |
| --- | --- | --- |
| `strategies` | id, owner, name, description, is_public, swap_fee_bps, created_at | v2 strategies |
| `strategy_versions` | strategy_id, version, allocation(jsonb), cadence, change_log, active_at | immutable versions |
| `portfolios` | id, user_id, strategy_id, version, schedule_state, created_at | portfolio + schedule |
| `smart_accounts` | portfolio_id, chain_id, address, owner_caip, account_type | smartAccounts |
| `session_keys` | portfolio_id, key_ref（不存私鑰）, permissions(jsonb), expiry, status, revoked_at | session-key records |
| `operations` | id, portfolio_id, type, state, idempotency_key, correlation_id, payload_hash | idempotency + op |
| `positions_snapshots` | portfolio_id, asset, amount, usd_value, block, ts | indexed positions |
| `performance` | strategy_id/portfolio_id, window(1d..12m), twr | TWR curve |
| `users`/`access` | 重用 access-store | — |

三條硬規則：

1. **session key 私鑰絕不進 DB**——只存 key reference 與權限 JSON，金鑰在 KMS。
2. **冪等錨點**：enroll/withdraw 用 `idempotency_key`。
3. **scope 分離**：`strategies:write`/`fees:write` 絕不下放到前端（Glider 文件明確警告的錯誤）。

`fees` 表第一版**不做**：訂閱走 x402 離線，swap fee 是 registry 欄位。

## 8. 分階段計畫

| Phase | 內容 | 產出 |
| --- | --- | --- |
| 0 | 鎖定範圍＋股票指數標的（發行方＋流動性）＋審計上游元件版本＋費率定案 | 決策記錄 |
| 1 | testnet 部署 EntryPoint v0.7＋Kernel v3＋SmartSession＋paymaster；自架 alto＋eRPC；接 KMS | 鏈上基建 |
| 2 | 寫 Registry＋Executor（swap-only）＋部署腳本＋fuzz/invariant＋BSC fork | 合約＋測試 |
| 3 | 排程器＋索引器＋兩段式 API＋DB schema＋x402 收費 | 後端 |
| 4 | Web：建指數 → enroll → 入金 → 自動再平衡 → 部位/績效 | UI |
| 5 | 上指數策略（Mag7 等權、市值上限 20%、自訂權重）＋session key 撤銷/輪換＋ops 韌性 | 產品 |
| 6 | 安全審查＋審計＋受限發布 | 上線門檻 |

Phase 2 與 3 可並行（合約與後端靠 Executor ABI 對接）。

## 9. 風險與待決

1. **資產前提**：股票指數需要真實代幣化股票發行方與流動性；sandbox 副本不算數。Phase 0 定案。
2. **收益模型**：績效費讓出後，指數周轉率低 → swap fee 收入薄；是否疊加訂閱（x402）Phase 0 定。
3. **自架 ops 負擔**：bundler＋paymaster＋eRPC＋KMS 全自架是隱形成本；評估託管服務 vs 自架（Phase 1）。
4. **GPL 授權**：alto/ultra-relay 自架 OK，散佈修改版要查義務。
5. **session key 是新的信任點**：金鑰洩漏＝有界損失（可撤銷），撤銷/輪換/監控當一等公民（Phase 5）。
6. **費率 vs best price**：swap fee 直接吃掉聚合器省下的滑價；費率要對齊「實際省下的滑價」，
   第一版建議定低（10–20 bps cover 執行成本），UI 揭露「pool fee＋swap fee」總成本。

## 10. 已定案決策（decision log）

| # | 決策 | 內容 |
| --- | --- | --- |
| 1 | 架構 | pooled vault → ATP（per-user smart account），照 Glider 分層 |
| 2 | 首策略 | 股票指數（權重＋排程/漂移再平衡＋swap） |
| 3 | 聚合器 | PancakeSwap（Unified Swap API＋Universal Router）；1inch 暫不接 |
| 4 | oracle | TWAP 地板（MandatePoolTwapFeed），fee 併進 minOut 反推 |
| 5 | 收費 | pool fee（swap 內）＋ swap fee（輸出側，admin-only）；infra fee＋訂閱走 x402 離線 |
| 6 | 合約 | 只自寫 Registry＋Executor；採用 EntryPoint v0.7/Kernel v3/SmartSession/verifying-paymaster |
| 7 | 標的 | BSC 友好 bStock、PCS 深池 |
| 8 | 鏈 | testnet 97 → mainnet 56 |
| 9 | minOut 不變式 | minGross = ceil(oracleFloor / (1 − swapFeeBps/10000)) |
| 10 | 標的確認 | bStock（BSC 股票代幣化 ERC-20） |
| 11 | 訂閱暫緩 | x402 訂閱/infra fee 暫不實作；第一版只收 swap fee |
| 12 | 執行模型 | 帳戶呼叫 Executor（Model A）；session key 權限在 Kernel 層 |

## 附錄：相關既有程式位置

- `web/lib/fund-builder.ts`：rebalance/rotate/exit 規則與參數範圍（MAX_ASSETS=7、MAX_POSITIONS=8 屬舊金庫，僅供參考）
- `src/composite/MandateScopeSwapAdapter.sol`：現有滑價/oracle 地板
- `src/composite/MandatePoolTwapFeed.sol`（TWAP feed）
- `execution/strategy-v3/`：keeper（observer/plans/ethereum）
- `deployments/venues-record-97-2026-10-24/spot-templates/`：29 條現貨路由（swap 白名單宇宙）
- `web/package.json`：`@x402/core`（訂閱收費，暫緩）
- `docs/atp-pivot-executor-spec.zh-TW.md`：Registry＋Executor 合約骨架（Phase 2 介面規格）
