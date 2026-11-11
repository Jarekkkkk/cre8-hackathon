# cre8-atp-db

CRE8 ATP 的鏈下資料庫 schema（Postgres 15+）。獨立 repo，只放 migration 與說明；
執行 migration 的程式在隔壁的 [`backend/`](../backend)。

## 檔案

| 檔 | 說明 |
| --- | --- |
| `migrations/0001_init.sql` | 初始 schema：策略／版本、投組、smart account、session key、operations、 positions、performance |
| `migrations/0002_normalize_provider.sql` | `strategies.provider` 既有資料轉小寫，並加 `strategies_provider_lowercase` CHECK（未來只收小寫） |
| `migrations/0004_enrollment_intents.sql` | 新表 `enrollment_intents`：enroll 在**任何鏈上動作之前**釘死 timestamp policy 的 `valid_until`，重試讀回同一個值，避免算出第二個帳戶地址 |
| `migrations/0005_positions_snapshot_key.sql` | `positions_snapshots` 補上 `UNIQUE (portfolio_id, asset, block)`（先刪同組重複列，保留最新一列）＋ 價格出處 `price_source`／`priced_at` |
| `migrations/0006_bstock_tokens.sql` | 新表 `bstock_tokens`：bStock 標的白名單（沒有官方 token list，必須自建），種入 4 個已查證代幣 |
| `migrations/0007_priceable_assets.sql` | `bstock_tokens` 改名為 `priceable_assets`（約束與索引一併改名）＋ `is_numeraire` 欄位（numeraire 不得有池）＋ 種入 `USDT`（numeraire）與 `WBNB`（fee 500 的 USDT 池） |
| `migrations/0008_snapshot_header.sql` | 新表 `portfolio_snapshots`：快照表頭，空倉也一定有一列；`complete = false` 時漂移欄位由 CHECK 綁成 0/false |
| `migrations/0009_holding_scan_cursor.sql` | 新表 `portfolio_scan_cursors`：持有掃描游標（`start_block`／`last_scanned_block`）＋ `portfolio_snapshots` 兩個誠實欄位 `unknown_token_count`／`universe_complete` |
| `migrations/0010_holding_candidates.sql` | 新表 `portfolio_holding_candidates`：**曾轉入過的宇宙外代幣**（每個 portfolio 每個 address 一列）。存在的理由是一次性偵測會讓 bug 延後一輪——每一輪都要對這張表的全部列重讀 `balanceOf` |
| `migrations/0012_scheduler.sql` | `portfolios` 加排程時間戳（`next_run_at`／`last_checked_at`／`last_rebalance_at`）＋ `schedule_state` 的 CHECK ＋ `(schedule_state, next_run_at)` 索引；`operations` 補生命週期欄位（`tx_hash`／`user_op_hash`／`attempts`／`last_error`）＋ `type`／`state`／`attempts` 的 CHECK |
| `migrations/0013_scheduler_alerts.sql` | 新表 `scheduler_alerts`：排程器告警（`portfolio_repeatedly_failing`／`session_key_expiring`／`gas_low`）＋ `(kind, coalesce(portfolio_id, -1)) WHERE resolved_at IS NULL` 的部分唯一索引（同一個問題同時只有**一列**未解決）＋ `(resolved_at, severity)` 索引（`/health` 每輪都問） |
| `migrations/` | 之後的變更一律新增檔案（`0003_xxx.sql`…），不改已套用的檔案 |

## 執行 migration

正式路徑是 backend 的 `migrate()`：**依檔名排序**執行 `migrations/*.sql`，每個檔案包在一個
交易裡，成功後把檔名 + sha256 寫進 `schema_migrations`。已套用過的檔案會跳過；若檔案內容
在套用後被改動（checksum 不符）會直接報錯，不會靜默重跑。

```bash
cd ../backend
cp .env.example .env      # 填入 DATABASE_URL
npm install
npm run migrate           # 只跑 migration（不啟 server）
npm run dev               # 啟動時也會先跑 migrate()
```

手動用 psql 只建議在「還沒有 schema_migrations 記錄的新庫」或除錯時使用。若手動套用，
必須自己補記錄，否則下一次 backend 啟動會重跑 0001：

