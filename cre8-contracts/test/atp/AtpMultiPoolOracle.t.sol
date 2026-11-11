// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { AtpMultiPoolOracle } from "../../src/atp/AtpMultiPoolOracle.sol";
import { PancakeV3TwapOracle } from "../../src/atp/PancakeV3TwapOracle.sol";
import { IOracleFloor } from "../../src/atp/interfaces/IOracleFloor.sol";

/// @dev ERC-20 metadata stub: `PancakeV3TwapOracle` reads `decimals()` at construction only.
contract MockToken {
    uint8 public immutable decimals;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }
}

/// @dev Two-window PancakeSwap V3 pool stub with the same shape as the one `PancakeV3TwapOracle.t.sol`
/// drives: it answers the configured TWAP window and the oracle's 5 minute recent window, each carrying the
/// same mean tick, so a quote through the router can be compared bit for bit with a direct oracle call.
/// Redefined here rather than imported so this suite does not depend on the internals of another test file
/// (which the router work is not allowed to touch).
contract MockPool {
    /// @dev Mirrors `PancakeV3TwapOracle.RECENT_WINDOW`; the mock serves the oracle's two-window shape.
    uint32 public constant RECENT_WINDOW = 5 minutes;

    address public immutable token0;
    address public immutable token1;

    uint160 public sqrtPriceX96 = 79_228_162_514_264_337_593_543_950_336; // 2^96, tick 0
    uint16 public observationCardinality = 2;
    bool public unlocked = true;

    uint32 public window;
    int56 public cumulativeAtWindow;
    int56 public cumulativeNow;
    int56 public cumulativeAtRecent;

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
        ticks = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 i; i < secondsAgos.length; ++i) {
            uint32 secondsAgo = secondsAgos[i];
            if (secondsAgo == 0) {
                ticks[i] = cumulativeNow;
            } else if (secondsAgo == window) {
                ticks[i] = cumulativeAtWindow;
            } else if (secondsAgo == RECENT_WINDOW) {
                ticks[i] = cumulativeAtRecent;
            } else {
                revert("mock: unsupported lookback");
            }
        }
    }

    // ---- test controls ----

    /// @dev Cumulatives whose mean tick is `meanTick` over both `window_` and the recent window.
    function setMeanTick(int24 meanTick, uint32 window_) external {
        window = window_;
        cumulativeAtWindow = 0;
        cumulativeNow = int56(meanTick) * int56(uint56(window_));
        cumulativeAtRecent = cumulativeNow - int56(meanTick) * int56(uint56(RECENT_WINDOW));
    }

    function setObservationCardinality(uint16 cardinality) external {
        observationCardinality = cardinality;
    }
}

