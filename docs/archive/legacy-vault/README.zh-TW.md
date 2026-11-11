<!--
  來源：bnb-agent-vaults/docs/README.zh-TW.md
  複製日期：2026-11-06
  狀態：**已廢棄架構**（pooled vault：共享金庫＋份額）。
        保留僅作歷史對照，用來說明「為什麼要遷移到 ATP」。
        不可作為現況參考，也不可據此實作。
-->

# 文件索引

新加入的工程師先讀根目錄 [README](../README.md) 與 [CONTRIBUTING](../CONTRIBUTING.md)。公司資料看 [CRE8 團隊工作區](../company/README.md)；AI 先讀 [Agent 閱讀入口](../company/agent-guide.md)，工程規則在根目錄 [AGENTS.md](../AGENTS.md)。這裡維持工程與規格的索引。

這裡只列現行文件。當時的審查、修補、交接紀錄與已被取代的設計都在 [archive/](archive/README.md)，內容停在寫作當天，不能用來判斷目前狀態。程式碼與下列文件衝突時，以程式碼為準。

## 現行：狀態與交接

| 文件 | 內容 |
| --- | --- |
| **[atp-pivot/HANDOFF](atp-pivot/HANDOFF.zh-TW.md)** | **ATP 遷移的交接文件（最新方向）**：pooled vault → 每人一個 smart account；三個新 repo 的位置、目前進度、怎麼跑、待辦、已知坑、所有參考資料 |
| [atp-pivot-plan](atp-pivot-plan.zh-TW.md)、[atp-pivot-executor-spec](atp-pivot-executor-spec.zh-TW.md) | ATP 的遷移計畫（5 層架構、退休／重用／新建）與 Executor 合約骨架規格（minGross 反推、command allowlist） |
| [strategy-v3/HANDOFF](strategy-v3/HANDOFF.zh-TW.md) | **組合金庫與策略執行的目前狀態**：文件與程式碼地圖、19 項工具的本地／fork／部署狀態、修正總表、gas 與真實協議證據、最終驗證、剩餘工作 |
| [strategy-v3/RELEASE_RUNBOOK](strategy-v3/RELEASE_RUNBOOK.zh-TW.md) | 組合金庫的營運手冊：角色權限、建置與凍結檢查、部署順序與測試網清單、catalog 准入、joinGas、外部前置條件、keeper、D06 與 raw exit |
| [strategy-v3/ACCEPTANCE_A01_A36_STATUS](strategy-v3/ACCEPTANCE_A01_A36_STATUS.zh-TW.md) | 36 個驗收案例各子條件對到的實際測試 |
| [TESTNET_RUNBOOK](TESTNET_RUNBOOK.md) | V2 mandate vault（`MandateVault`／`MandatePortfolio`）的部署、模板上架、sandbox、錄入與驗收 |
| [UI_HANDOFF](UI_HANDOFF.zh-TW.md) | 最新 UI 設計交接 |
| [APP_ACCESS](APP_ACCESS.zh-TW.md) | App 的登入門檻（錢包簽名＋X 或邀請碼、waitlist、管理員核准）、Vercel 上線步驟、app（demo）與 testnet 兩個站的設定，以及 Landing（只含首頁、要 Connect X＋邀請碼）的部署與文件、法律文件的關閉 |
| [PERSONAL_AGENT_IMPLEMENTATION](PERSONAL_AGENT_IMPLEMENTATION.zh-TW.md)、[PERSONAL_AGENT_PREVIEW_HANDOFF](PERSONAL_AGENT_PREVIEW_HANDOFF.zh-TW.md) | 個人 Agent（CRE8 AI）的服務、付款、預覽與交接 |
| [審計與形式化驗證 2026-10-08](evidence/audit-formal-2026-10-08/README.zh-TW.md)、[test/formal](../test/formal/README.md) | 全面審計的每項發現與處置（修正、非問題、待產品決定），以及 Halmos／窮舉／SMTChecker／z3 的證明範圍與結果 |
| [evidence/](evidence/) | 機器可讀的驗證證據，資料夾以日期命名（最新：`bsc-testnet-venues-fork-2026-10-21/`，真實場所測試網的 Borrow & earn 與 keeper 演練，其他選項看前一天的 `bsc-testnet-venues-fork-2026-10-20/`；審計：`audit-formal-2026-10-08/`；mixed 串接：`mixed-integration-2026-10-08/`；組合金庫合約交接：`composite-contract-handoff-2026-10-07/`） |

