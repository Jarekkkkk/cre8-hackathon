# cre8-app

CRE8 ATP 的前端。Vite + React 19 + TypeScript，公開頁保留設計稿 CSS，表單與抽屜使用 shadcn / Tailwind v4（無 preflight）。

## 技術選擇

| 層 | 選擇 | 為什麼 |
|---|---|---|
| 建置 | Vite 7 | dev server 啟動 <200ms，HMR 對「改一個表格欄位」這種工作差很多 |
| server state | `@tanstack/react-query` | 快取、重試、`isPending`/`error` 的狀態機。手寫這些每次都會漏一個分支 |
| client state | `zustand` | 只有錢包連線與 token 兩塊，Context 也能做但 zustand 的 selector 不會讓整個樹重繪 |
| 樣式 | 設計稿 CSS + shadcn / Tailwind v4 | 公開頁保留來源 class；工具頁沿用可存取元件，token 使用 sx- 前綴 |
| 鏈互動 | `viem` | 型別完整，且與後端同一個版本（`2.57.x`） |

視覺語言（顏色、圓角、字體、卡片/按鈕形狀）取自 `bnb-agent-vaults/web` 的 app 頁；
**landing page 與 docs 頁不參考**。

## 目錄

```
src/
  lib/
    api.ts        後端契約（型別 + fetch wrapper + ApiError）
    format.ts     純格式化：1e8 定點 → "$511,338.07"、bps、地址、日期
    query.ts      QueryClient 與 queryKeys（retry 1、不自動 refetch）
    wallet.ts     EIP-6963 探索、連線、personal_sign、dev 私鑰簽名
  store/
    session.ts    token / expiresAt / address（sessionStorage）
    wallet.ts     連線狀態（provider 留在模組層，不進 store）
  components/     TopBar / RequireSession / Badge・Note・Field・ErrorNote
  features/
    auth/         SIWE 登入
    portfolios/   投組列表
    status/       漂移明細
  styles/         tokens.css / base.css / components.css
```

## 開發

```bash
bun install --frozen-lockfile # Bun 1.4.4
bun test tests
bun run dev        # http://localhost:5173
bun run typecheck
bun run build
```

後端要跑在 `127.0.0.1:8081`。`vite.config.ts` 把 `/api/*` proxy 過去（並剝掉前綴），
所以**前端一律打相對路徑** —— 同源就沒有 CORS 與 preflight，部署時由反向代理做同一件事。

`VITE_API_BASE` 可覆寫（預設 `/api`）。

### 登入

1. 連錢包（EIP-6963 清單，或 dev build 的私鑰入口）
2. `POST /api/auth/nonce` 取得 SIWE challenge
3. 錢包簽 `personal_sign`
4. `POST /api/auth/login` 換 token → 存 sessionStorage

**為什麼是 sessionStorage 不是 localStorage**：這支 app 會動錢，token 的曝險窗口應該跟「這個分頁開著」
一樣長。重新整理不用重簽，關掉分頁就清掉。

**錢包連線不跨重新整理**（`provider` 不是可序列化的資料，而把私鑰或 provider 寫進儲存是把鑰匙放在
瀏覽器裡）。所以重新整理後會是「已登入、錢包未連」——TopBar 會顯示 `錢包未連`，續期卡與登入頁都提供
就地重連（`components/WalletConnect.tsx`）。**不用登出重來。**

## 這一版做到哪裡

已完成的兩條線：

1. **登入 → 投組列表 → 漂移明細**
2. **續期**：`GET /renewal-params` → 用 owner 錢包送 sudo UserOp → `POST /renewal-result`

續期的 UI 刻意分成「先看要簽什麼 → 勾選確認 → 才送出」：它花 gas，而且會改變鏈上權限。

3. **再平衡**：確認 → `POST /portfolios/:id/rebalance` → 結果（outcome / SwapExecuted / steps）

### 再平衡的三個設計

