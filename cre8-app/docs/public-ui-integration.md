# 完整公開 UI：來源、整合與驗收

2026-11-11，Cloudflare Pages 專案 `cre8-atp`。以 GitHub `cre8-protocol/cre8-app` 的 main 自動部署；不新增直接 wrangler 部署或第二條部署 workflow。

## 來源與完整範圍

來源 `0xJoooe/bnb-agent-vaults@0f3196d37821561050dee1176d9d33e3b51c5d5e`，已發布 UI 0.2.10.0。來源工作樹及 HEAD tree 必須與 pinned commit 相符；不得從髒工作區匯入。

`node scripts/sync-public-ui.mjs <source-repo>` 產生來源純資料、設計器與公開素材。雜湊見 [public-ui-source.json](public-ui-source.json)。runtime SHA-256 為 `6f2c7b84a9b06816ff91ad184c6049d339f7fb73c96dd806dea964644cd42d9f`。

| 範圍 | 內容 |
|---|---|
| Funds | 30 檔：Themes 5、Public figures 18、X voices 7；完整封面、人物介紹、搜尋分類、排序與期間 |
| Fund detail | NAV 曲線、最大回撤、詳細 Sharpe／volatility、Description／methodology／disclaimer、完整來源更新與交易明細 |
| Underlying assets | 219 頁，資產 hover、公司名稱／ticker、歷史價格、代幣化版本次要呈現；USDT 只作現金 |
| Create | 218 可選資產、權重、策略、規則、X handle、封面、草稿、檢視與 JSON 匯出 |
| Native ATP | 原有錢包、SIWE、帳戶、存入、提領、清倉、Operator、gas／approval 與查詢失效鏈 |

`/create/activate` 延用原有目標權重配置的執行流程。設計器其他規則／費率不會被默默啟用；匯入需使用者確認，精確代幣地址仍逐一與後端 `assets` 可交易清單核對。不支援的地址須移除才可送出。

## 資料與統計

* 初始資料完整保留來源已發布 NAV、人物、持倉與調倉更新，沒有使用目前配置重算過去。
* 人物官方資料按持倉基準日重建；X voices 按來源公開貼文模型重播。持倉快照變動保留其披露來源，不能宣稱本人逐筆實盤成交。
* Sharpe 與 volatility 使用來源的日曆日方法，至少 90 個連續日報酬；無風險參考利率只用前一 NAV 日已觀察到的最新值。選定期間會同時套用報酬、回撤與詳細統計。
* 當期持倉權重會隨價格漂移；ATP 的目標配置取 `backtest.targets`，不把漂移後持倉當成配置指令。
* `/reference-data/demo-funds` 為固定 Vercel 來源的 GET/HEAD 代理，拒絕其他方法，不轉發 Cookie 或 Authorization，也不回傳 Set-Cookie。
* 客戶端只接受完整同一目錄、連續日期 NAV、吻合的 share price／returns／drawdown 與有效來源更新；原子套用。請求或驗證失敗保留原截止日，一小時後可重試。
* 資產行情保留其自身資料時間，並非即時成交報價；公開基金參考數值不會代替 Portfolio 的真實 API 估值。

## 樣式、路由與登入

依 [uiux-handoff.md](uiux-handoff.md) 保留兩區原則。原 vendor CSS、shadcn tokens、wallet／Kernel／SIWE／session／API 契約不變。新增樣式在 `complete-ui.css`，策略側欄、績效、交易、代幣與手機下單使用既有 shadcn Sheet。來源置中的資產選擇及 Review 保留原生 modal dialog。

新增路由 `/asset/:slug`、`/leaderboard`、`/creator/:id`、`/create/activate`；舊 `/vault/:slug`、`/assets/:slug`、`/portfolio` 皆保留 alias。新抽屜有 `performance`、`trades`、`update`、`tokens`、`ticket` 深連結，Create 策略側欄使用 `strategy=<row id>`，既有 `facts`、`position`、`tab=withdraw` 仍有效。返回目錄保留本站搜尋條件並拒絕外部 returnTo。

`.env.production` 保留 chain 56 與 `/api`。Cloudflare 預設網域 `cre8-atp.pages.dev` 是部署備用入口；後端 SIWE 仍綁 `beta.cre8.finance`，登入請使用該正式網域。本次沒有改 auth domain 或 DNS。

## 驗收

家目錄外的獨立 checkout，使用 Bun 1.4.4 frozen install、資料／代理單元測試、TypeScript strict、Vite production build。瀏覽器檢查 320／390／1280 px 公開頁、完整設計器、人物 hover、資產預覽／返回、績效期間／焦點、來源交易明細、USDT、原生 facts／position／withdraw／close、Operator 標籤及 toast 顯示／到期。

需要持倉的畫面使用本機唯讀 API／錢包 fixture，provider 明確拒絕任何簽名。沒有發送真實錢包簽名或鏈上交易。完整資產歷史與 Create 已拆成延遲載入 chunk，主 bundle 仍較大，Vite 會保留大小警告。

部署以 Cloudflare Git preview 和 production 狀態加上真實 Chrome 驗證；命令列 HTTP client 可能被站方 Cloudflare browser-signature 規則擋下，不能直接視為網站故障。
