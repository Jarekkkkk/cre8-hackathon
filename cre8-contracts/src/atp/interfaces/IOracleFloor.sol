// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IOracleFloor
/// @notice The oracle floor the ATP executor enforces on every swap step.
/// @dev Deliberately narrow: the executor only ever needs one floor number per exact-input swap, so the
/// implementation is expected to be an adapter over the existing price path rather than a new oracle.
/// The reference semantics are `MandateScopeSwapAdapter.previewSwap` (see
/// `src/composite/MandateScopeSwapAdapter.sol`): `minimum` is the oracle-implied output discounted by
/// `maxSlippageBps`, and for a sale (where the route is priced by a trailing 30-90 minute pool mean) it is
/// additionally floored at the pool's recent mean value, so a sandwich against the stale mean cannot pass.
interface IOracleFloor {
    /// @notice Exact-input quote plus the floor the executor may require.
    /// @param tokenIn Token being sold.
    /// @param tokenOut Token being bought.
    /// @param amountIn Exact input amount, already denominated in `tokenIn` units.
    /// @return quoted Oracle-implied output before slippage.
    /// @return minimum Floor on the output of this swap: `ceil(quoted * (10000 - maxSlippageBps) / 10000)`,
    /// raised for sales to the route's recent-mean floor. Always non-zero for a priced pair; a bound, not a
    /// promise that the AMM would execute this size at this price.
    /// @dev MUST revert when the pair is unpriced or a required feed is stale, and MUST reject `amountIn == 0`.
    /// Implementations must not be stateful per caller: the executor calls this from its own address.
    function previewSwap(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 quoted, uint256 minimum);
}
