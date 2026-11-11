# 決策日誌（Decision Log）

最後更新：2026-11-06

這份文件記錄**為什麼**做成現在這樣。每條決策包含：選項、選擇、理由、風險、誰拍的。
「誰拍的」很重要 —— `使用者` 代表產品/商業判斷，`工程` 代表技術判斷，`使用者（依工程建議）` 代表工程提議後由使用者確認。

新增決策時請**往下追加**，不要改寫歷史；若決策被推翻，在原本那條標記 `⚠ 已被 D-xx 取代` 並保留下來。**被推翻的決策比正確的決策更有價值**，因為它記錄了哪條推理路徑走不通。

---

## D-01 · 帳戶範圍：每人每策略一個 Kernel 帳戶

| | |
|---|---|
| 決策 | salt 含 `strategyId`，每個 `(owner, strategyId)` 一個獨立 smart account |
| 選項 | (A) 每人每策略一個 (B) 每人全站一個 |
| 選擇 | **(A)** |
| 拍板 | 使用者（依工程建議） |

**理由**：`AtpRegistry._enrollments` 以 account 為 key **整筆覆寫**（`AtpRegistry.sol:183`）。若選 (B)，同一 owner 的第二個策略會**靜默覆寫**第一個的鏈上註冊，而 DB 會有兩行 portfolio → 鏈上與 DB 永久不一致。

選 (A) 讓 Registry 的「一帳戶一註冊」語意與 DB 的 `UNIQUE(chain_id, address)` 天然對齊，且**零合約改動**。

**代價**：實作的是「每人每策略一個」，不是字面上的「每人一個」。若未來產品要後者，**必須先重設計 Registry 的 enroll 映射**，那是獨立的一刀。

**salt 公式**
```
keccak256(abi.encodePacked("cre8-atp:kernel-v3.3", owner, strategyId))
```
前綴帶版本號，未來要強制全體換代時只改前綴，不必動 factory。

---

## D-02 · 重複 enroll 的語意：冪等

| | |
|---|---|
| 決策 | 重複 enroll 同一 `(user, strategy)` 回傳既有 portfolio，不新增列、不發部署 tx |
| 選項 | (A) 冪等 (B) 每次新增 portfolio 列但共用帳戶 (C) 每次開新帳戶 |
| 選擇 | **(A)** |
| 拍板 | 使用者（依工程建議） |

**理由**：counterfactual 地址由 `(owner, strategyId)` 完全決定，所以重試天然可自癒。「部署成功但 DB 寫入失敗」只要重跑就會補上，**不需要補償交易**。這是三個選項裡唯一讓失敗可自動恢復的。

選 (B) 會讓 DB 出現多筆指向同帳戶的 portfolio，而鏈上只有一筆註冊（再次不一致）。選 (C) 每 re-enroll 一次 gas 線性成長，使用者會累積多個帳戶。

**已實測驗證**：刪掉 DB 列後重跑 → 成功、**0 筆 deploy tx**（只有 1 筆 registry tx）、最終 1 列。

---

## D-03 · Kernel v3.3 + EntryPoint v0.7 + MetaFactory 路徑

| | |
|---|---|
| 決策 | pin Kernel v3.3（permissionless 的 `"0.3.3"`），走 MetaFactory（`useMetaFactory = true`） |
| 拍板 | 工程 |

**理由**
- v3.3 是 MetaFactory 共用範圍（v3.0–v3.3）內最新版，Glider 也用 v3 線
- MetaFactory 是 v3.0–v3.3 共用的穩定外層地址，少一個隨版本變動的 pin；且 permissionless 預設就走這條
- **兩條路徑算出的 counterfactual 地址不同，選定後不可中途切換**

**風險**：換 Kernel 版本時 factory / impl / validator 全要換 pin，地址會變，必須視為顯式遷移。

**已 pin 的地址（BSC chainId 56，全部 RPC 實測有 code）**

| 項目 | 地址 |
|---|---|
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| Kernel MetaFactory | `0xd703aaE79538628d27099B8c4f621bE4CCd142d5` |
| Kernel v3.3 KernelFactory | `0x2577507b78c2008Ff367261CB6285d44ba5eF2E9` |
| Kernel v3.3 impl | `0xd6CEDDe84be40893d153Be9d467CD6aD37875b28` |
| ECDSA validator（v3.1+） | `0x845ADb2C711129d4f3966735eD98a9F09fC4cE57` |

---

## D-04 · 部署觸發方式：operator EOA 直接發普通 tx，不走 UserOp

| | |
|---|---|
| 決策 | operator 用 `sendTransaction` 直接呼叫 MetaFactory `deployWithFactory` |
| 拍板 | 工程 |

**理由**：v1 沒有 bundler、沒有 paymaster。而**部署不需要任何簽章** —— `initData` 內嵌 owner 的 20-byte 地址，不含簽章。所以任何人（包括 operator）都可以花自己的 gas 幫某人部署，owner 不變。

UserOp 的唯一真優勢是 initCode 部署＋執行可原子化，代價是要為尚未存在的 counterfactual sender 付 gas（需要 paymaster 或預先充值），v1 一個都沒有。

**風險**：operator 是單點熱路徑，gas 全由 operator 墊付。可接受 —— 現況本就是單一 relayer 模型，且因為部署無簽章，未來要改成 user 自付或第三方代部署時隨時可改，**不會遷移已部署地址**。

---

## D-05 · 協議常數放 `src/addresses.ts`，不放 env

| | |
|---|---|
| 決策 | EntryPoint / MetaFactory / KernelFactory / impl / validator 是**程式碼常量**；`REGISTRY_ADDRESS` 仍是 env |
| 拍板 | 工程 |

**理由**：前者是「canonical 協議常數」，不是部署參數。放 env 會讓每個環境都能「不小心」指到錯的 factory，而且算不出地址時極難排錯。後者是**自家 per-deployment 合約**，本來就該由環境決定。

原本也考慮在 `cre8-contracts/` 建 `config/addresses.json` —— **沒做**，因為 Registry / Executor 的 constructor 都不吃 EntryPoint，建一個沒人讀的 config 檔是死代碼。

**（原定選項 D-04 手寫編碼已被 D-08 取代，見下）**

---

## D-06 · ⚠ 已被 D-08 取代 · 手寫 Kernel initData 編碼，不引入 ZeroDev SDK

| | |
|---|---|
| 決策 | 用 viem 手寫 ~80 行組 `initialize` / `deployWithFactory` calldata；`permissionless` 只當 devDependency 產生 golden vector |
| 拍板 | 使用者（依工程建議）—— **後來被實測推翻** |

**當初的三個理由，事後檢驗**

| 理由 | 事後結論 |
|---|---|
| 「這個 repo 極簡依賴（raw pg、無 ORM）」 | **不成立** —— SDK 進 devDependency 也一樣不進 runtime，評估成本遠低於當時假設 |
| 「錯誤訊息更清楚：EntryPoint 沒 code 會是我們自己的一行明確錯誤」 | 部分成立，但 SDK 的 fallback 反而暴露了手寫時不存在的**新風險**（見 pitfalls §3.1） |
| 「可以離線算 CREATE2、省掉 RPC」 | **假的** —— 我們手寫版也是打 `eth_call getSenderAddress`，跟 SDK 一樣 |

**為什麼會被推翻**：spike 實測證明 `@zerodev/sdk` 用 `index: BigInt(我們的 keccak salt)` 算出的 `factoryData` 與手寫輸出 **904 hex / 452 bytes 逐 byte 完全相同**，地址也相同。手寫**沒有換到任何可測量的好處**，卻多養了 80 行重複別人邏輯的程式碼。

**這條決策的價值就在這裡**：它記錄了一條「看起來合理但實測站不住」的推理路徑。下次遇到類似取捨（自寫 vs 用庫），先用 spike 量出「到底差多少」，不要用哲學論證。

