# cre8-atp-backend

CRE8 ATP 的鏈下後端（第一刀）。Bun + TypeScript + Postgres，直接用 `pg`，**不用 ORM**（與 web app 一致）。
預設鏈是 BNB Chain mainnet（chain 56）。目前做策略資料層、版本發布、SIWE（EIP-4361）錢包簽章 auth、
portfolio 續期，以及 **bundler relay**（`POST /bundler`：瀏覽器不能直連 alto，見 §bundler relay）。

## 架構

```
HTTP → src/index.ts（啟動：config → migrate → listen）
         └─ src/server.ts（node:http 路由、JSON、錯誤映射、auth 守門）
              ├─ src/auth.ts（SIWE nonce、EIP-4361 驗簽、session token）
              └─ src/strategies.ts（領域邏輯 + 純函式校驗）
                   └─ src/db.ts（pg Pool、query、transaction、migrate）
                        └─ Postgres（schema 在 ../db/migrations）
```

| 檔案 | 職責 |
| --- | --- |
| `src/config.ts` | 讀 env；`DATABASE_URL` 必填，`PORT` 預設 8080，`CHAIN_ID` 預設 56，`AUTH_DOMAIN` 預設 `localhost`。 |
| `src/auth.ts` | nonce／session 的 in-memory store、EIP-4361（SIWE）驗簽（viem `parseSiweMessage` + `recoverMessageAddress`）、`authenticate()`。 |
| `src/db.ts` | 單一 `Pool`、`query()`、`withTransaction()`、`migrate()`（checksum + advisory lock）。 |
| `src/errors.ts` | `AppError`／`ValidationError`／`NotFoundError`，讓領域層不必知道 HTTP。 |
| `src/strategies.ts` | `listStrategies`、`getStrategy`、`createStrategy`、`publishVersion`，以及 allocation／schedule 校驗。 |
| `src/portfolios.ts` | `enrollPortfolio`、`listPortfolios`、`requireOwnedPortfolio`：portfolio 的讀寫與擁有者檢查。 |
| `src/renewal.ts` | 續期：派生新 session key（`nextRenewalKeyIndex`／`buildRenewalKey`）、`buildRenewalParams`、`recordRenewalResult`。 |
| `src/server.ts` | 路由、body 解析（上限 1 MB）、錯誤 → JSON、CORS、access log、`POST /bundler` 的 relay 與方法白名單。 |
| `src/index.ts` | 啟動與優雅關閉（SIGINT／SIGTERM）。 |
| `src/migrate.ts` | `bun run migrate`：只跑 migration，不啟 server。 |
| `test/strategies.test.ts` | 校驗純函式與 HTTP 路由單測（路由層可注入 `createStrategy`／`publishVersion`，不需 DB）；DB 整合測試以 `DATABASE_URL` 為 gate。 |
| `test/auth.test.ts` | SIWE nonce／login／session 與 provider ownership；用 viem `createSiweMessage` + 隨機錢包在測試內簽名，走完整 HTTP 流程。 |
| `test/renewal.test.ts` | `/portfolios` 列表、`renewal-params`／`renewal-result`、路由分派、CORS 與 `/bundler` relay（含「白名單外不轉發」）；DB／鏈／時鐘／bundler 上游都以 DI 換成假替身。 |

選擇 `node:http` 而不是 express：這一刀只有七個路由，少一層依賴；`server.ts` 的 `route()` 是唯一需要換掉的
地方，之後要上 express/Fastify 不會動到領域層。

## 環境變數

| 變數 | 必填 | 預設 | 說明 |
| --- | --- | --- | --- |
| `DATABASE_URL` | ✅ | — | Postgres 連線字串；缺少時 `getConfig()` 直接 throw。 |
| `PORT` | | `8080` | HTTP 埠，1–65535。 |
| `CHAIN_ID` | | `56` | EIP-155 chain id；56 = BSC mainnet，97 = testnet。SIWE 訊息必須綁同一個 chain。 |
| `AUTH_DOMAIN` | | `localhost` | EIP-4361 `domain`：錢包要簽的站台 authority（純 host，可帶 port，不含 scheme／path）。部署時必填自己的網域。 |
| `AUTH_URI` | | `http://<AUTH_DOMAIN>` | EIP-4361 `uri`：這次登入指涉的資源。必須是 http/https 絕對 URI；部署時建議設 `https://app…`。 |
| `RPC_URL` | | 空 | JSON-RPC endpoint；目前只用於 `/health` 回報是否設定。 |
| `EXECUTOR_ADDRESS` | 續期／enroll 時 ✅ | 空 | session key CallPolicy 允許呼叫的 target（rebalance executor）。缺它時 enroll 與 `renewal-params` 會帶著變數名失敗。 |
| `SESSION_KEY_MASTER_SEED` | 續期／enroll 時 ✅ | 空 | 派生 session key 的 HD master seed（`0x` + 64 hex）。私鑰永不落 DB，DB 只存派生路徑 `m/44'/60'/0'/0/<index>`。 |
| `BUNDLER_URL` | | `http://127.0.0.1:3001` | `POST /bundler` 轉發的上游（alto）。`renewal-params` 也把它回給前端當**資訊**顯示。留空 = 這個預設值。 |
| `CORS_ALLOWED_ORIGINS` | | `http://localhost:5173,http://127.0.0.1:5173` | 逗號分隔的允許 origin（完整 origin，不分大小寫）。未設定 = dev 預設；不支援 `*`。 |

