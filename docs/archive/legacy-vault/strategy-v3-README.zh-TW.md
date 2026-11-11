<!--
  來源：bnb-agent-vaults/docs/strategy-v3/README.zh-TW.md
  複製日期：2026-11-06
  狀態：**已廢棄架構**（pooled vault：共享金庫＋份額）。
        保留僅作歷史對照，用來說明「為什麼要遷移到 ATP」。
        不可作為現況參考，也不可據此實作。
-->

# PR20：多資產、多策略 Vault 定案與實作入口

決策日期：2026-10-05。產品：CRE8（repo／早期研究亦稱 Sherwood）。本組檔案是產品決策來源，**不是已上線功能清單**。PR20 的初始提交 `635b5a8` 是規格與交接；2026-10-07 的 PR29 已實作 mixed parent／factory、原生部位及 deterministic worker，當時仍有未完成策略和發布驗收、未公開部署；目前 mixed 已部署 BSC 測試網，公開紀錄於 2026-10-22 切到實際協議程式碼，主網仍未部署。目前狀態——程式碼地圖、各工具的規格／本地實作／fork／部署狀態、修正、gas 證據、驗證與剩餘工作——集中在 [工程交接](HANDOFF.zh-TW.md)；[合約與執行進度](../archive/strategy-v3/CONTRACT_EXECUTION_CHECKPOINT_2026-10-07.zh-TW.md) 與 [實作狀態](../archive/strategy-v3/IMPLEMENTATION_STATUS.zh-TW.md) 是逐批的歷史紀錄。

工程盤點基準：PR17 `codex/mandate-product-completion`，commit `e4a8e07c906aecc6313f87930387137d1b08ff2e`。PR19 的個人 Agent、聊天、付款及方案流程沿用其介面，不在這裡重做。PR20 與 PR19 都接在 PR17 上；合併與後續實作時要重新核對最新 base，不能把另一支分支的舊 ABI 複製進來。

## 閱讀順序與檔案責任

| 檔案 | 負責回答 |
| --- | --- |
| 本頁 | 最後同意了什麼、資產範圍、借款數值、哪些提案取消 |
| [TOOLS](TOOLS.zh-TW.md) | 每一項用途、使用者填什麼、怎麼持續執行、容易出錯在哪 |
| [ENGINEERING](../archive/strategy-v3/ENGINEERING.zh-TW.md) | 現有程式碼盤點、共用邊界、資料模型、狀態與協議差異 |
| [HANDOFF](HANDOFF.zh-TW.md) | **目前狀態**：文件與程式碼地圖、各工具狀態、已做的修正、gas 與真實協議證據、最終驗證、剩餘工作；附錄為 A01–A36 驗收案例原文與規格數值向量 |
| [RESOURCES](../archive/strategy-v3/RESOURCES.zh-TW.md) | BNB／Pancake／交易所資源、可重用程度、官方來源 |
| [RELEASE_RUNBOOK](RELEASE_RUNBOOK.zh-TW.md) | 營運：角色與權限、建置與凍結檢查、部署順序、catalog 准入、joinGas、外部前置條件、keeper、D06 與 raw exit |
| [ACCEPTANCE_A01_A36_STATUS](ACCEPTANCE_A01_A36_STATUS.zh-TW.md) | 每個驗收案例的子條件對到哪個實際存在的測試 |
| [CONTRACT_EXECUTION_CHECKPOINT](../archive/strategy-v3/CONTRACT_EXECUTION_CHECKPOINT_2026-10-07.zh-TW.md)、[IMPLEMENTATION_STATUS](../archive/strategy-v3/IMPLEMENTATION_STATUS.zh-TW.md)、[COMPOSITE_SPOT_*](../archive/strategy-v3/COMPOSITE_SPOT_IMPLEMENTATION_2026-10-06.zh-TW.md) | 歷史紀錄（逐批的實作、數字與當時的缺項） |

本頁與 TOOLS 是**這輪新增功能的產品決策來源**。數值只在本頁定義，其他檔案引用。ENGINEERING 內明標「建議」的型別、切分及工作順序是實作方案；不得誤稱使用者另外批准了新功能。示例價格、頻率、比例不代表通用預設或報酬承諾。

既有 [Vault v2 規則](../VAULT_RULES_V2.zh-TW.md) 與 [PR17 工程覆核](../archive/PRODUCT_COMPLETION_ENGINEER_REVIEW.zh-TW.md) 保留目前程式語義；與本組新增目標衝突時，**現有程式不會因為更新檔案就自動支援新規則**。HANDOFF 列出必要改造。

