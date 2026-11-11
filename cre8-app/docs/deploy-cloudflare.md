# 前端部署：Cloudflare Pages + `/api` 同源代理

```
app.cre8.xyz  ──┬── /            → Pages（靜態，dist/）
                └── /api/*       → Worker → https://api-production-7f13.up.railway.app（去掉 /api）
```

## 為什麼要同源（不是可選的優化）

後端有兩道「網域必須一致」的檢查：

1. **SIWE**（`auth.ts`）—— `message.domain` 必須逐字等於 `AUTH_DOMAIN`，否則登入直接被拒；
   而且錢包彈窗會顯示一個跟瀏覽器不同的網域 —— 那正是釣魚的特徵，使用者應該警覺。
2. **CORS**（`server.ts`）—— 只白名單 `CORS_ALLOWED_ORIGINS`（預設只有 vite dev 的 localhost）。

同源之後這兩件事都不需要處理：同源請求不會觸發 CORS，`AUTH_DOMAIN` 也自然等於使用者看到的網址。

## 檔案

* `public/_worker.js` —— Pages 進階模式的入口。Vite 會把 `public/` 原樣複製到 `dist/`，
  而 Pages 讀的就是 `dist/_worker.js`，所以不需要額外 build 設定。
* `VITE_API_BASE` 不用設：程式預設就是 `/api`。

## 建置

```bash
VITE_CHAIN_ID=56 \
VITE_RPC_URL=https://bsc-rpc.publicnode.com \
bun run build
```

`VITE_CHAIN_ID` 會在**建置時**被寫進 bundle（`uu=56`），不是執行時讀取 —— 換鏈就要重新建置。

## 部署

目前唯一部署路徑是本文件下方的 **Cloudflare Git 整合**。早期手動部署已被取代；
不要在本機複製憑證、改 HOME 或額外推送 dist 來覆蓋 Git 部署。

## 目前狀態（正式網域已上線）

| 項目 | 值 |
|---|---|
| 前端 | `https://beta.cre8.finance` |
| API（同源代理） | `https://beta.cre8.finance/api/*` |
| `AUTH_DOMAIN` | `beta.cre8.finance` |
| `AUTH_URI` | `https://beta.cre8.finance` |
| 備用 | `https://cre8-atp.pages.dev`（Pages 預設網域，永遠可用）|

### 為什麼不是 `app.cre8.finance`

那個子網域**已經被既有的 Vercel 生產站佔用**（`app.cre8.finance` → `a8596c55…vercel-dns-016.com`）。
搶過來等於弄壞正式站，所以用 `beta.`。

### 綁定步驟（實際做過的）

1. `POST /accounts/{account}/pages/projects/cre8-atp/domains {"name":"beta.cre8.finance"}`
   —— wrangler 4.157 **沒有** `pages domain` 子指令，只能走 API。
   狀態會停在 `pending`、驗證方式 `http`：**Cloudflare 不會自動在同一個 zone 建記錄**。
2. 在 `cre8.finance` 的 DNS 加一筆：
   ```
   CNAME  beta  →  cre8-atp.pages.dev   Proxied（橘雲）
   ```
3. 等 TLS 簽發（實測 < 1 分鐘，憑證是 zone 的萬用憑證 `CN=cre8.finance`）。
4. 後端 `AUTH_DOMAIN` / `AUTH_URI` 改成新網域並重新部署。

### 權限註記

wrangler 的 OAuth token 只有 **zone 讀取**，DNS 寫入會被拒（`error 10000 Authentication error`）。
所以「建立 DNS 記錄」這一步只能由使用者在 Dashboard 做，或改用帶 `dns_records:edit` 的 API token。

### 驗證（不需要登入）

```bash
curl -s https://beta.cre8.finance/api/health
curl -s -X POST https://beta.cre8.finance/api/auth/nonce   # domain 必須是新網域
```

### 換成 app.cre8.xyz 時要改三處

1. Cloudflare Pages → 專案 → Custom domains → 加 `app.cre8.xyz`（DNS 由 Cloudflare 自動建立）
2. Railway api 服務的 `AUTH_DOMAIN=app.cre8.xyz`、`AUTH_URI=https://app.cre8.xyz`，然後**重新部署**
3. 驗證：`curl -s -X POST https://app.cre8.xyz/api/auth/nonce` → domain 要是 `app.cre8.xyz`