複製 `.env.example` 為 `.env` 即可；`.env` 不進版控。**不要**把真的 RPC URL 或連線字串寫進 repo。

## 指令

```bash
bun install
cp .env.example .env       # 填入 DATABASE_URL

bun run dev                # bun --watch src/index.ts（啟動時先 migrate）
bun run migrate            # 只套用 migration
bun run start              # bun src/index.ts
bun run typecheck          # tsc --noEmit（src + test 兩份 tsconfig）
bun test                   # bun 內建 test runner；沒有 DATABASE_URL 時 DB 測試會 skip
```

需求：Bun >= 1.4（`package.json` 的 `engines`）。bun 原生跑 TypeScript，不需 build 步驟、不需 tsx。

### 測試與 DB

```bash
# 純函式 + auth／路由測試（不需 DB）
bun test

# 加上 DB 整合測試；請用可拋棄的資料庫，測試會跑 migration 並建立／刪除資料
DATABASE_URL='postgres://postgres@127.0.0.1:5432/cre8_atp_test' bun test
```

### 會送鏈上交易的測試（`RUN_CHAIN_TESTS=1`）

有四個測試會**真的送出鏈上交易**：`createStrategy` 會 mirror 到 `AtpRegistry`、`publishVersion`
會上鏈、`enrollPortfolio` 會走 counterfactual deploy。它們預設**關閉**，就算 `.env` 齊全也一樣：

| 測試 | 檔案 |
| --- | --- |
| `DB: strategy and version round trip` | `test/strategies.test.ts` |
| `DB: POST /strategies/:id/versions publishes a version over HTTP` | `test/strategies.test.ts` |
| `DB: provider ownership is enforced end to end over HTTP` | `test/auth.test.ts` |
| `enrollPortfolio mirrors to chain and writes portfolio + smart account` | `test/portfolios.test.ts` |

為什麼要另外一個開關：「後端設定齊全」（`RPC_URL` / `OPERATOR_PRIVATE_KEY` / `REGISTRY_ADDRESS`）
只代表**伺服器**能用，不代表**測試**可以動鏈。把 `.env` 補齊就自動開跑，等於讓 `bun test` 變成一支
會寫鏈的腳本，而這幾條測試共用同一個 operator 帳號的 nonce。

```bash
# 預設：上面四個測試 skip，其餘照跑（0 fail）
bun test

# 真的跑鏈上寫入：一定要給足 timeout，而且不要開 --concurrent
RUN_CHAIN_TESTS=1 bun test --timeout=120000
```

兩個細節，都是實測踩出來的：

- **`--timeout` 不能省。** 每筆送交易 + 等 receipt 是幾秒的事（`enrollPortfolio` 那條整體實測 13–15
  秒），bun 預設每測試 5 秒一定逾時。而逾時的測試**底層的送交易不會停**，於是下一個測試用同一個
  operator 帳號讀到舊 nonce，就變成 `NonceTooLowError`。實測：`RUN_CHAIN_TESTS=1 bun test`
  （不加 `--timeout`）是 4 fail，加上 `--timeout=120000` 連兩輪都是 410 pass / 0 fail。
- **不要用 `--concurrent`。** 它會讓同一檔案內的測試並行，nonce 直接對撞。順帶一提
  `bun test --concurrent 1` 在 bun 1.4 是**無效**的寫法：`--concurrent` 不吃值，那個 `1` 會被當成
  檔名 filter，結果是「The following filters did not match any test files: 1」。bun 預設就是一個檔案
  跑完再換下一個，所以正確做法是**只給 `--timeout`、不要碰 `--concurrent`**。

⚠ 這四個測試會把交易送到 `RPC_URL` 指的鏈，並且在 `DATABASE_URL` 的資料庫留下 strategy 資料列。
**只對著本機 anvil fork（例如 `http://127.0.0.1:8545`）跑，不要對著主網跑。**

只**讀**鏈的測試（`test/pricing.crosscheck.test.ts`、`test/rebalance-plan.test.ts` 的真鏈驗證、
`test/snapshot.integration.test.ts`）不受這個開關影響：它們不送交易、不佔 nonce，可以安全並行，
skip 條件只看 fork 可不可用。

### Fork 鏈上整合測試（Anvil fork BSC mainnet）