## 現行：規格與設計

| 文件 | 內容 |
| --- | --- |
| [PRODUCT_LANGUAGE](PRODUCT_LANGUAGE.zh-TW.md) | **對外敘事、用詞表、費用與 mandate 路線圖**（2026-10-10 定案）：網站、App、Docs 與 CRE8 AI 都照這份寫 |
| [strategy-v3/README](strategy-v3/README.zh-TW.md)、[TOOLS](strategy-v3/TOOLS.zh-TW.md) | 多資產、多策略 vault 的產品決策（D01–D09）與 T01–T19 工具規格 |
| [VAULT_RULES_V2](VAULT_RULES_V2.zh-TW.md) | V2 mandate vault 的規則語義 |
| [SECURITY](SECURITY.md)、[核心帳務與限制](../design/MANDATE_VAULT_ACCOUNTING.md) | V2 安全模型、帳務與限制 |
| [CLONE_DEPLOYMENT_PLAN](CLONE_DEPLOYMENT_PLAN.zh-TW.md)、[STAGED_CREATION_SECURITY](STAGED_CREATION_SECURITY.zh-TW.md) | clone 部署與分階段建立的邊界 |
| [MARKET_VERIFICATION](MARKET_VERIFICATION.md)、[MANDATE_ENTRY_OBSERVATIONS](MANDATE_ENTRY_OBSERVATIONS.zh-TW.md) | 借貸市場地址驗證（2026-10-01 區塊快照）、入場價格觀測 |
| [MCP_V2_OPERATIONS](MCP_V2_OPERATIONS.zh-TW.md)、[MANDATE_SAFE_HANDOFF](MANDATE_SAFE_HANDOFF.zh-TW.md)、[PROTECTED_BSC_FORK_CI](PROTECTED_BSC_FORK_CI.zh-TW.md) | MCP 操作、Safe 操作交接、固定區塊的 fork CI |
| [TOP30_ADMISSION_2026-10-06](TOP30_ADMISSION_2026-10-06.zh-TW.md)、[TOP30_REMAINING11_2026-10-06](TOP30_REMAINING11_2026-10-06.zh-TW.md)、[TWO_POOL_HOLD_ROUTE_2026-10-06](TWO_POOL_HOLD_ROUTE_2026-10-06.zh-TW.md) | 初始 Top30 的 CA、池與准入結果；兩池持有路徑 |

## 法律文件草稿（未生效）

[使用條款](TERMS_OF_USE_DRAFT.zh-TW.md)、[風險揭露](RISK_DISCLOSURE_DRAFT.zh-TW.md)、[使用前須知](USER_GUIDE_LEGAL_NOTICE_DRAFT.zh-TW.md)、[使用資格與受限地區](RESTRICTED_JURISDICTIONS_DRAFT.zh-TW.md)、[隱私告知](PRIVACY_POLICY_DRAFT.zh-TW.md)、[彈窗規則](LEGAL_CONFIRMATION_POLICY.zh-TW.md)；網站版由 `web/scripts/build-legal-content.mjs` 從這些檔案產生，檔名不可任意更改。

研究資料在 [research/](../research/)（DeFi OS 2026-10-02、安全研究 2026-10-03、法務 2026-10-07，皆為當時快照）；UI 原型與設計系統在 [design/](../design/README.md)。
