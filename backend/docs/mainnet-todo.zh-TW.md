# 主網上線前的待辦（2026-11）

依「什麼會先咬到我們」排序。狀態：`[x]` 已完成、`[ ]` 未做。

## 1. 排程器 supervisor `[x]`

- `scheduler_status` 表（migration 0018）：每輪寫心跳（`started_at` / `last_finished_at` /
  `rounds` / `dry_run` / `limit` / `threshold` / `last_summary` / `last_error` / `pid`）
- `/operator/overview` 回傳 `scheduler`；`/operator` 頁面顯示 alive / dry-run / LIVE / 上一輪計數
- **為什麼不從 `portfolios.last_checked_at` 推算**：所有投組都還沒到期時那個時間是舊的，
  看起來像排程器死了 —— 而「死掉」與「沒事做」是兩種完全不同的處置
- Railway 上以 `bun run scripts/scheduler.ts --loop --live --interval 60 --limit 20` 作為獨立 service；
  進程死掉由 Railway 重啟（`restartPolicyType: ON_FAILURE`）

## 2. Secrets 外移 `[ ]`

- `OPERATOR_PRIVATE_KEY`、`SESSION_KEY_MASTER_SEED`、`DATABASE_URL` 目前在 `backend/.env`
- 部署到 Railway 時改用它的 Variables（等同 secret manager），`.env` 不進版控（已在 `.gitignore`）
- 待辦：**seed 輪替程序**（換 seed 等於所有 session key 失效，需要一次全量 renew）

## 3. Alert 投遞 `[ ]`（使用者說先放 todo）

- 現在只有 `scheduler_alerts` 表 + `GET /health` + `--alerts` CLI
- 缺 email / Slack / pager。至少要有 critical 的主動通知，不然沒人會去看

## 4. registry owner 換 multisig / timelock `[ ]` — 延後到主網測試結束

- 現在 `AtpRegistry` owner 是單一 EOA（部署者 `0x70fc55f8…7c60c`）
- 合約層面：owner 可以 `setFee`、`registerStrategy`、`pause`

### 決策（2026-11，使用者裁定）

**先維持單一 EOA，等主網測試全部跑完再轉 Safe。** 理由：

* 測試階段會頻繁改設定（fee、策略註冊、pause），每次都要走 multisig 流程會拖垮迭代速度
* 轉移之後要再改回來很麻煩，而現在還沒有真實使用者資金
* 私鑰目前只存在 `backend/.env.mainnet`（chmod 600、gitignored），風險可控

### 轉移前必須記得的三件事

1. **轉移後 `setPaused` 這條緊急通道要還走得通** —— 如果 Safe 的簽名門檻設太高（例如 3/5 但只有 2 個 signer 在線），
   出事時反而停不下來。緊急暫停應該是低門檻（1/2 或 2/3），日常設定變更才是高門檻。
2. 轉移前先確認 `OPERATOR_PRIVATE_KEY`（部署者）不再需要任何 owner 權限，
   否則轉移後會出現「合約 owned by Safe，但某支腳本還假設 EOA 是 owner」的隱性失敗。
3. 轉移後跑一次 `preflight --strict` —— 它會檢查 registry owner 並在 `--strict` 下對單一 EOA 報 warn，
   轉移完成後那個 warn 應該消失（這也是這個檢查存在的理由）。

### 為什麼這條不能忘

單一 EOA 的 owner 等於「一把私鑰控制整個協議」。現在可以接受，是因為**還沒有真實使用者資金**並且
我們在密集測試。一旦開始對外，這條就是最高優先的風險項。

## 5. 真 BSC 部署驗證 + 第一筆小額真錢 `[ ]`

- `DeployAtp.s.sol` 已在 fork 上反覆驗證；主網要確認 pool fee tier / permit2 / universal router 位址
- 第一筆用最小金額（例如 20 USDT）走完 deposit → rebalance → withdraw，並對帳 gas

## 9. `V2_SWAP_EXACT_IN` 需要 executor 多一層授權 `[ ]`

| 項目 | 內容 |
|---|---|
| 現況 | `ROUTE_V2_ENABLED` 預設**關閉**（只走 V3） |
| 真實原因 | **不是**「Router 不支援這個指令」—— 見下方更正 |

### 更正：我先前的結論是錯的

我原本的結論是「Pancake 的 Universal Router 不實作 `V2_SWAP_EXACT_IN`」。實測推翻了它：

    ① 送 command 0x08 + 空 input
       → revert 0x3b99b53d（SliceOutOfBounds，calldata 解析失敗）
       若是「不認這個 command」，會回 0xd76a1e9e（InvalidCommandType）

    ② 送 command 0x08 + 格式正確的 input（USDT→DOGE，payerIsUser=true）
       → revert 0xd81b2f2e（Permit2 的 AllowanceExpired(0)）

② 是決定性的：Router **認得**這個 command，並且把 V2 的資金腿也走 **Permit2**。
錯的是「誰被授權」——那筆呼叫沒有任何授權，所以停在 Permit2 的額度檢查。

### 那我們的 executor 為什麼會 revert

executor 的 `_swap` 只做這兩件事：

    tokenIn.forceApprove(address(permit2), step.amountIn);
    permit2.approve(step.tokenIn, address(universalRouter), uint160(step.amountIn), deadline);