需要三個終端／背景程序：Anvil fork、帶鏈設定的 backend、整合腳本。

```bash
# 1. 起 Anvil fork（chain 56，常駐）
cd ../cre8-contracts
/Users/jareklin/.foundry/bin/anvil --fork-url https://bsc-rpc.publicnode.com --chain-id 56 --port 8545

# 2. 部署三個合約，記下 registry 地址（另一終端）
/Users/jareklin/.foundry/bin/forge script script/DeployAtp.s.sol \
  --rpc-url http://127.0.0.1:8545 --broadcast --skip-simulation \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# 3. 起帶鏈設定的 backend（8081，避免撞到 8080）
cd ../backend
DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/cre8_atp' \
RPC_URL='http://127.0.0.1:8545' \
OPERATOR_PRIVATE_KEY='0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' \
REGISTRY_ADDRESS='<第 2 步印出的 registry>' \
PORT=8081 AUTH_DOMAIN=localhost bun src/index.ts

# 4. 跑端到端整合（auth → 建策略 → 發版本 → enroll）
bun run scripts/integration-fork.ts
```

驗證鏈上狀態：

```bash
cast call $REGISTRY 'enrollments(address)(uint256,uint16,bool)' $WALLET --rpc-url http://127.0.0.1:8545
# → 1 / 1 / false（strategyId / version / paused）
```

注意：Anvil fork 的帳戶私鑰是公開的測試金鑰，**只用在本地 fork**；真實鏈上要用自己的錢包。

沒有 `DATABASE_URL` 時，`node:test` 會把 DB 測試標成 skipped（不是 passed）。整合測試會自己
`migrate()`，並在 `finally` 清掉建立的 strategy（versions 由 FK cascade）。

## API

所有回應都是 `application/json; charset=utf-8`，錯誤格式固定為
`{"error":{"code":"...","message":"..."}}`。

| Method | Path | 說明 | 成功碼 |
| --- | --- | --- | --- |
| `GET` | `/health` | Postgres 可連線時 200，否則 503（`db: "down"`） | 200 |
| `GET` | `/strategies` | 列表；`limit`（1–100，預設 50）、`offset`、`provider`（不分大小寫）、`public=true\|false` | 200 |
| `GET` | `/strategies/:id` | 單一策略 + 版本歷史（新到舊） | 200 |
| `POST` | `/auth/nonce` | 取得一次性 nonce 與 SIWE 欄位（`domain`／`chainId`／`uri`／`statement`／`issuedAt`，TTL 5 分鐘）；不需 body | 200 |
| `POST` | `/auth/login` | body `{message, signature}`（完整 EIP-4361 訊息）；回 `{token, expiresAt}` | 200 |
| `POST` | `/strategies` | 建立策略 metadata；**需** `Authorization: Bearer <token>` | 201 + `Location` |
| `POST` | `/strategies/:id/versions` | 發布新版本；**需** token 且必須是該策略的 provider | 201 |
| `GET` | `/portfolios` | 目前登入錢包的 portfolio 列表（含 gas 狀態與現行 session key）；**需** token | 200 |
| `POST` | `/portfolios` | enroll 一個策略；**需** token，body `{strategyId}` | 201 + `Location` |
| `GET` | `/portfolios/:id/renewal-params` | 派生一把新的 session key，回傳前端組續期 UserOp 所需的全部材料；**需** token 且必須是擁有者 | 200 |
| `POST` | `/portfolios/:id/renewal-result` | 前端回報續期 UserOp 已上鏈，後端記進 `session_keys`；**需** token 且必須是擁有者 | 200 |
| `POST` | `/bundler` | bundler relay：把 JSON-RPC 原樣轉給 `BUNDLER_URL` 並原樣回傳；**需** token，方法必須在白名單內 | 上游的 status |

所有需要 token 的路徑都在讀 body **之前**驗證：沒帶 token 的請求即使 body 不合法也是 401，不是 400。

### Auth（SIWE／EIP-4361 + session token）

沒有密碼、沒有第三方服務。流程是「拿 SIWE 欄位 → 前端用 viem 組 EIP-4361 訊息 → 錢包簽 → 換 token →
帶 token 打寫入路由」。訊息綁住 **domain + chainId + nonce + issuedAt**，被釣到別的站台或別的鏈都簽不出可用的
訊息。

1. `POST /auth/nonce` 取得一次性 nonce（32 bytes hex，TTL 5 分鐘）與組訊息所需的欄位：
   ```bash
   curl -s -X POST localhost:8080/auth/nonce
   # {"nonce":"<64 hex>","domain":"localhost","chainId":56,"uri":"http://localhost",
   #  "statement":"Sign in to CRE8 ATP","version":"1",
   #  "issuedAt":"2026-11-06T01:00:00.000Z","expiresAt":"2026-11-06T01:05:00.000Z"}
   ```
   `domain`／`chainId`／`uri`／`statement` 來自伺服器設定（`AUTH_DOMAIN`、`CHAIN_ID`、`AUTH_URI`）；
   `issuedAt` 是伺服器時間，前端直接拿來用就不會被本機時鐘偏差影響。
