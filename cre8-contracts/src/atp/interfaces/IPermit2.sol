// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IPermit2
/// @notice The one Permit2 entry point the ATP executor uses.
/// @dev PancakeSwap's Universal Router does not pull ERC20 with a plain `transferFrom` on the caller. Its
/// swap path pays through Permit2 (`Permit2.transferFrom(owner, pool, amount, token)`), and Permit2 only
/// moves funds against an allowance granted *inside Permit2* by the token owner. So the executor needs
/// two legs for every input token: an ERC20 approve to Permit2, and this `approve` that tells Permit2 which
/// spender (the router) may use it, for how much, and until when.
/// @dev Deliberately minimal: the executor never reads Permit2 state, so no `allowance` getter is declared
/// and no `transferFrom` is exposed. Permit2 itself expires the allowance at `expiration`; the executor
/// still resets the ERC20 leg to zero after the swap.
interface IPermit2 {
    /// @param token ERC20 the owner (the caller, here: the executor) has approved to Permit2.
    /// @param spender Address allowed to pull `token` through Permit2 (here: the Universal Router).
    /// @param amount Maximum amount Permit2 may move; `type(uint160).max` is unbounded in Permit2's model.
    /// @param expiration Unix timestamp after which the allowance is dead; the caller chooses the horizon (this repo caps it at 30 days in the backend's MAX_DEADLINE_SECONDS).
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}
