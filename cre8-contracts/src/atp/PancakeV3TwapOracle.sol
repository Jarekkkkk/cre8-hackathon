// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IOracleFloor } from "./interfaces/IOracleFloor.sol";
import { IPancakeV3Pool } from "./interfaces/IPancakeV3Pool.sol";

/// @title PancakeV3TwapOracle
/// @notice `IOracleFloor` adapter that prices an exact-input swap from one PancakeSwap V3 pool's
/// time-weighted average tick over a fixed 30-90 minute window, floored additionally by the pool's
/// recent mean so a sale cannot be sandwiched below it.
/// @dev Price source: `pool.observe([window, 0])` only. Spot is never quoted; the current `slot0` price is
/// read for sanity gates (pool unlocked, spot inside the valid sqrt-price range) and then discarded, so a
/// single swapped tick cannot move the quote. `quoted` is the TWAP quote; `minimum` is the max of two
/// floors, each discounting its own quote by `maxSlippageBps` and rounding up: the TWAP floor over
/// `twapWindow` and the recent-mean floor over `RECENT_WINDOW` (5 minutes). The executor's floor therefore
/// sits below neither mean, so a sandwich that only moves the last few minutes still cannot drag `minimum`
/// under the recent price.
///
/// Decimals: a V3 pool price is raw `token1` per raw `token0`, so `10^(decimalsOut - decimalsIn)` is
/// already inside the ratio and must NOT be applied again. The quote is computed in raw units with full
/// precision (`_quote`), which is why an 18-decimal and a 6-decimal token quote correctly in both
/// directions. `decimals0` / `decimals1` are stored for off-chain verification only.
///
/// Trust model: the pool address is pinned per chain at deployment and must hold exactly the configured
/// pair. The adapter is stateless per caller (the executor calls it from its own address) and never
/// reads `msg.sender`.
///
/// Sandwich floor (v1.1): when the route itself is priced by this pool, a 30-90 minute mean trails spot in a
/// fast market, so a sale floored only by it could be sandwiched for the gap. The reference semantics are
/// `MandateEntryPrice.recentValue` / `MandateScopeSwapAdapter._saleFloor`: floor the sale additionally at the
/// pool's recent (5 minute) mean, discounted by `maxSlippageBps`, and take the max of the two floors:
/// `minimum = max(TWAP floor, recent-mean floor)`. That costs a second `observe([RECENT_WINDOW, 0])` read per
/// quote, and the pool's observation cardinality must be able to serve both lookbacks; if it cannot, the
/// second read fails closed with `TwapUnavailable` rather than silently dropping to the TWAP floor alone.
///
/// TODO(v1.2) gas/size: `previewSwap` now does two `slot0` + two `observe` reads. Hoist the shared `slot0`
/// sanity gate out of `_meanSqrtPrice` (one read for both windows) and consider caching the pool's
/// cardinality per bucket, but only after measuring the real keeper path; the duplication is deliberate for
/// v1.1 so each window keeps its own fail-closed check.
contract PancakeV3TwapOracle is IOracleFloor {
    // ---- constants ----

    /// @notice Basis-point denominator used for the slippage floor.
    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Shortest admitted TWAP window.
    uint32 public constant MIN_TWAP_WINDOW = 30 minutes;
    /// @notice Longest admitted TWAP window.
    uint32 public constant MAX_TWAP_WINDOW = 90 minutes;
    /// @notice Lookback of the second, recent-mean window: "the pool's mean over the last 5 minutes".
    /// @dev This is the sandwich floor. `twapWindow` is 30-90 minutes, so in a fast market its mean trails spot
    /// and a sale floored only by it can still be sandwiched for the gap; flooring the sale additionally at
    /// the 5 minute mean (discounted by `maxSlippageBps`) and taking the max of the two closes that gap. The
    /// window must stay strictly shorter than `twapWindow` (enforced in the constructor) so the two means stay
    /// distinguishable, and the pool's observation cardinality must be able to serve `observe([300, 0])` too.
    uint32 public constant RECENT_WINDOW = 5 minutes;
    /// @notice Smallest tick the pool can hold (also the smallest tick this adapter will quote).
    int24 public constant MIN_TICK = -887_272;
    /// @notice Largest tick the pool can hold (also the largest tick this adapter will quote).
    int24 public constant MAX_TICK = 887_272;
    /// @dev Lower bound of Uniswap V3's valid sqrt-price range.
    uint160 internal constant MIN_SQRT_RATIO = 4_295_128_739;
    /// @dev Upper bound of Uniswap V3's valid sqrt-price range.
    uint160 internal constant MAX_SQRT_RATIO =
        1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342;
    /// @dev Sanity ceiling on ERC-20 decimals; bStock and the quote assets settle well below it.
    uint8 internal constant MAX_DECIMALS = 18;
    /// @dev Second operand of the `observe` windows (`[twapWindow, 0]`).
    uint256 internal constant LATEST_OBSERVATION = 0;

    // ---- configuration ----

    /// @notice Pinned PancakeSwap V3 pool. Immutable: a wrong pool means redeploy, never re-point.
    IPancakeV3Pool public immutable pool;
    /// @notice Lower-address pool token (price denominator).
    address public immutable token0;
    /// @notice Higher-address pool token (price numerator).
    address public immutable token1;
    /// @notice Decimals of `token0` (informational; the raw ratio already embeds both decimals).
    uint8 public immutable decimals0;
    /// @notice Decimals of `token1` (informational; the raw ratio already embeds both decimals).
    uint8 public immutable decimals1;
    /// @notice TWAP lookback in seconds (30-90 minutes).
    uint32 public immutable twapWindow;
    /// @notice Discount applied to the oracle quote to form `minimum`, in basis points.
    uint16 public immutable maxSlippageBps;
    /// @notice Oldest price data this adapter is allowed to use; `twapWindow` must not exceed it.
    uint32 public immutable maxOracleAge;

    // ---- errors ----

    error InvalidConfig();
    error UnsupportedPair();
    error ZeroAmount();
    error ZeroQuote();
    error TwapUnavailable();
    error InvalidPoolPrice();

    /// @param pool_ PancakeSwap V3 pool holding exactly `tokenA_` and `tokenB_`.
    /// @param tokenA_ First leg of the pair (either order; `token0`/`token1` are read from the pool).
    /// @param tokenB_ Second leg of the pair.
    /// @param twapWindow_ TWAP lookback, 30 minutes to 90 minutes inclusive.
    /// @param maxSlippageBps_ Discount from the TWAP quote to the floor, 1..9999 bps.
    /// @param maxOracleAge_ Upper bound on the age of price data; must be at least `twapWindow_`.
    constructor(
        address pool_,
        address tokenA_,
        address tokenB_,
        uint32 twapWindow_,
        uint16 maxSlippageBps_,
        uint32 maxOracleAge_
    ) {
        if (pool_ == address(0) || pool_.code.length == 0) revert InvalidConfig();
        if (tokenA_ == address(0) || tokenB_ == address(0) || tokenA_ == tokenB_) revert InvalidConfig();
        if (twapWindow_ < MIN_TWAP_WINDOW || twapWindow_ > MAX_TWAP_WINDOW) revert InvalidConfig();
        // The recent-mean window is the sandwich floor, so it must be strictly shorter than the TWAP window:
        // at equal length the second floor would be a duplicate read, and at a longer one `RECENT_WINDOW`
        // would stop meaning "recent". Unreachable while `MIN_TWAP_WINDOW` is 30 minutes, kept as a guard on
        // the relationship itself so a future widening of the TWAP range cannot silently break the floor.
        if (RECENT_WINDOW >= twapWindow_) revert InvalidConfig();
        // A 0 floor is no floor, and a 10000 bps discount would make `minimum` zero on every swap.
        if (maxSlippageBps_ == 0 || maxSlippageBps_ >= BPS_DENOMINATOR) revert InvalidConfig();
        if (maxOracleAge_ < twapWindow_) revert InvalidConfig();

        IPancakeV3Pool poolInterface = IPancakeV3Pool(pool_);
        address poolToken0 = poolInterface.token0();
        address poolToken1 = poolInterface.token1();
        if (!((poolToken0 == tokenA_ && poolToken1 == tokenB_)
                    || (poolToken0 == tokenB_ && poolToken1 == tokenA_))) revert InvalidConfig();

        uint8 dec0 = IERC20Metadata(poolToken0).decimals();
        uint8 dec1 = IERC20Metadata(poolToken1).decimals();
        if (dec0 > MAX_DECIMALS || dec1 > MAX_DECIMALS) revert InvalidConfig();

        pool = poolInterface;
        token0 = poolToken0;
        token1 = poolToken1;
        decimals0 = dec0;
        decimals1 = dec1;
        twapWindow = twapWindow_;
        maxSlippageBps = maxSlippageBps_;
        maxOracleAge = maxOracleAge_;
    }

    // ---- IOracleFloor ----

    /// @inheritdoc IOracleFloor
    /// @dev Fails closed: zero input, an unsupported pair, an immature pool oracle (either window), a pool
    /// outside the valid price range, a mean tick outside the valid tick range, or a quote that rounds to zero
    /// all revert instead of returning a floor of zero.
    ///
    /// `quoted` is the TWAP quote. `minimum` is the max of two independently discounted floors, matching
    /// `MandateScopeSwapAdapter._saleFloor`: the TWAP floor over `twapWindow` and the recent-mean floor over
    /// `RECENT_WINDOW`. The recent read fails closed exactly like the TWAP read, so a pool whose
    /// cardinality cannot serve 5 minutes reverts instead of degrading to the TWAP floor alone.
    function previewSwap(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 quoted, uint256 minimum)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (tokenIn == tokenOut) revert UnsupportedPair();

        // `tokenIn` must be one of the two pool tokens, and `tokenOut` must be the other. Both sides are
        // checked: a `tokenIn` outside the pair leaves `inIsToken0` false, which on its own would accept any
        // `tokenOut == token0` and quote that unrelated asset off the token1 leg.
        bool inIsToken0 = tokenIn == token0;
        bool inIsToken1 = tokenIn == token1;
        if (!inIsToken0 && !inIsToken1) revert UnsupportedPair();
        if (inIsToken0 ? tokenOut != token1 : tokenOut != token0) revert UnsupportedPair();

        // TWAP floor over the configured 30-90 minute window.
        uint160 sqrtPriceX96 = _meanSqrtPrice(inIsToken0, twapWindow);
        quoted = _quote(amountIn, sqrtPriceX96, inIsToken0);
        if (quoted == 0) revert ZeroQuote();

        minimum = Math.mulDiv(quoted, BPS_DENOMINATOR - maxSlippageBps, BPS_DENOMINATOR, Math.Rounding.Ceil);

        // Recent-mean floor over the last 5 minutes, discounted by the same slippage budget. Taking the max
        // means a sale can never be floored below either mean: a sandwich that only moves the last few
        // minutes lifts the recent floor, and a crash that only moves them leaves the TWAP floor in force.
        uint160 recentSqrtPrice = _meanSqrtPrice(inIsToken0, RECENT_WINDOW);
        uint256 recentQuoted = _quote(amountIn, recentSqrtPrice, inIsToken0);
        uint256 recentFloor =
            Math.mulDiv(recentQuoted, BPS_DENOMINATOR - maxSlippageBps, BPS_DENOMINATOR, Math.Rounding.Ceil);
        if (recentFloor > minimum) minimum = recentFloor;

        if (minimum == 0) revert ZeroQuote();
    }

    // ---- price ----

    /// @dev Mean tick over `[window, 0]` converted to a Q64.96 sqrt price.
    /// @param inIsToken0 True when the sold token is `token0`; sets the direction the mean tick is rounded
    /// in, so the rounded mean never lowers the price of `tokenIn` in `tokenOut`.
    /// @param window Lookback in seconds, either `twapWindow` or `RECENT_WINDOW`.
    function _meanSqrtPrice(bool inIsToken0, uint32 window) private view returns (uint160 sqrtPriceX96) {
        // `observe` reverts when the pool cannot look back `window` seconds (immature ring buffer), but
        // check cardinality first so the failure reads as an oracle problem rather than a raw pool revert.
        (uint160 spotSqrtPrice,,, uint16 observationCardinality,,, bool unlocked) = pool.slot0();
        if (!unlocked || observationCardinality < 2) revert TwapUnavailable();
        if (spotSqrtPrice < MIN_SQRT_RATIO || spotSqrtPrice >= MAX_SQRT_RATIO) revert InvalidPoolPrice();

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        secondsAgos[1] = uint32(LATEST_OBSERVATION);

        int56[] memory tickCumulatives;
        try pool.observe(secondsAgos) returns (int56[] memory ticks, uint160[] memory) {
            tickCumulatives = ticks;
        } catch {
            revert TwapUnavailable();
        }
        // Fail closed on any shape the pool returns other than the two points this adapter asked for.
        if (tickCumulatives.length != 2) revert TwapUnavailable();

        int56 delta;
        // Cumulative ticks are int56 and intentionally wrap; a bounded window uses the wrapped difference.
        unchecked {
            delta = tickCumulatives[1] - tickCumulatives[0];
        }

        int56 windowInt = int56(uint56(window));
        int56 meanTick = delta / windowInt;
        // Solidity integer division truncates toward zero, so a non-zero remainder leaves the mean one
        // tick closer to zero than the true mean: nudge it to the side that raises `tokenIn`'s price.
        if (delta % windowInt != 0) {
            if (inIsToken0 && delta > 0) {
                ++meanTick;
            } else if (!inIsToken0 && delta < 0) {
                --meanTick;
            }
        }
        if (meanTick < MIN_TICK || meanTick > MAX_TICK) revert InvalidPoolPrice();

        sqrtPriceX96 = TickMathLite.getSqrtPriceAtTick(int24(meanTick));
    }

    /// @dev Raw exact-value conversion at `sqrtPriceX96`, rounded up so the floor is never the weak side.
    /// @param amountIn Raw `tokenIn` units.
    /// @param sqrtPriceX96 Pool sqrt price (raw token1 per raw token0) as Q64.96.
    /// @param inIsToken0 True when `tokenIn` is `token0` (output = amountIn * price).
    function _quote(uint256 amountIn, uint160 sqrtPriceX96, bool inIsToken0) private pure returns (uint256) {
        if (sqrtPriceX96 <= type(uint128).max) {
            // price = sqrtPriceX96^2 / 2^192, held exactly in a Q128.128 ratio.
            uint256 ratioX128 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
            return inIsToken0
                ? Math.mulDiv(amountIn, ratioX128, 1 << 192, Math.Rounding.Ceil)
                : Math.mulDiv(amountIn, 1 << 192, ratioX128, Math.Rounding.Ceil);
        }
        // sqrtPriceX96^2 would overflow: keep 128 fractional bits instead of 192.
        if (inIsToken0) {
            uint256 ratioX128 = Math.mulDiv(uint256(sqrtPriceX96), sqrtPriceX96, 1 << 64, Math.Rounding.Ceil);
            return Math.mulDiv(amountIn, ratioX128, 1 << 128, Math.Rounding.Ceil);
        }
        uint256 ratioX128 = Math.mulDiv(uint256(sqrtPriceX96), sqrtPriceX96, 1 << 64, Math.Rounding.Floor);
        return Math.mulDiv(amountIn, 1 << 128, ratioX128, Math.Rounding.Ceil);
    }
}