---

## D-07 · 沿用現有 anvil fork 做整合驗證，不重建

| | |
|---|---|
| 決策 | 在既有 fork 上用新錢包驗證，既有 EOA 列保留作對照 |
| 拍板 | 使用者（依工程建議） |

**理由**：fork 上 Kernel 四支合約已驗證齊備、registry 有既有 enrollment 可當對照。而**重啟 anvil 會讓 registry 消失**，等於要重跑整套部署 + DB 遷移。既有 EOA 列留著正好是「改造前 vs 改造後」的活體對照。

**後來追加的限制**：這個 fork 有 75 分鐘保存期限（見 pitfalls §2.1），所以「沿用」變成「定期刷新沿用」，靠 `refresh-anvil.sh` 維持。

---

## D-08 · 遷移到 `@zerodev/sdk`，先遷移再做 session key

| | |
|---|---|
| 決策 | 把 `src/kernel.ts` 的手寫編碼換成 SDK；**先完成遷移**，再做 session key |
| 選擇 | (A) 先遷 (B) 跟 session key 一起做 (C) 保持手寫 |
| 選擇 | **(A)** |
| 拍板 | 使用者（依工程建議） |

**理由**：遷移是**可以完整證明沒改變任何行為**的重構 —— 改完後 `bun test`（當時 83 pass）與 `verify-kernel-enroll.ts`（當時 20/20）就是完美回歸護欄，加上 fixture 斷言 `factory === MetaFactory`（堵 silent fallback），能證明每個帳戶地址不變。

先做這個的價值不只是少 80 行，而是**session key 那刀本來就要裝 `@zerodev/sdk` + `@zerodev/permissions`**。遷完之後那一刀是在熟悉的 API 上寫，不用同時適應新庫。

若選 (B)，出問題時會分不清是 SDK 換錯還是 session key 寫錯。

**實作要點**
- `@zerodev/sdk` + `@zerodev/ecdsa-validator` 進 `dependencies`；`permissionless` 留 `devDependencies`（只給 golden vector 產生腳本用）
- `index: BigInt(salt)`（不是 hex string，見 pitfalls §3.1）
- 用 `factoryAddress` + `generateInitCode()`，**不用 `getFactoryArgs()`**（見 pitfalls §3.2）
- 新增 sentinel：`factory !== MetaFactory` 就拋錯
- 帳戶建構函式預留 `plugins` / `initConfig` 參數（為下一刀的 session key 留門）

---

## D-09 · 帳戶模型維持 ERC-4337 獨立帳戶，不轉 EIP-7702

| | |
|---|---|
| 決策 | smart account 是獨立新地址，使用者把資金存進去 |
| 選項 | (A) 維持 4337 (B) 轉 7702 (C) 4337 為主、7702 當進階選項 |
| 選擇 | **(A)** |
| 拍板 | 使用者（依工程建議） |

**背景**：BSC 已於 **2025-03-20 Pascal 硬分叉**啟用 EIP-7702（一手來源：`bnb-chain/bsc` release `v1.5.7` + BEP-441），alto 也**預設支援** type-4（`--eip-7702-support` 預設 `true`，會自己組 `authorizationList`）。兩條路都可行。

**選 (A) 的理由**：7702 讓使用者的**主錢包** delegate 到 Kernel 的程式碼。對金融產品而言，這等於把主力錢包交給第三方邏輯執行 —— 一旦 Kernel 或 permission 設定有問題，波及的是使用者主要資產，而不是一個專用子帳戶。

而 CRE8 的產品形態（把錢存進來做規則再平衡）本來就自然對應「一個專用的 ATP 子帳戶」，跟券商的「交割帳戶 + 交易帳戶」很像。

**保留可能性**：7702 適合「不想多一個地址」的輕量用例，未來可作為進階選項，不排除。

**未驗證**：BSC 上實際發過 type-4 交易這件事**沒有實機驗證過**（只確認協議已啟用 + alto 有支援程式碼）。

---

## D-10 · 做 session key 之前，先查清 alto `safe-mode`

| | |
|---|---|
| 決策 | 不在 safe-mode 未解的情況下開始 session key |
| 拍板 | 使用者（依工程建議） |

**理由**：`safe-mode` 正是「bundler 是否強制 ERC-4337 全套規則（opcode ban、storage access、reputation、多實體角色檢查）」的開關。**session key 的安全性完全建立在這些護欄被強制執行上** —— 用 `safe-mode=false` 開發，等於在沒有護欄的環境裡驗證護欄。

**事後證明這個堅持是對的**：查出來的不是環境問題，是 **alto v1.2.8 的程式碼 bug**（SafeValidator 對 EP v0.7 用零 error 條目的 ABI 解碼，確定性失敗）。若當初直接開工，會在一個**完全不執行驗證規則**的 bundler 上開發 session key，而所有測試都會「通過」。

---

## D-11 · bundler 修復方式：降版 alto v1.2.5

| | |
|---|---|
| 決策 | 用 alto **v1.2.5**，`safe-mode=true` |
| 選項 | (A) 降版 v1.2.5 (B) patch v1.2.8 (C) 換 Rundler (D) 暫不處理 |
| 選擇 | **(A)** |
| 拍板 | 使用者（依工程建議） |

**理由**
- 零改碼，而且那段邏輯是 **upstream 自己寫對過的**（v1.2.5 用 `getSimulateValidationResult()` 做正確的兩段式解密），比我們手貼 30 行補丁更可信
- 這個 bug 有兩個 open issue（`#810`、`#756`）沒人修，不該把希望放在上游
- 沒有比 v1.2.8 更新的修好版本（main 分支仍壞）

**備案**：若 v1.2.5 在 BSC 上遇到其他問題，退回 patch v1.2.8（把 v1.2.5 的 helper 搬回來）。這是 GPL-3.0 私有自用修改，合法。

**淘汰 Rundler 的理由**：它可能是最終正確答案（Rust、GPL、支援 EP 0.7/0.8），但我們連 alto 的最小設定都花了一整輪摸索，換 bundler 等於重來一次，且目前還不確定 session key 需要 bundler 的哪些特定行為。

**已實測驗證**：v1.2.5 + `safe-mode=true` 成功送出 UserOp（tx `0xeb71e865…`），且偽造簽章被拒（`AA23 reverted - 0x8baa579f` = `ECDSA.InvalidSignature`）、gas 不足被拒，log 有 ERC-7562 規則標記。

---

## D-12 · R2 併發雙開：延後處理

| | |
|---|---|
| 決策 | 本刀不修，記錄為已知風險 |
| 拍板 | 使用者 |

**問題**：兩個並行 `POST /portfolios` 對同一 `(user, strategy)` 都會通過冪等 SELECT（此時無列），然後競態部署。落後方要嘛部署 tx 撞 CREATE2，要嘛 `INSERT smart_accounts` 撞 `UNIQUE(chain_id, address)` → 23505 → HTTP 500。

**理由（延後）**：需要使用者真的連點兩下才會觸發，而且 D-02 修完「冪等選錯列」那個確定性會爆的 bug 之後，這條更不緊急。符合這個 repo 的 YAGNI 傾向。

**將來的修法**：捕獲 23505 後回查既有列回傳（DB 已有 UNIQUE 後盾，只是沒接住），或用 `pg_advisory_xact_lock` 包住 SELECT → insert。

---

## D-13 · session key 在**部署時**以 `permission` initConfig 安裝

| | |
|---|---|
| 決策 | 把 permission plugin 塞進 `initConfig`，部署帳戶時一次完成；不做「部署後 enableMode 補裝」 |
| 拍板 | 工程（受現實約束，非偏好） |

**這不是偏好選擇，是被逼出來的唯一解。**

