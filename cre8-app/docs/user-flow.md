# User flows

> 這份文件畫的是**使用者實際會走的路徑**，以及每一步在後端／鏈上發生什麼事。
> 對照程式碼：`src/components/WalletMenu.tsx`（登入）、`src/features/reference/`（公開基金與資產）、
> `src/features/create/DesignFundPage.tsx`（設計）、`CreateFundPage.tsx`（原生啟用）、
> `src/features/fund/FundPage.tsx`（帳戶操作）、`src/features/operator/OperatorPage.tsx`（營運）。
> 2026-11-11 更新：完整公開資料與執行邊界見 [public-ui-integration.md](public-ui-integration.md)。

---

## 0. 一張圖看完

```mermaid
flowchart TD
    A([使用者打開 /vaults]) --> D[瀏覽 30 檔來源基金<br/>Themes / Public figures / X voices]
    D --> E{要做什麼?}
    E -- 查看參考資料 --> P["/funds/:slug 或 /asset/:slug<br/>曲線、持倉、來源與績效詳情"]
    E -- 設計基金 --> F["/create：完整設計器"]
    F --> F1[選資產、權重、策略與規則<br/>X handle、封面與草稿]
    F1 --> F2{下一步}
    F2 -- 匯出 --> J[下載設計 JSON<br/>不送交易]
    F2 -- 啟用配置 --> B
    E -- 查看自己的帳戶 --> B{原生操作已登入?}
    P -- 存入或提領 --> B
    B -- 否 --> C[Connect wallet<br/>標頭下拉選單]
    C --> C1[列出 EIP-6963 錢包]
    C1 --> C2[選一個 → 連線]
    C2 --> C3[Sign in with SIWE<br/>簽 EIP-4361 訊息，不是交易]
    C3 --> N[繼續所選原生操作]
    B -- 是 --> N
    N --> G["/portfolio 或 /portfolios<br/>真實帳戶與活動"]
    N --> H["/funds/:slug<br/>My position / Deposit / Withdraw / Close"]
    N --> F3["/create/activate<br/>確認只啟用目標權重配置"]
    F3 --> F4[按精確地址核對 API 可交易清單<br/>移除不支援資產，權重合計 100%<br/>選 Hourly / 6h / Daily]
    F4 --> S1[strategy<br/>+ 鏈上 registry]
    S1 --> S2[version<br/>權重 + 排程]
    S2 --> S3[enroll<br/>部署 Kernel 帳戶 + 裝 session key]
    S3 --> F5{帳戶有 gas?}
    F5 -- 沒有 --> F6[錢包轉 shortfall<br/>約 0.01 BNB]
    F5 -- 有 --> F7
    F6 --> F7[簽一次：approve 各資產給 executor]
    F7 --> F8([完成：帳戶可再平衡])

    G --> H
    H --> H1[入金後配置或排程檢查<br/>session key 執行允許的再平衡]
    H1 --> H2[執行結果與帳戶狀態<br/>不使用公開模型績效代替]
```

公開目錄、資產頁與設計器不要求 SIWE。公開 30 檔是有來源的參考模型，不會因為出現在目錄就自動建立 Registry 策略。
啟用只匯入精確代幣地址及目標權重；設計器其他規則和費率保留在匯出檔，不會默默啟動。
基金頁的 `?performance=1`／`?trades=1`／`?update=<id>`／`?tokens=1` 開啟對應資料，
`?position=1` 開啟真實帳戶抽屜，手機下單使用 `?ticket=1`，提領可用 `?tab=withdraw`。

---

## 1. 登入（沒有交易、沒有 gas）

```mermaid
sequenceDiagram
    autonumber
    actor U as 使用者
    participant W as 瀏覽器錢包<br/>(MetaMask…)
    participant App as cre8-app
    participant BE as backend
    participant DB as Postgres

    U->>App: 點 Connect wallet（標頭）
    App->>W: EIP-6963 偵測（announceProvider）
    W-->>App: 錢包清單（name / icon / rdns）
    U->>App: 選一個錢包
    App->>W: eth_requestAccounts
    W-->>App: address

    U->>App: Sign in with SIWE
    App->>BE: POST /auth/nonce
    BE->>DB: 存一次性 nonce（5 分鐘）
    BE-->>App: domain / chainId / nonce / uri / statement
    App->>W: personal_sign(EIP-4361 訊息)
    W-->>U: 顯示「這是登入，不是交易」
    U->>W: 簽名
    W-->>App: signature
    App->>BE: POST /auth/login {message, signature}
    BE->>BE: 還原位址 + 驗 nonce + 驗 domain/chainId
    BE->>DB: insert auth_sessions（存 sha256(token)）
    BE-->>App: {token, expiresAt}
    App->>App: sessionStorage 保存（重新整理仍在，關掉分頁消失）
```

**重點**：SIWE 只是證明「你擁有這個位址」。**鏈上權限與 session key 完全不受影響** ——
登入與否不改變任何合約狀態。

---

## 2. 啟用配置：3 個 API + 條件式錢包互動

此圖從 `/create/activate` 開始；`/create` 的設計、草稿及 JSON 匯出本身不呼叫以下 API。
從草稿匯入時須確認目標權重模式，資產仍依 API 的精確地址及可交易狀態檢查。