2. 前端用 viem 把這些欄位加上**自己的地址**組成完整 EIP-4361 訊息並簽名
   （`viem/siwe` 的 `createSiweMessage`，`version: "1"`）：
   ```ts
   import { createSiweMessage } from 'viem/siwe';

   const challenge = await (await fetch('/auth/nonce', { method: 'POST' })).json();
   const message = createSiweMessage({
     address: account.address,          // 簽名者自己填
     chainId: challenge.chainId,
     domain: challenge.domain,
     uri: challenge.uri,
     statement: challenge.statement,
     version: '1',
     nonce: challenge.nonce,
     issuedAt: new Date(challenge.issuedAt),   // 或用 new Date()
   });
   const signature = await walletClient.signMessage({ account, message });
   ```
   錢包顯示的是標準 SIWE 版面（`<domain> wants you to sign in with your Ethereum account:` + 地址 +
   `Sign in to CRE8 ATP` + `URI`／`Version`／`Chain ID`／`Nonce`／`Issued At`）。
3. `POST /auth/login`，body 只有 `{"message":"<完整 EIP-4361 訊息>","signature":"0x…"}`：
   ```bash
   curl -s -X POST localhost:8080/auth/login -H 'content-type: application/json' -d '{
     "message": "<完整 SIWE 訊息，含換行>",
     "signature": "0x<65-byte signature>"
   }'
   # {"token":"<64 hex>","expiresAt":"..."}
   ```
   後端依序檢查（順序刻意如此：先驗信封，再燒 nonce）：
   - 訊息可解析，且 `version=1`、`statement`、`domain`、`uri`、`chainId` 都等於本伺服器設定，
     否則 400 `INVALID_SIWE_MESSAGE`（**此時不消耗 nonce**，釣魚訊息燒不掉使用者的 challenge）。
   - 訊息裡的 nonce 存在（否則 400 `INVALID_NONCE`）且未過 TTL（否則 400 `NONCE_EXPIRED`）。
   - `issuedAt` 不在未來、不超過 nonce TTL + 2 分鐘時鐘容差，`expirationTime`／`notBefore` 若填了也要成立，
     否則 400 `SIWE_EXPIRED`／`INVALID_SIWE_MESSAGE`。
   - `recoverMessageAddress({ message, signature })` 解出的地址必須等於**訊息內**的地址，
     否則 401 `INVALID_SIGNATURE`。
   - 通過後立即刪除 nonce（重放 → 400 `INVALID_NONCE`），簽發 TTL 24 小時的 token。
4. 寫入路由帶 `Authorization: Bearer <token>`；伺服器把 token 換回錢包地址，**provider 一律由 session 推導**，
   body 裡的 `provider` 會被忽略。不是策略 owner 卻發布版本 → 403 `FORBIDDEN`。

驗簽只用 `recoverMessageAddress`（EOA），**不支援 EIP-1271 合約錢包**：那需要 RPC 去問合約。
要支援就得把 `verifySiweMessage`（viem，帶 `publicClient`）接上 `RPC_URL`，屬於下一刀。

nonce 與 session 目前是**單一 process 的 in-memory Map**：重啟即失效，也只能跑單實例。水平擴展前必須換成
Redis 或其它共享 store（見 TODO）。

```bash
curl -s localhost:8080/health
# {"status":"ok","service":"cre8-atp-backend","chainId":56,"rpcConfigured":false,"db":"ok","uptimeSeconds":3}

curl -s -X POST localhost:8080/strategies -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "name": "Index 500",
  "description": "BSC bStock index",
  "isPublic": true,
  "swapFeeBps": 25
}'
# {"id":1,"provider":"0x<session wallet, lowercase>",...,"swapFeeBps":25,"createdAt":"..."}

curl -s -X POST localhost:8080/strategies/1/versions -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "allocation": {"assets": [
    {"address": "0x00000000000000000000000000000000000000a1", "symbol": "AAPLB", "weightBps": 6000},
    {"address": "0x00000000000000000000000000000000000000b2", "weightBps": 4000}
  ]},
  "schedule": {"kind": "interval", "intervalSeconds": 86400},
  "changeLog": "initial weights"
}'
# {"strategyId":1,"version":1,"allocation":{...},"schedule":{...},"changeLog":"initial weights","activeAt":"...","createdAt":"..."}
```

`POST /strategies/:id/versions` 回傳的是**建立的版本紀錄本身**（`strategyId`、`version`、`allocation`、
`schedule`、`changeLog`、`activeAt`、`createdAt`），不是 strategy detail。版本號由後端配置
（`max(version)+1`，併發時靠唯一鍵重試），策略不存在回 404、allocation／schedule 校驗失敗回 400。

