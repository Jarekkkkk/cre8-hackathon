<!--
  來源：bnb-agent-vaults/docs/atp-pivot-executor-spec.zh-TW.md
  複製日期：2026-11-06
  狀態：歷史設計文件，內容反映 2026-11-06 當時的規劃。
        實作進度與後續決策請看 docs/HANDOFF.zh-TW.md 與 docs/decisions.zh-TW.md。
  ⚠ 本檔為原樣複製，未經修訂；若與現況衝突，以 docs/HANDOFF.zh-TW.md 為準。
-->

# ATP Executor 合約骨架（Phase 2 介面規格）

狀態：介面規格（未編譯、未接 CI）。本檔是設計骨架，開工時才抽成 `src/atp/` 的正式合約。
前提：bStock（BSC 股票代幣化 ERC-20）；暫不接 x402 訂閱；聚合器 = PancakeSwap Universal Router。

## 1. 執行模型（Model A：帳戶呼叫 Executor）

session key **不直接**當 `msg.sender` 呼叫 Executor。流程是：

```
session key ──簽 userOp──▶ Kernel account ──execute()──▶ AtpExecutor.executeRebalance()
                                                          msg.sender == account
```

- **權限在 Kernel 層**：session key 只能觸發「帳戶 → Executor.executeRebalance」這條白名單呼叫，
  由 Kernel/SmartSession 的 permission validator 強制（who/when/what）。
- **Executer 不需要驗 session key**：它信任 `msg.sender == account`（由帳戶層保證），
  只做**領域約束**——策略版本、白名單資產、minGross、deadline。
- 因此 Executor 不耦合 SmartSession 內部，審計面小。

安全備註：Executor 應 `require(msg.sender == account)` 且 `require(account.code.length > 0)`，
避免被 EOA 直接呼叫造成狀態錯亂。

## 2. 信任邊界與攻擊面

agent（我們的 keeper，KMS 簽名）**被信任去選路由，但不被信任不犯錯／不被盜**。所以：

| 攻擊面 | 防護 |
| --- | --- |
| agent 填 `amountOutMin = 0` 或選爛路由 | **oracle 地板 + minGross**（§5），不達即 revert |
| agent 塞任意 calldata 想動別的合約 | Universal Router 位址 immutable（Executor 自己呼叫它）＋ **command allowlist**（§4） |
| agent 想把輸出轉走 | `recipient` 固定 = Executor，收費與退回都在 Executor 內完成 |
| sandwich（TWAP 滯後） | 賣單加 `_saleFloor`（近 5 分鐘池均價），沿用現有做法 |
| session key 被盜 | 損失有上界（oracle 地板）＋可撤銷 |

