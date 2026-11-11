# CRE8 ATP 文件

CRE8 從 pooled vault 遷移到 **ATP（Automated Token Portfolio）**：每人一個 non-custodial smart account，架構照 Glider。第一版只做股票指數（目標權重＋再平衡排程，標的是 BSC 上的 bStock）。

---

## 從哪裡開始

**第一次接手這個專案 → 按這個順序讀：**

1. [HANDOFF.zh-TW.md](./HANDOFF.zh-TW.md) — 現況、已完成、下一刀
2. [pitfalls.zh-TW.md](./pitfalls.zh-TW.md) — 踩過的坑。**這份最能省你的時間**
3. [decisions.zh-TW.md](./decisions.zh-TW.md) — 為什麼做成這樣，包含被推翻的決策
4. [runbook.zh-TW.md](./runbook.zh-TW.md) — 怎麼跑起來、故障排除

**要動手改東西之前**：先看 `pitfalls` 裡的「診斷心法」（附錄）。這個專案有大量「錯誤訊息指向的位置不是真正原因」的情況。

---

## 文件地圖

### 現行文件（會持續更新）

| 文件 | 內容 | 什麼時候看 |
|---|---|---|
| [HANDOFF.zh-TW.md](./HANDOFF.zh-TW.md) | 現況、待辦、下一刀的決策點 | 每次接手、每個里程碑結束 |
| [pitfalls.zh-TW.md](./pitfalls.zh-TW.md) | 已實際踩過的坑，症狀→原因→解法 | **遇到怪問題時優先查這份** |
| [decisions.zh-TW.md](./decisions.zh-TW.md) | 決策日誌：選項、選擇、理由、風險、誰拍的 | 想改架構前、質疑某個設計時 |
| [runbook.zh-TW.md](./runbook.zh-TW.md) | 環境啟動、驗證指令、故障排除表 | 要跑東西的時候 |

### 歷史設計文件（原樣保留，不修訂）

| 文件 | 內容 |
|---|---|
| [atp-pivot-plan.zh-TW.md](./atp-pivot-plan.zh-TW.md) | 遷移計畫：五層架構、退休/重用/新建、分階段時程 |
| [atp-pivot-executor-spec.zh-TW.md](./atp-pivot-executor-spec.zh-TW.md) | Executor 骨架規格：Registry／Executor 介面、minGross 反推、command allowlist |

這兩份是 2026-11-06 當時的規劃，**內容未經修訂**。若與現況衝突，以 `HANDOFF.zh-TW.md` 與 `decisions.zh-TW.md` 為準。

### 封存（archive）

| 路徑 | 內容 | 為什麼留著 |
|---|---|---|
| [archive/handoff-2026-11-06.zh-TW.md](./archive/handoff-2026-11-06.zh-TW.md) | 2026-11-06 的交接文件 | 它記錄了當時的進度與已知坑，是歷史紀錄。**已被現行 HANDOFF 取代** |
| [archive/legacy-vault/](./archive/legacy-vault/) | 舊 pooled vault 架構：`VAULT_RULES_V2`、`ARCHITECTURE`、`strategy-v3` 產品決策、舊文件索引 | **已廢棄架構，不可作為現況參考。** 保留用來說明「為什麼要遷移」 |

---

## 這套文件的維護原則

1. **`pitfalls` 只記錄已實際踩過的坑**，不寫「可能會有問題」。每條都要有「症狀 → 原因 → 解法」。
2. **`decisions` 只追加、不改寫**。決策被推翻時，在原條目標記 `⚠ 已被 D-xx 取代` 並保留 —— **被推翻的決策比正確的更有價值**，它記錄了哪條推理路徑走不通。
3. **歷史文件原樣保留**，用檔頭註解標明狀態與取代關係，不改動內文。
4. **數字要能查證**。任何「N 個測試通過」「地址是 0x…」都應該是實際跑過或查過的結果，不是記憶。

---

## 相關位置

| 位置 | 說明 |
|---|---|
| `../backend/README.md` | 後端完整說明（API、校驗規則、env、runbook） |
| `../db/README.md` | schema 概觀與 JSON 形狀 |
| `../cre8-contracts/src/atp/*.sol` | 合約實作（最終權威） |
| `../cre8-contracts/deployments/fork.json` | fork 部署地址紀錄（權威） |
| `../spike/` | 評估用產物（不在任何 repo 的版控內，可安全刪除） |

三個 repo 的 git 根目錄各自獨立（`cre8-contracts/`、`backend/`、`db/`）。`cre8-protocol/` 本身**不是** git repo。