```bash
cd db
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_init.sql

# 讓 backend 知道這個檔案已套用（checksum 必須與檔案一致）
psql "$DATABASE_URL" -c "create table if not exists schema_migrations (
  filename text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);"
psql "$DATABASE_URL" -c "insert into schema_migrations (filename, checksum)
  values ('0001_init.sql', '$(shasum -a 256 migrations/0001_init.sql | cut -d' ' -f1)');"
```

注意事項：

- migration 檔內**不要**寫 `BEGIN`/`COMMIT`（runner 已經包交易），也不要用
  `CREATE INDEX CONCURRENTLY`（不能在交易內執行）。
- `schema_migrations` 由 backend 建立，不屬於任何一個 migration 檔。
- migration 只往前跑，沒有 down migration；復原方式是用備份或另寫補救 migration。

## Schema 概觀

```
strategies 1─n strategy_versions      （版本 append-only，PK = (strategy_id, version)）
strategies 1─n portfolios             （portfolio 釘住某個 version）
portfolios 1─n smart_accounts         （UNIQUE(chain_id, address)）
portfolios 1─n session_keys           （只存 KMS 參照，見下）
portfolios 1─n operations             （idempotency_key UNIQUE）
portfolios 1─n positions_snapshots    （每 block 每資產一列，UNIQUE(portfolio_id, asset, block)）
portfolios 1─n portfolio_snapshots    （每 block 一列表頭，PK (portfolio_id, block)；空倉也有）
portfolios 1─1 portfolio_scan_cursors （持有掃描游標：轉入日誌連續掃到哪個塊）
portfolios 1─n portfolio_holding_candidates（曾轉入過的宇宙外代幣：看過就永遠繼續看）
strategies 1─n performance            （portfolio_id 可 NULL = 策略層級）
priceable_assets                      （獨立白名單，沒有任何 FK：先有標的才有持倉）
```