列表回傳 `{ items, total, limit, offset }`；`total` 是符合條件的總筆數，不是本頁筆數。

### 校驗規則（與鏈上 `AtpRegistry` 對齊）

`POST /strategies`：

- `name` 必填、去空白後非空、≤ 120 字。`provider` **不從 body 讀**：由 `Authorization` 的 session 推導
  （body 帶了也忽略），長度上限 200 字。
- `description` ≤ 2000 字，預設 `""`。
- `isPublic` 必須是 boolean，預設 `true`。
- `swapFeeBps` 必須是 0–300 的整數（3% 上限，對齊 `MAX_SWAP_FEE_BPS`），預設 0。

`POST /strategies/:id/versions`（`publishVersion()`）：

- 請求 body 必須是物件；`allocation`、`schedule` 必填，`changeLog`、`activeAt` 選填。
- `allocation` 必須是 `{"assets":[{"address":"0x…","symbol"?:"  ≤32 字","weightBps":2500}]}`。
- 1–16 個資產（`MAX_VERSION_ASSETS`）；address 必須是 0x + 40 hex，入庫前轉小寫。
- 同一版本內資產不可重複（address 不分大小寫）。
- `weightBps` 必須是 1–10000 的整數，總和**必須剛好 10000**。
- `schedule` 是 `{"kind":"interval","intervalSeconds":>=60}` 或 `{"kind":"cron","cron":"…"}`。
- `changeLog` 選填，≤ 2000 字；`activeAt` 選填，預設 `now()`。
- 必須帶 token，且該策略 DB 的 `provider` 必須等於 session 錢包（不分大小寫），否則 403 `FORBIDDEN`。

錯誤碼：`INVALID_ALLOCATION`、`ALLOCATION_EMPTY`、`TOO_MANY_ASSETS`、`INVALID_ASSET`、
`DUPLICATE_ASSET`、`WEIGHT_OUT_OF_RANGE`、`WEIGHT_SUM`、`INVALID_SCHEDULE`、`INVALID_VERSION`、
`INVALID_STRATEGY`、`INVALID_SWAP_FEE`、`INVALID_ID`、`INVALID_QUERY`、`INVALID_JSON`、`NOT_FOUND`、
`METHOD_NOT_ALLOWED`、`PAYLOAD_TOO_LARGE`、`DB_UNAVAILABLE`、`INTERNAL`、`UNAUTHORIZED`、
`FORBIDDEN`、`INVALID_AUTH`、`INVALID_NONCE`、`NONCE_EXPIRED`、`INVALID_SIGNATURE`、
`INVALID_SIWE_MESSAGE`、`SIWE_EXPIRED`、`INVALID_RENEWAL`、`KEY_REF_CONFLICT`、`SESSION_KEY_CONFIG`、
`BUNDLER_METHOD_NOT_ALLOWED`、`BUNDLER_UNAVAILABLE`。


## Portfolio 與 session key 續期

三支 endpoint，全部需要 `Authorization: Bearer <token>`。設計原則：**後端只做前端做不到的事** ——
派生新的 session key（要 master seed，絕不進瀏覽器）。UserOp 的組裝、簽章、送 bundler 全在前端。

### `GET /portfolios`

目前登入錢包的所有 portfolio。只回 token 對應錢包的列（`lower(portfolios.user_id) = token 的錢包`），
沒有任何「查誰」的參數，所以不存在改一個 query string 就讀到別人 portfolio 這條路。

```bash
curl -s localhost:8080/portfolios -H "authorization: Bearer $TOKEN"
```

```json
{ "portfolios": [
  { "id": 3, "userId": "0xabc…", "strategyId": 11, "version": 1, "scheduleState": "active",
    "createdAt": "2026-11-06T00:00:00.000Z",
    "smartAccounts": [ { "chainId": 56, "address": "0xdef…", "owner": "0xabc…", "accountType": "KERNEL" } ],
    "gas": { "address": "0xdef…", "balanceWei": "50000000000000000", "minimumWei": "10000000000000000",
             "ready": true, "shortfallWei": "0", "estimatedOps": 163, "gasPriceKnown": true },
    "sessionKey": { "permissionId": "0xc0449df6", "sessionKeyAddress": "0x123…",
                    "keyRef": "m/44'/60'/0'/0/787718448", "expiresAt": "2028-01-15T08:00:00.000Z",
                    "status": "active" } }
] }
```

- `gas` 與 `sessionKey` 取不到時是 **`null`**，不是整個請求失敗：`null` 代表「暫時查不到」，不是
  「餘額 0」或「沒有 key」。
- `sessionKey` 是**現行**的那一把（`status = 'active'` 優先，其次到期日新到舊）。
- 錯誤：401 `UNAUTHORIZED`；DB 不可用 503 `DB_UNAVAILABLE`。