`enableMode` 安裝必須是一筆**由 sudo owner 簽的 UserOp**，而 sudo owner 是使用者的 EOA，**我們沒有使用者的私鑰**。要讓使用者簽，需要一個能簽 UserOp 的客戶端 —— **這個專案沒有前端**（只有 contracts / backend / db 三個 repo）。

所以「部署後補裝」這條路在 v1 是走不通的，不是「比較麻煩」。

**代價（必須記住）**
- `initConfig` 參與 counterfactual 地址推導 → **從此之後部署的帳戶地址空間與現有 3 個測試帳戶不同**。對新使用者無妨（我們沒有生產資料），但舊的 fork 測試帳戶無法「升級」。
- 每個帳戶的權限設定在**部署那一刻就定型**。要換權限 = 換帳戶（除非使用者自己簽名補裝，而那條路目前不存在）。
- SDK 文件明確警告：「permission 設定會改變 counterfactual 地址；若日後改設定重裝，必須在 `createKernelAccount` 顯式傳 `address`」。實作時務必顯式傳 `address`，不要依賴重算。

---

## D-14 · session key 的權限：Call + Gas 上限 + Timestamp 三層

| | |
|---|---|
| 決策 | 三層 policy：Call（限定搬錢點）＋ Gas（預算 1e18 wei）＋ Timestamp（1 年） |
| 選項 | (A) 三層 (B) 只有 Call (C) 全疊五層 (D) 先不設限 |
| 選擇 | **(A)** |
| 拍板 | 使用者（依工程建議） |

**理由**：這三層各自封住一個風險維度：
- **Call** → 只能呼叫 `AtpExecutor.executeRebalance`（selector `0x1b977850`），這是「合約側唯一搬錢點」不變式在執行層的對應
- **Gas** → 封住「鑰匙洩漏後帳戶餘額被吸光」—— gas 是**從使用者帳戶扣的**（Spike 實測：帳戶要先注資才發得出 op）
- **Timestamp** → 讓鑰匙自動失效，不需主動撤銷

**不做的兩層**
- **Rate Limit**：參數需要真實流量才能調，v1 沒有流量，隨便設一個數字只是自欺
- **Signature whitelist**：只有一個 operator，白名單等於恆真

### ⚠ Spike 實測修正了原本的理解（重要）

**1. GasPolicy 是「一次性 wei 預算」，跨 op 累計且永不重置**

實測：`allowed = 4e14` → 第 1 筆過（用掉約 2.46e14）、**第 2 筆立刻 `PolicyFailed(1)`**。`allowed = 1e6` → 連第 1 筆都不過（證明單位是 wei 不是 gas 計數）。

所以它同時是「保護使用者餘額」與**第二個倒數計時器**。**決定：預算放大到 `1e18 wei`**（BSC 約 1 gwei、單筆 ~250k gas 下約 4000 筆，每週再平衡一年只用 52 筆，一年內不會觸發）。

**2. CallPolicy 只驗 target + selector，不驗參數**

實測：空 `steps` 的 `executeRebalance` 也會 `success`。所以**「op 成功」≠「真的換了幣」** —— 金額層面只能靠 `AtpExecutor` 的 `minGross` 守。任何「看 op 成功就當作再平衡完成」的邏輯都是錯的。

**3. 越權是在「驗證期」被擋，不是執行期**

實測越權呼叫 `AtpRegistry.setDefaultFeeBps`：
- alto（safe-mode）在 `eth_estimateUserOperationGas` 階段就回 `AA23 reverted 0x1c49f4d1` → **沒有上鏈、沒有浪費 gas**
- 用 `eth_call handleOps` 獨立驗證，鏈上也會擋：`FailedOpWithRevert`（`0x65c8fd4d`）內層 `0x1c49f4d1`
- `0x1c49f4d1` = **CallPolicy 的 `InvalidCallData()`**；`debug_traceCall` 確認最深 revert frame 是 CallPolicy v0.0.4

**含意**：alto 的 safe-mode 是「多一層縱深」，**不是唯一安全邊界**。任何守規矩的 bundler 都會在模擬階段拒收，我方不必付 gas。

---

## D-15 · session key 用長效期，續期路徑列為明確技術債 ⚠ 這是暫時止痛

| | |
|---|---|
| 決策 | `expires_at` 設遠期（v1 用 1 年），把「續期需要使用者簽名」列為待辦 |
| 選項 | (A) 長效期 (B) 現在就做使用者簽名路徑 (C) operator 當 sudo owner (D) 短效期接受停擺 |
| 選擇 | **(A)** |
| 拍板 | 使用者（依工程建議） |

**背景：schema 已經決定了兩件事**
- `session_keys.expires_at timestamptz NOT NULL` → **沒有「永不到期」這個選項**
- `session_keys_key_ref_key UNIQUE (key_ref)` + `portfolio_id NOT NULL` → **一把 key 只能屬於一個 portfolio**，「共用一把 operator key」被 schema 否決

**⚠ 這是真實的死角，不是理論問題**

session key 一定會過期，而**續期必須是使用者簽的 UserOp**，我們沒有那個通道（見 D-13）。所以到期那天，該 portfolio 會**失去執行能力，且無法從後端修復**。

長效期只是把這面牆推遠，不是拆掉它。

**（C）為什麼不可接受**：把 operator 當 sudo owner 等於放棄 non-custodial —— 使用者的資產由我們的金鑰控制，那是 pooled vault 的老問題換個外觀。

**待辦**：建立使用者簽名通道（WalletConnect / 嵌入式錢包 / 本地 CLI，三選一未定），並在其中實作 session key 續期。這是**獨立於 session key 切片**的另一刀。

---

## D-16 · 不買 keyed archive RPC，沿用免費 + 每小時刷新

| | |
|---|---|
| 決策 | 繼續用 publicnode（免費），靠 `refresh-anvil.sh` 每約 55 分鐘刷新 |
| 拍板 | 使用者（依工程建議） |

**理由**：還在開發階段，每小時 10 秒的刷新成本可接受。等到要接真實 mainnet（待辦 #5）時再一併買 —— 那時本來就需要同一組金鑰，一起處理更合理。

**已知代價**：這是「用免費公共 RPC 跑生產級工作流」。refresh 腳本只是止痛，根因未解。詳見 [pitfalls §2.1](./pitfalls.zh-TW.md)。

---

## D-17 · Session key 用 HD 派生，master seed 在 KMS

| | |
|---|---|
| 決策 | 每個 portfolio 一把 session key，由 master seed 以 `m/44'/60'/0'/0/<portfolioId>` 派生；DB 只存 `key_ref`（派生路徑） |
| 拍板 | 工程 |

**理由**
- schema 已強制「一把 key 一個 portfolio」（`UNIQUE(key_ref)`），所以必須能產生 N 把
- HD 派生讓「私鑰永不進 DB」這條既有規則成立：DB 存路徑，seed 在 env（dev）/ KMS（prod）
- 派生是確定性的 → 重跑可重現、可驗證，不需要保管 N 把隨機金鑰
- `key_ref` 的形式在 dev 與 prod 一致，只是 seed 的來源不同

**風險**：master seed 洩漏 = 所有 session key 洩漏。所以 seed 必須進 KMS（dev 用 env），且**不可與 operator 私鑰共用**。

---

## D-18 · 新增 `EXECUTOR_ADDRESS` 設定

| | |
|---|---|
| 決策 | CallPolicy 的 target 需要 Executor 地址，目前 backend 沒有這個設定 → 新增 env |
| 拍板 | 工程 |

**為什麼不能放 `addresses.ts`**：Executor 是**自家 per-deployment 合約**（跟 `REGISTRY_ADDRESS` 同性質），不是 canonical 協議常數。每次重新部署都會變。協議常數（EntryPoint / MetaFactory / factory / impl / validator）才放 `addresses.ts`（見 D-05）。

---