| 表 | 重點欄位 | 約束／索引 |
| --- | --- | --- |
| `strategies` | `provider`、`name`、`swap_fee_bps` | `swap_fee_bps` 0–300（對齊鏈上 `MAX_SWAP_FEE_BPS`）；`portfolios(strategy_id)` |
| `strategy_versions` | `allocation jsonb`、`schedule jsonb`、`active_at` | PK `(strategy_id, version)`、`version > 0`、jsonb 形狀檢查 |
| `portfolios` | `user_id`、`strategy_id`、`version`、`schedule_state`、`next_run_at`、`last_checked_at`、`last_rebalance_at` | `portfolios(strategy_id)`；策略被投組引用時不可刪（`ON DELETE RESTRICT`）；`schedule_state` ∈ {idle, active, paused}（0012）；`(schedule_state, next_run_at)` 索引（0012：排程器每輪都問「誰到期了」） |
| `smart_accounts` | `chain_id`、`address`、`owner`、`account_type` | `UNIQUE(chain_id, address)`、address 必須是小寫 0x+40 hex；`smart_accounts(portfolio_id)` |
| `session_keys` | `key_ref`、`permissions`、`expires_at`、`status` | `key_ref UNIQUE`；`revoked_at` 非空時 `status` 必須是 `revoked`；`session_keys(portfolio_id)` |
| `operations` | `type`、`state`、`idempotency_key`、`payload_hash`、`tx_hash`、`user_op_hash`、`attempts`、`last_error` | `idempotency_key UNIQUE`；`operations(portfolio_id, state)`；`type` ∈ {rebalance, enroll, revoke_session_key, withdraw}、`state` ∈ {pending, submitted, confirmed, failed, reverted}、`attempts >= 0`（0012 起） |
| `positions_snapshots` | `asset`、`amount`、`usd_value`、`block`、`price_source`、`priced_at` | `numeric(38,18)`；`UNIQUE(portfolio_id, asset, block)`（同一 block 重跑不會多一列，可直接 `on conflict`）；`(portfolio_id, block DESC)` 取最新快照；`usd_value`、`price_source`、`priced_at` 三者要嘛全 NULL 要嘛全有值 |
| `performance` | `period`、`twr`、`since` | `numeric(18,8)`；`(strategy_id, period, since DESC)` |
| `enrollment_intents` | `user_id`、`strategy_id`、`chain_id`、`valid_until` | PK `(user_id, strategy_id, chain_id)`；`user_id` 必須小寫、`valid_until > 0`；鏈上動作前釘死，重試讀回同一個值（否則會出現無法回收的孤兒帳戶） |
| `portfolio_snapshots` | `block`、`native_balance_wei`、`total_usd_e8`、`gross_drift_bps`、`max_abs_delta_bps`、`threshold_bps`、`needs_rebalance`、`complete`、`unpriced_count`、`pinned_version`、`unknown_token_count`、`universe_complete` | PK `(portfolio_id, block)`（同一個 block 重跑是 UPDATE，不是第二份快照）；bps 一律 0–10000、count ≥ 0、`pinned_version` 為 NULL 或 ≥ 1；`complete = false` 時 `gross_drift_bps`／`max_abs_delta_bps`／`needs_rebalance` 必須是 0／0／false；`unknown_token_count > 0` 時 `complete` 必須是 false |
| `priceable_assets` | `address`、`symbol`、`decimals`、`usdt_pool`、`pool_fee`、`is_numeraire`、`enabled` | PK `address`（小寫 0x+40 hex）、`symbol` UNIQUE、`decimals` 1–36、`pool_fee` ∈ {100,500,2500,10000}、`usdt_pool` 與 `pool_fee` 必須成對、`is_numeraire` 為 true 時兩者都必須是 NULL；沒有 FK |
| `portfolio_scan_cursors` | `start_block`、`last_scanned_block`、`updated_at` | PK `portfolio_id`（FK，`on delete cascade`）；`start_block >= 0`、`last_scanned_block >= start_block - 1`（`start_block - 1` = 一塊都還沒掃） |
| `portfolio_holding_candidates` | `asset`、`first_seen_block`、`last_balance_wei`、`last_checked_at` | PK `(portfolio_id, asset)`（FK，`on delete cascade`）；`asset` 必須是小寫 0x+40 hex、`first_seen_block >= 0`、`last_balance_wei >= 0`（`numeric(78,0)`：uint256 全範圍） |
| `scheduler_alerts` | `kind`、`severity`、`portfolio_id`、`detail`、`occurrences`、`first_seen_at`、`last_seen_at`、`resolved_at` | `kind` ∈ {portfolio_repeatedly_failing, session_key_expiring, gas_low}、`severity` ∈ {warn, critical}、`occurrences > 0`；**部分唯一索引** `(kind, coalesce(portfolio_id, -1)) WHERE resolved_at IS NULL`：同一個問題未解決時只有一列（`coalesce` 是因為 UNIQUE 對 NULL 是「每個都不同」）；`(resolved_at, severity)` 給 `/health` 與 `--alerts`；`portfolio_id` FK `on delete cascade`；已解決的列**不刪**（那是「什麼時候好的」的唯一證據） |

### priceable_assets：為什麼白名單在 DB 而不在程式

bStock（代幣化美股）**沒有官方 token list**：發行方只有 HTML 頁面，沒有可程式化讀取的 JSON，
鏈上也找不到名錄。所以「哪個 address 是 bStock、symbol 是什麼、小數幾位、對 USDT 的池在哪」
只能自己維護。做成資料表而不是程式常數，是因為上新 ticker 應該是一筆 `INSERT`，
不必改程式、跑測試、重新部署。

這張表原本叫 `bstock_tokens`，0007 改名成 `priceable_assets`：它現在同時放**定價幣**
（USDT、WBNB），因為「這個地址有沒有價格、價格從哪來」對 bStock 與對定價幣是同一個問題。
一張叫 bstock 的表裡躺著 WBNB，會讓下一個讀者把它誤讀成「不是目標資產」。

- `usdt_pool` + `pool_fee` 成對：有池才能報價／換回 USDT。`NULL` 代表**還沒查證到池**，
  不是「沒有池」——不要填一個沒驗證過的地址，報價會讀到錯的池。
- `is_numeraire = true`：報價單位本身（USDT），**1 顆永遠 = 1e8**，是定義不是報價，所以不需要池
  ——約束 `priceable_assets_numeraire_has_no_pool` 禁止它同時有 `usdt_pool`/`pool_fee`（留著會讓人
  以為它要靠 TWAP 報價）。少了這一欄，USDT 只能被當成「無池 → 無價」，而它正是 portfolio 5 的
  目標之一：帳戶一持有 USDT，planner 就會因為「持有但無價」拒算漂移，索引器對唯一存在的策略失效。