### `GET /portfolios/:id/renewal-params`

**派生一把新的 session key，回傳前端組 UserOp 所需的一切。不簽章、不上鏈、不寫 DB。**

```bash
curl -s localhost:8080/portfolios/3/renewal-params -H "authorization: Bearer $TOKEN"
```

```json
{
  "portfolioId": 3,
  "strategyId": 11,
  "chainId": 56,
  "ownerAddress": "0xabc…",
  "accountAddress": "0xdef…",
  "executorAddress": "0x6069…",
  "entryPoint": "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  "kernelVersion": "0.3.3",
  "sessionKeyAddress": "0x123…",
  "keyRef": "m/44'/60'/0'/0/787718449",
  "validUntil": 1825512345,
  "expiresAt": "2027-11-06T00:00:00.000Z",
  "permissionId": "0x9ab4cdef",
  "policySnapshot": { "version": 1, "entryPoint": "0x…", "kernelVersion": "0.3.3", "flag": "0x0000",
                      "call": { "…": "…" }, "gas": { "…": "…" }, "timestamp": { "…": "…" },
                      "permissionId": "0x9ab4cdef", "sessionKeyAddress": "0x123…",
                      "expiresAt": "2027-11-06T00:00:00.000Z" },
  "initConfig": ["0x9198bdf5…", "0xe9ae5c53…"],
  "bundlerUrl": "http://127.0.0.1:3001"
}
```

- `accountAddress` 是 **DB `smart_accounts.address` 的權威值，不是重新推導**：已部署帳戶的位址取決於
  當初那組 `initConfig`，重算會落到另一個（沒部署過）的地址，見 `docs/pitfalls` §4.7。
- `initConfig` 是兩筆 calldata，`to` 都是**帳戶自己**（帳戶內的 `msg.sender == self`）。
- `validUntil` 是 `sessionValidUntil()` = now + 365 天（Unix 秒，uint48），`expiresAt` 是同一個瞬間的 ISO。
- `policySnapshot` 前端不需要解，但**必須原樣回傳**給 `renewal-result`。
- **新 key 的索引一定與既有那把不同**：`max(既有所有 key_ref 的索引, base) + 1`，其中
  `base = keccak256(owner, strategyId) % 2^31`。同一秒內重打這支 endpoint 會回**完全相同**的 key
  （索引只依賴 DB 狀態、`validUntil` 只到秒），所以前端逾時重試不會拿到另一把 key 去簽前一個 op。
- 錯誤：401 `UNAUTHORIZED`；404 `NOT_FOUND`（portfolio 不存在，或它沒有任何 smart account）；
  403 `FORBIDDEN`（不是你的）；400 `INVALID_ID`；500 `SESSION_KEY_CONFIG`（缺 `EXECUTOR_ADDRESS` 或
  `SESSION_KEY_MASTER_SEED`，訊息會指出缺哪一個）。

### `POST /portfolios/:id/renewal-result`

前端把已上鏈的續期結果記回 DB。**鏈是權威**，所以這裡不驗證 txHash 是否真的上鏈，只記錄。

```bash
curl -s -X POST localhost:8080/portfolios/3/renewal-result \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "txHash": "0x…", "userOpHash": "0x…",
  "permissionId": "0x9ab4cdef", "sessionKeyAddress": "0x123…",
  "keyRef": "m/44'\''/60'\''/0'\''/0/787718449", "validUntil": 1825512345,
  "policySnapshot": { "…": "…" }
}'
# {"ok":true,"recorded":{"keyRef":"m/44'/60'/0'/0/787718449","permissionId":"0x9ab4cdef"}}
# 重複提交（同一個 keyRef 再送一次）：
# {"ok":true,"recorded":{"…":"…"},"duplicate":true}
```

寫入的是一列**新的** `session_keys`（`permissions` = `policySnapshot`，`expires_at` = `validUntil`，
`status = 'active'`），SQL 是 `insert … on conflict (key_ref) do nothing`：

- **舊的那一列一個字都不動**：舊權限在鏈上仍然有效到它自己的 `expires_at`，改它的 status 會讓 DB 說一件
  鏈上不成立的事。
- 重複提交不是錯誤：`on conflict do nothing` 之後 `returning` 是空的，回應帶 `duplicate: true`，列的數量
  不變。
- 同一個 `keyRef` 已屬於**別的** portfolio 時回 409 `KEY_REF_CONFLICT`（那不是重複提交，是兩個 portfolio
  搶同一把 key）。
- 錯誤：401 `UNAUTHORIZED`；404 `NOT_FOUND`；403 `FORBIDDEN`；400 `INVALID_RENEWAL`（缺 `keyRef`／
  `permissionId`、`validUntil` 不在 uint48 內、`policySnapshot` 不是物件）、`INVALID_ID`、`INVALID_JSON`。