```mermaid
sequenceDiagram
    autonumber
    actor U as 使用者（owner）
    participant App as cre8-app
    participant BE as backend
    participant Reg as AtpRegistry
    participant Fac as MetaFactory
    participant Acct as Kernel 帳戶
    participant Er as AtpExecutor

    U->>App: 確認配置 / 名稱 / 節奏 → Activate
    App->>BE: POST /strategies {name}
    BE->>Reg: registerStrategy(name)（operator 送）
    Reg-->>BE: onchain id
    BE-->>App: {id, onchainId}

    App->>BE: POST /strategies/:id/versions {allocation, schedule}
    BE->>Reg: publishVersion(assets[], weightsBps[])（operator 送）
    Note over Reg: 版本一旦發布就不可改<br/>改權重 = 發新版本
    BE-->>App: {version: 1}

    App->>BE: POST /portfolios {strategyId}
    BE->>BE: 派生 session key（master seed + index）
    BE->>BE: 組 initConfig（權限）與 salt=keccak(owner, strategyId)
    BE->>Fac: deployWithFactory(...)（operator 送）
    Fac->>Acct: 部署帳戶 + 安裝 session key
    BE->>Reg: enroll(account, id)（operator 送）
    BE->>BE: 寫 DB（portfolios / smart_accounts / session_keys）
    BE-->>App: {portfolio, gas: {shortfallWei}}

    alt 帳戶 gas 不足
        App->>U: 請錢包轉 shortfall（約 0.01 BNB）
        U->>Acct: transfer(BNB)
    end

    App->>U: 一次簽名：approve(USDT/NVDAB/WBNB → executor)
    U->>Acct: 簽 sudo UserOp
    Acct->>Er: approve（每個資產，無限額度）
    App->>App: 完成（Allowance 全 ok）
```

**為什麼 approve 是 owner 簽、而部署不是**：`AtpExecutor._swap` 用 ERC-20
`safeTransferFrom` 從**帳戶**拉幣，所以 allowance 必須由帳戶給。session key 給不了
（CallPolicy 只白名單 `executeRebalance`），而後端沒有 owner 私鑰。詳見 `architecture.md`。

---

## 3. 一輪再平衡（session key 簽名）

現行手動營運入口在 `/operator` 的 Run round；基金頁入金後則使用 owner 的再平衡端點執行首次配置。
下圖描述營運路徑，不代表公開基金頁有 Re-analyse 按鈕；兩條路徑均由後端規劃，不由公開參考曲線決定交易。

```mermaid
sequenceDiagram
    autonumber
    actor U as 營運者
    participant App as cre8-app
    participant BE as backend
    participant Chain as BSC (fork/主網)
    participant Bund as alto bundler
    participant Ex as AtpExecutor
    participant Orac as AtpMultiPoolOracle

    U->>App: Run round
    App->>BE: POST /operator/portfolios/:id/rebalance
    BE->>Chain: 讀持倉（Transfer 日誌 + 多呼叫）+ 定價
    BE->>BE: 算漂移 → 目標差 → 每步 amountIn
    BE->>Chain: 前置檢查：session key 已裝? allowance? 餘額?
    Note over BE: noop / blocked 直接回傳理由<br/>只有可執行的 steps 才繼續
    BE->>BE: 寫 before 快照
    BE->>Bund: eth_sendUserOperation（session key 簽）
    Bund->>Chain: handleOps
    Chain->>Ex: executeRebalance(account, steps, deadline)
    Ex->>Orac: previewSwap 取 TWAP 地板
    Ex->>Ex: 每個 step：safeTransferFrom → swap → 轉出
    Chain-->>BE: receipt
    BE->>BE: 寫 after 快照
    BE-->>App: {outcome, tx, steps}
    App->>U: 顯示 executed + 前後漂移

    Note over BE: 同一條路徑也由常駐排程器<br/>每 60 秒自動跑（--loop --live）
```

---

## 4. Session key 續期的 API 參考

續期 API 與 SDK 呼叫保留在 `src/lib/api.ts`／`src/lib/kernel.ts`。目前路由沒有
`/portfolios/:id` 或舊的 RenewalCard；此圖是 owner 續期的協定參考，不宣稱已提供該公開操作入口。

```mermaid
flowchart LR
    A["排程器 / 告警<br/>偵測 key 剩少於 30 天"] -->|warn| B[使用者看到提醒]
    A -->|"剩少於 7 天：critical"| B
    B --> C[owner 準備續期請求]
    C --> D[GET /renewal-params<br/>後端派生新 key + initConfig]
    D --> E[owner 錢包簽一筆 sudo UserOp]
    E --> F[帳戶 installValidation<br/>把新權限裝到自己身上]
    F --> G[POST /renewal-result<br/>DB 記回新 key]
    G --> H[排程器下次會用新的那把<br/>DB 由新到舊逐把驗鏈上是否安裝]
```

**舊 key 不會被撤銷** —— 它到自己的到期日為止仍然有效。這是刻意的：撤銷需要另一筆交易，
而多一把有效 key 的風險低於「續期失敗導致資金卡住」。

---

## 5. 失敗時使用者會看到什麼

| 情況 | 使用者看到的 | 系統實際狀態 |
|---|---|---|
| 錢包拒絕簽名 | 選單裡留著錯誤訊息，可重試 | 沒有任何鏈上動作 |
| 帳戶沒 gas | approve 失敗，訊息說明 gas | 帳戶存在但付不出 op |
| 沒 approve | 帳戶 Allowance 提示或再平衡 `blocked` | 不送不符合前置條件的交易 |
| 空倉 | Needs funding；再平衡結果為 `noop` | 沒有部位可搬 |
| API 不支援的設計資產 | `/create/activate` 列出 unavailable，要求移除並重新檢查權重 | 可在設計器研究，但不能直接啟用 |
| fork/RPC 掛掉 | 503 + 說明「讀不到狀態」 | **不顯示任何漂移數字**（刻意的） |
| 算不出執行後漂移 | `cannot be estimated yet` | 保留完整間隔，不亂調度 |