- 下架請設 `enabled = false`，不要 `DELETE`：舊快照還要靠這張表把 address 對回 symbol。
- 目前種入 6 個已查證的代幣（全部 18 位小數）：`NVDAB` 有 USDT 池（PancakeSwap V3，fee 2500）；
  `WBNB` 用 WBNB/USDT 池（fee 500，與鏈上 oracle 同一個池，交叉驗證 0 ppm 一致）；
  `USDT` 是 numeraire（無池）；`TSLAB`／`MUB`／`CRCLB` 的池尚未查證，`usdt_pool` 為 `NULL`。

### portfolio_snapshots：為什麼快照需要一列表頭

`positions_snapshots` 是明細，而空倉時它**一列都不寫**（沒有資產就沒有明細，這在資料上正確）。
於是「剛才檢查過、確認帳戶什麼都沒有」與「索引器三小時前就死了」在下游長得一模一樣：兩邊都查不到列。
表頭每 `(portfolio_id, block)` 一列、空倉照樣寫，讓「跑過且是空的」變成看得出來的事；它同時記下
`total_usd_e8`、`gross_drift_bps`、`max_abs_delta_bps`、`threshold_bps`、`needs_rebalance` 與
`pinned_version`，所以「portfolio 5 上次什麼時候檢查過、當時漂移多少、該不該動」不必重跑就算得出來。

- 同一個 block 重跑是 **UPDATE**（`on conflict (portfolio_id, block)`）：同一份觀測不該有兩個總額，
  `created_at` 也保留第一次寫入的時間。要問「上次檢查」請取最大的 `block` 那一列。
- `complete = false` = 這一輪的漂移不可信（持有無價資產，或 DB 與鏈上的 allocation 不一致）。
  此時 `gross_drift_bps`/`max_abs_delta_bps` 一定是 0、`needs_rebalance` 一定是 false，
  由 `portfolio_snapshots_incomplete_has_no_drift` 綁住——因為 0/false 單獨看像「不必動」，
  而它其實是「不能判斷」。**下游判讀前必須先看 `complete`。**
- `total_usd_e8` 在 `complete = false` 時是「已定價部位的部分總額」，不是投組總值。
- `native_balance_wei` 只是 gas 的錢，不進漂移（見 `backend/src/positions.ts` 檔頭）。
- `created_at` 不在 `do update` 裡：同一個 block 是同一份觀測，刷新它會讓「這份觀測什麼時候開始的」消失。

### complete 與 universe_complete：兩個不同的問題（0009）

`priceable_assets` 定義的是**「什麼有價格」**，不是**「帳戶擁有什麼」**。0009 之前索引器的讀取宇宙
就是「白名單 ∪ 目標資產」，於是使用者帳戶收到一顆不在白名單的 ERC-20（空投、別人轉錯、新上架的幣）
時，那顆代幣**根本不被讀**：`total_usd_e8` 低估 → 每個已知資產的 `current_bps` 偏高 → 漂移算錯，
而 `complete` 仍然是 true。一份「看起來完全合理」的錯誤報告會送進 keeper。
**持有但未觀察 ≠ 持有 0。**

所以表頭的兩個布林回答兩件不同的事，keeper **必須兩個都 true** 才能相信漂移：

| 欄位 | 回答的問題 | false 的意思 |
| --- | --- | --- |
| `complete` | 「我們**看到的**資產都有價嗎？」 | 已知有問題：持有無價資產／未知代幣，或 DB 與鏈上 allocation 不一致 → 漂移拒算 |
| `universe_complete` | 「我們**確定看到了**帳戶擁有的全部資產嗎？」 | 還沒確認：游標尚未覆蓋部署塊，或某次 `eth_getLogs` 失敗 → 漂移照算，但它建立在可能缺項的宇宙上 |

- `universe_complete = false` **不算 blocked**。「還不知道」與「知道有問題」是兩件事：前者要在表頭
  明確標示（CLI 也要印），後者（`unknown_token_count > 0`）才擋漂移。兩者都 false 的列是正常狀態。
