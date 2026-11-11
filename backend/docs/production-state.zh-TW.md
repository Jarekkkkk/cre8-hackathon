# 生產環境現況（主網）

> 最後更新：2026-11-09

## 已上線

| 元件 | 位置 | 狀態 |
|---|---|---|
| **AtpRegistry** | `0xf429929c9fc89446c08fd4c201543b40d7d3d67a` | 主網，有 bytecode |
| **AtpExecutor** | `0x547764c2a6f789986f0f3e532c115ffc7e3ac9e7` | 主網，有 bytecode |
| **AtpMultiPoolOracle** | `0x6a31f0c5180e5d25accf5775da98e2404a46d869` | 主網 |
| Oracle WBNB/USDT | `0x7c7df82b4c27251db247af363f99e595d42a8d78` | 主網 |
| Oracle NVDAB/USDT | `0xebf5a243e79436b49dcfb8092968b161e323d873` | 主網 |
| **api 服務** | `https://api-production-7f13.up.railway.app` | Railway，SUCCESS |
| **alto bundler** | `https://alto-production-c309.up.railway.app` | Railway，SUCCESS（v1.2.5 + safe-mode） |
| **scheduler** | Railway 內部（無公開網域） | SUCCESS，**dry-run**，60 秒一輪 |
| **Postgres** | Railway（私有網路） | SUCCESS，18 個 migration |

健康檢查實測：

```json
{"status":"ok","service":"cre8-atp-backend","chainId":56,"rpcConfigured":true,
 "db":"ok","alerts":{"critical":0,"warn":0,"open":0}}
```

部署者：`0x70fc55f8BF3BE3E599566417A1a58c9bf6a7c60c`（全新錢包，非 anvil 測試帳號）
部署成本：0.000299 BNB（7 筆交易）

bundler 實測：

    eth_supportedEntryPoints → ["0x0000000071727De22E5E9d8BAf0edAc6f37da032"]
    eth_chainId              → 0x38 (56)

## 還沒做

| # | 項目 | 阻礙 |
|---|---|---|
| 1 | ~~alto bundler~~ | ✅ 已完成 |
| 2 | ~~scheduler 服務~~ | ✅ 已部署，**dry-run**；要 `SCHEDULER_LIVE=1` 才會真的送交易 |
| 3 | 前端部署 | `VITE_CHAIN_ID=56` + `VITE_RPC_URL` + `VITE_API_BASE` |
| 4 | 第一筆真錢驗證 | 等 1–3 |
| 5 | registry owner → Safe | 使用者裁定：測試完再轉（見 todo §4） |
| 7 | **alto 與部署者共用私鑰** | 目前 `EXECUTOR_PRIVATE_KEY` = 部署者金鑰。正式前應拆開：alto 的熱錢包只放少量 BNB |
| 6 | alert 投遞 | TODO §3 |

## 部署紀錄的重要教訓

* `railway up` 上傳「連結時的專案根目錄」，不是 CWD → 必須 `railway up .deploy --path-as-root`
* `railway up` 預設用**已連結的服務** → 先 `railway add --service api` 再指定
* 沙箱不能寫 `~/.railway` → `HOME=<工作區> railway ...`
* publicnode 對 archive 查詢要 token：`forge` 驗證 receipt 時噴 403，但交易成功

## 同一個 image、兩種角色

`SERVICE_ROLE` 決定啟動什麼（`docker-entrypoint.sh`）：

| 服務 | SERVICE_ROLE | 啟動 |
|---|---|---|
| api | `api`（預設） | `bun src/index.ts` |
| scheduler | `scheduler` | `bun run scripts/scheduler.ts --loop --interval $SCHEDULER_INTERVAL …` |

**`--live` 必須由 `SCHEDULER_LIVE=1` 明確開啟。** 沒設就只觀察不動手 ——
「部署時忘記某個變數」的代價應該是「它不會動錢」，不是「它動了錢」。

驗證（本地 docker）：

    SERVICE_ROLE=api        → [entrypoint] role=api port=8081
    SERVICE_ROLE=scheduler  → [entrypoint] role=scheduler interval=60s dry-run
    SERVICE_ROLE=bogus      → 明確報錯並 exit 1（不靜默 fallback 到 api）

線上實測：第 1/2/3 輪各間隔 60 秒、無錯誤、`認領 0 個 portfolio`（還沒有任何投組）。

## 下一步

1. 前端部署（`VITE_CHAIN_ID=56` + API 位址）
2. 第一筆真錢：部署者建立一個投組、存入小額 USDT
3. 確認 scheduler 在 `--live` 下能真的送出第一輪
