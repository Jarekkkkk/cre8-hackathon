// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IOracleFloor } from "./interfaces/IOracleFloor.sol";
import { PancakeV3TwapOracle } from "./PancakeV3TwapOracle.sol";

/// @title AtpMultiPoolOracle
/// @notice `IOracleFloor` router: one numeraire, one `PancakeV3TwapOracle` per asset, forwarded per call.
/// @dev `AtpExecutor` pins a single immutable `oracle`, and `PancakeV3TwapOracle` pins a single pool, so a
/// stack built from exactly those two contracts can only ever rebalance the one pair that pool holds.
/// Neither link is actually single-pair by nature: `IOracleFloor.previewSwap` is already pair-agnostic (it
/// takes both legs as arguments) and `PancakeV3TwapOracle`'s constructor is generic (pool, tokenA, tokenB),
/// so "one instance per pair" is a deployment choice, not a limitation of either contract. This contract is
/// the missing indirection: a registry from `asset -> per-pair oracle` that answers a quote by forwarding to
/// the right instance. A new index asset then costs one `setOracle` call instead of a redeploy of the
/// money-handling executor, and the TWAP math stays in the one contract whose tests already pin it.
///
/// Scope: v1 prices only the two paths that pass through `numeraire` - `asset -> numeraire` and
/// `numeraire -> asset`. A route where neither leg is the numeraire (`assetA -> assetB`, i.e. a multi-hop
/// route through the numeraire) reverts with `UnsupportedRoute` rather than inventing a path no registered
/// pool prices. The executor consumes the floor as a per-step bound, so refusing an unpriceable step is the
/// fail-closed answer; composing hops needs an explicit route argument in `IOracleFloor`, which is a
/// different change than this one and not something to approximate here.
///
/// Value: this is a read-only quote router and is deliberately built so that it cannot become a second entry
/// point for funds. It has no payable function, no `receive`, no `fallback`, no `transfer` / `transferFrom` /
/// `approve`, and no `call` / `delegatecall`; every outbound call it can make goes through a `view` on a
/// typed interface, which the compiler emits as STATICCALL, so even a hostile implementation behind
/// `PancakeV3TwapOracle` cannot be used to write state from here. It holds no balance and grants no
/// allowance, and the only call the executor ever makes on it is `previewSwap`.
///
/// Access: `owner` is a single key in v1, matching `AtpRegistry` (multisig / timelock before mainnet). A
/// registered oracle's pair is immutable, so the pair check `setOracle` performs once holds for the whole
/// life of the registration - there is no later call that could re-point a registration at the wrong pool.
contract AtpMultiPoolOracle is IOracleFloor {
    // ---- configuration ----

    /// @notice The quote asset every registered pair must contain (for example USDT).
    address public immutable numeraire;
    /// @notice Admin key allowed to register and clear per-asset oracles.
    address public owner;
    /// @dev asset -> the per-pair oracle that prices `asset` against `numeraire`.
    mapping(address asset => PancakeV3TwapOracle oracle) private _oracles;

    // ---- events ----

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OracleSet(address indexed asset, address indexed oracle);
    event OracleCleared(address indexed asset);

    // ---- errors ----

    error NotOwner();
    error ZeroAddress();
    /// @dev The numeraire must be a contract: a quote asset without code is a typo, and every quote against
    /// it would revert downstream rather than here.
    error InvalidNumeraire();
    /// @dev Registered oracle has no code, so its `token0` / `token1` / `previewSwap` cannot be trusted and
    /// the registration would fail open on the first quote.
    error InvalidOracle();
    /// @dev Registering the numeraire against itself; there is no such pair.
    error NumeraireAsAsset();
    /// @dev The oracle's pair does not hold exactly `asset` and `numeraire`. Without this check a
    /// registration would silently price the asset from the wrong pool.
    error PairMismatch(address asset, address oracle);
    /// @dev The asset already has an oracle; `clearOracle` first so replacing a live oracle is deliberate.
    error OracleAlreadySet(address asset);
    error OracleNotSet(address asset);
    /// @dev Both legs are the same token. This is also the `numeraire -> numeraire` case: there is exactly
    /// one numeraire, so a pair with both legs on the numeraire collapses into this check.
    error SameToken();
    /// @dev Neither leg is the numeraire: a multi-hop route, which v1 does not price.
    error UnsupportedRoute(address tokenIn, address tokenOut);

    /// @param numeraire_ Quote asset every registered pair is priced against.
    constructor(address numeraire_) {
        if (numeraire_ == address(0) || numeraire_.code.length == 0) revert InvalidNumeraire();
        numeraire = numeraire_;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ---- IOracleFloor ----

    /// @inheritdoc IOracleFloor
    /// @dev Pure routing, no math: the numeraire leg identifies the asset, the asset's registered oracle
    /// answers, and that answer is returned unchanged. The quote is therefore bit-identical to calling the
    /// pair oracle directly - no re-derivation, no re-rounding, no second slippage discount - which is what
    /// keeps the TWAP and sandwich-floor semantics audited in exactly one contract.
    /// @dev Reverts on: the same token on both legs (`SameToken`, covering `numeraire -> numeraire`), a
    /// route with no numeraire leg (`UnsupportedRoute`, multi-hop is not priced), an asset with no
    /// registration (`OracleNotSet`, never a zero quote as a stand-in for "unknown"). `amountIn == 0` is
    /// rejected by the pair oracle (`ZeroAmount`), so `IOracleFloor`'s zero-input rule still holds on every
    /// path this contract admits.
    function previewSwap(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 quoted, uint256 minimum)
    {
        if (tokenIn == tokenOut) revert SameToken();

        // Exactly one leg must be the numeraire. `tokenIn != tokenOut` above means at most one branch matches.
        address asset;
        if (tokenOut == numeraire) {
            asset = tokenIn;
        } else if (tokenIn == numeraire) {
            asset = tokenOut;
        } else {
            revert UnsupportedRoute(tokenIn, tokenOut);
        }

        PancakeV3TwapOracle oracle = _oracles[asset];
        if (address(oracle) == address(0)) revert OracleNotSet(asset);

        // The pair is re-checked against `tokenIn` / `tokenOut` by the oracle itself; the registration check
        // guarantees that pair is exactly `asset` / `numeraire`, so this forward cannot price a third token.
        return oracle.previewSwap(tokenIn, tokenOut, amountIn);
    }

    // ---- registry ----

    /// @notice The per-pair oracle registered for `asset`, or the zero address when there is none.
    function oracleOf(address asset) external view returns (PancakeV3TwapOracle) {
        return _oracles[asset];
    }

    /// @notice Register the oracle that prices `asset` against `numeraire`.
    /// @dev Validates against a silent mispricing rather than against a revert somewhere downstream: the
    /// oracle must be a contract, and its pair must be exactly `{asset, numeraire}` in either order. The pair
    /// is immutable on `PancakeV3TwapOracle`, so this one check is valid for the life of the registration.
    /// @dev Re-registering an existing asset reverts with `OracleAlreadySet` instead of overwriting: swapping
    /// the oracle that prices a live index is a deliberate act, so it takes an explicit `clearOracle` first.
    /// The checks run cheapest and most actionable first, so an already-registered asset reports
    /// `OracleAlreadySet` even when the supplied oracle would also fail the pair check.
    function setOracle(address asset, PancakeV3TwapOracle oracle) external onlyOwner {
        if (asset == address(0) || address(oracle) == address(0)) revert ZeroAddress();
        if (address(oracle).code.length == 0) revert InvalidOracle();
        if (asset == numeraire) revert NumeraireAsAsset();
        if (address(_oracles[asset]) != address(0)) revert OracleAlreadySet(asset);

        address token0 = oracle.token0();
        address token1 = oracle.token1();
        if (!((token0 == asset && token1 == numeraire) || (token0 == numeraire && token1 == asset))) {
            revert PairMismatch(asset, address(oracle));
        }

        _oracles[asset] = oracle;
        emit OracleSet(asset, address(oracle));
    }

    /// @notice Remove `asset`'s oracle, making that asset unquotable until a new one is registered.
    /// @dev Exists so that `setOracle` can refuse to overwrite: retiring a live oracle is then two explicit
    /// statements instead of one accidental one, and the gap in between fails closed with `OracleNotSet`.
    function clearOracle(address asset) external onlyOwner {
        if (address(_oracles[asset]) == address(0)) revert OracleNotSet(asset);
        delete _oracles[asset];
        emit OracleCleared(asset);
    }

    // ---- admin ----

    /// @notice Hand the registry role to `next`. Single-step on purpose in v1, as in `AtpRegistry`: a
    /// two-step handover lands together with the multisig.
    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, next);
        owner = next;
    }
}