- 唯一的證據是**游標**：`start_block <= 部署塊`，而且從 `start_block` 到 head 之間每一塊的
  `eth_getLogs` 都成功過。掃描失敗時 `last_scanned_block` 不前進——一個洞會讓某筆轉入永遠不被看到。
- 部署塊用 `eth_getCode` 二分搜尋取得（鏈上狀態才是權威；`smart_accounts.created_at` 是鏈下時間戳，
  換算成塊號要先有時間→塊號索引，而那正好是最讀不到的東西）。取不到就是取不到：`universe_complete`
  留 false，不猜。
- 本機 anvil fork 上讀不到舊塊（`docs/pitfalls §2.1` 的 403 archive），所以游標只能從「看得見的塊」
  開始，`universe_complete` 在本機永遠是 false。那不是 bug，是那個環境的事實——它正是這一欄存在的理由。

### portfolio_holding_candidates：為什麼偵測本身要落地（0010）

0009 加了游標與 `universe_complete`，但偵測仍然是**一次性**的：每一輪只對「這一輪日誌裡看到的候選」
讀 `balanceOf`，然後把游標往前推。游標一前進，舊視窗就再也看不到，於是：

| 輪次 | 日誌視窗 | `unknown_token_count` | `universe_complete` | keeper |
| --- | --- | --- | --- | --- |
| 第 N 輪 | CAKE 在 B 塊轉入 | 1、`complete=false` | true | 不信 ✅ |
| 第 N+1 輪 | 沒有新日誌 | 0 | true | **又開始相信一份漏掉 CAKE 的宇宙** ❌ |

0009 只是把這個 bug **延後一輪**。修法是把「曾見過的候選」落地，讓偵測的輸入不再只是這一輪的視窗：

- 日誌看到新的宇宙外代幣 → `insert ... on conflict do nothing`（`first_seen_block` 只記第一次）。
- **每一輪**都對 `portfolio_holding_candidates` 的**全部列**重讀 `balanceOf`，不論這一輪有沒有新日誌。
- 餘額 > 0 → 進 `unknownHoldings` → `blocked` + `complete = false`（表頭 `unknown_token_count > 0`）。
- 餘額 = 0 → **不刪列**（它可能再度有餘額，而屆時未必有日誌），只是不算持倉。
- 讀不到 `balanceOf` → 保留舊的 `last_balance_wei`，不寫 0：「讀不到」與「0」不是同一件事。
- 候選重讀與日誌掃描**解耦**：這一輪 `eth_getLogs` 失敗（游標不動、`universe_complete = false`）時，
  已存下來的候選**仍然**要被重讀，否則「掃描失敗 → 忘記已知的未知持倉」會變成同一個 bug 的另一個版本。

結果：CAKE 一旦被發現，**blocked 會持續到餘額歸零**，不會因為「這輪沒新日誌」而消失。

### portfolios 的三個時間戳：排程器怎麼回答「誰現在該跑」（0012）

`schema_migrations` 之前的 `portfolios` 只有一個 `schedule_state`（而且沒有 CHECK），沒有任何時間戳——
排程器沒有任何欄位可以回答「這個 portfolio 上次什麼時候檢查過、下一次什麼時候該跑」。三個欄位各自回答
一個問題，而且**語意不同，不要混用**：

| 欄位 | 回答的問題 | 誰會寫它 |
| --- | --- | --- |
| `next_run_at` | 「下一次**該被檢查**」的時間（不是「下一次該成交」） | 排程器**認領時**（`now + intervalSeconds`），不是執行完 |
| `last_checked_at` | 「最後一次真的看過它」的時間（blocked／noop 也算看過） | 排程器跑完那一個 portfolio 之後 |
| `last_rebalance_at` | 「最後一次**成功上鏈**再平衡」的時間 | 只有 `state = confirmed` 時 |