/// @notice Pins `AtpMultiPoolOracle`: quotes are forwarded bit for bit to the per-pair `PancakeV3TwapOracle`,
/// both directions are priced, every unpriced route fails closed, `setOracle` cannot register a pair that
/// would misprice an asset, and the router has no fund-moving surface.
contract AtpMultiPoolOracleTest is Test {
    uint32 internal constant WINDOW = 30 minutes;
    uint16 internal constant MAX_SLIPPAGE_BPS = 50;
    uint32 internal constant MAX_ORACLE_AGE = 1 hours;

    address internal constant OUTSIDER = address(0xB0B);

    /// @dev 18 decimals, the shape of BSC-USDT, the numeraire of every registered pair.
    MockToken internal numeraire;
    /// @dev 6 decimals: the decimals trap the pair oracle already handles, asserted again through the router.
    MockToken internal asset6;
    /// @dev 18 decimals, a second asset so the router has to pick between two registrations.
    MockToken internal asset18;
    /// @dev Plausible token with no registration.
    MockToken internal stranger;

    MockPool internal poolAsset6;
    MockPool internal poolAsset18;

    PancakeV3TwapOracle internal oracleAsset6;
    PancakeV3TwapOracle internal oracleAsset18;

    AtpMultiPoolOracle internal router;

    function setUp() public {
        numeraire = new MockToken(18);
        asset6 = new MockToken(6);
        asset18 = new MockToken(18);
        stranger = new MockToken(18);

        // Tick -276324 is a raw ratio of about 1e-12, i.e. one 18-decimal numeraire unit buys about one
        // 6-decimal asset unit. Tick 0 is raw parity, which keeps the second pair's numbers obvious.
        (poolAsset6, oracleAsset6) = _deployPair(numeraire, asset6, -276_324);
        (poolAsset18, oracleAsset18) = _deployPair(numeraire, asset18, 0);

        router = new AtpMultiPoolOracle(address(numeraire));
        router.setOracle(address(asset6), oracleAsset6);
        router.setOracle(address(asset18), oracleAsset18);
    }

    // ---- pricing ----

    /// @dev The core claim of the router: it adds no math. Quoting through it returns exactly what the pair
    /// oracle returns, in both directions, for the same fixture `PancakeV3TwapOracle.t.sol` pins.
    function test_previewSwap_matchesThePairOracleBitForBit() public view {
        (uint256 routedQuoted, uint256 routedMinimum) =
            router.previewSwap(address(numeraire), address(asset6), 1000e18);
        (uint256 directQuoted, uint256 directMinimum) =
            oracleAsset6.previewSwap(address(numeraire), address(asset6), 1000e18);
        assertEq(routedQuoted, directQuoted, "numeraire -> asset quoted");
        assertEq(routedMinimum, directMinimum, "numeraire -> asset minimum");
        // Same numbers `PancakeV3TwapOracle.t.sol::test_quotesAcrossDecimalsInTheRawRatio` pins for this
        // fixture, so the forwarding path demonstrably preserves the decimals-neutral raw ratio and the floor.
        assertEq(routedQuoted, 1_000_002_644, "18 -> 6 quote");
        assertEq(routedMinimum, 995_002_631, "50 bps floor");

        (uint256 routedBackQuoted, uint256 routedBackMinimum) =
            router.previewSwap(address(asset6), address(numeraire), 1000e6);
        (uint256 directBackQuoted, uint256 directBackMinimum) =
            oracleAsset6.previewSwap(address(asset6), address(numeraire), 1000e6);
        assertEq(routedBackQuoted, directBackQuoted, "asset -> numeraire quoted");
        assertEq(routedBackMinimum, directBackMinimum, "asset -> numeraire minimum");
        assertEq(routedBackQuoted, 999_997_356_176_039_153_114, "6 -> 18 quote");
        assertEq(routedBackMinimum, 994_997_369_395_158_957_349, "50 bps floor");
    }

    function testFuzz_previewSwap_matchesThePairOracleBitForBit(uint96 amountIn) public view {
        uint256 amount = bound(uint256(amountIn), 1, type(uint96).max);

        (uint256 routedQuoted, uint256 routedMinimum) =
            router.previewSwap(address(numeraire), address(asset18), amount);
        (uint256 directQuoted, uint256 directMinimum) =
            oracleAsset18.previewSwap(address(numeraire), address(asset18), amount);
        assertEq(routedQuoted, directQuoted, "numeraire -> asset quoted");
        assertEq(routedMinimum, directMinimum, "numeraire -> asset minimum");

        (uint256 routedBackQuoted, uint256 routedBackMinimum) =
            router.previewSwap(address(asset18), address(numeraire), amount);
        (uint256 directBackQuoted, uint256 directBackMinimum) =
            oracleAsset18.previewSwap(address(asset18), address(numeraire), amount);
        assertEq(routedBackQuoted, directBackQuoted, "asset -> numeraire quoted");
        assertEq(routedBackMinimum, directBackMinimum, "asset -> numeraire minimum");
    }

    function test_previewSwap_pricesBothDirections() public view {
        (uint256 quotedSell, uint256 minimumSell) =
            router.previewSwap(address(numeraire), address(asset6), 1000e18);
        assertGt(quotedSell, 0, "numeraire -> asset quoted");
        assertGt(minimumSell, 0, "numeraire -> asset floored");

        (uint256 quotedBuy, uint256 minimumBuy) =
            router.previewSwap(address(asset6), address(numeraire), 1000e6);
        assertGt(quotedBuy, 0, "asset -> numeraire quoted");
        assertGt(minimumBuy, 0, "asset -> numeraire floored");
        assertLt(minimumSell, quotedSell, "floor sits below the quote");
        assertLt(minimumBuy, quotedBuy, "floor sits below the quote");
    }

    /// @dev The reason the router exists: two assets, two per-pair oracles, one immutable `oracle` slot.
    function test_previewSwap_routesEachAssetToItsOwnPair() public view {
        (uint256 quoted6,) = router.previewSwap(address(numeraire), address(asset6), 1000e18);
        (uint256 quoted18,) = router.previewSwap(address(numeraire), address(asset18), 1000e18);

        (uint256 direct6,) = oracleAsset6.previewSwap(address(numeraire), address(asset6), 1000e18);
        (uint256 direct18,) = oracleAsset18.previewSwap(address(numeraire), address(asset18), 1000e18);

        assertEq(quoted6, direct6, "asset6 routed to its own oracle");
        assertEq(quoted18, direct18, "asset18 routed to its own oracle");
        assertEq(quoted18, 1000e18, "tick 0 parity");
        assertTrue(quoted6 != quoted18, "the two assets must not share a quote");
    }

    /// @dev `previewSwap` is declared `view`, so the executor reaches it with STATICCALL; if the router ever
    /// wrote state the call would revert here. This is the EVM-level form of "it cannot move funds".
    function test_previewSwap_answersUnderStaticcall() public {
        (bool ok, bytes memory data) = address(router)
            .staticcall(
                abi.encodeCall(IOracleFloor.previewSwap, (address(numeraire), address(asset6), 1000e18))
            );
        assertTrue(ok, "quote must answer under STATICCALL");
        (uint256 quoted, uint256 minimum) = abi.decode(data, (uint256, uint256));
        assertEq(quoted, 1_000_002_644, "18 -> 6 quote");
        assertEq(minimum, 995_002_631, "50 bps floor");
    }

    /// @dev The router is stateless per caller: the executor calls it from its own address, so an answer that
    /// depended on `msg.sender` would be wrong.
    function test_previewSwap_isCallerIndependent() public {
        (uint256 quotedFromTest,) = router.previewSwap(address(numeraire), address(asset6), 1000e18);

        vm.prank(OUTSIDER);
        (uint256 quotedFromOutsider, uint256 minimumFromOutsider) =
            router.previewSwap(address(numeraire), address(asset6), 1000e18);
        assertEq(quotedFromOutsider, quotedFromTest, "quote must not depend on the caller");
        assertEq(minimumFromOutsider, 995_002_631, "floor must not depend on the caller");
    }

    // ---- fail-closed routing ----

    function test_previewSwap_revertsForUnregisteredAsset() public {
        vm.expectRevert(abi.encodeWithSelector(AtpMultiPoolOracle.OracleNotSet.selector, address(stranger)));
        router.previewSwap(address(numeraire), address(stranger), 1e18);
    }

    function test_previewSwap_revertsForUnregisteredInboundAsset() public {
        vm.expectRevert(abi.encodeWithSelector(AtpMultiPoolOracle.OracleNotSet.selector, address(stranger)));
        router.previewSwap(address(stranger), address(numeraire), 1e18);
    }

    /// @dev v1 prices only paths through the numeraire. A route between two assets is refused explicitly
    /// rather than guessed at, in both argument orders and on both assets.
    function test_previewSwap_revertsForMultiHopRoute() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                AtpMultiPoolOracle.UnsupportedRoute.selector, address(asset6), address(asset18)
            )
        );
        router.previewSwap(address(asset6), address(asset18), 1e18);

        vm.expectRevert(
            abi.encodeWithSelector(
                AtpMultiPoolOracle.UnsupportedRoute.selector, address(asset18), address(asset6)
            )
        );
        router.previewSwap(address(asset18), address(asset6), 1e18);
    }

    /// @dev `numeraire -> numeraire` is the same-token case: there is exactly one numeraire, so a pair with
    /// both legs on it is a degenerate pair, not a route.
    function test_previewSwap_revertsForSameToken() public {
        vm.expectRevert(AtpMultiPoolOracle.SameToken.selector);
        router.previewSwap(address(numeraire), address(numeraire), 1e18);

        vm.expectRevert(AtpMultiPoolOracle.SameToken.selector);
        router.previewSwap(address(asset6), address(asset6), 1e18);
    }

    /// @dev Forwarding must not swallow the pair oracle's own fail-closed paths.
    function test_previewSwap_propagatesPairOracleFailures() public {
        vm.expectRevert(PancakeV3TwapOracle.ZeroAmount.selector);
        router.previewSwap(address(numeraire), address(asset6), 0);

        poolAsset6.setObservationCardinality(1);
        vm.expectRevert(PancakeV3TwapOracle.TwapUnavailable.selector);
        router.previewSwap(address(numeraire), address(asset6), 1000e18);
    }

    // ---- registry ----

    function test_oracleOf_reportsRegistrations() public view {
        assertEq(address(router.oracleOf(address(asset6))), address(oracleAsset6), "asset6 registration");
        assertEq(address(router.oracleOf(address(asset18))), address(oracleAsset18), "asset18 registration");
        assertEq(address(router.oracleOf(address(stranger))), address(0), "unregistered asset");
    }

    function test_setOracle_acceptsReversedPairOrdering() public {
        MockToken fresh = new MockToken(18);
        MockPool pool = new MockPool(address(fresh), address(numeraire)); // token0 = asset, token1 = numeraire
        PancakeV3TwapOracle reversed = new PancakeV3TwapOracle(
            address(pool), address(fresh), address(numeraire), WINDOW, MAX_SLIPPAGE_BPS, MAX_ORACLE_AGE
        );

        vm.expectEmit(true, true, false, false, address(router));
        emit AtpMultiPoolOracle.OracleSet(address(fresh), address(reversed));
        router.setOracle(address(fresh), reversed);
        assertEq(address(router.oracleOf(address(fresh))), address(reversed), "reversed pair accepted");
    }

    function test_setOracle_revertsOnZeroAddresses() public {
        vm.expectRevert(AtpMultiPoolOracle.ZeroAddress.selector);
        router.setOracle(address(0), oracleAsset6);

        vm.expectRevert(AtpMultiPoolOracle.ZeroAddress.selector);
        router.setOracle(address(stranger), PancakeV3TwapOracle(address(0)));
    }

    function test_setOracle_revertsOnNonContract() public {
        vm.expectRevert(AtpMultiPoolOracle.InvalidOracle.selector);
        router.setOracle(address(stranger), PancakeV3TwapOracle(OUTSIDER));
    }

    function test_setOracle_revertsOnNumeraireAsAsset() public {
        vm.expectRevert(AtpMultiPoolOracle.NumeraireAsAsset.selector);
        router.setOracle(address(numeraire), oracleAsset6);
    }

    /// @dev The expensive mistake this check prevents: an oracle over a pool that does not hold the
    /// numeraire would quote the asset against some third token and the executor would enforce it.
    function test_setOracle_revertsOnPairWithoutNumeraire() public {
        MockToken target = new MockToken(18);
        MockPool wrongPool = new MockPool(address(stranger), address(target));
        PancakeV3TwapOracle wrongOracle = new PancakeV3TwapOracle(
            address(wrongPool), address(stranger), address(target), WINDOW, MAX_SLIPPAGE_BPS, MAX_ORACLE_AGE
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                AtpMultiPoolOracle.PairMismatch.selector, address(target), address(wrongOracle)
            )
        );
        router.setOracle(address(target), wrongOracle);
    }

    /// @dev And the mirror image: a pair that holds the numeraire but not the asset being registered.
    function test_setOracle_revertsOnPairWithoutAsset() public {
        MockToken target = new MockToken(18);
        MockPool wrongPool = new MockPool(address(numeraire), address(stranger));
        PancakeV3TwapOracle wrongOracle = new PancakeV3TwapOracle(
            address(wrongPool),
            address(numeraire),
            address(stranger),
            WINDOW,
            MAX_SLIPPAGE_BPS,
            MAX_ORACLE_AGE
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                AtpMultiPoolOracle.PairMismatch.selector, address(target), address(wrongOracle)
            )
        );
        router.setOracle(address(target), wrongOracle);
    }

    /// @dev Replacing the oracle that prices a live index takes two deliberate statements, not one.
    function test_setOracle_revertsOnDuplicateRegistration() public {
        vm.expectRevert(abi.encodeWithSelector(AtpMultiPoolOracle.OracleAlreadySet.selector, address(asset6)));
        router.setOracle(address(asset6), oracleAsset6);
    }

    function test_setOracle_revertsForNonOwner() public {
        vm.prank(OUTSIDER);
        vm.expectRevert(AtpMultiPoolOracle.NotOwner.selector);
        router.setOracle(address(stranger), oracleAsset6);
    }

    // ---- registry maintenance ----

    function test_clearOracle_makesTheAssetUnquotable() public {
        router.clearOracle(address(asset6));
        assertEq(address(router.oracleOf(address(asset6))), address(0), "registration removed");

        vm.expectRevert(abi.encodeWithSelector(AtpMultiPoolOracle.OracleNotSet.selector, address(asset6)));
        router.previewSwap(address(numeraire), address(asset6), 1000e18);

        // The other registration is untouched.
        (uint256 quoted18,) = router.previewSwap(address(numeraire), address(asset18), 1e18);
        assertEq(quoted18, 1e18, "unrelated asset still priced");

        // And the slot can be filled again after the explicit clear.
        router.setOracle(address(asset6), oracleAsset6);
        (uint256 quoted6,) = router.previewSwap(address(numeraire), address(asset6), 1000e18);
        assertEq(quoted6, 1_000_002_644, "re-registered oracle prices again");
    }

    function test_clearOracle_revertsOnUnknownAsset() public {
        vm.expectRevert(abi.encodeWithSelector(AtpMultiPoolOracle.OracleNotSet.selector, address(stranger)));
        router.clearOracle(address(stranger));
    }

    function test_clearOracle_revertsForNonOwner() public {
        vm.prank(OUTSIDER);
        vm.expectRevert(AtpMultiPoolOracle.NotOwner.selector);
        router.clearOracle(address(asset6));
    }

    function test_transferOwnership_movesTheRegistryRole() public {
        router.transferOwnership(OUTSIDER);
        assertEq(router.owner(), OUTSIDER, "ownership handed over");

        vm.prank(OUTSIDER);
        router.clearOracle(address(asset6));
        assertEq(address(router.oracleOf(address(asset6))), address(0), "new owner can administer");

        vm.expectRevert(AtpMultiPoolOracle.NotOwner.selector);
        router.clearOracle(address(asset18));
    }

    function test_transferOwnership_revertsForNonOwner() public {
        vm.prank(OUTSIDER);
        vm.expectRevert(AtpMultiPoolOracle.NotOwner.selector);
        router.transferOwnership(OUTSIDER);
    }

    function test_transferOwnership_revertsOnZeroAddress() public {
        vm.expectRevert(AtpMultiPoolOracle.ZeroAddress.selector);
        router.transferOwnership(address(0));
    }

    function test_constructor_revertsOnZeroNumeraire() public {
        vm.expectRevert(AtpMultiPoolOracle.InvalidNumeraire.selector);
        new AtpMultiPoolOracle(address(0));
    }

    function test_constructor_revertsOnNumeraireWithoutCode() public {
        vm.expectRevert(AtpMultiPoolOracle.InvalidNumeraire.selector);
        new AtpMultiPoolOracle(OUTSIDER);
    }

    // ---- no fund-moving surface ----

    /// @dev Structural claim, asserted behaviourally: the router cannot take value (no `receive`, no payable
    /// function), and none of the ERC-20 movers is in its dispatcher - so there is no call path that could
    /// touch a token balance, no matter who sends it a transaction.
    function test_router_cannotHoldOrMoveValue() public {
        vm.deal(address(this), 1 ether);
        (bool sent,) = address(router).call{ value: 1 ether }("");
        assertFalse(sent, "router must not accept native value");
        assertEq(address(router).balance, 0, "router holds no value");

        (bool transferred,) =
            address(router).call(abi.encodeWithSignature("transfer(address,uint256)", address(this), 1));
        assertFalse(transferred, "transfer(address,uint256) must not exist");

        (bool transferredFrom,) = address(router)
            .call(
                abi.encodeWithSignature(
                    "transferFrom(address,address,uint256)", address(this), address(this), 1
                )
            );
        assertFalse(transferredFrom, "transferFrom(address,address,uint256) must not exist");

        (bool approved,) = address(router)
            .call(abi.encodeWithSignature("approve(address,uint256)", address(this), type(uint256).max));
        assertFalse(approved, "approve(address,uint256) must not exist");
    }

    /// @dev Same claim read off the deployed bytecode: a compiler emits a function's selector as a constant in
    /// the dispatcher, so its absence proves no dispatch path (and no fallback) can reach such a function.
    function test_router_hasNoFundMovingSelectorInCode() public view {
        assertFalse(_selectorInCode(address(router), 0xa9059cbb), "transfer(address,uint256)");
        assertFalse(_selectorInCode(address(router), 0x23b872dd), "transferFrom(address,address,uint256)");
        assertFalse(_selectorInCode(address(router), 0x095ea7b3), "approve(address,uint256)");
        // Sanity check on the scan itself: `previewSwap` and `setOracle` must be found, or the negative
        // results above would be meaningless.
        assertTrue(_selectorInCode(address(router), IOracleFloor.previewSwap.selector), "previewSwap");
        assertTrue(_selectorInCode(address(router), AtpMultiPoolOracle.setOracle.selector), "setOracle");
    }

    // ---- helpers ----

    /// @dev Deploys a mock pool plus the real `PancakeV3TwapOracle` over it, with `a` as the pool's token0.
    function _deployPair(MockToken a, MockToken b, int24 meanTick)
        private
        returns (MockPool pool, PancakeV3TwapOracle oracle)
    {
        pool = new MockPool(address(a), address(b));
        pool.setMeanTick(meanTick, WINDOW);
        oracle = new PancakeV3TwapOracle(
            address(pool), address(a), address(b), WINDOW, MAX_SLIPPAGE_BPS, MAX_ORACLE_AGE
        );
    }

    /// @dev True when `selector` appears as four consecutive bytes anywhere in `target`'s deployed code.
    function _selectorInCode(address target, bytes4 selector) private view returns (bool) {
        bytes memory code = target.code;
        for (uint256 i; i + 4 <= code.length; ++i) {
            if (
                code[i] == selector[0] && code[i + 1] == selector[1] && code[i + 2] == selector[2]
                    && code[i + 3] == selector[3]
            ) {
                return true;
            }
        }
        return false;
    }
}