**① 前端不猜要換什麼。** 規劃在後端（DB 價格 + 鏈上報價 + impact 上限 + 不改善就不送的守衛），
回應裡的 `steps` 才是真的送出去的參數。在畫面上先顯示一份「預計」等於給一個會被推翻的承諾。

**② `403 OPERATOR_REBALANCE_DISABLED` 不當成權限錯誤。** 那是部署層的開關：
後端沒帶 `ENABLE_OPERATOR_REBALANCE=true` 時這支端點**不存在**。卡片會直接說清楚，
不是丟一句「403 Forbidden」讓人去查 token。

**③ 結果照原文顯示。** `reason` 是排程器寫的那一句（含哪一層沒過），前端不改寫成「失敗」。
`noop` 與 `blocked` 都是**正確的結果**，不是錯誤 —— 例如「漂移 595 bps 不比現在的 595 低，
送出去只是付 gas」。

實測（兩條路徑都驗過）：

```
flag off → HTTP 403 code=OPERATOR_REBALANCE_DISABLED
flag on  → 200 {portfolioId, outcome, reason, txHash, userOpHash,
                swapExecuted, expectedSwaps, gasUsed, steps}
           對 #5（漂移 0）→ noop，不動錢、不燒 gas
```

## 續期走的路

```
GET /api/portfolios/:id/renewal-params     後端派生新 key（不簽章、不上鏈、不寫 DB）
  ↓ initConfig（每筆都是打給「帳戶自己」的 calldata）
owner 錢包簽 sudo UserOp                     createKernelAccount + signerToEcdsaValidator
  ↓ bundlerTransport = /api/bundler          ⚠ 必須帶 Authorization: Bearer <token>
alto（經後端 relay）                         白名單六個方法
  ↓ receipt
POST /api/portfolios/:id/renewal-result     後端記進 session_keys
```

實測（用這支 app 自己的 `lib/api.ts` + `lib/kernel.ts`）：

```
續期前 pid 0xb357c054 installed true
新 key m/44'/60'/0'/0/24806719 | pid 0xc87a3d81 | calldata 2 筆
上鏈 success | gasUsed 552381
記回 DB pid 0xc87a3d81
續期後 configured 0xc87a3d81 installed true → 排程器會用 0xc87a3d81
```

### 兩個整合陷阱（都踩過）

**① `/api/bundler` 是認證端點。**
少了 `Authorization: Bearer <token>` 就是 401；而且它只放行六個白名單方法。`kernel.ts` 用
`http(url, { fetchOptions: { headers } })` 帶標頭，並把 timeout 拉到 60 秒（viem 預設 10 秒不夠
估 gas + 送 op + 等 receipt）。

**② SDK 的 `entryPoint` 要物件，不是位址字串。**

```ts
{ address, version: '0.7' }   // ✓
'0x0000000071727De22E5E9d8BAf0edAc6f37da032'   // ✗ → Error: Unsupported entry point version
```

訊息完全沒提「你傳的是字串」。`kernel.ts` 現在把物件寫成常數，並先驗後端給的位址與它相等。

## 兩個刻意的顯示決定

**① 讀不到狀態時，不顯示任何漂移數字。**
`GET /portfolios/:id/status` 失敗（503）時，這一頁只顯示錯誤，不顯示「漂移 0、不需要再平衡」。
一個看起來正常的零比一個錯誤訊息危險得多。

**② `GET /portfolios/:id/status` 的 `sessionKey` 有兩種 key。**

| 欄位 | 意思 |
|---|---|
| `configured` | DB 記的最新那把（＝列表頁顯示的那把）。**可能沒安裝在鏈上** |
| `usable` | 排程器實際會用的那把（由新到舊逐把驗） |

兩者不同時畫面會警告「DB 記的 key 鏈上沒安裝；實際會用 X」。`usable === null` **只有在
`error === null`** 時才可以讀成「沒有可用的 key」。

## 驗證方式