**`next_run_at` 為什麼要在執行之前就推進**（`backend/src/scheduler.ts` 的 `claimDuePortfolios`）：
`SELECT … FOR UPDATE SKIP LOCKED` 選出到期列的**同一個 transaction**裡就把 `next_run_at` 寫成
`now + intervalSeconds`。若等執行完才推進，一次 crash／逾時／`kill -9` 會讓同一個 portfolio 在下一輪
仍然「到期」→ 被重複認領 → **重複送一筆再平衡＝重複動錢**。寧可漏跑一次（下一輪會補），也不要重複跑：
漏跑只是延後，重複跑是不可逆的。所以這個欄位的語意是「已經排到下一輪了」，而**不是**「上一次跑完的時間」
——後者才是 `last_checked_at`。

`next_run_at is null` 的 active portfolio **視為立刻到期**（`next_run_at is null or next_run_at <= now()`），
所以新建立的 portfolio 不必任何額外寫入就會被撿到，不會被漏掉。相對地，非 interval 的排程
（`{kind:'cron'}`、缺排程、形狀不對）仍然會被認領並記成 `blocked`（不靜默跳過），但後推一個小時的退避：
留著 NULL 的話它們每輪都排最前面（`nulls first`），會把 `limit` 吃光、讓真正能跑的 portfolio 永遠輪不到。

`idle`／`paused` 一律不會被選到，即使 `next_run_at` 已經過期。

### operations：生命週期欄位與 idempotency_key（0012）

`operations` 從 0001 起就有 `idempotency_key UNIQUE`，但沒有地方記「那筆交易上鏈了沒、試過幾次、
為什麼失敗」。0012 補上 `tx_hash`／`user_op_hash`／`attempts`／`last_error`，並把
`type`／`state` 的值域凍結成 CHECK —— 因為排程器現在**依 `state` 決定要不要再送一筆**：

| `state` | 排程器的判讀 |
| --- | --- |
| `confirmed` | 同一組參數已上鏈成功 → **永不再送** |
| `pending`／`submitted` | 在途或結果未知 → **不重送**（結果未知時重送的代價是重複動錢） |
| `failed`／`reverted` | 上一次沒有成交 → 允許同一個 `idempotency_key` 重試，`attempts + 1` |

`idempotency_key` 用 `rebalance:{portfolioId}:{planHash}`，而 `planHash = keccak256(abi.encode(steps 的
tokenIn/tokenOut/amountIn/amountOutMin, deadline))`：同一組參數必然同一個 key，換了金額或 deadline 就是
另一個 key。打錯一個字在這一欄不再是「顯示錯誤」，而是「重複動錢」的入口，所以值域到此凍結。

⚠ **dry-run 不寫 `operations`**：`pending` 一列會讓真正的執行被自己的預演擋住（同一個 plan 的 key 必然
相同），那比少一列稽核紀錄嚴重得多。dry-run 只把 `planHash`／`idempotency_key` 印出來。

### scheduler_alerts：為什麼告警必須落地（0013）

2026-11 的三次長跑（各約 2.5 小時）實際結果：34 輪只有 1 輪成功、17 輪只有 1 輪成功、1 輪 ——
**20+ 輪連續失敗，沒有任何東西通知任何人**，是靠人手動翻 log 才發現的。排程器的價值建立在「無人
值守」上，而無人值守的前提是「壞掉時有人會知道」。只寫 stdout 的 log 撐不起這件事：行程重啟就沒了、
輪替就沒了，而且沒有人會去讀一個沒人叫你看的檔案。

所以「有問題」是一個**查詢得到的狀態**，不是一行輸出。三個出口都只讀這張表：

| 出口 | 誰看 | 行為 |
| --- | --- | --- |
| `GET /health` | 監控／負載平衡器 | 有 critical 未解決 → `status: "degraded"`，**HTTP 仍是 200**（503 只給 Postgres 掛掉） |
| 排程器每輪的 stdout | 正在看 log 的人 | 每個警示一行 `[ALERT][critical] …`；沒有警示也會印一行（沉默與沒跑一模一樣） |
| `scripts/scheduler.ts --alerts` | 被叫來處理的人 | 列出目前未解決的警示，不跑任何一輪 |

**為什麼是 upsert 一列而不是每次插一列**：同一個問題每 60 秒被偵測到一次，一天就是 1440 列 ——
那不是告警，是一份噪音 log。未解決時依 `(kind, portfolio_id)` 只有一列：再次偵測到 → `occurrences + 1`
並更新 `last_seen_at`／`detail`；條件消失 → `resolveAlerts` 寫 `resolved_at`。所以
「這個問題持續多久、被看到幾次」看 `first_seen_at`／`occurrences` 就有答案。