/// @title TickMathLite
/// @notice Tick to sqrt-price conversion for the adapter, kept in-repo so the ATP stack has no
/// Uniswap/PancakeSwap library dependency.
/// @dev Same algorithm and the same magic constants as Uniswap V3 `TickMath.getSqrtRatioAtTick`
/// (verified against the upstream table), so a mean tick resolves to the identical Q64.96 price.
library TickMathLite {
    /// @notice Lowest tick a V3 pool can hold.
    int24 internal constant MIN_TICK = -887_272;
    /// @notice Highest tick a V3 pool can hold.
    int24 internal constant MAX_TICK = 887_272;

    error TickOutOfRange(int256 tick);

    /// @notice sqrt(1.0001^tick) as a Q64.96 value.
    /// @dev Reverts outside [MIN_TICK, MAX_TICK]; at the bounds it returns the pool's own minimum and
    /// maximum sqrt prices.
    function getSqrtPriceAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        unchecked {
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
            if (absTick > uint256(int256(MAX_TICK))) revert TickOutOfRange(tick);

            uint256 ratio =
                absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

            // The product is Q128.128 of 1/sqrt(1.0001)^|tick|; positive ticks need its reciprocal.
            if (tick > 0) ratio = type(uint256).max / ratio;

            // Q128.128 -> Q64.96, rounding up so the price is never understated.
            sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }
}
