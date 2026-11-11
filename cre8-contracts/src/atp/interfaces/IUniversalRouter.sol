// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IUniversalRouter
/// @notice The only aggregator entry point the ATP executor is allowed to call.
/// @dev PancakeSwap's Universal Router, pinned per chain in the executor constructor. The executor never
/// forwards arbitrary calldata to it: commands are allowlisted and every command's recipient must resolve
/// back to the executor (see `AtpExecutor._checkCommands`).
interface IUniversalRouter {
    /// @param commands One command byte per entry in `inputs`.
    /// @param inputs Per-command ABI-encoded payload, decoded by the router according to the command byte.
    /// @param deadline Unix timestamp after which the whole batch reverts.
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @title UniversalRouterCommands
/// @notice Command bytes admitted by the ATP executor (decision log: swap-only, no ETH handling).
/// @dev bStock is a plain ERC-20, so the ETH/WETH commands (WRAP_ETH / UNWRAP_WETH) are out of scope by
/// design. PAY_PORTION, PERMIT2_TRANSFER_FROM, and every other command are rejected outright; the executor
/// matches the exact byte, so flag bits such as FLAG_ALLOW_REVERT are rejected too.
/// Recipient word index refers to the head of the command input: swaps encode `recipient` first, while
/// SWEEP and TRANSFER encode `token` first and `recipient` second.
library UniversalRouterCommands {
    bytes1 internal constant V3_SWAP_EXACT_IN = 0x00;
    bytes1 internal constant V2_SWAP_EXACT_IN = 0x08;
    bytes1 internal constant SWEEP = 0x04;
    bytes1 internal constant TRANSFER = 0x05;
}