**為什麼是 `coalesce(portfolio_id, -1)`**：Postgres 的 UNIQUE 對 NULL 是「每個 NULL 都不同」，
`(kind, portfolio_id)` 會讓 portfolio 無關的警示重複插入。因此 `recordAlerts` 的
`ON CONFLICT (kind, (coalesce(portfolio_id, -1))) WHERE resolved_at IS NULL` **必須與索引逐字相同**
—— 推斷不到索引時 Postgres 是直接報錯，不是「去重失效」。

**為什麼已解決的列不刪**：它是「這件事曾經發生過、什麼時候好的」的唯一證據。刪掉就再也答不出
「上週那個連續失敗是幾點解除的」。

三個種類的判定與閾值（`ALERT_FAILING_OPS`／`ALERT_KEY_EXPIRY_DAYS`／`ALERT_MIN_OPS`）都在
`backend/src/alerts.ts`。⚠ 讀鏈失敗（RPC 掛）**不產生** `gas_low`：假 critical 會讓人開始忽略真的
critical。

### allocation / schedule 的 JSON 形狀

```jsonc
// strategy_versions.allocation：權重單位是 bps，總和必須剛好 10000
{ "assets": [ { "address": "0x…", "symbol": "AAPLB", "weightBps": 2500 } ] }

// strategy_versions.schedule：二選一
{ "kind": "interval", "intervalSeconds": 86400 }
{ "kind": "cron", "cron": "0 0 * * *" }
```

JSON 的語意由 `backend/src/strategies.ts` 驗證（權重總和、資產不重複、資產上限 16 個），
DB 只做輕量 shape check。鏈上 `AtpRegistry` 以 `bytes32 scheduleHash` 記錄排程，
這裡的 JSON 是它的來源。

## 安全邊界

- **session_keys 只存 `key_ref`（KMS 的金鑰參照），私鑰、助記詞、加密後的私鑰一律不進 DB。**
  表與欄位都有 `COMMENT` 說明；未來新增欄位前先問「這是不是金鑰材料」。
- 沒有資料庫層的 auth：`user_id`、`provider` 都是宣稱值，由 API 層（尚未實作）負責驗證。
- `payload_hash` 存 canonical payload 的 hash，讓 audit 可以事後重驗而不必保存原文。

## 已知缺口（給下一刀）

- `portfolios.version` 沒有複合 FK 到 `strategy_versions(strategy_id, version)`；打錯版本號要等
  keeper 執行才炸。加上複合 FK 會讓錯誤提早到 insert 時，但會綁死「投組只能釘已發布版本」。
- 0005 加的 `UNIQUE (portfolio_id, asset, block)` 在建約束前會**靜默刪掉**同組的重複列
  （保留 `ts` 最新的一列）。本機與正式庫當時都是 0 列，沒有真的刪到東西；但若某個環境早有
  重複，那些列在 migration 輸出裡看不到（runner 只回檔名）。
- `priceable_assets` 只有 6 個已查證資產，其餘上架標的要靠運維補；沒有「來源可信度」欄位之前，
  白名單的權威性全靠人工 review。
- `portfolio_snapshots` 與 `positions_snapshots` 沒有 FK 綁在一起，只有 `(portfolio_id, block)` 這個
  自然鍵：資料庫不強制「明細一定有一列表頭」。寫入端（`writeSnapshot`）是同一個 statement 寫兩者，
  但繞過它直接寫 `positions_snapshots` 就沒有這個保證。
- `operations.updated_at` 由應用程式維護，沒有 trigger（排程器的每一條 UPDATE 都自己寫 `now()`）。
- `operations` 沒有「同一組參數最多試幾次」的上限：`failed`／`reverted` 的列永遠允許重試。目前不會失控，
  因為 `planHash` 含塊時間推出來的 deadline，每一輪都會是新 key；但一個壞掉的 planner 會持續產生新列。
- `strategies.name` 沒有唯一性限制（同 provider 可有同名策略）。
- 尚未有 retention／partition 策略；`positions_snapshots` 與 `operations` 會持續長大。