### 前端拿到 `renewal-params` 之後還缺什麼

缺兩樣，而且**全部刻意放在前端**：`ownerAddress` 的 **sudo 簽章者**（後端沒有使用者的 owner 私鑰，
也不該有）、以及 **gas 參數**（`maxFeePerGas`／`maxPriorityFeePerGas`，前端讀鏈現況）。UserOp 的
`sender` 是 `accountAddress`、`callData` 由 `initConfig` 那兩筆 call 組成 —— 這些都在前端組，後端不碰。

**送 bundler 的傳輸層是後端的 `POST /bundler`**，不是前端自己連 alto：回應裡的 `bundlerUrl` 只是
「後端會打哪裡」的資訊，前端不拿它發請求（原因見下一節）。

## CORS

瀏覽器從別的 origin（vite dev 的 `http://localhost:5173`）打這支 API 時，preflight 由
`src/server.ts` 回答：

- 允許的 origin 來自 `CORS_ALLOWED_ORIGINS`（逗號分隔的**完整 origin**；未設定 = 上面那組 dev 預設）。
- `OPTIONS` → `204`，帶 `Access-Control-Allow-Methods`（`GET, POST, OPTIONS`）、
  `Access-Control-Allow-Headers`（`authorization, content-type`）、`Access-Control-Max-Age`（600）、
  `Access-Control-Allow-Origin`（**回具體 origin**）與 `Access-Control-Allow-Credentials: true`。
- 每個回應（含 401／404／405）都帶 `Access-Control-Allow-Origin` 與 `Vary: Origin`：同一條 URL 會因為
  Origin 不同而回應不同標頭，快取必須按 Origin 分開。
- **不在清單裡的 origin 不會拿到任何 CORS 標頭**（讓瀏覽器自己擋），但請求照常處理完 —— CORS 是瀏覽器的
  規則，不是認證；能不能存取由 `Authorization` 決定。
- 刻意不支援 `*`：請求帶 `Authorization`，而 `*` 不能與 credentials 併用。

## bundler relay（`POST /bundler`）

### 為什麼需要

**alto v1.2.5 完全沒有 CORS 支援**：`--help` 沒有相關選項，`OPTIONS` 請求回 404 且回應不帶任何
`access-control-*` 標頭（v1.2.8 才有 `enable-cors`，但它對 EntryPoint v0.7 的 SafeValidator 是壞的）。
所以瀏覽器直連 bundler 一律被 preflight 擋掉：

```
Access to fetch at 'http://127.0.0.1:3001/' from origin 'http://localhost:5173'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header
```

**這不是 dev 問題 —— 生產環境一樣。** 瀏覽器永遠無法直連 bundler，所以 UserOp 只能由這支 API 代送。
這支 API 自己已經有 CORS（上一節），前端只需要一個 same-origin（或已列入允許清單）的 `/bundler`。

### 契約

```bash
curl -s -X POST localhost:8080/bundler   -H "authorization: Bearer $TOKEN" -H 'content-type: application/json'   -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# {"jsonrpc":"2.0","id":1,"result":"0x38"}
```

- 請求 body **就是** JSON-RPC 信封（`{jsonrpc, id, method, params}`），後端**原樣轉發**收到的 bytes
  （不重新序列化），到 `BUNDLER_URL`。
- 回應也是**上游的 status 與原始 bytes**，含 `result` 或 `error`。**JSON-RPC 的錯誤形狀不改寫**——
  前端要靠 `{code, message, data}` 的原文診斷 AA 錯誤，重新包一層等於把唯一有用的線索丟掉。
- 需要 `Authorization: Bearer <token>`（順序與其他寫入路由一致：先驗 token，再讀 body）。
- 上游 timeout 30 秒。

### 方法白名單

只有這六個會被轉發，其餘一律 `403` 且**不轉發**（檢查在 `fetch` 之前）：

```
eth_sendUserOperation   eth_estimateUserOperationGas   eth_getUserOperationReceipt
eth_getUserOperationByHash   eth_supportedEntryPoints   eth_chainId
```

是**白名單**而不是黑名單：這支 relay 帶著使用者的 session token，能碰到 bundler 就等於能代替使用者發
UserOp；黑名單永遠會漏一個方法，白名單漏掉的代價只是一個 403。

### 錯誤碼

| 情況 | status | code |
| --- | --- | --- |
| 沒帶／帶錯 token | 401 | `UNAUTHORIZED` |
| body 不是合法 JSON、或不是物件 | 400 | `INVALID_JSON` |
| `method` 不在白名單、或沒有 `method` | **403** | `BUNDLER_METHOD_NOT_ALLOWED` |
| 上游連不上／timeout | **502** | `BUNDLER_UNAVAILABLE` |

