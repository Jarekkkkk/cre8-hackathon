# cre8-contracts

CRE8 ATP（Automated Token Portfolio）智慧合約。獨立 repo，自 bnb-agent-vaults 的 pooled-vault
架構遷移出來：每人一個 non-custodial smart account，平台只做「權重 ＋ 排程」的執行與分發。

## 範圍（v1）

- 第一版策略：**股票指數**（目標權重 ＋ 排程/漂移再平衡 ＋ swap），標的為 BSC bStock（ERC-20）。
- 聚合器：PancakeSwap（Unified Swap API ＋ Universal Router）。
- 收費：pool fee（swap 內）＋ swap fee（輸出側，admin-only）。infra fee／訂閱走 x402（暫緩）。

## 合約

| 檔 | 說明 |
| --- | --- |
| `src/atp/AtpRegistry.sol` | 策略版本（權重＋排程）、swapFeeBps（admin-only）、enroll |
| `src/atp/AtpExecutor.sol` | 唯一搬錢合約：`executeRebalance` 驗證鏈、command allowlist、fee 切分 |
| `src/atp/interfaces/IOracleFloor.sol` | oracle 地板介面（`previewSwap`） |
| `src/atp/interfaces/IUniversalRouter.sol` | PancakeSwap Universal Router 介面＋command 常數 |

## 核心不變式

`minGross = ceil(oracleFloor / (1 - swapFeeBps/10000))`：fee 併進 minOut 反推，保證扣費後使用者實得
仍 ≥ oracle 地板。詳見 `docs/atp-pivot-executor-spec.zh-TW.md`（在 bnb-agent-vaults repo）。

## 工具鏈

Foundry 0.8.37（via_ir、optimizer 200、Cancun）、OpenZeppelin 5.4.0（vendored）。

```
forge build
forge test
```

## 上游依賴版本

- OpenZeppelin Contracts 5.4.0（`lib/openzeppelin-contracts`，自 bnb-agent-vaults 複製，pin 住版本）
- forge-std（`lib/forge-std`）