**漏掉第 2 步的症狀**：頁面載入正常，但按下 Sign in 時錢包簽完卻得到
`SIWE message domain "app.cre8.xyz" does not match this server (cre8-atp.pages.dev)`。

驗證（不必登入就能看）：

```bash
curl -s -X POST https://api-production-7f13.up.railway.app/auth/nonce
# → {"domain":"app.cre8.xyz","chainId":56,"uri":"https://app.cre8.xyz",...}
```

**這一行就是整個設定的驗收條件**：domain 與 chainId 對了，SIWE 才會過。

## 要換環境時

* 換後端 → 改 `public/_worker.js` 的 `API_ORIGIN`
* 換前端網域 → 改 Railway 的 `AUTH_DOMAIN`/`AUTH_URI`，"並重新部署 api"
* 換鏈 → 改 `VITE_CHAIN_ID` **並重新建置前端**（它是建置時常數）

## 注意

`CORS_ALLOWED_ORIGINS` 刻意**不設** —— 同源不需要 CORS，而預設值只允許
`localhost:5173`（dev 用），生產環境不會有任何跨域來源被放行。這比「為了方便把 `*` 加進去」安全得多。

---

## 部署路徑：Cloudflare Git 整合（唯一一條）

**決定：部署交給 Cloudflare 的 Git 整合，不用 GitHub Actions 部署。**

理由：兩條部署路徑會互相覆蓋（Cloudflare 的 Git 部署 vs Actions 的 `wrangler pages deploy`），
誰最後跑誰贏 —— 「不確定哪個版本在線上」是最難查的狀態。而 Git 整合還免費給 PR 預覽網址。

### Cloudflare 那邊的設定

```
Workers & Pages → cre8-atp → Settings → Build
  Git repository          cre8-protocol/cre8-app
  Production branch       main
  Build command           bun run build
  Build output directory  dist
  Root directory          /                  （repo 根目錄就是 app）
  Environment variable    BUN_VERSION = 1.4.4（可選，釘住與本機一致）
```

`.env.production`（`VITE_CHAIN_ID=56`）**已進版控**，所以不需要在 Cloudflare 設任何變數。
`public/_worker.js` 會在 `vite build` 時被複製進 `dist/`，那是 `/api` 代理的實作。

### 為什麼還留著 `.github/workflows/ci.yml`

它跑單元測試、`typecheck` + `build` 並標在 PR 上。Cloudflare 的建置失敗**只顯示在 Cloudflare**，
PR 上看不到 —— 而 `typecheck` 抓的是「本機能過、CI 掛掉」那類問題（例如依賴只存在於某人
的家目錄 `~/node_modules`，實際發生過兩次）。

## CI（GitHub Actions，只有檢查、不部署）

| Workflow | 觸發 | 做什麼 |
|---|---|---|
| `.github/workflows/ci.yml` | PR、push main、手動 | `bun install --frozen-lockfile` → `bun test tests` → `typecheck` → `build` → 上傳 `dist` artifact |

### 兩個刻意的設計

* `--frozen-lockfile`：lockfile 與 `package.json` 不一致就**直接失敗**，
  而不是安靜地裝一組新的依賴
* 建置設定只來自 `.env.production`（已進版控），CI **不注入** `VITE_CHAIN_ID` ——
  避免「CI 與本機產生不同 bundle」這種最難查的差異

### 驗證 CI 會過（本機）

在家目錄之外的乾淨 checkout（例如 `/private/tmp/cre8-app-check`），使用 Bun 1.4.4：

```bash
bun install --frozen-lockfile
bun test tests
bun run typecheck
bun run build
```

僅更改 HOME 無法隔離 TypeScript 向父目錄搜尋 node_modules；必須讓原始碼本身位於家目錄之外。
詳細原因見 [uiux-handoff.md §6.5](uiux-handoff.md)。

## 完整公開資料的只讀代理

`GET /reference-data/demo-funds` 固定代理到來源站的公開歷史資料，僅允許 GET/HEAD，
不轉發錢包憑證，不改動既有 `/api/*` → Railway 的認證流程。整合及驗收見
[public-ui-integration.md](public-ui-integration.md)。