## 附註：`permissionId` 的特性與限制（Spike 實測）

- 公式：`keccak256(abi.encode([toPolicyId(policies), flag, toSignerId(signer)]))[0..4]`
- **純 keccak、不含 chainId、不含帳戶地址** → 免部署即可離線算出，可存 DB
- 跨 3 個獨立 process、部署前後完全一致；只保留 Call policy 時變為 `0x30e04ef6`（證明綁 policies）
- ⚠ **只有 4 bytes**，不是唯一鍵等級。要當參照就必須搭配 `(account, sessionKey)` 一起存，不可單獨當 key
- 我們的組合（Call + Gas + Timestamp）算出 `0x1c6f587d`

---

## 附註：`plugins.regular` 與 `initConfig` 的職責分工（Spike 實測）

這是本刀最容易搞錯的地方，用三方對照釘死：

| 設定 | 算出的地址 |
|---|---|
| 只有 `sudo` | `0xCF0c37F1…704D02`（與無權限 baseline 相同） |
| `sudo` + `plugins.regular`（不給 initConfig） | **同上，地址不變** |
| `sudo` + `initConfig`（不給 regular） | `0x0Efb1a5e…1122A`（**變了**） |

**結論**
- `plugins.regular` 決定「誰簽」，**不影響地址**
- `initConfig` 決定「權限有沒有被安裝」，**唯一影響地址的東西**
- 兩者在 production **必須同時給** —— 只給 regular 會拿到「一個沒有安裝權限的帳戶，但用 session key 簽會失敗」的組合

**實務含意**：既有帳戶**不能**靠重算參數變成新地址。要加裝權限只能在原地址用 UserOp 自己執行那 2 筆 initConfig calldata —— 而那需要使用者簽名，我們沒有（見 D-13）。

---

## D-19 · session key 用「穩定索引」派生，不依賴 DB id

| | |
|---|---|
| 決策 | `index = keccak256(encodePacked('cre8-atp:session-key:v1', owner, strategyId)) % (2^31-1)`；`key_ref = m/44'/60'/0'/0/<index>` |
| 選項 | (A) 穩定索引（純函式） (B) 用 `nextval('portfolios_id_seq')` 預取 DB id |
| 選擇 | **(A)** |
| 拍板 | 工程 |

**為什麼不能用 DB id**

`nextval` 看似自然（session key 屬於 portfolio），但它會破壞 D-02 的冪等自癒。因為 **`initConfig` 會改變 counterfactual 地址**，所以失敗模式是：

> 鏈上部署 + enroll 成功、DB 交易被殺 → 重跑拿到**新的** `nextval` → 新索引 → 新 session key → 新 `initConfig` → **另一個地址**：會再部署第二個帳戶並在 registry 上 enroll 第二個地址，DB 只留下後者。**前者變成鏈上無人認領的孤兒帳戶，而且兩次都「成功」，沒有任何錯誤提示。**

選 (A) 之後，整個 enroll 變成 `(owner, strategyId)` 的**純函式**，跟 `computeSalt` 同性質 —— `getCode` 冪等守衛才真的有意義，重跑必然落在同一個地址。

**撞索引怎麼辦**：兩個不同的 `(owner, strategyId)` 撞同一索引時，`session_keys_key_ref_key` 的 UNIQUE 會在 insert 時擋下 → 整個交易回滾 → 大聲失敗（23505），不會靜默共用金鑰。代價是那次的鏈上部署白做（無害）。碰撞機率約 2^-31/對，等同生日界約 46k 個 portfolio 才有一半機會。

**附帶好處**：不燒 sequence、不產生 id 缺口、enroll 完全不需要先讀寫 DB。

---


## D-20 · gas 由使用者自己的 smart account 支付（v1 不做 paymaster）

| | |
|---|---|
| 決策 | 使用者把 BNB 存進自己的 smart account，執行時 gas 從該帳戶扣 |
| 選項 | (A) 使用者自己存 BNB (B) 架 paymaster 代付 (C) operator 定期補 |
| 選擇 | **(A)** |
| 拍板 | 使用者（依工程建議） |

**先釐清一件容易搞混的事：這裡有兩筆 gas，付的人不同。**

| 階段 | 誰發交易 | 誰付 gas |
|---|---|---|
| ① 建帳戶 + `AtpRegistry.enroll` | operator EOA 的普通交易 | **operator**（見 D-04） |
| ② 執行再平衡 | session key 簽的 **UserOp** | **使用者的 smart account** |

原因是 ERC-4337 的 UserOp **gas 由 `sender` 預付**，不是由簽名者付。session key 只是「有權限指揮這個帳戶」，它不持有資產。

**實測成本**（一筆真實上鏈的 op）：gasUsed ≈ 250,000、BSC 有效 gas price ≈ 1.22 gwei → **一次 op ≈ 0.0003 BNB**。存 1 BNB 約 3300 次。

**為什麼選 (A) 不選 (B)**

不是因為 paymaster 不好，而是**現在沒有計量基礎去承諾代付**：我們還沒有真實 op 頻率、沒有單次 gas 成本的分佈、也沒有建過 gas 支出的帳。(A) 今天就能做完，而且 (A) 跑一段時間後產生的資料，正是之後設計 paymaster 參數（deposit 上限、per-op 限制、成本如何從 swap fee 回收）的依據。

**已知的 UX 代價**：使用者必須額外持有 BNB。對「只想買股票指數」的使用者這是摩擦。這是 v1 接受的債。

**(C) 為什麼不選**：等於我們付錢但假裝不是，gas 從 operator 錢包流出、與平台營運成本混在一起，帳記不清。

**與 GasPolicy 的關係**：session key 的 GasPolicy 預算設 `1e18` wei（= 1 BNB 的 gas，見 D-14）。所以**使用者存超過 1 BNB 的部分用不到** —— 會被 GasPolicy 先擋下。兩者要一致思考，`MIN_SESSION_GAS_WEI` 的預設值（0.01 BNB）刻意遠低於這個上限。

---

## D-21 · `validUntil` 持久化到 `enrollment_intents`，讓帳戶地址可重建

| | |
|---|---|
| 決策 | 在**任何鏈上動作之前**把 `validUntil` 寫進 `enrollment_intents`（key = `user_id + strategy_id + chain_id`），重試時讀回同一個值 |
| 選項 | (A) `validUntil = 0` 永不到期 (B) 持久化 (C) 時間取整到粗粒度桶 |
| 選擇 | **(B)** |
| 拍板 | 使用者（依工程建議） |

**這是在修一個既有的 bug，不是在加功能。**

帳戶地址 = `f(initConfig, salt)`，而 `initConfig` 含 timestamp policy 的 `validUntil`（預設 `now + 365 天`）。實測只改 `validUntil` 就會得到不同地址：

```
validUntil = 1825508606 → 0x2b082FAd…d042
validUntil = 1825512206 → 0x2017888D…f325   （只差 3600 秒）
```

**失效模式**：`enroll` 鏈上成功但 DB 寫入失敗 → 重試時 `validUntil` 已經不同 → **部署到第二個地址** → 鏈上留下孤兒帳戶，帶完整權限安裝與 registry 註冊，**且無法回收**（我們沒有使用者的 sudo key）。

這正是 D-19「穩定索引」想防的事 —— 它把 session key 變成純函式，卻漏了 `validUntil` 也是地址輸入的一部分。

**為什麼不選 (A)**：`validUntil = 0` 能讓 initConfig 完全確定，但會**失去時間止損**。而一年只跑 52 次再平衡，時間界其實比 GasPolicy 的 3300 次預算更早生效 —— 它是真正有效的止損，不該為了少一張表而放棄。

**為什麼不選 (C)**：把時間取整到整點能讓重試窗口幾乎總在同一個桶內，但跨桶邊界時**仍會產生孤兒**。機率小但不是零，而這個 bug 的失效模式不可回收。

