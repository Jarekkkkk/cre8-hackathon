<!--
  來源：bnb-agent-vaults/docs/VAULT_RULES_V2.zh-TW.md
  複製日期：2026-11-06
  狀態：**已廢棄架構**（pooled vault：共享金庫＋份額）。
        保留僅作歷史對照，用來說明「為什麼要遷移到 ATP」。
        不可作為現況參考，也不可據此實作。
-->

# CRE8 Vault 規則 v2（目前實作語義）

> 2026-10-05 新增產品定案與接手順序見 [PR20 多資產、多策略規格](strategy-v3/README.zh-TW.md)。本文件保留 PR17 的目前實作語義；新規格涉及多策略歸屬、LP／債務聚合、閒置生息及整池退出等改造，不能將兩者混為已完成程式。衝突與遷移清單見 [PR20 HANDOFF](strategy-v3/HANDOFF.zh-TW.md)。

> PR #18 原始產品討論版本：`a2008208e71cc8141d1dea2d7d58f9bd1416fb63`，2026-10-04。
> 本文件已依2026-10-05確認的產品決策校正：逐戶成本、不可轉讓份額、固定5% idle、創建人2% live ownership、
> token／個人 stops 與 schedule v2。實作與驗證細節以
> [工程覆核入口](archive/PRODUCT_COMPLETION_ENGINEER_REVIEW.zh-TW.md) 為準。尚未執行同版本BSC fork、測試網演練與外部審計，
> 因此這是待發布驗收的實作規格，不是安全保證。

## 目錄

