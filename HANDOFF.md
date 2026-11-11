# CRE8 ATP — 三個 repo 的入口

這個資料夾是 CRE8 ATP（Automated Token Portfolio）的三個獨立 repo。

**先讀 [`docs/`](./docs/README.md)** —— 文件已全部收進這個工作區，不再依賴外部 repo：

| 想知道的 | 看 |
|---|---|
| 現況、待辦、下一刀 | [`docs/HANDOFF.zh-TW.md`](./docs/HANDOFF.zh-TW.md) |
| **踩過的坑（優先看）** | [`docs/pitfalls.zh-TW.md`](./docs/pitfalls.zh-TW.md) |
| 為什麼做成這樣 | [`docs/decisions.zh-TW.md`](./docs/decisions.zh-TW.md) |
| 怎麼跑起來 | [`docs/runbook.zh-TW.md`](./docs/runbook.zh-TW.md) |

## 三個 repo

| repo | 內容 | 工具鏈 |
| --- | --- | --- |
| `cre8-contracts/` | AtpRegistry、AtpExecutor、PancakeV3TwapOracle、deploy script | Foundry 0.8.37（viaIR） |
| `backend/` | SIWE 認證、策略鏡像上鏈、enroll API、Kernel smart account | Bun + TypeScript + Postgres（raw `pg`，無 ORM） |
| `db/` | 8 張表、3 個 migration | SQL |

三個 repo 的 git 根目錄各自獨立。**`cre8-protocol/` 本身不是 git repo**。

## 30 秒狀態（2026-11-06）

- 第一版只做**股票指數**（目標權重＋再平衡＋swap），標的是 BSC bStock。
- 聚合器：PancakeSwap Universal Router（走 Permit2）。
- 收費：pool fee（swap 內）＋ swap fee（輸出側，admin-only）。
- 帳戶層已就位：enroll 會真的部署 Kernel v3.3 smart account（`account_type='KERNEL'`），
  協議編碼已遷移到 `@zerodev/sdk`。
- 已完成：**Kernel session key 授權** —— enroll 時安裝三層權限，session key 已實測可上鏈發 op。
- 下一刀：**使用者簽名通道** —— 它同時解掉 session key 續期、權限變更、EIP-1271 SIWE。
  見 [`docs/HANDOFF.zh-TW.md` §3.2](./docs/HANDOFF.zh-TW.md)。

## 快速驗證

```bash
cd backend && bun test && bun run typecheck
# 預期 120 pass / 1 skip / 0 fail，typecheck exit 0
# 那 1 個 skip 是鏈上整合測試（要求 RPC_URL 非空），是正常的

cd ../cre8-contracts && forge test
# 預期 85 pass / 1 skip（fork 測試需 BSC_RPC_URL）
```

要跑鏈上端到端驗證（含 anvil fork 與 75 分鐘保存期限的處理），見
[`docs/runbook.zh-TW.md`](./docs/runbook.zh-TW.md) §3 與 §5。

## 評估用產物

`spike/` 是本輪技術評估的產物（SDK 地址等價、alto bundler、anvil 狀態可攜性）。
它**不在任何 repo 的版控內**，可安全刪除；結論已收進 `docs/`。
