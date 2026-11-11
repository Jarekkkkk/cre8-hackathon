// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IPancakeV3Pool
/// @notice Minimal PancakeSwap V3 pool surface used by the ATP TWAP oracle adapter.
/// @dev Only the members the oracle actually reads, so the adapter stays independent of any vendored
/// Uniswap/PancakeSwap package. `slot0` is declared with its full return list on purpose: a partial
/// tuple would decode every later field at the wrong offset.
interface IPancakeV3Pool {
    /// @notice Packed pool state, in the exact order the pool returns it.
    /// @return sqrtPriceX96 Current spot price as a Q64.96 square root (raw token1 per raw token0).
    /// @return tick Current spot tick.
    /// @return observationIndex Index of the last written oracle observation.
    /// @return observationCardinality Number of oracle observations the pool currently stores.
    /// @return observationCardinalityNext Next cardinality the pool is willing to grow to.
    /// @return feeProtocol Portion of the swap fee taken by the protocol, in hundredths of a bip.
    /// @return unlocked False while a swap callback is in flight.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint32 feeProtocol,
            bool unlocked
        );

    /// @notice Pool token with the lower address; this is the denominator of the pool's price.
    function token0() external view returns (address);

    /// @notice Pool token with the higher address; this is the numerator of the pool's price.
    function token1() external view returns (address);

    /// @notice Swap fee tier in hundredths of a bip (500 = 0.05%, 2500 = 0.25%, 10000 = 1%).
    function fee() external view returns (uint24);

    /// @notice Active in-range liquidity.
    function liquidity() external view returns (uint128);

    /// @notice Cumulative tick values for each requested lookback.
    /// @dev Reverts when the pool cannot look back far enough (for example when
    /// `observationCardinality` is too small for the requested window), which is what the adapter relies
    /// on to fail closed on an immature oracle.
    /// @param secondsAgos Lookbacks in seconds, ascending, oldest first.
    /// @return tickCumulatives Accumulated tick at each lookback, same order as `secondsAgos`.
    /// @return secondsPerLiquidityCumulativeX128s Accumulated seconds-per-liquidity at each lookback.
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}