## D01：產品與執行邊界

- 一座 vault 可有多種資產、多個 LP 及借款部位。每個資產可使用不同策略，**同一資產可拆核心持倉與交易持倉，甚至多個策略**；資金及持倉只能分配一次。
- 設定一次之後，按價格、時間、有效完整 K 線、成交結果及固定公式持續執行。計算訊號、選交易、重試與風控**不呼叫 LLM，不消耗 AI token**；仍有行情、keeper、gas 與協議成本。
- 聊天只負責找 vault／形成可審核設定，沿用 [PR19](https://github.com/joooe453-creator/bnb-agent-vaults/pull/19)。Connect、登入、授權資金是不同步驟；不能把 connect 當成無人值守交易授權。
- 現貨與 AMM LP 為範圍；用 vault 資產抵押借穩定幣生息已另外同意。沒有期貨、永續、期權；沒有借款再抵押的迴圈槓桿。
- **沒有 90 天固定存款鎖定**。上游提款受限、BNB 解質押等待與尚未完成的減債，必須顯示實際原因及狀態，不能包裝成新固定鎖定期。
- 費用（2026-10-10 調整）：存入費 1%，建立人種子的 1% 稱為建立費（種子不另收存入費）；不收操作費（hook 保留、費率 0）；績效費維持平台 10% + 建立人 0–20%。份額不可轉讓、建立人 seed／2% 持有規則不變。新交易路徑必須接同一 fee accounting，不能漏收或重複收。

## D02：資產與手動上架

| 用途 | 最終範圍 | 開放前條件 |
| --- | --- | --- |
| bStock 持有／現貨交易 | **所有真正的 bStocks**，不限 Mag7 | issuer、合約、底層標的、倍率／公司行動、價格、以實際操作金額驗證買入及退出深度 |
| Crypto 持有／現貨交易 | 初始按全球市值前 30 名建立**固定平臺清單** | BNB Chain 上對應版本、合約、對映、價格及流動性逐一批准；不是任意同 ticker 代幣 |
| Crypto 抵押 | 同一初始前 30 名範圍 | 另核對 Aave／Lista／Venus 具體市場是否真的接受該 BNB 版本及借款幣 |
| bStock 抵押 | 可驗證的 bStocks 實際抵押市場 | 交易支援不等於抵押支援；確認 oracle、借款上限、清算門檻、額度與退出 |
| 穩定幣 | U、USDT、USD1、USDC；可同時持有多種 | `U` 是 United Stables 的具體 token，不能把所有美元資產都對映成它 |
| Pancake 既有 LP | 逐池支援的既有現貨 LP；**底層資產不必限於 bStocks／Top30** | 版本、token pair、fee、range、相容性、持有／質押與退出權限分別批准，並顯示真實穿透曝險 |
| 收入 token | 支援策略實際取得的費用／獎勵 | 留存可以形成額外曝險；不得因獎勵幣不在現貨名單就悄悄全部換成 U |

**不自動更新資格。** 掉出前 30 不自動下架；排名上升不自動上架；vault 也不按平臺排名自動換成分。官方之後手動上架，分別標示「可交易」「可抵押」「LP 支援」，可供 New Listing 宣傳。市場參數、價格、流動性及債務風控仍即時檢查；真實事故可暫停新增風險。

排名落地：CoinGecko global USD circulating `market_cap_rank` 的原始 Top30（不是 FDV），stablecoin 佔原排名名額，BTCB 對映 BTC、WBNB 對映 BNB。[2026-10-06 初始資料與准入報告](../TOP30_ADMISSION_2026-10-06.zh-TW.md)已儲存 30 個原排名、19 個可交叉核對的 BNB 版本，以及逐池檢查結果。ETH／WBNB 的直接 USDT Hold 路徑通過真實 fork，形成**待鏈上治理核准的提案**；不是 30 個皆已批准的合約清單，也不代表抵押或完整 v3 執行支援。新增平臺 listing 不會自動擴大既有 vault 的 mandate。

**2026-10-12 決定：bStocks 先不用外部 oracle（只限組合金庫）。** bStocks 在 BNB Chain 上沒有 Chainlink feed，`MandateMarketFeed`（Chainlink Data Streams）的根本修正也還沒完成。組合金庫的入金是實際買進各資產、提領是領走自己那一份，誰的錢都不是照報價算的；價格只用來擋住被灌價的池子、觸發策略與計算費用。因此 bStock 的 route 改用 `MandatePoolTwapFeed`（該代幣自己的 PancakeSwap V3 池 30–90 分鐘 TWAP）搭配 `MandateUnitPriceFeed`（帳務資產 = 1），既有合約不變。條件：池子 USDT 端至少 50,000（硬性，不是 Top30 的「thin」警示）、observation 容量 ≥ 2,400、現價與 30 分鐘 TWAP 相差 ≤ 1%、Binance 現貨價做為鏈下對照紀錄；先只做現貨策略，借貸、LP、借款之後再開（2026-10-13 更新：放貸與以股票抵押借 USDT 已開放，限 Venus；LP 仍未開，見 HANDOFF 第 35 點）。V2（classic）照舊等 MarketFeed 修正（2026-10-22：V2 已允許以 MarketFeed 定價股票腿，因為 V2 的入金以三者最高價計價、現金退出付實得，挑選報告動不了持有人之間的價值；組合金庫照舊用池子 TWAP，見 [HANDOFF 第 53 點](HANDOFF.zh-TW.md)）。Chainlink 之後接得上時，加為第二層獨立價格。實作與數字見 [HANDOFF 第 31 點](HANDOFF.zh-TW.md)。2026-10-13 安全審查後：池子定價的賣單另以近 5 分鐘平均價為下限、keeper 只在 Binance 確認價格（2% 內）時交易、准入要求價格 ±2% 各 10,000 USDT 的深度（[HANDOFF 第 33、34 點](HANDOFF.zh-TW.md)）；上主網前仍需行情發布的營運、fork 演練與正式准入（[runbook 的 bStocks 一節](RELEASE_RUNBOOK.zh-TW.md)），在那之前只在測試網使用。

## D03：已納入的工具

| ID | 工具 | 定位與狀態 |
| --- | --- | --- |
| T01 | 單資產／多資產 DCA | 基本；含買入上限、恢復、止損、止盈、結束／重啟 |
| T02 | 多資產再平衡與籃子 | 基本；等權、自訂、市值加權上限、股／幣／現金分層、核心／交易分層；時間由使用者選 |
| T03 | 固定區間現貨網格 | 基本；算術／等比例、已擁有庫存、固定預算及迴圈 |
| T04 | 每批止盈＋迴圈回補 | DCA 進階；不同批次獨立成本、實際賣出價作回補基準 |
| T05 | 有限順勢分段加碼 | 有限每輪預算、加碼級數、整輪風險、退出後新訊號重啟 |
| T06 | 回檔收復買入 | 先回檔、再反彈確認；每輪一次，不是越跌無限補 |
| T07 | 強勢資產輪動 | 固定授權候選池、分股票／crypto 比較、換入門檻與冷卻 |
| T08 | Pancake 既有 LP | 多 LP、投入、收費、有效 farm、原策略複投、可選內部退出資產 |
| T09 | LP 自動區間重建 | 進階；同池固定寬度、出界確認、次數／成本／移動範圍限制 |
| T10 | 共用收入處理 | 只填複投比例；複投到原策略或留存賺到的 token |
| T11 | 價格條件／限價、固定止損止盈 | 共用成交／退出工具；完成一次任務，由持續策略建立下一次 |
| T12 | 移動止盈 | 共用退出工具；啟用後高點只上移，第一版完整退出指定批次／輪次 |
| T13 | TWAP | 共用成交工具；把一次交易分時，與持續 DCA 分工 |
| T14 | 閒置穩定幣生息 | Aave／Lista／Venus，同鏈同幣，不為存款自動換幣 |
| T15 | 同一交易對 LP 自動換池 | **第二階段**；同鏈同 pair、批准池、收益優勢扣遷移成本 |
| T16 | Vault 整體止盈／止損 | 共用全池退出；不是每位持有人自己的成本報酬 |
| T17 | 資產對資產相對價格網格 | 例如 ETH／BTCB；共用網格但有雙資產及雙腿路由會計 |
| T18 | BNB 質押生息 | 先由官方開示範 vault；尚未建立／部署，退出區分市場賣出與解質押 |
| T19 | Vault 抵押借穩定幣再供款 | 單抵押品獨立部位，可同時使用三個協議；只投下方十個目的地 |

持有／一次買入是既有配置方式，不為增加策略數量另造引擎。價格策略捕捉價格變動、LP 收取費用／可能獎勵、供款收利息、BNB 質押取得分潤、借款 carry 取得扣債務成本後的利差；配置、TWAP、收入分配本身不新增收益來源。

## D04：Mag7 定案

Mag7 以 Apple、Microsoft、Alphabet、Amazon、Nvidia、Meta、Tesla **七家公司**為成分。七檔批准且可交易才啟用模板，不能缺一檔自動變成六檔。

- 等權：Mag7 區塊內每家公司 `1/7`，最後以 deterministic remainder 分配 bps／raw units。
- 市值加權：底層公司的**流通市值**，不是股票代幣流通市值、池 TVL 或發行量。Alphabet 多股別按公司合併，避免重複公司權重。
- 預設單公司上限 **20%**，進階可選 **25%**。這是我們的產品政策，不能宣稱是傳統金融統一標準。
- 在再平衡時計算 cap，期間允許漂移；以 Mag7 子組合為分母，不是全 vault。fully invested 七家公司最低可行 cap 是 `1/7`。
- 官方模板預設**每季**，使用者可選頻率／日期／時間／時區與「到期調整」或「到期檢查漂移後調整」。即使到期調整，也有最低交易與成本限制。
- 反覆 cap 與重新按剩餘市值分配，直到沒有超限；不能只截斷一次再全體 renormalize，否則又超限。

## D05：收入處理與退出的範圍

複投比例 0%：全留原收入 token；50%：一半同策略複投、一半留原 token；100%：全部可用淨收入同策略複投。以扣相關成本後可用收入計算，不碰本金；只可換複投那份。留存不自動換 U、不流入其他策略；未能投入的複投份額保持待投入，仍受原策略進場／上限限制。

單資產／策略止損止盈只操作自己分配的持倉。某籃子成分觸發退出，第一版先暫停**整個該籃子的新增買入與再平衡**；其他成分退出監控繼續，符合設定重啟條件才恢復，不能自動把資金攤給剩餘成分。

**LP 內部離場**可選兩邊原幣、全 A、全 B、指定穩定幣或其他支援且已核准路由的資產。**離開 vault**則結算成該 vault 指定穩定幣；借款要先處理退出份額對應債務。搬移 LP 區間的資金直接接新 LP，不先轉退出幣再買回。

## D06：借款與減債（最新「可以」已確認）

借款使用 vault 自己的資產，債務與損益由所有持有人共同承擔。每個部位**一種抵押品、一種債務幣、自己的市場與帳戶**。可同時使用 Aave、Lista、Venus，不要求整座 vault 只用一個協議；協議原本會合併抵押品時，需真實隔離帳戶，不能只是 UI 分行。獨立帳戶隔離計算／清算，**不隔離共同 vault 的經濟損失**。

以下 `L` 是該市場清算門檻（Lista LLTV／Aave LT／Venus LT），不是可借款上限；`D` 含已累積利息，`C` 是協議認可抵押價值，`NAV` 扣全部實際債務及應付費用。

| 規則 | 定案 |
| --- | --- |
| 預設目標 LTV | **50%**；低於協議真正可借上限與下方最高目標，UI 顯示經降低的實際可用值 |
| 最高可設目標 | **L − 15 個百分點**，並受協議 borrow cap／抵押參數限制；不可設到還款觸發線 |
| 開始還款 | 實際 `D/C >= L − 10 個百分點`；或 native health 更早不合格 |
| 減債目標 | 還到使用者目標 LTV；價格回升／還款後**不自動補借** |
| 全 vault 新借款上限 | 交易後 `總 D / NAV <= 30%`，包含其他部位及預估成本 |
| 全 vault 執行觸發 | `總 D / NAV >= 40%`，啟動減債至 **30%**；與逐部位風控同時滿足 |
| 準備金 | 同一債務幣的**即時現金**，最低債務 20%，按公式向上取至 5% 倍數；不存貸、不放 LP |
| 資金用途 | 僅同鏈、同一 token 供款至 D07 十個目的地；不能買股／幣、DCA、網格、LP、BNB 質押或再抵押 |
| 標籤 | mandate 允許時「可借款」；實際 debt balance 大於零時「借款中」；含正在減債／等待提領狀態 |

設目標 `t`、還款線 `T = L−0.10`，準備金比例：

```text
r = ceil_to_0.05(max(0.20, 1 − t/T + 0.05))
reserveRaw = ceil(actualDebtRaw × r)
到觸發線且抵押品不出售時，回到 t 的所需還款 ≈ D × (1 − t/T)
```

| L | t | T | r |
| --- | --- | --- | --- |
| 65% | 50% | 55% | 20% |
| 70% | 50% | 60% | 25% |
| 80% | 50% | 70% | 35% |
| 86% | 50% | 76% | 40% |

這是平穩價格、固定抵押數量的估算，不是跳空／清算保證。若扣掉 15pp 的上限無正值、native health 不合格或保守捨入無安全借款量，就不可開倉。協議修改 L／borrow limit 需立即重新風控；不得保持舊值等下次排名更新。保留既有不含已保留資金的 5% idle 約束（只適用有借款部位的 vault；2026-10-12 決定：沒有借款部位的 vault 不必保留 5% idle，可全部投入）；新增準備金要另外標記，不可被普通策略花掉，也不可在 NAV 重複加回。

### D06a：淨 carry 門檻

統一期間與利率口徑（APR／APY 先轉換），以**整份借款額**為分母：

```text
netAnnualCarry = actuallyInvestedDebtFraction × supplyNetAnnualRate
                 − borrowAnnualRate − otherAnnualizedCost
```

準備金視為零利息現金；全額借款計息。供款 8%、借款 5%、r=35%：`0.65×8%−5%=0.2%/年`，尚未扣其他成本。不能用供款 APY 直接減借款 APR；不得把短期獎勵混進基本收入以湊門檻。

| 條件 | 行為 |
| --- | --- |
| 當前與最近 24h 的基本淨 carry 均 >= **2%／年** | 可開倉，仍須額度、流動性、風控全部合格 |
| **0% <= 淨 carry < 2%／年** | 保留現有部位，暫停新增投入 |
| 持續 < **0%／年，達 6h** | 取回供款，償還該筆借款 |
| < **−3%／年**，或任何健康／LTV 觸發 | 立即啟動退出／減債，不等觀察窗 |
| 缺資料或不足 24h 有效歷史 | 不開新倉；風控繼續，不能把缺資料當 0% 或 2% |

門檻是已接受的起始產品政策，仍需壓測。24h 統計取樣、成本年化持有期及可接受資料缺口由工程驗證定義，未定前 fail closed。十個地方「可以存」不代表十條借款路徑都有正 carry；沒有合格機會就待機。

### D06b：緊急減債與提款

暫停所有新增買入／借款／LP 投入／複投，先核對已傳送交易。可還的準備金立即還；再取回該筆供款。不足、提領失敗或價格快速惡化時，按開 vault 時預授權順序出售**同 vault 的其他未抵押資產／LP**，只籌必要金額。不等全部錢到齊才開始還款；不得用另一部位已保留現金或已結算給退出者的錢。

抵押品不能當自由現金直接出售：先還款取得安全可解押額度 → 解押 → 賣出 → 再還款。每步按 native health、實際收到、minOut、deadline 與事前限制的 emergency slippage。未完成就保持「減債未完成」，不能以提交交易當作恢復健康。

使用者只送**一次 withdraw**，系統處理該退出份額的減債／解除抵押／變現。**不必先還清全 vault 債務**。假設 gross assets=130,000、debt=30,000、NAV=100,000，退出 10%：處理 13,000 gross、還 3,000 debt、付 10,000；剩 gross117,000、debt27,000、NAV90,000（忽略費用／價格變動）。不得只付 cash 把該人的全部負債留給其他人。

供款流動性不足時保持可查詢的 pending request，資金與份額仍有歸屬，不能 falsely complete 或固定鎖 90 天。**這是借款組合的新交接目標**；PR17 原子退出目前可能直接 revert，尚沒有這套 durable pending withdrawal，不能立即對外宣稱已支援。完整關閉需結清剩餘債務／利息／費用；活躍債務不可用 raw receipt 轉嫁給提款人。

## D07：批准範圍的十個穩定幣供款目的地

範圍批准不等於已通過 deployment admission。地址是本輪研究快照的 discovery seed，必須按最新官方資料、chain56 runtime／pointer／asset／流動性重新驗證；不將本表直接當 production manifest。

| # | 協議 | 接受幣 | 目的地／receipt 候選 |
| --- | --- | --- | --- |
| 1 | Aave V3 BNB | USDT | USDT reserve；aToken `0xa9251ca9DE909CB71783723713B21E4233fbf1B1` |
| 2 | Aave V3 BNB | USDC | USDC reserve；aToken `0x00901a076785e0906d1028c7d6372d247bec7d61` |
| 3 | Venus Core | USDT | vUSDT `0xfD5840Cd36d94D7229439859C0112a4185BC0255` |
| 4 | Venus Core | USDC | vUSDC `0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8` |
| 5 | Venus Core | USD1 | vUSD1 `0x0C1DA220D301155b87318B90692Da8dc43B67340` |
| 6 | Venus Core | U | vU `0x3d5E269787d562b74aCC55F18Bd26C5D09Fa245E` |
| 7 | Lista | USDT | Gauntlet USDT Vault `0x6d6783c146f2b0b2774c1725297f1845dc502525` |
| 8 | Lista | USDC | Lista USDC Vault `0x8a06ac91265dbebe6d4606f45b10993e9a571869` |
| 9 | Lista | USD1 | Gauntlet x Lista DAO USD1 Vault `0xfa27f172e0b6ebcef9c51abf817e2cb142fbe627` |
| 10 | Lista | U | Gauntlet x Lista DAO U Vault `0x9a17fd5cb8efc25d11567e713ae795a89775a759` |

Underlying 候選：USDT `0x55d398326f99059ff775485246999027b3197955`；USDC `0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d`；USD1 `0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d`；U `0xce24439f2d9c6a2289f741120fe202248b666666`。BSC USDT／USDC 是 18 decimals，不能套 Ethereum 常見的 6 decimals；所有精度仍逐合約驗證。

Aave pool／provider／data provider 取 [官方 Address Book](https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3BNB.sol)；Venus 取 [部署清單](https://docs-v4.venus.io/deployed-contracts/markets)；Lista 名稱與 asset 用 [vault API](https://docs.bsc.lista.org/for-developer/services/lending-api/vault) 核對。Aave USD1／U 不在這十個內。其他 Lista Exclusive／PT／第三方 vault 本輪沒有批准；品牌相同不代表相同風險或 permissionless 可存入。

## D08：共享 vault 修改規則

已公開授權範圍內的時間、權重與交易參數可由管理者調整，通知持有人、下一輪生效，保留舊輪持倉／成本／交易進度。風險收緊、暫停新增、減債可立即生效。提高原承諾借款上限、增加未授權資產／策略／協議或更高費用：**新建 vault，持有人自行轉入**。不能用「等 24h」替代這條新產品邊界；也不能為了實作新規則刪掉 PR17 仍適用的 nonce／24h 風險放寬保護。

## D09：取消、延期與尚未批准的早期候選

| 專案 | 最終處理 |
| --- | --- |
| AI 搜尋／建立／付款 | PR19；此 PR 只記整合邊界 |
| 期貨／永續／期權、funding／basis／雙幣期權產品 | 不納入現貨策略規格 |
| 迴圈借款／再抵押、同資產 staking loop | 2026-10-10 改列路線圖（[產品用語與敘事](../PRODUCT_LANGUAGE.zh-TW.md) §5）；尚未實作，現有 Loop 方法仍不能暴露給新模板 |
| 多抵押品共同擔保帳戶 | 不納入，改真實單抵押品隔離部位 |
| 跨池／跨 DEX 現貨套利 | 使用者明確先不要，**不是已批准第二階段** |
| LP 單邊區間買賣迴圈 | 與 DCA／網格重疊，先不加入 |
| 同一批多價位部分止盈 | 前面批准的是每批整批退出；新增分段比例未獲確認，不算納入 |
| 收益接力到其他資產／策略、LP 收益買 Mag7 | 被最新「只填比例、同策略或留原 token」取代 |
| 財報條件選股／輪動、盈利修正／品質／估值因子 | 使用者要交易操作；不加入本輪落地清單 |
| 波動權重、Risk Parity、CPPI、VA、事件／假突破／自動換檔、Pendle PT、股票單邊出借 | 早期 brainstorm，沒有逐項成為本輪定案；不補成隱含需求 |
| 每 vault 最多七種、每 token 只能一策略 | PR17 實作限制，不是本輪產品上限；新架構需支援並設經 gas 驗證的技術容量 |
| 同交易對 LP 換池 | 唯一明確標為第二階段的已接受工具 T15 |

## 交付與完成定義

本規格完整，不表示所有市場可用或 runtime 已完成。各工具目前的「規格／本地實作／真實市場 fork／部署」狀態在 [HANDOFF §3](HANDOFF.zh-TW.md)，每批實作後更新該表。不能用虛構收益卡、空 executor 或策略名稱列表代替真實設定 → 授權 → 執行 → 失敗恢復 → 可退出的完整流程。