`lib/format.ts` 沒有 DOM、沒有 fetch、沒有 React，所以可以直接驗算：

```bash
bun -e 'import {formatUsdE8} from "./src/lib/format.ts"; console.log(formatUsdE8("51133807293686"))'
# $511,338.07
```

金額一律走 BigInt：`123456789012345678` → `$1,234,567,890.12`（用 Number 會失真）。

## 一個踩過的契約坑

`GET /portfolios` 回的是 **`{ portfolios: [...] }`**，不是裸陣列。型別寫成 `Portfolio[]` 時
TypeScript 不會有任何意見（`request<T>` 只是斷言），執行期卻會在 `.map` 爆掉、畫面空白。
`lib/api.ts` 現在把 wire 形狀寫出來並在客戶端拆掉。


---

## UI/UX（沿用 bnb-agent-vaults 的設計稿）

`src/styles/vendor/` 是從 `bnb-agent-vaults/web/app/` 複製過來的：`design.css`（設計系統，4506 行）、
`fund-explore.css`（vaults 頁）、`fonts.css` + `fonts/`（自架字體）。**它們是純 CSS，沒有 Tailwind 指令。**

載入順序在 `main.tsx` 是刻意的：先 vendor（tokens + 全域 reset + 既有元件規則），再我的
`tokens/base/components.css` 覆蓋。反過來的話他們的 `button { background:none }` 會蓋掉我的元件。

### 完整公開 UI（2026-11-11）

來源釘在 `0xJoooe/bnb-agent-vaults@0f3196d37821561050dee1176d9d33e3b51c5d5e`：
30 檔基金、219 個底層資產頁、218 個 Create 可選資產。來源與雜湊見
[public-ui-source.json](docs/public-ui-source.json)，整合方式見
[public-ui-integration.md](docs/public-ui-integration.md)。

* `/vaults`：Market themes / Public figures / X voices，搜尋、排序、期間與返回篩選。
* `/funds/:slug`：原始封面、人物介紹、持倉、資產 hover、歷史曲線、Max drawdown、
  Performance details（Sharpe / volatility）、完整 recent trades 與來源。
* `/asset/:slug`：底層公司／資產介紹、歷史價格；代幣化版本為次要資訊。USDT 只作現金。
* `/leaderboard`、`/creator/:id`：來源基金排序與創作者目錄。
* `/portfolio`、`/portfolios`：維持原生帳戶與 API 真實資料，不把模型報酬當成使用者績效。

歷史曲線使用原始已發布 NAV，不會拿目前配置回填歷史。官方人物以持倉基準日重建，
X voices 依來源的貼文模型重播；這些不是本人實盤成交證明。原始披露／貼文連結保留。
只讀 `/reference-data/demo-funds` 可接收來源完整每日更新；資料不完整或請求失敗就保留舊截止日。

### Create fund（`/create`）與啟用（`/create/activate`）

`/create` 是完整來源設計器：資產、權重、策略、規則、X handle、封面、草稿與 JSON 匯出。
設計完成可進入原生啟用表單；ATP 目前能執行的是**目標權重配置**。
匯入只帶精確代幣地址與權重，其他規則不會被默默轉成執行策略。
啟用前須確認配置模式，且每個地址仍必須通過後端可交易資產清單。

三步都是真的後端呼叫（第 1、3 步會上鏈）：
```
POST /strategies                  → strategy.id（鏡像到鏈上 Registry，實測 ~1.7s）
POST /strategies/:id/versions     → v1（allocation.assets[].weightBps 必須剛好 10000，實測 ~3.1s）
POST /portfolios { strategyId }   → portfolio.id（部署 smart account + 安裝 session key，實測 ~6.0s）
```
進度逐步顯示 —— 一個轉圈 30 秒什麼都不說的按鈕會讓人以為壞掉而重複按。

權重用 **bps 累加**判斷是否 100%：`33.3 + 33.3 + 33.4` 在浮點裡不是 100。
