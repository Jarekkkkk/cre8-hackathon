# deployments

- `fork.json` 是**權威部署地址**，記錄目前 anvil fork（chainId 56）上真正存在的合約。
- 內容由 `broadcast/DeployAtp.s.sol/56/run-latest.json` 對照鏈上 `eth_getCode` 交叉驗證後產生；正常產生器是 `scripts/deploy-fork.sh`（它會重啟 fork，跑之前先確認可以清掉現有狀態）。
- `fork-state.json` 是同一時間點的可執行狀態快照（owner / version / enrollment / 塊高 / 餘額 / Kernel 基建），供整合驗證當基準線。
- **若 anvil fork 重啟，這兩份檔案必須重新產生，不可手改。**

## anvil fork 的保存期限與刷新（重要）

本機 8545 的 anvil 是**對於上游 BSC RPC 的 fork**，它只釘住「啟動當下」的上游塊號，
而 `bsc-rpc.publicnode.com` 只保留約 **75 分鐘**的歷史狀態窗口（約 10000 塊 × 0.45 秒/塊）。
超過窗口後，凡是需要回上游補資料的查詢——也就是 dump 裡沒有的**冷位址**——就會收到 403：

```
Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode
```

已 dump 的 9 個合約不受影響，所以症狀是「合約都還在、但查一個新地址就爆」，
`verify-kernel-enroll.ts` 的 R1a 檢查會因此失敗。

### 刷新方式

```bash
bash backend/scripts/refresh-anvil.sh
```

腳本會自動 **先 dump 現有狀態（保留所有新部署）→ 重啟 anvil → loadState → 驗證三項**，
並在結尾印出「新頭塊 / 9 合約驗證摘要 / 下次建議刷新時間（現在 + 55 分鐘）」。
dump 存到 `spike/anvil/state-dump-<unix時間>.json`，只保留最近 3 份。

- **約每 55 分鐘跑一次**（上游窗口 75 分鐘，留 20 分鐘餘裕），因此這是一個**需要有人定期執行**的維運動作。
- 可安全重複執行；沒有 anvil 在跑時會沿用最新一份 dump。
- 任何一步失敗都會以非 0 結束並印出原因；若 state 沒載入成功，腳本會**關掉新 anvil**，
  不留下「合約全空卻看似正常」的 fork。
- 可調參數：`ANVIL_PORT`（預設 8545）、`BSC_RPC_URL`（預設 publicnode）、`FOUNDRY_BIN`。

### 為什麼不選其他兩種設定

| 設定 | 結果 | 為什麼不用 |
|---|---|---|
| **A（採用）** `--fork-url` 不給 `--fork-block-number` + loadState | 冷查詢正常、Router 讀得到 | 唯一可行；代價是約 75 分鐘要刷新一次 |
| 無 fork（純本地 anvil） | 永不 403，但 PancakeSwap Router 等**真實 BSC 合約全部讀成 `0x`** | **靜默的錯資料**——不會報錯，只會讓池子／bStock 變空，比 403 難查得多 |
| bnbchain 當上游 | 歷史窗口僅約 **43–58 秒** | 開機沒多久就廢，實務上不可用 |

另外**不要給 `--fork-block-number`**：指定一個較舊的塊號會讓 anvil 一開機就撞 403
（連抓 dev account 都可能失敗而直接退出）。