**教訓**：任何會進入 `initConfig` 的東西都必須**可重建**，否則地址就不可重建。**時間不是**。

---

## D-22 · bundler 一律走後端 relay，瀏覽器不直連

| | |
|---|---|
| 決策 | 新增 `POST /bundler`（需 token、方法白名單），前端所有 UserOp 都經它轉發到 `BUNDLER_URL` |
| 拍板 | 工程（受 alto 限制所迫 + 安全性更好） |

**起因是一個硬限制**：前台在瀏覽器裡送 UserOp 時直接被 CORS 擋死。查證發現 **alto v1.2.5 完全沒有 CORS 支援**（`--help` 無相關選項、`OPTIONS` 回 404 且零 `access-control-*` 標頭）。v1.2.8 有 `enable-cors`，但它對 EP v0.7 的 SafeValidator 是壞的（D-11）。**所以任何瀏覽器都不可能直連 bundler，生產環境也一樣。**

**這推翻了先前的設計**：原本的架構是「前端自己組 op、自己簽、自己送 bundler」，當時我考慮了「暴露 bundler URL」的成本，但沒考慮到**瀏覽器無法繞過 CORS**。

**relay 的好處不只是「能跑」**：
- alto 不必對外（綁 `127.0.0.1` 即可）
- 可以限流（誰能送 op、送幾次）
- 複用既有 `Authorization` 認證，不必給 bundler 另一套權限
- **方法白名單**擋掉 `debug_*` 這類危險方法（用 `Set.has` 而非前綴比對，否則 `eth_chainIdFoo` 會過）

**代價**：多一個轉發層（一個 hop 的延遲 + 一段要維護的轉發程式碼）。UserOp 是請求/回應、不是長連線，所以沒有 CDN timeout 問題。

**關鍵實作要求**：上游的 JSON-RPC `error` 物件必須**原樣透傳**，不能改寫成後端的 `{error:{code,message}}` 形狀 —— 前端要靠它顯示原文診斷。

---

## D-23 · Executor 改成 per-call oracle（**已拍板、尚未實作**）

| | |
|---|---|
| 決策 | `executeRebalance` 的 oracle 從建構子 immutable 改成每次呼叫傳入 |
| 拍板 | 工程（受合約限制所迫） |
| 狀態 | 實作業已完成（本輪），但**做法改了**：見下方「實際做法」 |

**起因**：`AtpExecutor.oracle` 是 `immutable`，而 `PancakeV3TwapOracle` 在建構子就釘死**一個 pool**：

```solidity
IOracleFloor public immutable oracle;                    // AtpExecutor.sol:37
IPancakeV3Pool public immutable pool;                    // PancakeV3TwapOracle.sol:75
if (inIsToken0 ? tokenOut != token1 : tokenOut != token0) revert UnsupportedPair();  // :167
```

部署時傳的是 WBNB/USDT 那一池。**所以今天這套合約只能再平衡 WBNB ↔ USDT，任何涉及第三個代幣的 step 都會 revert。** 一個 bAAPL/bTSLA/bNVDA 的股票指數根本執行不了。

**關鍵觀察**：`IOracleFloor.previewSwap(tokenIn, tokenOut, amountIn)` 這個**介面本身已經是與 pair 無關的** —— 是實作把它綁死的。所以技術上不需要改介面。

**為什麼選 per-call 而不是「只換 oracle 實作」**：兩條路都一樣會產生新的 Executor 地址（因為 oracle 是 immutable），而 address 一變，**所有 session key 的 CallPolicy（target 釘在 executor 上）都要重建**。既然代價已經付了，就順便把「以後換定價策略要重新部署」這個成本也消掉。

**代價**：`executeRebalance` 的 selector 會變 → CallPolicy 白名單要一起改 → 所有既有權限失效需重建。DEV 只有 4 個帳戶，現在付最低。

**為什麼現在不做**：排程器與索引器都還沒跑出真實資料。先知道「真實漂移分佈、真實 bStock 深度、真實 gas 成本」，才能決定 oracle 的參數（fee tier 怎麼選、要不要加流動性下限）。先拍參數再改合約，很可能改完發現參數不對要再改一次。

---

## D-24 · 漂移的宇宙是 `version.assets`，策略外持倉不阻擋

| | |
|---|---|
| 決策 | 漂移只在策略的 `version.assets` 內正規化；策略外持倉只記錄不阻擋 |
| 拍板 | 產品（在「要不要租專用 RPC 節點」的討論中釐清） |

**起因**：code review 把「未知持倉不可見」判為【高】，理由是「總值低估 → 權重算錯 → 而 `complete=true`」。我照單全收，建了掃描游標、候選表，還準備租專用 BSC 節點（公共節點拒絕不帶 address 的多塊 `getLogs`）。

**但那個 review 用錯了模型。** 它假設漂移的分母是「帳戶全部持倉的總價值」。而在我們的合約約束下（`AtpExecutor.sol:180-182`：`AssetNotAllowed`），**執行器拒絕換任何不在 `version.assets` 裡的代幣** —— 策略外的代幣我們**根本賣不掉**，把它們算進分母只會產生「無法執行的指令」。

**所以正確的語意是**：漂移只在 `version.assets` 內正規化。一筆空投不進 `holdings`、不進分母，`grossDriftBps` 與沒有空投時逐位相同。

**代價**：`priceable_assets` 從「讀哪些資產」降級為「這地址的價格怎麼查」的查詢表。`unknown_token_count` / `universe_complete` 保留為**運維觀測訊號**，不再是可信度 gate。0009 的 `portfolio_snapshots_unknown_holdings_incomplete` CHECK 被 0011 移除（那是在舊語意下寫的）。

**教訓**：一份語氣肯定的 review 也要回頭核對它依賴的前提。「總值低估」在另一個模型下是真 bug，在我們的模型下不是。

**實際做法（推翻原案的 per-call 設計）**：新增 `AtpMultiPoolOracle` router，內部持有「asset → per-pair `PancakeV3TwapOracle`」對照表，`previewSwap` 純轉發。`AtpExecutor` **一行未改**。

理由：`IOracleFloor.previewSwap(tokenIn, tokenOut, amountIn)` 這個介面本來就與 pair 無關，是**實作**釘死的。per-call 要改 `executeRebalance` 的簽名（動管錢的合約），router 達到同樣目的（加新標的不需重部署 executor）而**不碰資金路徑**。

兩條路的遷移成本相同（都產生新 Executor 地址 → 所有 session key 的 CallPolicy 要重建，見 `pitfalls §8.15`）。既然成本躲不掉，就選風險小的。

---

## D-25 · 淺池被 `BelowFloor` / impact 上限擋掉是**設計**，不是缺陷

| | |
|---|---|
| 決策 | 流動性不足時不硬換，等市場把流動性搬上來再說 |
| 拍板 | 產品 |

執行器的 `BelowFloor`、規劃器的 impact 上限（`maxImpactBps`，預設 50）在池子太淺時會擋下 swap。直覺會把它當成「系統太慢／容量不足」，**但那是錯的讀法**。

**刻意的行為**：rebalance 依照**鏈上當下的流動性**決定做多少；流動性不夠就只做一小塊（或完全不做），**絕不硬換在爛價格上**。等有人把流動性搬到鏈上，下一輪自然做得多。

**這帶來一個必須接受的操作特性**：一個投組可能需要**多輪、跨數小時**才收斂，而且**收斂速度由市場流動性決定，不是由我們的排程參數決定**。把 `PARTIAL_FOLLOW_UP_SECONDS` 調小於 TWAP 視窗（1800 秒）**不會**加速 —— 它只會讓每一輪可做的量變小（實測：18,680 USDT → 2,557 USDT）。