## 3. Registry 骨架

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract AtpRegistry {
    // ---- admin / fee ----
    address public owner;                      // 多簽 / admin
    uint16  public defaultSwapFeeBps;          // admin-only，全策略預設
    mapping(uint256 => uint16) public feeBps;  // 策略覆寫

    modifier onlyOwner() { require(msg.sender == owner, "owner"); _; }

    function setDefaultFeeBps(uint16 bps) external onlyOwner;      // bps <= 300（0–3%）
    function setStrategyFeeBps(uint256 id, uint16 bps) external onlyOwner;

    // ---- strategy / version ----
    struct Version {
        address[] assets;      // 白名單資產（bStock）
        uint16[]  weightsBps;  // 合計 == 10000
        bytes32   scheduleHash;// 排程（interval|cron）的離線編碼 hash
        uint64    activeAt;
    }
    struct StrategyMeta {
        address provider;
        string  name;
        string  description;
        bool    isPublic;
    }

    mapping(uint256 => StrategyMeta) public strategies;
    mapping(uint256 => Version[])   internal _versions;   // strategyId -> history
    mapping(uint256 => uint16)      public  activeVersion;// strategyId -> active idx
    uint256 public nextStrategyId;

    // ---- enrollment ----
    struct Enrollment { uint256 strategyId; uint16 version; bool paused; }
    mapping(address => Enrollment) public enrollments;
    mapping(address => bool)      public isEnrolled;

    // ---- helpers ----
    function version(uint256 id, uint16 v) external view returns (Version memory); // v == 0 => active
    function isAssetAllowed(uint256 id, uint16 v, address asset) public view returns (bool);

    // ---- events ----
    event VersionPublished(uint256 indexed id, uint16 version, bytes32 scheduleHash);
    event FeeBpsUpdated(uint256 indexed id, uint16 bps);
    event Enrolled(address indexed account, uint256 id, uint16 version);

    // TODO: publishVersion 完整校驗（weights 合計 10000、無重複資產、只增不減資格的版本號）
    // TODO: enroll 由後端在兩段式簽名後呼叫（或由 Kernel account 自呼叫）
}
```

## 4. Executor 骨架

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IOracleFloor {
    /// 回傳 (quoted, minimum)：oracle 推算的成交價與地板（含 maxSlippage + 賣單近均值地板）。
    /// 語義對齊現有 MandateScopeSwapAdapter.previewSwap / _saleFloor。
    function previewSwap(address tokenIn, address tokenOut, uint256 amountIn)
        external view returns (uint256 quoted, uint256 minimum);
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

contract AtpExecutor is ReentrancyGuard {
    AtpRegistry      public immutable registry;
    IUniversalRouter public immutable universalRouter; // pinned per chain
    IOracleFloor     public immutable oracle;          // 包一層現有 previewSwap/_saleFloor
    address          public feeRecipient;              // admin 可改

    struct SwapStep {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOutMin; // agent 填（僅提示），實際以 minGross 覆核
        bytes   commands;     // Universal Router commands（受 allowlist 限制）
        bytes[] inputs;       // Universal Router inputs
    }

    event SwapExecuted(address indexed account, address tokenIn, address tokenOut,
        uint256 amountIn, uint256 gross, uint256 fee, uint256 net, uint256 oracleAt);

    function executeRebalance(address account, SwapStep[] calldata steps, uint256 deadline)
        external nonReentrant
    {
        require(msg.sender == account && account.code.length > 0, "caller");
        AtpRegistry.Enrollment memory e = registry.enrollments(account);
        require(!e.paused, "paused");

        uint16 fBps = registry.feeBps(e.strategyId); // 0 表示用 defaultSwapFeeBps
        if (fBps == 0) fBps = registry.defaultSwapFeeBps();

        for (uint256 i; i < steps.length; ++i) {
            _checkStep(account, steps[i], e, fBps, deadline);
            uint256 gross = _swap(steps[i]);
            _splitFee(steps[i].tokenOut, gross, fBps, account);
        }
    }

    function _checkStep(address account, SwapStep calldata s, AtpRegistry.Enrollment memory e,
        uint16 fBps, uint256 deadline) internal view
    {
        require(block.timestamp <= deadline, "deadline");
        require(registry.isAssetAllowed(e.strategyId, e.version, s.tokenIn)
             && registry.isAssetAllowed(e.strategyId, e.version, s.tokenOut), "asset");

        // command allowlist：只接受「換幣 + 把輸出送回 Executor」，拒絕 PAY_PORTION /
        // PERMIT2_TRANSFER_FROM / WRAP / UNWRAP 等能移動任意 token 的命令
        _checkCommands(s.commands);

        // oracle 地板 + fee 反推（§5）
        (, uint256 minimum) = oracle.previewSwap(s.tokenIn, s.tokenOut, s.amountIn);
        uint256 minGross = _minGross(minimum, fBps);
        require(_decodeAmountOutMin(s.commands, s.inputs) >= minGross, "below-min"); // 或用 s.amountOutMin >= minGross 簡化
    }

    function _swap(SwapStep calldata s) internal returns (uint256 gross) {
        // 1. 從 account 拉 tokenIn（account 先 approve Executor，或走 Permit2）
        IERC20(s.tokenIn).transferFrom(msg.sender, address(this), s.amountIn);
        // 2. approve universalRouter（Permit2 或 ERC20 approve）
        IERC20(s.tokenIn).approve(address(universalRouter), s.amountIn);
        // 3. 呼叫 aggregator，recipient = Executor
        uint256 before = IERC20(s.tokenOut).balanceOf(address(this));
        universalRouter.execute(s.commands, s.inputs, type(uint256).max); // deadline 由 input 內含
        gross = IERC20(s.tokenOut).balanceOf(address(this)) - before;
    }

    function _splitFee(address tokenOut, uint256 gross, uint16 fBps, address account) internal {
        uint256 fee = gross * fBps / 10000;
        if (fee > 0) IERC20(tokenOut).transfer(feeRecipient, fee);
        IERC20(tokenOut).transfer(account, gross - fee);
        // TODO: emit SwapExecuted(...)
    }
}
```

