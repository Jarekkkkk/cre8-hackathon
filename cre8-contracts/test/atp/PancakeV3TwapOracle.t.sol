// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { PancakeV3TwapOracle } from "../../src/atp/PancakeV3TwapOracle.sol";

/// @dev ERC-20 metadata stub: the oracle reads `decimals()` at construction only.
contract MockToken {
    uint8 public immutable decimals;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }
}

/// @dev PancakeSwap V3 pool stub. `observe` answers the two lookbacks the oracle can ask for: the configured
/// TWAP `window` and the 5 minute `RECENT_WINDOW`, each with its own cumulative pair, so the two windows can
/// be made to disagree. Unless a test says otherwise the recent segment carries the same mean tick as the
/// TWAP segment, which keeps every pre-sandwich-floor expectation identical.
contract MockPancakeV3Pool {
    /// @dev Mirrors `PancakeV3TwapOracle.RECENT_WINDOW`; the mock opts in to the oracle's own two-window shape.
    uint32 public constant RECENT_WINDOW = 5 minutes;

    address public immutable token0;
    address public immutable token1;

    uint160 public sqrtPriceX96 = 79_228_162_514_264_337_593_543_950_336; // 2^96, tick 0
    uint24 public fee = 500;
    uint128 public liquidity = 1e18;
    uint16 public observationCardinality = 2;
    bool public unlocked = true;

    uint32 public window;
    int56 public cumulativeAtWindow;
    int56 public cumulativeNow;
    int56 public cumulativeAtRecent;

    bool public observeReverts;
    /// @dev Injects the second `observe` failing: the pool cannot serve the 5 minute lookback.
    bool public recentObserveReverts;
    uint256 public observeLengthOverride;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint32, bool) {
        return (sqrtPriceX96, 0, 0, observationCardinality, observationCardinality, 0, unlocked);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory ticks, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        if (observeReverts) revert("mock: no history");
        if (recentObserveReverts) {
            for (uint256 i; i < secondsAgos.length; ++i) {
                if (secondsAgos[i] == RECENT_WINDOW) revert("mock: no recent history");
            }
        }

        uint256 length = observeLengthOverride == 0 ? secondsAgos.length : observeLengthOverride;
        ticks = new int56[](length);
        secondsPerLiquidityCumulativeX128s = new uint160[](length);
        for (uint256 i; i < length && i < secondsAgos.length; ++i) {
            ticks[i] = _cumulativeAt(secondsAgos[i]);
        }
    }

    function _cumulativeAt(uint32 secondsAgo) private view returns (int56) {
        if (secondsAgo == 0) return cumulativeNow;
        if (secondsAgo == RECENT_WINDOW) return cumulativeAtRecent;
        if (secondsAgo == window) return cumulativeAtWindow;
        revert("mock: unsupported lookback");
    }

    // ---- test controls ----

    /// @dev Builds cumulatives whose exact mean tick is `meanTick` over `window_`; the recent segment is
    /// derived so it carries the same mean, which is the pre-sandwich-floor regime.
    function setMeanTick(int24 meanTick, uint32 window_) external {
        window = window_;
        cumulativeAtWindow = 0;
        cumulativeNow = int56(meanTick) * int56(uint56(window_));
        cumulativeAtRecent = cumulativeNow - int56(meanTick) * int56(uint56(RECENT_WINDOW));
    }

    function setCumulatives(int56 atWindow, int56 now, uint32 window_) external {
        window = window_;
        cumulativeAtWindow = atWindow;
        cumulativeNow = now;
        // Linear interpolation at the 5 minute mark, so the recent mean matches the TWAP mean.
        cumulativeAtRecent =
            atWindow + (now - atWindow) * int56(uint56(window_ - RECENT_WINDOW)) / int56(uint56(window_));
    }

    /// @dev Pins the recent 5 minute segment to its own mean tick, independent of the TWAP segment.
    function setRecentMeanTick(int24 recentMeanTick) external {
        cumulativeAtRecent = cumulativeNow - int56(recentMeanTick) * int56(uint56(RECENT_WINDOW));
    }

    function setObservationCardinality(uint16 cardinality) external {
        observationCardinality = cardinality;
    }

    function setUnlocked(bool unlocked_) external {
        unlocked = unlocked_;
    }

    function setSqrtPrice(uint160 sqrtPriceX96_) external {
        sqrtPriceX96 = sqrtPriceX96_;
    }

    function setObserveReverts(bool reverts_) external {
        observeReverts = reverts_;
    }

    function setRecentObserveReverts(bool reverts_) external {
        recentObserveReverts = reverts_;
    }

    function setObserveLengthOverride(uint256 length) external {
        observeLengthOverride = length;
    }
}