**什麼時候該擔心**：不是「慢」，而是「**連續多輪完全沒有進展**」—— 那時 `remainingDriftBps` 不會下降。告警的 `portfolio_repeatedly_failing` 會蓋到這一塊。

---

## D-26 · 不把 `account→executor` 腿搬到 Permit2（維持現狀，但目標設計已定）

| | |
|---|---|
| 決策 | **不改** `AtpExecutor`。現狀是每個 token 一次 `approve(executor, uint160.max)`，永不失效 |
| 拍板 | 工程（分析後判定收益不抵遷移成本） |
| 目標 | 選項 4：per-op 精確金額 approve（batch 在同一 UserOp）—— **卡在 CallPolicy 不綁參數** |

合約自己標了 `TODO(permit2)`。分析五個選項後**不改**，理由如下。

**① Permit2 沒有消掉永久授權，只是搬給它。** canonical Permit2 的 `_transfer` 最後仍 `ERC20.safeTransferFrom` —— ERC-20 授權必須存在且**沒有到期日**。而且：
- `permit2.approve` 的 `expiration` 是 `uint48`，**沒有 30 天上限**（可到西元 ~890 萬年）
- `amount == uint160.max` 在 Permit2 裡**不扣減**

→ 它動的是「時間」，而真正能抽乾帳戶的是「**金額**」。

**② per-call `PermitTransferFrom` 需要第二個簽名。** Permit2 驗的是 Permit2 domain 的 `_hashTypedData`，Kernel 驗的是 EntryPoint 的 `userOpHash` —— **兩個不同的 digest → 兩個簽章**。而且 owner 是合約，Permit2 會走 ERC-1271 callback。

**③ 換 executor 的代價反而讓權威變大。** 要讓到期日不變成死線，session key 就得能呼叫 `permit2.approve`；而 CallPolicy **只驗 target+selector、不驗參數** —— 那把 key 就能鑄造任意 Permit2 授權。**不做自動化則每個 token 每個週期要一次 sudo 續約，而後端沒有 owner 私鑰。**

**④ 真正的修法在帳戶層。** 選項 4（per-op 精確 `approve`，batch 在同一 UserOp）—— 零額外簽名、不用 Permit2、**合約不用改** —— 但需要一個**能綁參數的 CallPolicy**。那是一個獨立的、更大的工單。

**過渡期做法（選項 5）**：onboard 時只授**有界 buffer** 而不是 `uint160.max`，零遷移即可消掉「無上限」。⚠ 代價是 buffer 用完要補，而補需要 sudo 簽名。

---

## D-27 · `maxImpactBps` 量的是**總**衝擊（相對 TWAP），不是「本筆造成的增量」

| | |
|---|---|
| 決策 | **維持**總衝擊 ≤ 50 bps。不改成「只看增量」 |
| 拍板 | 產品（2026-11-08 覆議） |
| 覆議了什麼 | 一度認為「把 fee + 現貨 vs TWAP 的既有偏差算進預算」是語意錯誤 |

一度打算把預算改成只看**增量**衝擊（`impactBps(size) − baselineBps`），理由是「baseline 不是我們造成的」。**覆議後否決。**

**理由**：baseline 是**真的會付出去的錢**。現貨比 30 分鐘 TWAP 貴 67 bps，買下去就是相對公允價買貴 67 bps —— 不管那 67 bps 是「我們推的」還是「市場本來就在那」。把預算改成只看增量，等於允許**最多貴到 oracle 容忍的 100 bps**，那是**放寬**風控，不是修正語意。

**佐證**：portfolio 305 曾在 baseline 92 bps（fee 25 + 偏差 67）時連續 `noop`；市場回到 TWAP 附近後同一個投組自動變 `ready`（2 steps、執行後預估 596 bps）。**系統在正確地等**，這正是 D-25 要的行為。

**若真的想放寬**，正確的做法是調**參數**（`maxImpactBps` 或 per-pair oracle 的 `maxSlippageBps`），不是改判準 —— 這樣放寬是看得見、可回滾的。

⚠ 不要忘記：`maxImpactBps`（我們的 50）永遠必須**小於** oracle 的 `maxSlippageBps`（鏈上 100），否則會產生鏈上必定 `BelowFloor` revert 的計畫。

---

## D-28 · 換 executor 的遷移是**四步**，續期不能只寫 `spike/…/state.json`

| | |
|---|---|
| 決策 | 遷移程序固定為：部署新 executor → 每帳戶**重裝**權限 → 重新 approve → **寫進 DB `session_keys`** |
| 佐證 | 2026-11-08 在 portfolio 5 上完整走通（漂移 843 → 0 bps） |

只做前兩步，帳戶在排程器眼裡仍然是壞的 —— 排程器用 **DB 的 `session_keys`** 重建 `permissionId`，DB 沒有的那把等於不存在。

**實測的四步**（`scripts/renew-session-key.ts`）：
1. 帳戶身分**直接讀鏈**（`registry.enrollments(account)`），不要用「重算地址」當守衛 ——
   續期過多次的帳戶只有**第一次**的 `initConfig` 能重現地址（§8.21）
2. 安裝新權限，`CallPolicy.target` = **新** executor，`permissionId` 因此是新的（§8.22）
3. 重新 approve（allowance 的 spender 也是新 executor）
4. **寫進 `session_keys`**（api `POST /portfolios/:id/renewal-result` 或腳本直接寫）

⚠ 第 4 步的 `key_ref` 必須是**沒被用過**的 index，否則 `on conflict (key_ref) do nothing` 會靜默回
`duplicate: true`，DB 那一列描述的仍是舊 executor 的 policy → 排程器重建出來的 pid 對不上鏈上 → 帳戶卡死。

---

## D-29 · 快照的真相是**鏈上餘額**，不是事件累加；每一輪 op 前後各留一張

| | |
|---|---|
| 決策 | `readPositions`（`balanceOf`）是餘額的唯一真相；indexer 只做「未知持倉偵測」與對帳 |
| 決策 | 排程器每次送出前寫 `phase='before'`、落地後**重新讀鏈**寫 `phase='after'`，兩張共用 `operation_id` |
| 拍板 | 工程（2026-11-08） |

**問過的問題**：「跑 indexer 把鏈上事件存進 DB、用事件累加算當前價值，會不會更 robust？」

**答：事件累加不能當餘額的真相。** 三個理由：

1. **它要求「一個 Transfer 都沒漏」。** 掃描中斷一小時，餘額就安靜地錯下去，**而且不會報錯** ——
   這是這個專案最毒的那類故障（看起來正常、其實錯了）。
2. **它對 token 實作做了假設。** fee-on-transfer、rebasing、`delegatecall` 改 storage 的 token，
   事件模型跟不上餘額。標準 ERC-20 今天沒問題，但那是假設，不是保證。
3. **權威在鏈上。** `balanceOf` 是鏈的視角，事件是旁觀者視角。

**所以分工是**：`balanceOf` 回答「現在是多少」；事件回答「誰在什麼時候動了什麼」。
`holdings-scan.ts` 保持原角色（未知持倉偵測），**不升級**成餘額的真相。

**為什麼要前後快照**：2026-11-08 要回答「#305 上一輪到底換了多少、總值掉了多少」時，DB 裡查不到
任何一筆 #305 的快照，而 fork 的歷史在 `loadState` 之後就沒了 —— 那個問題**最後驗不掉**。
現在任何一輪都能直接算：

```
before  block 132254516  op 185  total $513,087.06  drift 832 bps
after   block 132254517  op 185  total $513,022.06  drift 595 bps
   NVDAB  +61.484292  (+$11,883.65)
   USDT   -12,199.079 (-$12,199.08)
   WBNB   +0.359936   (+$251.00)
→ 搬了 $12,199 的價值，付掉 $64.43（fee + impact ≈ 53 bps），漂移 -237 bps
```