1. [原則](#1-原則)
2. [費用](#2-費用)
3. [存款、提領、份額](#3-存款提領份額)
4. [創建人最低持有](#4-創建人最低持有)
5. [策略](#5-策略)
6. [保護機制](#6-保護機制)
7. [緊急賣出和結束 vault](#7-緊急賣出和結束-vault)
8. [執行規則](#8-執行規則)
9. [資產和市場](#9-資產和市場)
10. [Agent](#10-agent)
11. [平台的權限](#11-平台的權限)
12. [頁面和 UI](#12-頁面和-ui)
13. [官網文案和數字](#13-官網文案和數字)
14. [對外的安全說法](#14-對外的安全說法)
15. [不做的事](#15-不做的事)
16. [第二階段和之後](#16-第二階段和之後)
17. [發布前仍需決定或驗收](#17-發布前仍需決定或驗收)
18. [合約完成狀態](#18-合約完成狀態)
19. [參考來源](#19-參考來源)

---

## 1. 原則

1. **池子是大家共用的。** 任何規則都不能讓後來的人或先走的人，吃掉留下的人的錢。
2. **賣（降風險）隨時可以，買（加風險）要受限。**
3. **暫停不撤銷用戶的退出權。** 可以嘗試領 USDT，也可以按比例直接領 token／receipt。實物退出不讀
   oracle、不走 DEX、不要求 lending redeem；外部 token 自己暫停、黑名單、拒絕 receiver 或耗盡 gas 時，原子交易仍可能失敗。
4. **沒有人能把錢轉走。** 平台、創建人、agent 都一樣。合約不能升級。
5. **規則放寬要等 24 小時並通知持有人，收緊立即生效。**

---

## 2. 費用

| 費用 | 費率 | 給誰 | 什麼時候收 |
| --- | --- | --- | --- |
| 建立費 | 創建人種子的 1% | 平台 | 基金上線（seed）時收一次；種子不另收存入費 |
| 存入費 | 每次存入的 1%（種子除外） | 平台 | 每次存錢。創建人之後追加的錢也收 |
| 操作費 | 不收 | — | 合約保留計費 hook 與期間記帳，但費率與上限都是 0 |
| 績效費 | 用戶自己獲利的 10%（平台）+ 0–20%（創建人，預設 10%），合計最多 30% | 平台、創建人 | **出場時才收**，照每個人自己的成本算。沒賺錢不收。直接收 USDT |
| 提領 | 免費 | — | — |
| 年費／管理費 | 不收 | — | — |

- 費率在開 vault 時寫死，之後不能改。平台以後調整，只影響新開的 vault。
- 只領一部分時，績效費照比例算。直接領 token、個人止損、vault 結束後領錢，都照同一套方式收。
- **Gas：** 交易發送者自行支付gas。目前不從vault補償permissionless caller；按`gasUsed × tx.gasprice`退款可被
  高gas price、no-op或重複觸發抽走資產。日後若增加keeper bounty，必須綁定成功消耗的唯一condition nonce並設期間總上限。
- **用戶的例子：** 存 $10,000，創建人用預設 10%，一年賺 20%：
  - 存入費 $100、績效費約 $396，沒有操作費。
  - 用戶留下約 $1,484，是獲利的 74%。
- **平台收入的例子：** 一檔有 $100 萬新存款的基金，一年賺 20%：
  - 存入費約 $10,000、績效費約 $19,800。
  - 合計約 $3 萬；虧錢的年份約 $1 萬（只來自新存款）。
- 2026-10-10 費率調整：存入費 0.5% → 1%，種子的 1% 改稱建立費，取消操作費；績效費維持平台 10% + 創建人 0–20%。

> v2已移除共用高水位與fee-share增發。成本在每次淨存入時增加、退出時按退出份額比例扣減；平台與創建人的
> 已實現費用進入Accounting pull escrow，由各自收款地址自行領取。

---

## 3. 存款、提領、份額

- **中途存錢：** 存款當場照池子現在的比例買一份，滑價自己吃，老用戶不會被稀釋。
  - 有開「只用新錢」再平衡的 vault，改照目標權重買。
  - 例：50 天定期買計畫的第 45 天，池子有 $900 token + $100 現金。新用戶存 $1,000，當場買 $900 token，$100 留著跟剩下的 5 次買。
- **存款沒有鎖定期。** 因為存款是當場買，存了馬上領也佔不到便宜。
- **存款前要看「重要聲明」並打勾才能存。** 內容依序是平台免責、用戶須知、法律須知，費用放在最下面。
- **提領：**
  - 照持有比例把自己那份賣成 USDT，滑價自己吃，不影響留下的人。
  - 從借貸平台取不出來時，整筆交易失敗、錢還在，之後再試。
  - 最後手段是「直接領 token」（`redeemInKind`），拿到 token 和借貸收據，不依賴借貸平台的現金和 DEX 深度。
  - App 要先算出「現在最多能領多少 USDT」，不夠時建議分批，或改領 token。
  - 不做排隊或分批機制（見第 15 節）。
- **份額（收據）不能轉給別人。** 因為績效費照每個人的成本算，轉出去成本會算不清楚。個人止損是授權合約幫你領回自己的錢包，不算轉帳。

> **實物退出的費用語義：** 價格可用時，以退出者的份額切出對應fee shares，平台、創建人與用戶按同一物理庫存
> 比例領取，不會拿其他持有人的idle USDT付款。可靠價格不可取得時，oracle／DEX-independent逃生路徑仍立刻讓持有人
> 實物退出，但**不再豁免費用**（2026-10-22）：最高可能的費用份額（10% + 創建人費率，向上取整）留在基金裡、由
> Accounting 持有（`ExitFeeDeferred`）。任何人在 30 天內以當下的每份額價格、同一個公式結算（`settleDeferred`），
> 扣留份額接著照有定價的實物退出離開：費用切片給平台與創建人、其餘給原收款人；30 天後仍無法結算就不收費、以實物全數
> 交給原收款人（`releaseDeferred`）。成本basis仍按
> 實際退出份額扣減；完整退出同時清除該持有人的個人stop設定。

---

## 4. 創建人最低持有

- 建立時創建人存入固定100個accounting-asset units，收種子的1%建立費（不另收存入費），預期鑄出99 whole shares。
- 這不是stake或時間鎖。創建人可依正常退出路徑領回，但其他持有人仍有份額時，退出後必須至少保留live supply的2%。
- 2%以份額檢查，不以估值或可操縱的oracle價格計算；所有creator burn路徑都經過同一個`unlockedShares`限制。
- 創建人是最後一個真實持有人時可完整退出。虛擬份額只用於定價算術，不會永久卡住創建人。
- v2不以創建人資金乘數設定TVL cap，也不提供用增加stake提高容量的流程。
- 卡片與vault頁可顯示創建人的目前份額比例，並在退出預覽中說明2%下限。

---

## 5. 策略

| 策略 | 一句話 |
| --- | --- |
| 定期買 | 每天／週／月買一次，有結束或不設結束 |
| 跌價買 | 每個 token 從上次買入後的高點跌 X% 就買一筆 |
| 一次買入 | 開始時照權重買完，之後持有 |
| 固定比例（股幣平衡） | 一次買入 + 完整再平衡，例如 40% bStock / 40% BTCB / 20% USDT |
| Agent 自己決定 | 在上限內，agent 自己決定什麼時候買賣 |
| 網格 | 第二階段（見第 16 節） |

**所有計畫型策略的共通規則**
- 平常只買不賣。只有碰到止損、目標價、緊急賣出、結束 vault 時才賣。固定比例策略的再平衡也可以賣。
- 有沒有照計畫走由合約檢查，不靠 agent。agent 停用時，這些規則照常執行。
- 每個 token 都可以設止損價和目標價（第 6 節）。

### 定期買
- 有結束日（買 N 次、或到某日）：每次買「剩下的現金 ÷ 剩下的次數」。
- 不設結束：每次買現金的 X%。頁面要顯示「已投入 X%，照目前速度約再 N 次到 90%」。
- 某次沒買成不補，自動攤到之後幾次（上面的公式本來就會這樣）。
- 買入時間在一個時段內隨機，例如 08:00–10:00。
- 金額大時，一個時段內可以拆成好幾筆（第 8 節）。
- 緊急賣出時，計畫的時鐘暫停，剩下的天數保留。
- 計畫跑完後繼續持有，等創建人決定要不要結束 vault。

### 跌價買
- 參考價 = **上次買入後的最高價**，每個 token 各自算，用價格來源（oracle）判斷。跌了就買那個 token，金額照它在籃子裡的權重。
- 觸發門檻最小 3%。
- 觸發就買，不加隨機延遲，也不限最多買幾筆。
- **冷卻時間：** 每個 token 分開算，創建人選 1 小時到 7 天，預設 24 小時。
- 開始時先買一部分，預設 30%，可以設 0–95%。這筆在 24 小時內拆單買完，它的價格就是第一個參考價。
- 崩盤照樣買。不用「一天跌幾 %」判斷暴跌，只看 token 有沒有壞掉（第 6 節）。
- 閒置現金不拿去放貸。
- 緊急賣出後恢復時，參考價重設成恢復當天的價格（細節待工程確認）。

### 一次買入
- 開始那天 24 小時內拆單買完。開始前存進來的錢，等開始那天一起買。
- 時程（開始時間、期數、間隔、買入窗口，以及緊急恢復時的期數與間隔）建立後就固定，`Tighten`、`Schedule`、`Apply` 都不能改；其他設定（例如權重）照常走審查。這樣「一次買完」不會事後被改成長期定投。
- 沒有到期日，一直持有到創建人結束 vault。
- 權重會跟著價格偏移。頁面並排顯示「現在的權重」和「原本的權重」。
- 緊急賣出後，可以在同一個 vault 買回，績效接著算：
  - 24 小時內不能買回。
  - 7 天內要選「買回」或「結束」，沒選就結束。
  - 買回只能照原本的 token 和權重，24 小時內拆單買完。

### 固定比例（股幣平衡）
- 等於一次買入 + 完整再平衡（買賣都做）。
- 偏離目標權重 5% 以上才動。
- **可以搭配存借貸**：賣之前先從借貸平台取出；取不出來就跳過，下一輪再試。
- USDT 也可以當目標資產之一，USDT 那部分可以選存 Venus、Lista 或 Aave（預設不存）。
- bStock 那部分只在美股交易時段再平衡（第 9 節）。

### Agent 自己決定
- 在上限內隨時可以買賣，不檢查計畫。
- 止損和目標價對 agent 是硬限制，agent 不能改。
- 換手率顯示在卡片上。
- 顯示「最後交易 N 天前」，不會因此自動停止收存款。
- agent 叫不醒連續 7 天，暫停收新存款，提領不受影響；current enabled agent 以帶鏈上期限、綁定當前
  activation generation 的回報恢復收款（第 10 節）。
- 每筆交易都要附理由，理由全文上鏈（第 10 節）。
- agent 怎麼建、怎麼一直跑，見第 10 節。

### 再平衡

| 策略 | 可以用的方式 |
| --- | --- |
| 一次買入、固定比例 | 只用新錢，或買賣都做 |
| 定期買、跌價買 | 只用新錢（每次買時先補最不足的 token） |
| Agent 自己決定 | 不需要 |

- 偏離門檻最小 5%。再平衡時間不加隨機。
- 不參與再平衡的 token：被止損或目標價賣掉的、出現壞掉訊號的、卡在借貸平台領不出來的。
- 緊急賣出期間關閉再平衡。
- 「買賣都做」可以跟存借貸一起開（改自 v1 的「不能一起開」），規則同上面的固定比例。

### 買完存借貸（加選）
- 預設是只持有。每個 token 由創建人自己選要不要存進 Venus、Lista 或 Aave。
- 選的時候加一行提醒：「協議出事時可能領不出來，你可以改領收據 token。」
- vault 頁並排顯示兩個利率：現在的，以及過去 30 天實際賺到的。
- 協議出事時，只把 token 從協議取回來繼續持有，不賣。要賣是另外按緊急賣出。
- slisBNB 質押放到第二階段。

---

## 6. 保護機制

| 保護 | 誰設 | 觸發條件 | 觸發後 |
| --- | --- | --- | --- |
| 單一 token 止損／目標價 | 創建人 | 用 oracle 價格判斷，碰到止損價或目標價 | 那個 token **全部**賣掉，錢留成 USDT，不自動買回 |
| Agent 交易虧損熔斷 | 創建人在 2–10% 之間選，預設 5% | agent 自己的交易讓 vault 淨值減少的比例，最近 25 小時（逐小時分桶）累計達到門檻 | 自動停用 agent；累計達 2%（門檻低於 4% 時為門檻的一半）先在 vault 頁顯示黃色警示並發 Telegram 通知 |
| 個人止損／止盈 | 每個用戶自己 | 自己的部位跌或漲到設定的 % | 只把他自己的部位全部領出成 USDT |
| 緊急賣出 | 創建人手動按 | — | 第 7 節 |
| Agent 叫不醒 | 系統 | current enabled agent 連續 7 天沒有有效鏈上回報（成功交易也算） | 暫停收新存款，提領不受影響；以當前 activation generation 的有效回報自動恢復 |

- **止損和目標價：**
  - 所有策略都能用，不做防插針（價格瞬間跌破又彈回時會賣在低點，頁面要寫清楚）。
  - 止損價往上調：新止損價至少比該 token 目前的風險價格低 5% 時立即生效；更接近現價、高於現價，或當下讀不到價格時，要等 24 小時審查（審查期間舊的止損照常有效）。往下調或改目標價，也要等 24 小時並通知持有人。
  - 急需更緊的保護時，可以先設一個至少低 5% 的止損（立即生效）、直接賣出該 token，或宣告緊急狀態。
  - 止損觸發後，該 token 自動凍結（之後的定投不再分配給它）；只有該 token 還有庫存時才擋比例入金，賣光後入金照常。
  - 被止損賣掉的 token 可以重新買入，但要先公告、等 24 小時。
  - vault 頁顯示每個 token 的止損價、目標價、現在價格、還差多少。已觸發的標「已止損賣出」。
- **Agent 交易虧損熔斷：** 照 vault 計算，換 agent 也不會重新計算。取代 v1 的「單日跌 2% 就暫停」。
  - 門檻：創建人在 2–10% 之間選（預設 5%）。調緊立即生效；放寬要等 1 天。
  - 預警：累計損失達 2%（門檻低於 4% 時為門檻的一半）時，vault 頁顯示黃色「Agent loss warning」並說明；達到門檻、agent 被自動停用時改成紅色，說明 manager 審核後才會重新啟用、提領不受影響。
  - 有綁 Telegram 的持有人、創建人與 council 會收到同樣的通知（見 CRE8 AI 的「Telegram risk alerts」）。
- **個人止損／止盈：**
  - 跌幅可以從「存入時」算，也可以從「持有期間最高點」算（移動止損）。
  - 不設最小值。
  - 任何人都可以觸發，錢只會領回給本人。
  - Portfolio 頁顯示設定，以及離觸發還有多遠。
- **壞掉的訊號**（取代用跌幅判斷的暴跌保護）：出現下面任何一種，就停止買那個 token，並通知創建人。
  - oracle 停更
  - 池子沒流動性
  - 錨定資產脫鉤（例如 bStock 跟股票本身的價格對不上）
  - token 被暫停轉帳或被列入黑名單
- **取消的：** vault 層級的自動停損、回撤暫停、市場熔斷、每日 2% 熔斷。

---

## 7. 緊急賣出和結束 vault

### 緊急賣出
- 只有創建人能按。創建人的 vault 頁多一個按鈕。可以全部賣，也可以勾選只賣幾個 token。
- 宣告後的賣出（以及結束 vault 時的清算賣出）只有 manager、council 或啟用中的 agent 能執行；其他人不能替基金決定賣出時機。持有人隨時可以自己退出（現金或實物）。
- 確認視窗顯示預估滑價，並提醒「24 小時內不能買回，7 天內要選恢復或結束」。
- 按下後：
  - 停止所有買入，也停止收存款。存在借貸平台的部分，先取出再賣。
  - 24 小時內不能買回。
  - 計畫型策略：7 天內選「恢復」或「結束」，沒選就結束。頁面顯示兩個倒數，並提醒創建人好幾次。
  - Agent 自己決定的 vault：24 小時後，agent 照自己的判斷操作。
- 不限次數。每次都記在 vault 頁、標在績效圖上，卡片顯示「緊急賣出 N 次」。
- 開 vault 時有「允許緊急賣出」開關，預設開。關掉的話，卡片標「純持有，不會賣」。
- 賣不掉的部分拆小單慢慢賣，不放寬 1% 的限制。oracle 停更的 token 先等。用戶隨時可以自己直接領 token 走。

### 結束 vault
1. 創建人按「結束」，或緊急賣出後 7 天沒選，就進入結束流程。
2. 立刻停止收存款。
3. 1 天內盡量全部賣完，沒賣完的繼續拆單賣，直到賣完。
4. 賣完後，用戶隨時可以領回 USDT，**沒有期限**。不自動把錢發給每個人。

- 結束後不能重新打開。
- 其他持有人全部退出後，創建人的2% live-ownership限制自然解除；不存在另一筆stake或時間鎖資產。
- 結束的 vault 保留在創建人頁和排行榜上。

---

## 8. 執行規則

- **觸發：** 規則交易（定期買、跌價買、止損、目標價、再平衡、個人止損）**任何人都可以觸發**，由合約自己檢查條件。被夾不處理。
- **Keeper：** 我們自架一支程式 24 小時一直跑，確保一定有人觸發。它掛掉只會延遲交易，不會卡住提領；它的私鑰被偷也只能觸發「條件已經成立」的交易。
- **單筆大小：**
  - 下單前先詢價，**價格影響 ≤0.3% 就可以下**，一天可以下好幾筆。
  - 取代 v1 的「單筆不超過池子 TVL 0.1%」。舊規則下，NVDAB 池子只有 $480 萬，一筆約 $4,800，$100 萬要買 200 多天。
- **滑價上限：** 每筆成交價跟 oracle 最多差 1%，合約強制執行，**不放寬**。
- **冷卻：** 只有跌價買有（每個 token、1 小時到 7 天）。定期買本來就是一天一次，止損和目標價不受限。
- **每個資產的部位上限跟池子深度掛鉤：** 先不做（第 17 節）。

---

## 9. 資產和市場

### 開放上架：「積木」要檢查，「組合」完全開放
- **積木：**
  - 資產積木 = 一個代幣 + 它在 PancakeSwap 對 USDT 的池子 + 價格來源。
  - 借貸積木 = 那個資產在 Venus、Lista、Aave 的借貸市場。
- **自動檢查**（全部通過就自動上架，平台只負責送出那筆交易，任何人都可以提名新代幣）：
  - 是正常的代幣：模擬轉帳時沒有被扣稅、數量不會自己變多變少。
  - 跟 USDT 有 PancakeSwap 池子，而且深度達門檻（例如 $5 萬）。
  - 有可信的價格來源：Chainlink、Binance Oracle、RedStone，或 Venus、Lista 自己用的那一個。
  - 價格來源和 DEX 的價差小於 2%。

> **安全阻擋：** 自動檢查只產生 admission evidence，不能自動授權。正式上架仍由多簽經 12 小時 queue（僅 BNB Chain 測試網 chain97 為立即），
> 綁定 source/runtime/proxy、token、pool、oracle、market 與 receipt 的完整 tuple；任一 required read 失敗就 fail closed。
- **組合：** 創建人從已核准積木裡任選最多 **7 個**。Factory 仍要對完整組合執行 token／receipt collision、
  route、decimals、TWAP history、caps 與 gas preflight；逐塊核准不能單獨授權任意組合。
- **為什麼積木還是要檢查：** vault 的淨值靠價格來源計算。如果創建人能自己指定價格來源，他可以把價格灌高，用灌水的淨值把別人的錢領走。
- **出問題時：** 平台可以把某塊積木標成「停止新買入」，已經持有的部位照樣能賣、能提領。
- 要改合約：工廠從「整組設定審核」改成「每塊積木審核」（第 18 節）。
- 開 vault 頁直接列出所有積木，讓創建人搜尋、選擇。

### bStock（代幣化美股）
- 價格來源週末也每小時更新（9/30 實測 Venus 的 NVDAB：週末在 224.4–225.3 之間，週一開盤前跳到 228.3）。
- **收盤價** = 美股交易日 16:00 ET 之後的第一筆報價，由 keeper 記錄，要處理假日和提早收盤。
- bStock 的跌價買和再平衡只在可由鏈上資料驗證的交易時段判斷。
- market closed 或 underlying price 無法驗證時，USDT deposit／mint／cash exit 與增加風險 fail closed；in-kind exit 與可驗證的降風險操作保留。
- feed 週末持續更新不等於 underlying 有可交易價格。完成 underlying × issuer multiplier、market-status、DEX
  spot/TWAP 的保守入場定價與歷史套利測試前，不接受週末舊價入場。

---

## 10. Agent

### 身分和更換
- 有 ERC-8004 身分的算「Agent」，沒有的算「一般人」。這是自己申報的，我們不驗證背後是不是真的 AI。
- 一鍵停用 agent，立即生效；該地址不能再啟用。只想暫時停止時使用 pause。
- 換新 agent：一律先排程並等 24 小時，vault 頁顯示候選地址、可套用時間，以及「換過 N 次」。不提供立即授權新 agent。

> **安全採用：** 停用可以立即；任何新 agent 的交易權一律延遲 24 小時。不能讓遭入侵的 creator key
> 用「立即生效」繞過持有人退出窗口。每個地址在同一 vault 只能被提名一次：初始 agent 已標記 used；候選地址在
> 第一次成功 `ScheduleAgent` 時、延遲開始前就永久寫入 `agentAddressUsed`。取消、覆寫、停用、套用或更換 Safe owners
> 都不會釋放這個地址；current、previous、cancelled、overwritten 地址不能再提名。每次輪替都要用新的 executor address，
> 包含 Safe contract address。暫時停止操作使用 pause，不靠停用後重新提名同一地址恢復。
- 換 agent 後績效接著算。新 agent 沒有 ERC-8004 身分的話，排行榜分類就變成「一般人」。

### 交易理由全文上鏈（安全切片已實作）
- agent 的每筆交易都要附理由，**全文寫進鏈上紀錄**（交易事件），不靠我們的伺服器，也不用 Greenfield。我們的雲端掛了，任何人還是能在 BscScan 上查到。
- 理由 calldata 在 public mempool 中可能於入塊前公開。deadline、minOut、oracle bound、quota、nonce／epoch 才是交易保護；
  event 時機不能防搶跑。
- 格式是英文 JSON。SDK／MCP 以嚴格 UTF-8 驗證完整 schema；有效 payload 經 UTF-8 編碼後必須為 25–4,096 bytes。
  合約檢查原始 bytes 的兩個必要條件，不符合就拒絕這筆交易：
  - 長度在 25–4,096 bytes 之間。
  - 前 25 bytes 必須精確等於 `{"schema":"cre8.reason/1"`。
- 只有 current enabled agent 能使用附 reason 的 selector。操作成功後，同一筆交易原子發出 `AgentHeartbeat` 與
  `AgentActionReason`；操作或後續檢查 revert 時，兩個事件與 liveness 更新一併回滾。manager 的降風險操作不能冒用
  agent reason selector 或產生 agent reason evidence。
- 我們的索引程式（讀鏈上資料的服務）負責檢查完整格式。缺欄位或格式錯，vault 頁和排行榜上就標紅色「Reason invalid」。
- 資產、金額、最低成交量這些本來就是交易參數，**理由裡不重寫**，避免數字對不上。理由只放「為什麼」和「根據什麼」。
- 規則觸發的交易不用寫理由，合約直接記錄觸發類型和參數，例如「定期買第 45 次」「ETH 止損 1,900」。App 用同一個格式顯示。
- 創建人按緊急賣出時，可以選擇附上理由。
- 動態 bytes 的實際 gas 依長度、內容、鏈上 gas price 與事件欄位而變；以測試網／正式 calldata 量測，不使用固定美元估算。
- 實作時要寫進 skill（`skills/bnb-agent-vaults/SKILL.md`、`web/public/skill.md`）和 MCP（`web/app/mcp/route.ts`）。MCP 要新增這些工具：
  - 查格式
  - 自動幫 agent 填好比例和價格（交易前後的比例、oracle 報價、相對 oracle 的最低輸出偏差上限）
  - 送出前檢查理由合不合格
  - 查 vault 過去所有的理由

**`cre8.reason/1` 格式**

```json
{
  "schema": "cre8.reason/1",
  "decidedAt": "2026-10-04T08:01:12Z",
  "intent": "add",
  "thesis": "BNB fell 6.2% in 24h on a broad market selloff with no BNB-specific negative news; the mandate's 40% BNB limit leaves room to add at a lower average cost.",
  "evidence": [
    {"metric": "BNB 24h change", "value": "-6.2", "unit": "%", "source": "oracle:0x… (Binance Oracle BNB/USD)", "observedAt": "2026-10-04T08:00:00Z"},
    {"metric": "BNB/USDT pool depth within 1%", "value": "412000", "unit": "USDT", "source": "pool:0x… (PancakeSwap V3 0.05%)", "observedAt": "2026-10-04T08:00:30Z"}
  ],
  "mandateCheck": {"limitBps": 4000, "weightBeforeBps": 3120, "weightAfterBps": 3600, "cashAfterBps": 2400, "withinLimits": true},
  "risk": {"oracleDeviationBoundBps": 18, "maxSlippageBps": 100, "oraclePrice": "585.10", "oracleUpdatedAt": "2026-10-04T07:59:41Z"},
  "invalidation": "Stop adding if BNB closes below 540 on the oracle or weight would exceed 40%.",
  "agent": {"erc8004Id": "1306", "runtime": "BNB Agent Studio", "model": "optional", "version": "1.4.0"}
}
```

- 除了 `agent.model` 和 `agent.runtime`，其他欄位都是必填。
- 只用英文。數字寫成字串、單位分開寫；時間一律 UTC（ISO 8601）；比例用 bps。
- `intent` 只能是 `open`、`add`、`reduce`、`exit`、`rebalance`、`yield`。
- `evidence` 1–8 筆，每筆都要有來源，而且要是鏈上地址或公開資料集。
- `thesis` 要寫「為什麼是現在」，最多 600 字元。
- `oracleDeviationBoundBps` 是交易最低輸出相對該筆 oracle 參考值允許的最大不利偏差；它不是 DEX 的實際成交價格影響。

### Agent 怎麼運作（定案）

**大部分 vault 不需要 agent。** 定期買、跌價買、一次買入、固定比例都是規則交易，由我們的 keeper 執行，開 vault 時不會出現 Agent 這一步。只有「Agent 自己決定」需要 agent。

**主要做法：把 CRE8 的 skill 和 MCP 交給創建人自己的 coding agent，雲端常駐用 BNB Agent Studio。**

- Claude Code、Codex、Cursor 這類工具是「人開著才會動」，關掉電腦或忘記打開，agent 就停了。所以要部署到 24 小時在雲端跑的地方。
- BNB Agent Studio（BNB Chain 2026 年 6 月推出）會把自己的工具裝進 Claude Code 和 Cursor，讓 AI 代替人部署 agent：
  - 產生程式、建錢包、註冊 ERC-8004 身分。
  - 部署到 AWS AgentCore。
  - 只收 AI 呼叫的費用。
- 繁瑣的步驟由創建人的 coding agent 去做，人幾乎不用動手。

**創建人的流程**
1. 在 Claude Code、Codex 或 Cursor 裡加入 CRE8 的 skill 和 MCP（一行指令或一個網址）。
2. 用說的：「幫我開一個 CRE8 vault，BNB 和 BTC 做波段，單一資產最多 40%，agent 部署到 Agent Studio。」
3. coding agent 自己去做：
   - 用 Agent Studio 部署 agent（建錢包、註冊 ERC-8004、上雲端）。
   - 用 CRE8 MCP 準備好 vault 設定，並把 agent 的地址填進去。
4. 人只做兩件事：
   - 在錢包簽名開 vault（放錢一定要本人簽）。
   - 在 agent 錢包儲值一點 AI 費和 gas（coding agent 會提醒要放多少）。
5. 完成，可以關電腦。我們的 keeper 照創建人選的頻率（15 分鐘到 1 天）叫醒 agent：
   - 送出 vault 快照：持倉、價格、限制、上次的理由。
   - agent 自己判斷要不要交易，要的話自己下單並附上理由。
   - 只呼叫 agent 在 ERC-8004 註冊資料裡寫的服務網址，而且限制頻率，避免被拿來攻擊別人的網站。

**網頁上開 vault 的 Agent 步驟**（給不用 coding agent 的人）
- 推薦：顯示一段可以直接複製給 Claude Code 或 Codex 的指令，內容已經填好 vault 規則。
- 已有 agent：
  - 填 ERC-8004 編號，我們從鏈上讀出它的錢包地址。
  - 或直接填地址：自己架的 agent、手動交易的人都走這條，沒有身分的話排行榜算「一般人」。
  - 手動交易要我們另外做一個「手動下單」頁。

**錢包建議**（寫在 skill 裡）
- Altana 錢包，白名單只填這個 vault 的地址；或 Turnkey 錢包（私鑰放在隔離的安全硬體裡）。
- vault 合約不授權 agent 提款；但私鑰失陷仍可能造成反覆不利成交、MEV與熔斷觸發前的損失。
  錢包政策要精確限制 chain、vault、selectors、value、gas、頻率與到期時間，不能只 allowlist 一個地址。

**費用**
- AI 費由 agent 錢包付。Agent Studio 會在創建人設定的上限內自動補值。
- 交易 gas 由 agent 錢包付 BNB。可以研究用 BNB Chain 的 MegaFuel 幫忙付「呼叫 CRE8 vault」的 gas（待確認）。

**創建人忘記了怎麼辦**

| 情況 | 會發生什麼 |
| --- | --- |
| 他關電腦、不管了 | 沒影響。agent 在雲端，叫醒的是我們的 keeper |
| agent 錢包的 AI 費用完了 | 在他設的上限內自動補。真的沒錢了，agent 就停下來，我們在 Portfolio 通知他 |
| agent 完全停了 | 資產只是持有不動。止損、個人止損、提領都由 keeper 照常處理 |
| 叫不醒連續 7 天 | **暫停收新存款**，提領不受影響。current enabled agent 提交綁定當前 generation、短 deadline 與近期 canonical block challenge 的有效回報後自動恢復收款 |

- 「沒交易」和「叫不醒」要分開：
  - 沒交易可能是 agent 判斷不用動，只顯示「最後交易 N 天前」。
  - 叫不醒就是壞了，vault 頁顯示「Agent 已 N 天沒回應」。
- 判斷方式放在鏈上，不靠我們的伺服器：current enabled agent 呼叫
  `heartbeat(expectedAgentGeneration, deadline, observedBlock, observedBlockHash)`。合約同時檢查 current activation generation、
  未過期且不超過目前鏈上時間一小時的 deadline，以及一個近期鏈上 challenge：`observedBlock` 必須早於執行區塊、
  最多相差 255 blocks，`observedBlockHash` 必須是合約可用 `blockhash` 讀到的精確非零 canonical hash。255 是區塊數，
  不能換成固定秒數；準備、簽名與送出要及時完成。
- 獨立 heartbeat 的 `AgentHeartbeat.actionHash` 不是 zero，而是
  `keccak256(abi.encode(keccak256("MANDATE_AGENT_HEARTBEAT_V2"), vault, agent, generation, deadline, observedBlock, observedBlockHash))`。
  SDK／receipt verifier 要用完整 plan 重建並精確核對。成功交易也會更新 heartbeat。超過 7 天沒有有效回報時，Agent 策略的
  deposit／mint 與對應 view 額度 fail closed；cash exit、in-kind exit 與降風險路徑不受影響。
- 只靠 sequential generation 仍可能讓 A 先簽 `g+2`，等 A→B→A 再 relay。因此地址從第一次成功提名就永久 single-use，
  不允許 A 回來。也不使用 `block.prevrandao` 當任期 entropy：BSC Parlia 的 in-turn／out-of-turn difficulty 是固定 2／1，
  EVM 在 header 沒有 Random 時會回傳 difficulty，不能當不可預測隨機數。官方實作見
  [EVM block context](https://github.com/bnb-chain/bsc/blob/c5533ab5b7244dc474add10740834417a2c605d7/core/evm.go#L54-L95)、
  [`DIFFICULTY`／`RANDOM` opcode](https://github.com/bnb-chain/bsc/blob/c5533ab5b7244dc474add10740834417a2c605d7/core/vm/instructions.go#L467-L476)與
  [Parlia constants](https://github.com/bnb-chain/bsc/blob/c5533ab5b7244dc474add10740834417a2c605d7/consensus/parlia/parlia.go#L92-L95)。

**曝光**
- vault 頁和排行榜顯示「Agent Studio」標籤。能從 ERC-8004 註冊資料判斷就自動顯示，判斷不到就由創建人自己勾選，並標「自行申報」。
- 排行榜的 Agent 分類裡可以篩選 Agent Studio。
- 把 CRE8 的 MCP 登記成其他 agent 能用的工具，讓別的 agent 查 vault 或存錢進來。
- 官方 AI vault 也用同一套，當作示範。

**不做：CRE8 幫大家代管 agent。** 這樣 agent 的私鑰會在我們手上，法律上也更像「平台幫人操盤」。

**要先實測的**
- Codex 能不能用。Agent Studio 官方寫支援 Claude Code、Cursor 和「任何支援 MCP 的工具」。
- Agent Studio 建出來的 ERC-8004 身分，擁有者是創建人的錢包還是 agent 自己的錢包。這決定我們怎麼確認「這個 agent 是你的」：
  - 是創建人的錢包：直接比對擁有者。
  - 不是：改成讓 agent 簽一則訊息證明。
- 「部署 agent → 開 vault」能不能讓 coding agent 一次跑完。這要靠 CRE8 的 skill 和 MCP 寫好流程。

---

## 11. 平台的權限

| 角色 | 能做 | 不能做 |
| --- | --- | --- |
| 平台風控（risk council） | 暫停某個 vault 的存款和買入。暫停後，創建人至少要等 24 小時才能恢復 | 賣出、提領、轉走資金、換 agent、改費率、升級合約 |
| 平台工廠管理者 | 上架積木、把積木標成「停止新買入」、暫停開新 vault | 動已經存在的 vault 的錢 |
| 創建人 | 緊急賣出、結束 vault、停用或換 agent、收緊規則（放寬要等 24 小時） | 轉走資金、領別人的錢 |
| Agent | 在上限、止損、1% 滑價內買賣 | 領錢、轉帳、改止損和目標價 |

- **官方 vault：** 用 CRE8 logo 當標籤，判斷方式是看開 vault 的錢包在不在官方名單裡，不看名字。官方 vault 跟一般 vault 一起排名，不置頂，規則和費用也一樣。

---

## 12. 頁面和 UI

UI demo 在 Claude canvas 上（連結向專案負責人拿）。重點：

- **開 vault：**
  - 拿掉「USDT 直接放貸」和「回撤暫停」。
  - 定期買和跌價買分開設定，每個 token 都可以設止損價和目標價。
  - 費用區寫：建立費（種子的 1%）、存入費 1%、績效費平台 10% + 創建人 0–20%（預設 10%），沒有操作費，並附用戶總費用試算。
  - 新增設定：「允許緊急賣出」開關、換agent的方式與agent交易虧損門檻（2–10%，預設5%）。閒置比例固定5%，不提供百分比設定；創建人區塊顯示2% live-ownership規則。
  - 頁面上只留重要或容易出事的提醒，其他規則和費用收進「重要聲明」彈窗，打勾才能開。
  - 選「Agent 自己決定」時才出現 Agent 步驟：推薦「複製給你的 Claude Code／Codex」，或填已有的 ERC-8004 編號或地址（第 10 節）。
- **存款和提領面板：**
  - 存款：「這個 vault 已買 X%，你的錢約 $Y 會馬上買入」、存入費和實際投入金額、個人止損和止盈。
  - 提領：照自己的成本預估績效費；「直接領 token」當成正常選項；金額大時建議分批。
  - 第一次存款前跳「重要聲明」，打勾才能存。
- **Vault 頁：**
  - Buying plan 用日曆顯示，一排最多一個月，標出已買、漏買、暫停、今天、剩下的天數。
  - 跌價買：每個 token 的現價、參考高點、觸發價、冷卻剩多久。
  - 止損和目標價、權重對照、利率（現在的和過去 30 天的）。
  - 交易紀錄附理由、換手率、最後交易時間、agent 換過幾次、緊急賣出紀錄。
  - Share price 圖：
    - 有 X、Y 軸和刻度數字，可以切 7D、30D、ALL。
    - 比 vault 年紀還長的期間不顯示。
    - 滑鼠移上去顯示當天的價格。
    - 緊急賣出用橘點標在圖上。
- **創建人控制：** 緊急賣出按鈕和倒數、結束 vault、停用或換 agent、重新買入、修改止損和目標價。
- **錢包狀態：** 還沒連錢包時，右上角和底部都只顯示「Connect wallet」；連上後才出現「Deposit / Withdraw」和個人資料。
- **縮放：**
  - 寬度小於 1024px 時換成手機排版：Deposit / Withdraw 固定在底部，點了開全螢幕表單。
  - 小於 760px 時，圖表換成手機版小圖。
- **手機版：** 參考 Lista 的排版：返回列、分頁、兩欄數字、底部固定按鈕、全螢幕表單。Fund prospectus 也有手機版。
- **Portfolio：**
  - 最上面是通知區，直接讀鏈上事件：緊急賣出、止損觸發、規則變更預告、vault 結束請領回、你的個人止損觸發了。
  - 創建人另外看到：7 天倒數、agent 沒回應、agent 錢包快沒錢。
  - 每個部位顯示成本、止損和止盈、預估績效費。
  - 不做 Telegram。
- **Leaderboard：**
  - 照創建人地址排名，預設照「幫用戶賺了多少錢」排序。
  - 期間可選 7、30、90 天、全部（預設 90 天）。
  - 已結束的 vault 也算。分 Agent 和一般人兩類。不加策略篩選。
  - 用報酬率排序時，規模不到 $1,000 的 vault 不參與排名。
- **創建人頁：** 列出他所有的 vault，包含已結束的。
- **法律文字：** 重要聲明裡的免責、須知、法律文字都是草稿，上線前要給律師看。`[RESTRICTED REGIONS]` 要填實際的限制地區。

---

## 13. 官網文案和數字

- **標題：** Pick funds, not coins. / Or CRE8 your own.（2026-10-19 起，取代 Wall Street built funds. Now anyone can CRE8 one.，後者移到首頁的 For creators 段；Hero 只有標題和按鈕，首頁不寫 CRE8 費用。用詞與敘事見 [產品用語與敘事](PRODUCT_LANGUAGE.zh-TW.md)。舊標題 Every asset on BNB Chain. 不再使用：BNB Chain 只放在頁尾與技術說明。）
- **數字**（都是全鏈的數字，底下用小字標來源和日期，每季更新）：

| 數字 | 文案 | 來源 |
| --- | --- | --- |
| 590K+ | AI agents registered onchain | agenteconomy.to，ERC-8004，24 條鏈，2026-09-23 |
| $3.7B / $75T | Tokenized stocks onchain / US stock market | Token Terminal 2026-10-02 / Siblis Research 2026-06-30 |
| 4.3M | Tokenized stock holders | Token Terminal，2026-09-25 |

- 590K 是「註冊數」，裡面有不少測試帳號，文案寫 **registered**，不要寫 active。
- 不放 x402（AI 付款）的數字：從高峰掉了 92%，而且很多是測試和迷因幣的交易量。

---

## 14. 對外的安全說法

**可以說：**「資金放在每個 vault 自己的合約裡。平台、創建人和 AI 都沒有轉走資金的權限，合約不能升級。
平台最多只能暫停存款和買入，提領不受影響。」

**要附註的外部風險：**
- Venus、Lista、Aave 自己的合約可以升級，也可能暫停提款。
- bStock 的代幣合約是發行方可以升級的，USDT 也能凍結地址。
- 價格來源過期時，換回 USDT 的提領可能失敗；直接領 token／receipt 不依賴 oracle、DEX 或 lending redeem，
  但第三方 token 自己的 transfer 限制仍可能令交易失敗。

**做好之前不能說的：**
- 「理由上鏈」：要等第 10 節實作後才能說，在那之前只能說「每筆交易鏈上可查，理由在 App 看」。
- 「上線、可以買」：合約部署前不能說。

---

## 15. 不做的事

| 項目 | 原因 |
| --- | --- |
| USDT 放貸策略 | 拿掉（USDT 只能當固定比例策略的目標資產，見第 5 節） |
| 提領排隊或分批機制 | 要大改合約；已經有「直接領 token」這個退路 |
| 虧損時先扣創建人資產 | 市場下跌不是創建人犯錯；很像保本承諾，也會讓份額會計失真；只執行第4節的2% live-ownership規則 |
| 再提高平台收費 | v2 已經比 v1 高很多；用戶已經交出約 25% 的獲利，比 Hyperliquid（leader 10%）貴 |
| 複製交易型的跟單 | 每個人分開執行，gas、滑價和被夾的風險都會乘以人數；已經有個人止損 |
| 放寬 1% 價格偏離上限 | 這是防止 agent 用很差的價格交易、掏空 vault 的底線 |
| 用戶自己分批存入、計畫期間不收新錢 | 太複雜，只做「存款當場照比例買」 |
| vault 自動停損、回撤暫停、每日 2% 熔斷 | 改成個人止損和 agent 交易虧損熔斷 |
| 防插針 | 太麻煩；頁面寫清楚就好 |
| 創建人領錢要預告或另設stake | 使用合約統一檢查的2% live-ownership floor，不設時間鎖或另外質押 |
| Telegram 通知 | 用 Portfolio 通知區 |
| 排行榜的策略篩選 | 不需要 |
| 防夾的私有通道 | 我們是 DeFi，觸發開放給所有人 |
| 用未驗證的週末價格接受 bStock vault 存款 | 會讓新舊持有人互相補貼；完成保守休市定價與套利測試前 fail closed |
| CRE8 幫大家代管 agent | agent 私鑰會在我們手上，法律上更像「平台幫人操盤」；改用 Agent Studio 雲端常駐 |

---

## 16. 第二階段和之後

- **網格策略：**
  - 只開放 BNB、BTC、ETH 這種深的池子，格距至少 1%。
  - 每格各自冷卻，再加每天最多幾筆。
  - 注意：交易次數多不另收操作費，但 DEX 手續費與滑價照算。
- slisBNB 質押
- 領取協議發的獎勵幣（例如 XVS）並換成 USDT
- 借款、Loop、LP（上線前另外討論：被清算的風險、要先還款才能領錢、無常損失）

---

## 17. 發布前仍需決定或驗收

- 第 10 節「要先實測的」三件事：Codex 能不能用、Agent Studio 身分的擁有者、能不能一次跑完部署和開 vault。
- 每個資產的部位上限跟池子深度掛鉤：先不做，等真的出現大 vault 再看。
- 限制 vault 在單一借貸市場的存量（例如 ≤5–10%）：先不做。
- 第 12 節的法律文字定稿，以及限制地區的名單。
- 跌價買在緊急賣出後恢復時，參考價怎麼重設（第 5 節）。
- 用 MegaFuel 幫 agent 付 gas 可不可行。

---

## 18. 合約完成狀態

| 範圍 | 目前實作 | 主要合約 |
| --- | --- | --- |
| 存入與定價 | 1%費後淨額、比例複製或NewMoney權重、保守entry pricing、unused budget退款 | `MandateVault`、`MandateJoinHelper`、`MandatePortfolio` |
| 費用 | 操作費為0（保留hook與365日期間記帳）、逐戶basis、退出實現績效費、pull escrow | `MandateAccounting` |
| 份額／創建人 | 不可轉讓；無時間鎖；其他持有人存在時創建人保留2% live shares | `MandateVault` |
| 固定idle | 新增風險操作後至少保留5%，不是建立參數 | `MandateRulesValidator`、`MandateVaultOperations` |
| 排程v2 | initial allocation、BuyOnce、有限／無限DCA、逐token Dip高點與cooldown、missed window不補單 | `MandateSchedule`、`MandateRules` |
| Token stop／target | 獨立policy nonce、放寬延遲、permissionless條件觸發、賣回accounting asset | `MandateStopController`、`MandateRules` |
| 個人stop／take／trailing | 每位持有人獨立設定，觸發只退出該持有人的全部份額到本人 | `MandateStopController`、`MandateVault` |
| Agent控制 | 可立即停用、24小時輪替、地址單次提名、generation-bound actions與heartbeat | `MandateGovernance`、`MandateAccounting` |
| 退出 | 實際現金成交額結算；可靠定價的in-kind以比例fee shares結算；缺價逃生明示waiver | `MandateVault`、`MandateAccounting` |
| 建立與大小 | Accounting／Operations外置deployers，staged CREATE2，BSC cap回歸 | `MandateVaultFactory`、`MandateFundDeployer`、`MandatePolicyDeployer` |

以上表示程式與本地回歸已完成，不表示已部署或已取得外部審計。完整同版本BSC fork、正式市場gas、Safe／4337
包裝、測試網、真WalletConnect與外部審計仍屬第17節的發布條件。

**要維持不變的：**
- 暫停不主動封鎖退出；實物退出不依賴價格與交易市場，但仍受第三方 token transfer 與 BSC 單筆 gas 的客觀限制。
- 沒有轉走資金的功能，合約不能升級。
- 每筆成交價跟 oracle 最多差 1%。
- 平台風控只能暫停存款和買入，不能賣出。

**鏈下同步：** `mandate@2.0`、SDK、MCP schema、browser bundle、公開skill與ABI必須由同一份source重建。
獨立`manifest@1.0`只供reference planning；更早的`manifest@0.9`、`sharedCooldownHours`與local-calendar欄位會被拒絕，不能轉成V2授權。

---

## 19. 參考來源

- [Hyperliquid：vault leader](https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/vaults/for-vault-leaders-legacy)
- [Hyperliquid：vault depositor](https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/vaults/for-vault-depositors-legacy)
- [幣安合約跟單](https://www.binance.com/en/support/faq/how-to-use-copy-trading-on-binance-futures-0b3a91eea664402f812fe41358c8a206)
- [幣安跟單冷卻期公告](https://www.binance.com/en/support/announcement/binance-futures-copy-trading-upgrades-the-cooling-period-for-lead-trader-portfolios-a9ea41f6a2224f8c971ac50b9f582e36)
- [幣安 Spot DCA](https://www.binance.com/en/support/faq/what-is-spot-dca-and-how-does-it-work-27713d3ddb3c406da52f36b9aaaa1360)
- [Morpho 費用](https://docs.morpho.org/curate/concepts/fee/)
- [Enzyme 平台費](https://docs.enzyme.finance/general-info/protocol-fees)
- [BNB Agent Studio 官方頁](https://www.bnbchain.org/en/bnb-agent-studio)
- [BNB Agent Studio 上線公告](https://www.bnbchain.org/en/blog/bnb-agent-studio-is-live-on-bnb-chain-ai-agents-from-one-prompt)
- [bnbagent-sdk](https://github.com/bnb-chain/bnbagent-sdk)
- [BNB Chain AI Agent Landscape](https://www.bnbchain.org/en/blog/bnb-chain-ai-agent-landscape-agents-tools-and-payments)
- [agenteconomy.to：鏈上 AI agent 數量](https://agenteconomy.to/stats/how-many-ai-agents-are-onchain)
- [Cointelegraph：代幣化股票 $3.7B、BNB Chain 佔 30%](https://cointelegraph.com/markets/bnb-chain-1-billion-tokenized-assets-market-3-7-billion)
- [ChainCatcher：代幣化股票持有人 4.3M](https://www.chaincatcher.com/en/article/2292174)
- [Siblis Research：美股總市值](https://siblisresearch.com/data/us-stock-market-value/)
- [Blockchain.news：x402 交易量下滑 92%](https://blockchain.news/news/okx-ventures-ai-agent-economy-x402-transactions-drop-92-percent)
