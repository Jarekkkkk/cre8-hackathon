// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Script, console } from "forge-std/Script.sol";
import { AtpRegistry } from "../src/atp/AtpRegistry.sol";
import { AtpExecutor } from "../src/atp/AtpExecutor.sol";
import { AtpMultiPoolOracle } from "../src/atp/AtpMultiPoolOracle.sol";
import { PancakeV3TwapOracle } from "../src/atp/PancakeV3TwapOracle.sol";
import { IUniversalRouter } from "../src/atp/interfaces/IUniversalRouter.sol";
import { IOracleFloor } from "../src/atp/interfaces/IOracleFloor.sol";

/// @dev Minimal PancakeSwap V3 factory: `getPool` is the only call this script makes to it.
interface IV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

/// @title DeployAtp
/// @notice Deploys the ATP stack against BSC mainnet (chain 56) addresses. Pools are resolved at runtime
/// through the PancakeSwap V3 factory, so a fork of any block height that holds the pools deploys identically.
///
/// @dev Idempotency. `forge script` cannot read or write files here: `foundry.toml` grants no
/// `fs_permissions` (the default is read-only on `out/`), so the address book lives in this file as
/// constants instead of being read back from `deployments/fork.json`. Rerunning is therefore the same single
/// command with no arguments to remember and no environment to get wrong - the two ways a "reuse the existing
/// deployment" flag usually leaks a duplicate registry. Every entry is reused when its address still has
/// code, and redeployed only when it does not (a fork that lost its state), so a stale book heals instead of
/// producing a second registry that silently strands every enrollment.
///
/// @dev A reused contract is never trusted blindly: the pin that makes reuse safe (its pool, its numeraire,
/// its registry and oracle pointers) is re-read from chain, and a mismatch reverts here rather than yielding
/// a deployment that looks fine and quotes the wrong pool. `deployments/fork.json` is the human-readable
/// record of what this script produced, not its input.
///
/// @dev Deployment order is fixed and must stay so: the addresses below are the ones a run over an empty
/// address book prints, and reordering `new` calls reassigns the nonces.
contract DeployAtp is Script {
    // ---- address book for this fork (chain 56) ----
    // An entry is reused when it still has code; otherwise it is deployed again and printed for the record.
    //
    // Retired per-pair oracles (buggy pair check: they accepted a `tokenIn` outside their own pool and quoted
    // it off the `token1` leg). Kept here as the record of what was replaced, never referenced again:
    //   ORACLE_WBNB_USDT v1 = 0x3e736BF184C3FBEF85909A6407bD2Cc3Af6ba3DB
    //   ORACLE_NVDAB_USDT v1 = 0xD14e18278cDe758E9cC6f3214f5766E7917dCE25
    // The router and the executor are untouched by that fix: the executor points at the router, and the router
    // points at whichever per-pair oracle is registered, so only these two addresses move.
    address internal constant REGISTRY = 0x27739a1AD35a924F5545C7d04C2B0537069CA76C;
    address internal constant ORACLE_WBNB_USDT = 0x535111F60a9cB7C3b95A17fB8d1dd2D17275DBFE;
    address internal constant ORACLE_NVDAB_USDT = 0x12Ce4542B25fe53a3c606dd7783513357b6D838d;
    address internal constant MULTI_POOL_ORACLE = 0x132cDfCe34d385f783dAB7F011B2E66E78A2f87f;
    address internal constant EXECUTOR_MULTI_POOL = 0x9C41696ea7FaA5470eAfb77415D063beEef83f4a;

    /// @dev Not a token of any pool this stack prices, so every per-pair oracle must refuse it. Used to tell a
    /// fixed oracle from the retired one: both pin the same pool and answer every legitimate pair identically.
    address internal constant STRAY_PROBE = address(0x1);

    // ---- BSC mainnet (chain 56) pins ----
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant NVDAB = 0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436;
    address internal constant V3_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    address internal constant V3_UNIVERSAL_ROUTER = 0x1A0A18AC4BECDDbd6389559687d1A73d8927E416;
    address internal constant PERMIT2 = 0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768;

    uint24 internal constant WBNB_USDT_FEE = 500;
    uint24 internal constant WBNB_USDT_FEE_FALLBACK = 2500;
    uint24 internal constant NVDAB_USDT_FEE = 2500;

    // ---- oracle config (matches the fork suite) ----
    uint32 internal constant TWAP_WINDOW = 30 minutes;
    uint16 internal constant MAX_SLIPPAGE_BPS = 100;
    uint32 internal constant MAX_ORACLE_AGE = 3600;

    struct Deployment {
        AtpRegistry registry;
        PancakeV3TwapOracle oracleWbnbUsdt;
        PancakeV3TwapOracle oracleNvdabUsdt;
        AtpMultiPoolOracle multiPoolOracle;
        AtpExecutor executorMultiPool;
        address wbnbUsdtPool;
        uint24 wbnbUsdtFee;
        address nvdabUsdtPool;
    }

    function run() external {
        Deployment memory d;

        // Pools are resolved through the factory rather than hardcoded, and the 0.05% / 0.25% fallback on
        // WBNB/USDT is kept: an oracle pins one pool forever, so a wrong one is a redeploy.
        d.wbnbUsdtFee = WBNB_USDT_FEE;
        d.wbnbUsdtPool = IV3Factory(V3_FACTORY).getPool(WBNB, USDT, WBNB_USDT_FEE);
        if (d.wbnbUsdtPool == address(0)) {
            d.wbnbUsdtFee = WBNB_USDT_FEE_FALLBACK;
            d.wbnbUsdtPool = IV3Factory(V3_FACTORY).getPool(WBNB, USDT, WBNB_USDT_FEE_FALLBACK);
        }
        require(d.wbnbUsdtPool != address(0), "no WBNB/USDT pool at 500 or 2500");
        d.nvdabUsdtPool = IV3Factory(V3_FACTORY).getPool(NVDAB, USDT, NVDAB_USDT_FEE);
        require(d.nvdabUsdtPool != address(0), "no NVDAB/USDT pool at 2500");

        vm.startBroadcast();

        bool created;

        // 1. Registry (owner = deployer). Reused whenever it survives: it holds the enrollment state.
        (d.registry, created) = _reuseRegistry(REGISTRY);
        _row("registry", created, address(d.registry));

        // 2. One oracle per pair, all against the same numeraire (USDT).
        (d.oracleWbnbUsdt, created) = _reuseOracle(ORACLE_WBNB_USDT, WBNB, d.wbnbUsdtPool);
        _row("oracleWbnbUsdt", created, address(d.oracleWbnbUsdt));
        (d.oracleNvdabUsdt, created) = _reuseOracle(ORACLE_NVDAB_USDT, NVDAB, d.nvdabUsdtPool);
        _row("oracleNvdabUsdt", created, address(d.oracleNvdabUsdt));

        // 3. The router: asset -> per-pair oracle, numeraire = USDT.
        (d.multiPoolOracle, created) = _reuseMultiPool(MULTI_POOL_ORACLE);
        _row("multiPoolOracle", created, address(d.multiPoolOracle));

        // 4. Register both pairs. `setOracle` refuses to overwrite, so the oracle itself is the guard.
        _register(d.multiPoolOracle, WBNB, d.oracleWbnbUsdt);
        _register(d.multiPoolOracle, NVDAB, d.oracleNvdabUsdt);

        // 5. Executor pinned to the router. Reused only while it still points at the router and at the same
        //    registry; the v1 executor (oracle = the WBNB/USDT pair oracle) can never satisfy that.
        (d.executorMultiPool, created) = _reuseExecutor(EXECUTOR_MULTI_POOL, d.registry, d.multiPoolOracle);
        _row("executorMultiPool", created, address(d.executorMultiPool));

        vm.stopBroadcast();

        _report(d);
    }

    // ---------------------------------------------------------------- idempotent deployment

    /// @dev A recorded address is reusable only if it still has code: after a fork reset the book keeps its
    /// entries while the chain behind them is empty, and reusing a dead address would hand out a deployment
    /// that reverts on first use.
    function _live(address recorded) internal view returns (bool) {
        return recorded != address(0) && recorded.code.length != 0;
    }

    function _reuseRegistry(address recorded) internal returns (AtpRegistry registry, bool created) {
        if (_live(recorded)) return (AtpRegistry(recorded), false);
        return (new AtpRegistry(), true);
    }

    function _reuseOracle(address recorded, address asset, address pool)
        internal
        returns (PancakeV3TwapOracle oracle, bool created)
    {
        if (!_live(recorded)) {
            return (
                new PancakeV3TwapOracle(pool, asset, USDT, TWAP_WINDOW, MAX_SLIPPAGE_BPS, MAX_ORACLE_AGE),
                true
            );
        }
        oracle = PancakeV3TwapOracle(recorded);
        require(
            address(oracle.pool()) == pool, "recorded oracle pins a different pool: clear its address first"
        );
        _requireFixedPairCheck(oracle);
        return (oracle, false);
    }

    /// @dev The pool pin alone cannot tell the fixed oracle from the retired one: both pin the same pool and
    /// answer every legitimate pair identically. Reuse therefore also probes the pair check with a token that
    /// belongs to no pool, and re-reads a legitimate pair so that a pool which cannot serve a TWAP reports
    /// itself instead of letting the probe pass for the wrong reason.
    function _requireFixedPairCheck(PancakeV3TwapOracle oracle) internal view {
        try oracle.previewSwap(STRAY_PROBE, oracle.token0(), 1e18) returns (uint256, uint256) {
            revert("recorded oracle prices a tokenIn outside its pair: clear its address first");
        } catch {
            // Refused, which is what the two-sided check is there to do.
        }
        (uint256 quoted,) = oracle.previewSwap(oracle.token0(), oracle.token1(), 1e18);
        require(quoted != 0, "recorded oracle cannot quote its own pair: clear its address first");
    }

    function _reuseMultiPool(address recorded) internal returns (AtpMultiPoolOracle multiPool, bool created) {
        if (!_live(recorded)) return (new AtpMultiPoolOracle(USDT), true);
        multiPool = AtpMultiPoolOracle(recorded);
        require(
            multiPool.numeraire() == USDT,
            "recorded router has a different numeraire: clear its address first"
        );
        return (multiPool, false);
    }

    function _reuseExecutor(address recorded, AtpRegistry registry, AtpMultiPoolOracle multiPool)
        internal
        returns (AtpExecutor executor, bool created)
    {
        if (_live(recorded)) {
            AtpExecutor candidate = AtpExecutor(recorded);
            // Fee recipient = deployer for the fork; point it at a treasury before mainnet.
            if (
                address(candidate.oracle()) == address(multiPool)
                    && address(candidate.registry()) == address(registry)
            ) {
                return (candidate, false);
            }
        }
        return (
            new AtpExecutor(
                registry,
                IUniversalRouter(V3_UNIVERSAL_ROUTER),
                IOracleFloor(address(multiPool)),
                PERMIT2,
                msg.sender
            ),
            true
        );
    }

    /// @dev Registration is safe to repeat, and deliberately not a single overwriting call. The router answers
    /// a re-registration with `OracleAlreadySet` rather than overwriting, so moving an asset to a different
    /// oracle takes two explicit statements: `clearOracle` then `setOracle`.
    ///
    /// The gap between them leaves the asset unquotable and the router fails closed with `OracleNotSet` for
    /// that one statement. That window is deliberate and acceptable - it is strictly narrower than an in-place
    /// overwrite, and it is the price of an auditable oracle swap instead of a silent one. Both steps are read
    /// back, so a run that stops in the middle reports the state it actually left rather than assuming it.
    function _register(AtpMultiPoolOracle multiPool, address asset, PancakeV3TwapOracle oracle) internal {
        address current = address(multiPool.oracleOf(asset));
        if (current == address(oracle)) {
            console.log(
                string.concat("register            SKIP  ", vm.toString(asset), " already on this oracle")
            );
            return;
        }
        if (current != address(0)) {
            multiPool.clearOracle(asset);
            require(address(multiPool.oracleOf(asset)) == address(0), "clearOracle did not clear");
            console.log(
                string.concat("clearOracle         CLEAR ", vm.toString(asset), " was ", vm.toString(current))
            );
        }
        multiPool.setOracle(asset, oracle);
        require(address(multiPool.oracleOf(asset)) == address(oracle), "setOracle did not take");
        console.log(
            string.concat(
                "setOracle           SET   ", vm.toString(asset), " -> ", vm.toString(address(oracle))
            )
        );
    }

    // ---------------------------------------------------------------- reporting

    function _row(string memory label, bool created, address target) internal {
        console.log(
            string.concat(label, created ? string(": NEW   ") : string(": REUSE "), vm.toString(target))
        );
    }

    /// @dev Printed as `key = address` so the block can be pasted into `deployments/fork.json` and read by
    /// eye against the constants above.
    function _report(Deployment memory d) internal {
        console.log("");
        console.log("--- address book (deployments/fork.json) ---");
        console.log(string.concat("registry          = ", vm.toString(address(d.registry))));
        console.log(string.concat("oracleWbnbUsdt    = ", vm.toString(address(d.oracleWbnbUsdt))));
        console.log(string.concat("oracleNvdabUsdt   = ", vm.toString(address(d.oracleNvdabUsdt))));
        console.log(string.concat("multiPoolOracle   = ", vm.toString(address(d.multiPoolOracle))));
        console.log(string.concat("executorMultiPool = ", vm.toString(address(d.executorMultiPool))));
        console.log(string.concat("pool (WBNB/USDT)  = ", vm.toString(d.wbnbUsdtPool)));
        console.log(string.concat("pool (NVDAB/USDT) = ", vm.toString(d.nvdabUsdtPool)));
        console.log("--- router.oracleOf() readback ---");
        console.log(
            string.concat("oracleOf(WBNB)    = ", vm.toString(address(d.multiPoolOracle.oracleOf(WBNB))))
        );
        console.log(
            string.concat("oracleOf(NVDAB)   = ", vm.toString(address(d.multiPoolOracle.oracleOf(NVDAB))))
        );
    }
}