/// @notice Pins `PancakeV3TwapOracle`: TWAP-only `quoted`, the decimals-neutral raw ratio, the rounding
/// direction, the max(TWAP floor, recent-mean floor) sandwich floor and the fail-closed paths.
contract PancakeV3TwapOracleTest is Test {
    uint32 internal constant WINDOW = 30 minutes;
    uint16 internal constant MAX_SLIPPAGE_BPS = 50;
    uint32 internal constant MAX_ORACLE_AGE = 1 hours;

    MockToken internal token0;
    MockToken internal token1;
    MockPancakeV3Pool internal pool;
    PancakeV3TwapOracle internal oracle;

    function setUp() public {
        token0 = new MockToken(18);
        token1 = new MockToken(6);
        pool = new MockPancakeV3Pool(address(token0), address(token1));
        oracle = new PancakeV3TwapOracle(
            address(pool), address(token0), address(token1), WINDOW, MAX_SLIPPAGE_BPS, MAX_ORACLE_AGE
        );
    }

    // ---- pricing ----

    /// @dev Tick -276324 is a raw ratio of about 1e-12, i.e. one 18-decimal unit of `token0` buys about
    /// one 6-decimal unit of `token1`. That is exactly the decimals trap: the raw ratio already carries
    /// 10^(decimalsOut - decimalsIn), so a second factor would be off by 1e12.
    function test_quotesAcrossDecimalsInTheRawRatio() public {
        pool.setMeanTick(-276_324, WINDOW);

        (uint256 quoted, uint256 minimum) = oracle.previewSwap(address(token0), address(token1), 1000e18);
        assertEq(quoted, 1_000_002_644, "18 -> 6 quote");
        assertEq(minimum, 995_002_631, "50 bps floor");

        (uint256 quotedBack, uint256 minimumBack) =
            oracle.previewSwap(address(token1), address(token0), 1000e6);
        assertEq(quotedBack, 999_997_356_176_039_153_114, "6 -> 18 quote");
        assertEq(minimumBack, 994_997_369_395_158_957_349, "50 bps floor");
    }

    function test_quotesParityAtTickZero() public {
        pool.setMeanTick(0, WINDOW);

        (uint256 quoted, uint256 minimum) = oracle.previewSwap(address(token0), address(token1), 1000e18);
        assertEq(quoted, 1000e18, "raw parity");
        assertEq(minimum, 995e18, "50 bps floor");
    }

    function test_minimumIsCeilOfQuotedAfterSlippage() public {
        pool.setMeanTick(-276_324, WINDOW);
        (uint256 quoted, uint256 minimum) =
            oracle.previewSwap(address(token0), address(token1), 123_456_789e18);

        assertEq(minimum, _ceilDiv(quoted * (10_000 - MAX_SLIPPAGE_BPS), 10_000), "ceil floor");
    }

    /// @dev Solidity division truncates toward zero, so the mean tick needs a nudge in the two cases where
    /// truncation would lower the sold token's price. Selling `token0` (price rises with the tick) rounds
    /// up; selling `token1` (price falls with the tick) leaves the truncated tick alone.
    function test_meanTickRoundsUpTheSoldTokenPrice() public {
        MockToken tokenA = new MockToken(18);
        MockToken tokenB = new MockToken(18);
        MockPancakeV3Pool pool18 = new MockPancakeV3Pool(address(tokenA), address(tokenB));
        PancakeV3TwapOracle oracle18 = new PancakeV3TwapOracle(
            address(pool18), address(tokenA), address(tokenB), WINDOW, MAX_SLIPPAGE_BPS, MAX_ORACLE_AGE
        );
        // True mean tick 100.5: delta = 1800 * 100 + 900.
        pool18.setCumulatives(0, 180_900, 1800);

        (uint256 quotedSellA,) = oracle18.previewSwap(address(tokenA), address(tokenB), 1e18);
        assertEq(quotedSellA, 1_010_150_667_059_085_857, "sell token0 rounds the tick up to 101");

        (uint256 quotedSellB,) = oracle18.previewSwap(address(tokenB), address(tokenA), 1e18);
        assertEq(quotedSellB, 990_050_328_741_209_482, "sell token1 keeps the truncated tick 100");
    }

    /// @dev Pins `TickMathLite` at the pool's tick bounds. Above tick 0 the sqrt price exceeds 2^128, so
    /// the quote takes the full-width path; an overflow there would panic instead of reverting cleanly.
    /// Expected values come from an independent TickMath reference implementation.
    function test_quotesAtTheTickBounds() public {
        MockToken tokenA = new MockToken(18);
        MockToken tokenB = new MockToken(18);
        MockPancakeV3Pool pool18 = new MockPancakeV3Pool(address(tokenA), address(tokenB));
        PancakeV3TwapOracle bounded = new PancakeV3TwapOracle(
            address(pool18), address(tokenA), address(tokenB), WINDOW, MAX_SLIPPAGE_BPS, MAX_ORACLE_AGE
        );

        pool18.setMeanTick(887_272, WINDOW);
        (uint256 atMaxTick, uint256 minAtMaxTick) =
            bounded.previewSwap(address(tokenA), address(tokenB), 1e18);
        assertEq(atMaxTick, 340_256_786_836_388_094_070_642_339_899_681_172_762_184_831_912_720_469_416);
        assertGt(minAtMaxTick, 0);

        pool18.setMeanTick(-887_272, WINDOW);
        (uint256 atMinTick, uint256 minAtMinTick) =
            bounded.previewSwap(address(tokenA), address(tokenB), 1e18);
        assertEq(atMinTick, 1);
        assertEq(minAtMinTick, 1);
    }

    // ---- recent-mean sandwich floor ----

    /// @dev (a) A pool that traded up over the last 5 minutes must lift `minimum` above the TWAP floor to the
    /// recent-mean floor, without moving `quoted` (which stays the TWAP quote).
    function test_recentMeanLiftsTheFloorWhenThePoolTradedUp() public {
        pool.setMeanTick(0, WINDOW);
        pool.setRecentMeanTick(1_000); // last 5 minutes trade 10% above the 30 minute mean

        (uint256 quoted, uint256 minimum) = oracle.previewSwap(address(token0), address(token1), 1000e18);

        assertEq(quoted, 1000e18, "quoted stays the TWAP quote");
        uint256 twapFloor = _ceilDiv(quoted * (10_000 - MAX_SLIPPAGE_BPS), 10_000);
        uint256 recentQuoted = _quoteAtTick(1_000, address(token0), address(token1), 1000e18);
        uint256 recentFloor = _ceilDiv(recentQuoted * (10_000 - MAX_SLIPPAGE_BPS), 10_000);

        assertGt(recentFloor, twapFloor, "recent mean is the higher mean here");
        assertEq(minimum, recentFloor, "floor is the recent-mean floor");
        assertGt(minimum, twapFloor, "the recent floor raises the TWAP floor");
    }

    /// @dev (b) A pool that traded down over the last 5 minutes must leave the TWAP floor in force: the recent
    /// floor may never lower `minimum`, so a fast crash cannot be used to sell under the TWAP.
    function test_recentMeanLeavesTheTwapFloorWhenThePoolTradedDown() public {
        pool.setMeanTick(0, WINDOW);
        pool.setRecentMeanTick(-1_000);

        (uint256 quoted, uint256 minimum) = oracle.previewSwap(address(token0), address(token1), 1000e18);

        assertEq(quoted, 1000e18, "quoted stays the TWAP quote");
        uint256 twapFloor = _ceilDiv(quoted * (10_000 - MAX_SLIPPAGE_BPS), 10_000);
        uint256 recentQuoted = _quoteAtTick(-1_000, address(token0), address(token1), 1000e18);
        uint256 recentFloor = _ceilDiv(recentQuoted * (10_000 - MAX_SLIPPAGE_BPS), 10_000);

        assertLt(recentFloor, twapFloor, "recent mean is the lower mean here");
        assertEq(minimum, twapFloor, "floor stays the TWAP floor");
    }

    /// @dev The recent window is not directional by accident: selling `token1` means a *higher* recent tick is a
    /// *lower* recent price, so the max must still pick the side that protects the sale.
    function test_recentMeanFloorFollowsTheSoldTokenDirection() public {
        pool.setMeanTick(0, WINDOW);
        pool.setRecentMeanTick(-1_000); // recent tick below the TWAP: token1 is richer in token0

        (uint256 quoted, uint256 minimum) = oracle.previewSwap(address(token1), address(token0), 1000e6);

        uint256 twapFloor = _ceilDiv(quoted * (10_000 - MAX_SLIPPAGE_BPS), 10_000);
        uint256 recentFloor = _ceilDiv(
            _quoteAtTick(-1_000, address(token1), address(token0), 1000e6) * (10_000 - MAX_SLIPPAGE_BPS),
            10_000
        );

        assertGt(recentFloor, twapFloor, "the same recent tick is the higher price for token1");
        assertEq(minimum, recentFloor, "floor is the recent-mean floor");
    }

    /// @dev With both windows carrying the same mean the two floors coincide, so the max is a no-op. This is the
    /// shape every pre-sandwich-floor expectation in this file runs under.
    function test_recentMeanFloorCoincidesWithTheTwapFloorForAFlatPool() public {
        pool.setMeanTick(-276_324, WINDOW);

        (uint256 quoted, uint256 minimum) = oracle.previewSwap(address(token0), address(token1), 1000e18);

        assertEq(quoted, 1_000_002_644, "TWAP quote unchanged");
        assertEq(minimum, _ceilDiv(quoted * (10_000 - MAX_SLIPPAGE_BPS), 10_000), "single effective floor");
    }

    /// @dev (c) If the pool cannot serve the 5 minute lookback, the second read fails closed: the oracle reverts
    /// instead of quietly falling back to the TWAP floor alone.
    function test_revertsWhenTheRecentWindowObserveFails() public {
        pool.setMeanTick(0, WINDOW);
        pool.setRecentObserveReverts(true);

        vm.expectRevert(PancakeV3TwapOracle.TwapUnavailable.selector);
        oracle.previewSwap(address(token0), address(token1), 1e18);
    }

    /// @dev The recent read is guarded by the same pool sanity gates as the TWAP read, so a pool that is locked or
    /// quoting outside the valid range still fails closed before either mean is used.
    function test_recentReadFailsClosedOnAPoolThatIsNoLongerServable() public {
        pool.setMeanTick(0, WINDOW);
        pool.setRecentMeanTick(1_000);

        pool.setUnlocked(false);
        vm.expectRevert(PancakeV3TwapOracle.TwapUnavailable.selector);
        oracle.previewSwap(address(token0), address(token1), 1e18);

        pool.setUnlocked(true);
        (uint256 quoted, uint256 minimum) = oracle.previewSwap(address(token0), address(token1), 1e18);
        assertGt(
            minimum, _ceilDiv(quoted * (10_000 - MAX_SLIPPAGE_BPS), 10_000), "recent floor still applied"
        );
    }

    // ---- fail closed ----

    function test_revertsOnZeroAmount() public {
        pool.setMeanTick(0, WINDOW);
        vm.expectRevert(PancakeV3TwapOracle.ZeroAmount.selector);
        oracle.previewSwap(address(token0), address(token1), 0);
    }

    function test_revertsOnSameToken() public {
        pool.setMeanTick(0, WINDOW);
        vm.expectRevert(PancakeV3TwapOracle.UnsupportedPair.selector);
        oracle.previewSwap(address(token0), address(token0), 1e18);
    }

    function test_revertsOnTokenOutsideThePinnedPair() public {
        pool.setMeanTick(0, WINDOW);
        MockToken stray = new MockToken(18);

        vm.expectRevert(PancakeV3TwapOracle.UnsupportedPair.selector);
        oracle.previewSwap(address(stray), address(token1), 1e18);

        vm.expectRevert(PancakeV3TwapOracle.UnsupportedPair.selector);
        oracle.previewSwap(address(token0), address(stray), 1e18);
    }

    /// @dev The regression this check exists for. A `tokenIn` outside the pinned pair used to be accepted
    /// whenever `tokenOut == token0`: the direction flag simply stayed false and nothing verified that
    /// `tokenIn` was on the other side. `previewSwap(stray, token0)` then quoted the stray asset off the
    /// pool's `token1` leg - a confidently wrong price rather than a revert. All four stray combinations are
    /// closed, in both the sold and the received position.
    function test_revertsWhenTokenInIsOutsideThePinnedPair() public {
        pool.setMeanTick(0, WINDOW);
        MockToken stray = new MockToken(18);

        // Sold leg outside the pair: the case the single-sided check let through.
        vm.expectRevert(PancakeV3TwapOracle.UnsupportedPair.selector);
        oracle.previewSwap(address(stray), address(token0), 1e18);

        vm.expectRevert(PancakeV3TwapOracle.UnsupportedPair.selector);
        oracle.previewSwap(address(stray), address(token1), 1e18);

        // Received leg outside the pair: unchanged, kept here so all four combinations are pinned together.
        vm.expectRevert(PancakeV3TwapOracle.UnsupportedPair.selector);
        oracle.previewSwap(address(token0), address(stray), 1e18);

        vm.expectRevert(PancakeV3TwapOracle.UnsupportedPair.selector);
        oracle.previewSwap(address(token1), address(stray), 1e18);
    }

    function test_revertsWhenObserveReverts() public {
        pool.setMeanTick(0, WINDOW);
        pool.setObserveReverts(true);

        vm.expectRevert(PancakeV3TwapOracle.TwapUnavailable.selector);
        oracle.previewSwap(address(token0), address(token1), 1e18);
    }

    function test_revertsWhenObservationCardinalityIsTooSmall() public {
        pool.setMeanTick(0, WINDOW);
        pool.setObservationCardinality(1);

        vm.expectRevert(PancakeV3TwapOracle.TwapUnavailable.selector);
        oracle.previewSwap(address(token0), address(token1), 1e18);
    }

    function test_revertsWhenPoolIsLocked() public {
        pool.setMeanTick(0, WINDOW);
        pool.setUnlocked(false);

        vm.expectRevert(PancakeV3TwapOracle.TwapUnavailable.selector);
        oracle.previewSwap(address(token0), address(token1), 1e18);
    }

    function test_revertsWhenObserveReturnsTheWrongShape() public {
        pool.setMeanTick(0, WINDOW);
        pool.setObserveLengthOverride(1);

        vm.expectRevert(PancakeV3TwapOracle.TwapUnavailable.selector);
        oracle.previewSwap(address(token0), address(token1), 1e18);
    }

    function test_revertsWhenSpotPriceIsOutsideTheValidRange() public {
        pool.setMeanTick(0, WINDOW);
        pool.setSqrtPrice(1);

        vm.expectRevert(PancakeV3TwapOracle.InvalidPoolPrice.selector);
        oracle.previewSwap(address(token0), address(token1), 1e18);
    }

    function test_revertsWhenMeanTickIsOutsideTheTickRange() public {
        pool.setMeanTick(1_000_000, WINDOW);

        vm.expectRevert(PancakeV3TwapOracle.InvalidPoolPrice.selector);
        oracle.previewSwap(address(token0), address(token1), 1e18);
    }

    /// @dev The quote rounds up, so even one raw unit of the sold token keeps a non-zero floor; a swap
    /// can never slip through with `minimum == 0`.
    function test_dustAmountKeepsANonZeroFloor() public {
        pool.setMeanTick(-276_324, WINDOW);

        (uint256 quoted, uint256 minimum) = oracle.previewSwap(address(token0), address(token1), 1);
        assertEq(quoted, 1, "one raw unit in still quotes one raw unit out");
        assertEq(minimum, 1, "floor never rounds to zero");
    }

    // ---- constructor ----

    function test_constructorPinsConfiguration() public view {
        assertEq(address(oracle.pool()), address(pool));
        assertEq(oracle.token0(), address(token0));
        assertEq(oracle.token1(), address(token1));
        assertEq(oracle.decimals0(), 18);
        assertEq(oracle.decimals1(), 6);
        assertEq(oracle.twapWindow(), WINDOW);
        assertEq(oracle.maxSlippageBps(), MAX_SLIPPAGE_BPS);
        assertEq(oracle.maxOracleAge(), MAX_ORACLE_AGE);
    }

    function test_constructorAcceptsReversedPairOrder() public {
        PancakeV3TwapOracle reversed = new PancakeV3TwapOracle(
            address(pool), address(token1), address(token0), WINDOW, MAX_SLIPPAGE_BPS, MAX_ORACLE_AGE
        );
        assertEq(reversed.token0(), address(token0));
        assertEq(reversed.token1(), address(token1));
    }

    function test_constructorRejectsShortWindow() public {
        vm.expectRevert(PancakeV3TwapOracle.InvalidConfig.selector);
        new PancakeV3TwapOracle(
            address(pool), address(token0), address(token1), 29 minutes, MAX_SLIPPAGE_BPS, MAX_ORACLE_AGE
        );
    }

    function test_constructorRejectsLongWindow() public {
        vm.expectRevert(PancakeV3TwapOracle.InvalidConfig.selector);
        new PancakeV3TwapOracle(
            address(pool), address(token0), address(token1), 91 minutes, MAX_SLIPPAGE_BPS, MAX_ORACLE_AGE
        );
    }

    function test_constructorRejectsZeroSlippage() public {
        vm.expectRevert(PancakeV3TwapOracle.InvalidConfig.selector);
        new PancakeV3TwapOracle(address(pool), address(token0), address(token1), WINDOW, 0, MAX_ORACLE_AGE);
    }

    function test_constructorRejectsFullSlippage() public {
        vm.expectRevert(PancakeV3TwapOracle.InvalidConfig.selector);
        new PancakeV3TwapOracle(
            address(pool), address(token0), address(token1), WINDOW, 10_000, MAX_ORACLE_AGE
        );
    }

    function test_constructorRejectsOracleAgeBelowWindow() public {
        vm.expectRevert(PancakeV3TwapOracle.InvalidConfig.selector);
        new PancakeV3TwapOracle(
            address(pool), address(token0), address(token1), WINDOW, MAX_SLIPPAGE_BPS, WINDOW - 1
        );
    }

    function test_constructorRejectsTokensOutsideThePool() public {
        MockToken stray = new MockToken(18);

        vm.expectRevert(PancakeV3TwapOracle.InvalidConfig.selector);
        new PancakeV3TwapOracle(
            address(pool), address(token0), address(stray), WINDOW, MAX_SLIPPAGE_BPS, MAX_ORACLE_AGE
        );
    }

    function test_constructorRejectsIdenticalTokens() public {
        vm.expectRevert(PancakeV3TwapOracle.InvalidConfig.selector);
        new PancakeV3TwapOracle(
            address(pool), address(token0), address(token0), WINDOW, MAX_SLIPPAGE_BPS, MAX_ORACLE_AGE
        );
    }

    function test_constructorRejectsPoolWithoutCode() public {
        vm.expectRevert(PancakeV3TwapOracle.InvalidConfig.selector);
        new PancakeV3TwapOracle(
            address(0xBEEF), address(token0), address(token1), WINDOW, MAX_SLIPPAGE_BPS, MAX_ORACLE_AGE
        );
    }

    /// @dev The sandwich floor's window is pinned at 5 minutes and must stay strictly shorter than `twapWindow`.
    function test_constructorPinsTheRecentWindowBelowTheTwapWindow() public view {
        assertEq(oracle.RECENT_WINDOW(), 5 minutes, "recent window is pinned at 5 minutes");
        assertLt(oracle.RECENT_WINDOW(), oracle.twapWindow(), "recent window is shorter than the TWAP window");
    }

    /// @dev A TWAP window at or below `RECENT_WINDOW` is rejected. `MIN_TWAP_WINDOW` already rules it out, so the
    /// explicit `RECENT_WINDOW >= twapWindow_` guard is defence in depth; the revert is the same `InvalidConfig`.
    function test_constructorRejectsTwapWindowAtTheRecentWindow() public {
        // Read the constant before `expectRevert`: an external view call would consume the expectation.
        uint32 recentWindow = oracle.RECENT_WINDOW();

        vm.expectRevert(PancakeV3TwapOracle.InvalidConfig.selector);
        new PancakeV3TwapOracle(
            address(pool), address(token0), address(token1), recentWindow, MAX_SLIPPAGE_BPS, MAX_ORACLE_AGE
        );
    }

    /// @dev Independent reference: the quote of a flat pool whose single mean tick is `meanTick`, i.e. what the
    /// recent-mean leg of `previewSwap` quotes when only the recent segment carries `meanTick`.
    function _quoteAtTick(int24 meanTick, address tokenIn, address tokenOut, uint256 amountIn)
        internal
        returns (uint256 quoted)
    {
        MockPancakeV3Pool referencePool = new MockPancakeV3Pool(address(token0), address(token1));
        referencePool.setMeanTick(meanTick, WINDOW);
        PancakeV3TwapOracle referenceOracle = new PancakeV3TwapOracle(
            address(referencePool), address(token0), address(token1), WINDOW, MAX_SLIPPAGE_BPS, MAX_ORACLE_AGE
        );
        (quoted,) = referenceOracle.previewSwap(tokenIn, tokenOut, amountIn);
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : ((a - 1) / b) + 1;
    }
}