那是為 **V3 那條腿**準備的。V2 的 payer leg 需要的是另一組授權
（V2 路徑的 payer 不是 Permit2 的 spender，實際是哪個地址要用一次帶授權的真實呼叫確認）。
所以 `payerIsUser=true` 在 V2 上會因為授權不對而 revert —— 而 EntryPoint 的模擬只回了裸 `0x`。

### 要開啟 V2 必須做的事

1. 用一個**持有 USDT 且已完成各種可能授權**的位址，對 UR 送一次真實的 V2 command，
   看它在哪一層 revert（Permit2？V2 router 的 ERC20 allowance？）—— 這一步才知道要多授權給誰
2. 據此改 `AtpExecutor._swap`（合約變更）→ 重新部署 executor
3. 重新部署的代價：**每個使用者要重新 approve + 重新安裝 session key（各簽一次）**

### 結論

V2 的收益是 1.3%（DOGE 0.5 USDT 那筆），代價是全體使用者的遷移成本。
**現在維持 V3-only**；等「多種資產」真的需要 V2 深度時，再一次性做這個合約變更。

### 仍然成立的教訓

「allowlist 允許一個 command」只代表我們的合約不擋它。要確認下游能不能執行，
必須送一次**帶正確授權的真實呼叫** —— quoter 算得出數字與此無關。

---

|---|
| 現況 | `ROUTE_V2_ENABLED` 預設**關閉**，路由只走 V3 |
| 為什麼 | 打開後第一次真實執行就 revert 成裸 `0x`（`UserOperation reverted during simulation with reason: 0x.`）|

### 發生了什麼

我加了「V2 + V3 全候選比較」之後，DOGE 被選中走 **V2 直連**（quoter 用 pair 儲備算出來的數字最漂亮）。
但送出去後 UserOp 模擬直接 revert，**沒有任何 reason 字串**。

裸 `0x` revert 的典型形狀是「路由器不認這個 command」。我們 executor 的 allowlist 有 `0x08`
（`Cmd.V2_SWAP_EXACT_IN`）—— 那是照 Uniswap Universal Router 的文件寫的，
但 **Pancake 的 fork 未必實作它**，而我們從來沒有在主網真的送出過這個 command。

停用 V2 後同一個投組立刻成功：**5 筆 SwapExecuted**，DOGE 也買到了（走 V3 兩跳）。

### 怎麼驗證（下次要做的事）

不要靠猜，用 `eth_call` 直接對 Universal Router 送一筆 V2 command：

1. 找一個持有 USDT 的地址（測試錢包）
2. `USDT.approve(universalRouter, amount)`
3. `cast call universalRouter "execute(bytes,bytes[],uint256)" 0x08 [<V2 input>] <deadline> --from <測試錢包>`
4. 回 `0x` = 不支援；回正常 = 支援，這時才可以開 `ROUTE_V2_ENABLED=1`

### 教訓

**「A 的介面在 B 的 fork 上存在」不是事實，是假設。** allowlist 允許一個 command，
只代表我們的合約不會擋它，不代表下游實作了它。這種假設要用一次真實呼叫驗證，
而不是靠「quoter 算得出數字」—— quoter 是我們自己算的，跟 router 能不能執行無關。

---

## 8. bundler safe-mode（見上）

## 6. 文件進版控 `[x]`

- `backend/docs/pitfalls.zh-TW.md`（43 條踩坑記錄）
- `backend/docs/decisions.zh-TW.md`（35 條架構決策）

## 8. bundler 的 `safe-mode` 目前是關的 `[ ]` — 免費 RPC 不支援 tracing

| 項目 | 內容 |
|---|---|
| 現況 | Railway 的 alto 跑 `SAFE_MODE=false`（NodeReal 免費 RPC） |
| 為什麼 | alto 的 `safe-mode=true` 用 `debug_traceCall` 執行 ERC-7562 的儲存存取規則檢查 |
| 實測 | publicnode / bsc-dataseed / 1rpc / ankr / meowrpc / blastapi / blxrbdn 全部**不支援** `debug_traceCall`；drpc 支援但免費額度立刻被限流；NodeReal 免費層「not available at your level」 |

### 這個開關實際少了什麼

`safe-mode=false` 不強制 ERC-4337 的驗證規則（ERC-7562 的 opcode / 儲存存取白名單）。
後果：一個惡意或寫壞的 UserOp 可以做到嚴格 bundler 會拒絕的事。
**EntryPoint 本身仍然驗簽章、nonce、prefund** —— 少的是「bundle 前的規則檢查」。

### 為什麼現在可以接受

* 我們的 bundler **只服務自家後端**送出的 UserOp，不對外開放給第三方
* 主網目前只有測試資金

### 上線前必須做的事

1. 換一個支援 `debug_traceCall` 的**付費** RPC（NodeReal / QuickNode / Ankr 的付費層，
   或 drpc 付費方案）
2. 把 alto 的 `SAFE_MODE` 改回 `true` 並重新部署
3. 用一個**故意違規**的 UserOp 驗證它會被擋（偽造簽章應回 `AA23 reverted - 0x8baa579f`；
   這個案例在 fork 上已驗證過，見 `spike/alto/V125-VERDICT.md`）

---

## 7. 擴容：多使用者同時再平衡 `[ ]`

- 現況：`--limit 20`、**循序**處理，一輪約 40–80 秒；100 個訂閱者要 5 批
- 認領是交易式（`claimDuePortfolios` + 推進 `next_run_at`），所以**多進程並行是安全的**
- 待辦：決定「提高 limit」還是「多個 scheduler 進程」，並在 supervisor 裡把並行度變成設定