## 5. minGross：fee 併進 minOut 反推（核心不變式）

```
minimum   = oracle.previewSwap(tokenIn, tokenOut, amountIn).minimum   // 已含 slippage + 近均值地板
minGross  = ceil( minimum / (1 − fBps/10000) )                        // fee 折回 gross 側
require( grossOutput ≥ minGross )
```

- `minimum` 直接複用 `MandateScopeSwapAdapter.previewSwap` 的語義：`quoted × (10000−maxSlippageBps)/10000`，
  賣單再 `max(minimum, _saleFloor)`（池價路線加近 5 分鐘池均價，擋 TWAP 滯後的 sandwich）。
- 把 fee 折回 gross 側，保證**扣費後使用者實得 ≥ 地板**，而不是「地板上再被扣一層」。

## 6. 開放項（開工前要定的）

1. **Universal Router command allowlist**：白名單 = `V3_SWAP_EXACT_IN / V2_SWAP_EXACT_IN / SWEEP / TRANSFER`，
   拒絕 `PAY_PORTION / PERMIT2_TRANSFER_FROM / WRAP_ETH / UNWRAP_WETH`。bStock 是 ERC-20 純現貨，不需 ETH 命令。
2. **approve vs Permit2**：account 先 approve Executor，Executor 再 approve Router；或整條走 Permit2。二選一。
3. **amountOutMin 覆核來源**：骨架裡有兩個選項——解碼 `inputs` 的 minOut，或簡化成
   `require(s.amountOutMin ≥ minGross)` 且強制 Executor 在呼叫 Router 時用 `minGross` 覆寫。後者較簡單，建議採用。
4. **`oracle` 的實作**：包一層現有 `MandatePoolTwapFeed`＋`MandateScopeSwapAdapter` 的 previewSwap/_saleFloor，
   抽成 `IOracleFloor`。不重新發明，只做適配。
5. **feeRecipient 與 swapFeeBps 的 admin**：沿用 registry 的 `onlyOwner`；上線前改多簽。
6. **session key 權限範例（Kernel permission）**：`{ target: AtpExecutor, selector: executeRebalance, 額度: 無上限但受 minGross 約束, 到期: 可續簽 }`。
   「金額上限」第一版可留空，因為 minGross/oracle 已經是金額上界；若想再加一道，可在 policy 設「單筆 amountIn ≤ X」。

## 7. 與現有程式對照

| 新元件 | 對應現有程式 |
| --- | --- |
| `IOracleFloor.previewSwap` | `MandateScopeSwapAdapter.previewSwap / _saleFloor / value` |
| oracle 地板來源 | `MandatePoolTwapFeed`（30–90 分鐘 TWAP）＋ `MandateSingleStepFeed` |
| 資產白名單 | 29 條現貨路由（`spot-templates/`）的 asset/pool 綁定 |
| 收費切分 | 新（pooled vault 的 fee accounting 不搬） |
| 兩段式簽名 / 冪等 | `web/lib/mandate-*` 的 existing intent 骨架，後端重寫為 ATP 版 |

## 8. 下一步

- 定 §6 的 1–3（command allowlist、Permit2、amountOutMin 覆寫方式）→ 骨架轉正式 `src/atp/`。
- 抽 `IOracleFloor` 適配層 → 接 `MandatePoolTwapFeed`。
- 補 deploy 腳本與 BSC fork 測試（沿用 repo 的 fuzz/invariant 門檻）。