⚠ **after 一定是重新讀鏈**，不能沿用送出前的觀測 —— 那一張的全部意義就是「交易真的改變了什麼」。
沿用等於自己抄一份給自己。

⚠ 快照寫失敗**不讓那一輪失敗**：觀測不是這一輪的目的；為了一張快照放棄一筆已規劃好的再平衡才是
真正不可接受的（與告警同一個原則）。

---

## D-30 · `maxImpactBps` 50 → 80，並對「卡住」加告警（A+C）

| | |
|---|---|
| 決策 | 預設總衝擊預算 80 bps（**仍嚴格小於** per-pair oracle 的 `maxSlippageBps` = 100） |
| 決策 | 新增告警 `portfolio_stuck`：最新快照仍 `needs_rebalance` 且超過 6 小時沒有成功執行 |
| 拍板 | 產品（2026-11-08） |

**A 的理由**：50 在「現貨偏離 TWAP 60–80 bps」這種很常見的盤況下會讓每一輪都做不了事（baseline 就吃掉
全部預算），投組長期停在漂移裡。80 讓多數情況做得動，而合約的 `BelowFloor`（100）仍然是最後一道、
且永遠比我們寬鬆 —— 不會送出必定 revert 的計畫。

⚠ **A 不是萬靈丹，算術上說清楚**：真正的上限是 `min(我們的預算 + baseline, oracle 的 100)`。
實測某一輪 baseline 92 bps 時，即使預算 80 也一樣做不了事 —— 那種情況要動的是 oracle 的
`maxSlippageBps`（換 per-pair oracle），不是這裡。**改參數能解的是「中等偏離」，不是「深度偏離」。**

**C 的理由**：D-25 說「等市場」，但**等待沒有終點保證**。#305 卡在 595 bps、每輪 noop，
而既有的三個告警種類都蓋不到它（`portfolio_repeatedly_failing` 只看 operations 的失敗，
而 noop 根本沒有 operation）。

**C 的判定不新增計數器**：用**最新那一張快照**。成功執行會寫 `after` 快照，所以
「最新快照仍 `needs_rebalance` 而且很舊」＝「這段時間內一次都沒成功動過，而上一次觀測說它還需要動」。
記憶體計數器會被重啟／`kill -9` 歸零，快照不會。這個判定同時蓋到「排程器根本沒在跑」——
對人來說那與「一直 noop」是同一個症狀。

**實測**（真實 DB，門檻暫調 1 小時）：

```
[ALERT][warn] portfolio 305 上次觀測漂移 595 bps（仍高於門檻）距今 1.1 小時，
              期間沒有任何一次成功執行 —— 可能是市場讓 impact 預算做不了事
              （看 GET /portfolios/:id/plan），或排程器沒在跑
```

門檻調回預設 6 小時後，下一輪 `[ALERT] 已解除 1 筆（條件消失）` —— 條件消失會自己收掉。

---

## D-31 · 收斂**有地板**，那個地板是 `maxImpactBps` 與市場價差，不是 0

| | |
|---|---|
| 決策 | 接受「漂移會收斂到某個非零地板」，不為了追 0 而放寬風控 |
| 佐證 | 2026-11-08 在 #305 上連續四輪實測 |

```
op   drift before → after   Δ      搬動的 USDT    總值變化
185       832 → 595        −237     12,199        −$64.43
250       589 → 374        −215     11,084        −$55.38
251       374 → 327         −47      2,335        +$181.72  ← 價格移動蓋過成本
252       327 → 260         −67      3,424         +$36.23
```

**第一批（185/250）降 200+ bps；之後每輪只剩 50–70 bps**，而且**每輪能搬的量由 impact 預算決定**，
不是由缺口決定（缺口 ~$80k，但一輪只搬 $2–3k）。

**決定性證據**（op 252 之後的 dry-run 預覽）：

```
買 NVDAB 被跳過：估算衝擊 111 bps 超過上限 80 bps，
縮小之後只剩 1599，不到理想量的 1 bp（dust），送了也只是付 gas
```

也就是說：**剩下的缺口在任何「符合預算」的量下都換不回足夠的改善**。這不是「還沒做完」，是
「在 80 bps 的預算下做完了」。

**所以「無人值守會收斂到門檻以下」這句話只在市場配合時成立。** 正確的說法是：

> 排程器每一輪都會做「預算內划得來」的最大量；當現貨相對 TWAP 的既有偏差吃掉大部分預算時，
> 投組會停在一個**地板**上，等市場回來才繼續。`portfolio_stuck` 告警（D-30）就是為了
> 「等太久」而被看見。

**要真正降低地板，只有兩條路**（都不該由排程器偷偷做）：
1. 調高 `maxImpactBps`（目前 80，oracle 容忍 100）——只剩 20 bps 空間，再調就沒有安全邊際。
2. 換 per-pair oracle 的 `maxSlippageBps`（100 → 150+）——那是**改合約 + 重新部署 + 權限重建**，
   而且等於承認「願意用更差的價格成交」。

---

## D-32 · Session 存 Postgres，不存進程記憶體

| | |
|---|---|
| 決策 | `auth_sessions` 表 + sha256(token)；nonce 仍留在進程 |
| 起因 | 開發時每改一次 backend 就要重新登入；多實例部署等於隨機 401 |

原本 `#sessions = new Map(...)`。兩個後果都是實測踩到的：

1. **重啟即登出**：這一輪光是為了截圖就重取 token 五次以上；生產的 rolling restart 等於每次上線清空所有 session。
2. **多實例不可用**：A 發的 token，B 不認識。

**存 sha256(token)，不存 token 本身**：資料庫備份或一次 `SELECT` 洩漏，拿到的是雜湊，
不是可用的 session（token 只在發出的那一次出現在 HTTP 回應裡）。

**過期由 DB 的 `now()` 判斷**，不是應用程式的時鐘 —— 兩個實例差幾秒時，使用者不會「在 A 能用、
在 B 不能用」。

**nonce 不搬**：5 分鐘、單次使用、只在同一次登入流程內有意義；放進 DB 只增加寫入量。

實測：取得 token → 重啟 backend → 同一個 token 打 `/portfolios` 回 **200**。

---

## D-33 · 「建好的投組要能動」是產品要求；目前只做到腳本補丁

| | |
|---|---|
| 決策 | approve 應該併進 enroll 的同一個 UserOp（待實作） |
| 現況 | `scripts/fund-portfolio.ts --approve` 補丁 |

實測走完一次完整流程（create → 入金 → approve → 再平衡，漂移 6600 → 8 bps），過程中卡在
`[ALLOWANCE_TOO_LOW]`：**enroll 不會開 ERC-20 allowance，而 session key 也開不了**（CallPolicy 只白名單
`executeRebalance`，放寬它等於把受限權限換成更大的權限）。

所以「用一個指令把 vault 變成可用的」目前是**兩件事**：入金 + approve。這在真鏈上是要花錢的兩步，
而且**忘記第二步的症狀是「按下去被擋」**，不是「建立失敗」—— 使用者會以為系統壞了。

**要做的**：把 `approve(token, executor, max)` 的 calls 併進 enroll 的 UserOp。兩者都是 sudo 簽名，
本來就可以 batch 在同一個 op 裡。驗收標準：新建的投組在入金之後，**不需要任何額外指令**就能再平衡。

---

## D-34 · approve 放 app（owner 簽一筆 UserOp），不併進部署 op

| | |
|---|---|
| 決策 | create 流程在建好之後自動：補 gas → 簽一筆 approve UserOp |
| 取代 | D-33 的「併進 enroll 的同一個 UserOp」這個方向 |

D-33 寫的方向是錯的，原因是讀程式碼才發現：**enroll 不是用 UserOp 部署帳戶**。

```ts
// chain.ts —— operator 直接送 factory 交易，owner 完全沒簽名
await wallet.sendTransaction({ account: operator, to: factory, data: factoryData });
```