502 的訊息帶上游位址（例：`bundler http://127.0.0.1:3001/ 無法連上（eth_chainId，timeout 30000ms）：…`），
但 URL 的 userinfo 會被剝掉——bundler 的 API key 常常就嵌在那裡，印出去等於寫進 log 與瀏覽器。
這條路徑不碰任何私鑰，回應裡也不會出現 `0x` + 64 hex 這種東西。

## Migration

- SQL 在 **`../db/migrations`**（`db/` 必須與 `backend/` 並排 checkout）。路徑由 `src/db.ts` 以
  `import.meta.url` 解析，`src/`（tsx）與 `dist/`（tsc）都指向同一個資料夾。
- 啟動時與 `bun run migrate` 都會跑：依檔名排序、每個檔案一個交易、`schema_migrations` 記錄
  filename + sha256、已套用就跳過、已套用檔案被改動則報錯。
- `pg_advisory_lock` 避免多個 instance 同時 migrate。
- 檔案內不要寫 `BEGIN`/`COMMIT`，也不要用 `CREATE INDEX CONCURRENTLY`。細節見 [`../db/README.md`](../db/README.md)。
- 目前兩個檔案：`0001_init.sql`（初始 schema）、`0002_normalize_provider.sql`（既有 `provider` 轉小寫，
  並加上 `strategies_provider_lowercase` CHECK，之後插入／更新都只能是小寫）。

## 設計取捨

- **config / pool 延遲載入**：`getConfig()`、`getPool()` 在第一次使用時才初始化，所以測試可以 import
  `strategies.ts` 而不需要 `DATABASE_URL`；同時 `DATABASE_URL` 仍會在啟動時 fail fast。
- **id 轉型**：`bigserial` 經 `pg` 回來是字串；mapper 明確 `Number()` 成 number（遠低於 2^53），
  `numeric` 欄位則維持字串，避免精度流失。
- **版本號配置**：`max(version)+1` + PK `(strategy_id, version)`。併發發布時靠唯一鍵衝突重試（最多 3 次），
  不需要額外鎖。
- **jsonb 不另開表**：allocation／schedule 是「版本的一份快照」，用 jsonb 保留原樣；形狀由 DB CHECK
  ＋ 應用層校驗兩道把關。
- **路由依賴注入**：`createServer(deps)` 的 deps 是 `Partial<ServerDeps>`（`createStrategy`、`publishVersion`），
  讓路由層測試（201／401／403／404／405）不需要 DB；正式啟動用預設 deps，跑真正的實作。
- **auth 用記憶體 store ＋ SIWE**：nonce／session 都是 process 內的 Map，訊息是標準 EIP-4361，
  驗簽用 `parseSiweMessage` ＋ `recoverMessageAddress`，不引入 JWT 或 session 資料表。好處是零額外基礎設施、
  auth 測試不必連 DB；代價是重啟後 token 全失效、不能水平擴展——單實例 v1 成立，多實例要換共享 store（TODO）。
- **SIWE 訊息由前端組**：`/auth/nonce` 只回欄位，地址由錢包自己填。若後端代填一個示範地址，前端就得重組
  訊息，等於多一份可能不同步的字串樣板；而 `createSiweMessage` 本來就是 viem 的公開 API。
- **不用 `verifySiweMessage`**：它需要 `publicClient`／RPC（合約錢包走 ERC-6492），而這一刀不保證有
  `RPC_URL`；EOA + `recoverMessageAddress` 對目前的使用者足夠，合約錢包列在 TODO。
- **provider 一律小寫**：寫入時 `validateCreateStrategyInput` 轉小寫，DB 再加
  `check (provider = lower(provider))`（0002）當第二道；查詢參數也先轉小寫再精確比對，走得到索引。
- **provider 由 session 推導**：`createStrategy(body, provider)`、`publishVersion(id, body, provider)` 的
  provider 是參數，不採信 body；`publishVersion` 先讀策略列比對 owner 再寫入，不符回 403。

## TODO（後續硬化）

1. 合約錢包（EIP-1271／ERC-6492）：現在只認 EOA 的 `recoverMessageAddress`；接 `RPC_URL` 後改用 viem
   `verifySiweMessage`，讓 smart account 也能登入。
2. Session／nonce 共享 store：in-memory Map 只支援單實例；多實例前換 Redis（或 Postgres），處理 TTL 與併發。
3. CORS、rate limit、request id（`correlation_id` 已有欄位）、body size 以外的防護。
4. `GET /strategies/:id` 要不要把 private 策略也公開？目前是；已有 auth，可據此收斂可見性。
5. operations／positions／performance 的讀寫 API（schema 已就緒，尚無程式）。
6. 錯誤回應加上 `details`（哪個 asset 出錯），方便 web app 顯示。
7. 用 OpenAPI 描述 API；現在 README 是唯一契約。
8. `portfolios.version` 的複合 FK（見 `db/README.md` 的已知缺口）。