所以沒有「enroll 的 UserOp」可以 batch。而且**後端沒有 owner 的私鑰**（`addressToEmptyAccount`），
它根本簽不出 approve。

**那為什麼不改成「owner 簽一筆含 `initCode` 的 UserOp」一次做完部署+權限+approve？**
技術上可以（initCode 跑在 callData 之前），但前端就必須重現決定**帳戶地址**的 `factoryData`
（`initConfig` 在裡面，見 D-21）。兩邊算不一致時，使用者會部署出一個**後端不知道的帳戶** ——
孤兒地址，救不回來。同樣是「一次簽名」，現在的形狀避開了這一類 bug。

**成本分配**：部署的 gas 仍由 operator 付；approve 那筆 op 由帳戶付，所以流程會先補 shortfall
（實測 0.01 BNB）。使用者看到的是「建立 → 一次簽名」，不是「建立 → 自己去 approve」。

實測 portfolio #1682（全新建立）：`shortfall=0.01 BNB → 補 gas → 一筆 UserOp(success) → 三個資產 ok
→ 入金 $5,000 → 預覽 ready（2 step）`。

---

## D-35 · `snapshot.integration` 暫時 skip，不自足化（成本換不到的兩件事）

| | |
|---|---|
| 決策 | 這組測試改成「fixture 不在就明確 skip」，不重構成自足 |
| 理由 | 它驗的是**鏈上行為**（真的 balanceOf、真的池子 slot0、真的 debug_traceCall） |

自足化意味著每個測試都要先自己 enroll 一個 portfolio（部署帳戶 + 掛策略 + 灌代幣），
而那條路徑本身已經被 `enrollPortfolio mirrors to chain` 那支測過。用 10 倍的執行時間
換一個已經被覆蓋的前置條件，不划算。

**代價**：這 7 條在乾淨環境永遠是 skip —— 所以它們**不會**在 CI 擋下任何東西。
接受這個代價的前提是「它們在原 dev 環境仍然是綠的」。如果哪天有人以為 CI 綠燈代表
snapshot 寫入被驗過，這個決策就是錯的。要恢復它的價值，就得自足化。

---

## D-36 · deposit 時 gas 不足**自動補**，不擋下

| 項目 | 內容 |
|---|---|
| 決策 | deposit 前偵測 Kernel 帳戶的 BNB，不足就自動送一筆 top-up，再轉 USDT |
| 觸發點 | 清倉會把 BNB 掃回錢包（只留 0.003 給當次 gas），下一次 deposit 之後再平衡就付不出 gas |
| 實測症狀 | `Send failed: Smart Account does not have sufficient funds` —— 錢到了、配置失敗 |

### 為什麼不是「擋下叫使用者自己補」

第一版是擋下並顯示：

    This fund's account has only 0.0016 BNB for gas (needs 0.05).
    Top up 0.0484 BNB first — your first rebalance would run out of gas.

這在**技術上正確**，但把我們的內部概念（Kernel 帳戶、gas 儲備）丟給使用者處理。
使用者剛按下 Deposit，被告知「請先去別的地方按另一顆按鈕」—— 而那顆按鈕之所以需要存在，
只是因為我們的清倉會把 gas 掃走。**是我們造成的，就該我們收尾。**

### 代價（明講）

deposit 的簽名次數變成**取決於帳戶狀態**：

| 情境 | 簽名次數 |
|---|---|
| gas 足夠 | 1 次（USDT 轉帳） |
| gas 不足 | **2 次**（先補 BNB，再轉 USDT） |

「同一個動作有時要簽兩次」在錢包體驗上是缺點。接受的理由是：它只發生在「清倉後再入金」
這個我們自己造成的路徑上；而且 toast 會明講 `Topping up gas`，不是偷偷多彈一次。

### 補多少

    topUpWei = (minimumWei − balanceWei) + 0.01 BNB

`minimumWei` 是後端算的「一輪再平衡需要的最低 gas」；`+0.01` 是餘裕，避免補完立刻又低於門檻。

### 新帳戶也要補

剛 `enroll` 的帳戶 gas 一定是 0。第一版對它**跳過檢查**（否則第一次存款永遠過不去），
但那個理由在「自動補」之後消失了 —— 現在新帳戶也走同一條補 gas 路徑，
`minimumWei` 查不到時用 `0.01 BNB` 當下限。

### 什麼情況會失效

* owner 錢包的 BNB 也不足 → top-up 交易本身會失敗（錯誤會顯示在 toast）
* RPC 讀不到 gas 狀態（`gas === null`）→ 當作餘額 0 處理，**會**補 gas（寧可多補，不要半套）

---

## D-37 · 跳過 testnet，直接主網部署

| 項目 | 內容 |
|---|---|
| 決策 | 不做 BSC testnet 驗證，直接在 chainId 56 部署並用小額真錢驗證 |
| 理由 | **我們依賴的資產在 testnet 上不存在**：bStock 代幣（TSLAB/SPCXB）、以及真實的 PancakeSwap 池子與 aggregator 路由 |
| 代價 | 部署錯誤要花真錢修（但 BSC gas 極低，實測 0.05 gwei，整組合約 < 0.001 BNB） |

### 為什麼 testnet 測不出東西

testnet 上會驗證到的只有「合約能不能部署、函式能不能呼叫」——那些在 fork 上已經反覆驗過幾十次。
真正會出事的地方全部依賴主網才有的東西：

* bStock 代幣合約本身（testnet 沒有）
* 這些代幣對 WBNB 的**池子與 fee tier**（testnet 沒有流動性）
* aggregator 路由（testnet 沒有真實路由可走）

在 testnet 上跑一輪「成功」的再平衡，只能證明我們的合約能跟**假的**池子互動 —— 那不是這次要驗的東西。

### 部署前已驗證的主網事實

    主網 RPC       chainId 56，可達
    位址簿        腳本裡那 4 個 fork 位址在主網**全是空的** → 會乾淨重新部署
                   （若有 code 會被誤認成「可重用」，腳本會 revert 而不是靜默用錯）
    TSLAB 池       liquidity 8.12e23
    SPCXB 池       liquidity 5.19e23
    BTCB  池       liquidity 9.43e23
    ETH   池       liquidity 3.39e23

最後一項是關鍵：`AtpExecutor._checkStep` 會在執行期 re-quote oracle，而 oracle 綁的是
**特定池子**。池子若沒有流動性，報價會爆掉、再平衡必然 revert（fork 上踩過：死池的 slot0
停在 MAX_TICK，報價變成天文數字）。四個池子都有流動性 → 這條路是通的。

### 部署錢包不能用 anvil 測試帳號

anvil 的測試私鑰（`0xac0974…`、`0x7c8521…` 等）是**公開的**，主網上任何人看到餘額就能搬走。
所以另外產生了全新的錢包，金鑰只存在 `.env.mainnet`（chmod 600、已 gitignore），
只放部署所需的少量 BNB。

---

## 待決（尚未拍板）

### 待決-1 · 使用者簽名通道要用什麼

這個決策會一次解掉三個問題：
1. session key 續期（D-15 的技術債）
2. 使用者自行安裝／更換 permission（D-13 的限制）
3. EIP-1271 / ERC-6492 的 SIWE（待辦 #2）

選項未定：WalletConnect（最貼近既有錢包）、嵌入式錢包（Privy / Dynamic 這類，UX 最好但要引入供應商）、本地 CLI（最快但使用者體驗最差）。

**這是下一刀之後最該處理的架構決策。**

### 待決-2 · Kernel 版本升級策略

目前 pin v3.3（D-03）。換版本時 factory / impl / validator 全要換 pin，且**所有新帳戶的地址會變**。目前沒有升級壓力，但要在某個時點決定「跟隨 upstream」還是「凍結在 v3.3 直到必要」。
