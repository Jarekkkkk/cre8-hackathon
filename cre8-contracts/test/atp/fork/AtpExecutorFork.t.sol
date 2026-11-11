// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { AtpExecutor } from "../../../src/atp/AtpExecutor.sol";
import { AtpRegistry } from "../../../src/atp/AtpRegistry.sol";
import { PancakeV3TwapOracle } from "../../../src/atp/PancakeV3TwapOracle.sol";
import { IUniversalRouter } from "../../../src/atp/interfaces/IUniversalRouter.sol";
import { IPancakeV3Pool } from "../../../src/atp/interfaces/IPancakeV3Pool.sol";

/// @dev The one member of the PCS V3 factory this test reads. The pool address is resolved on-chain, never
/// hard-coded, so a factory re-deployment cannot silently point the test at the wrong pool.
interface IV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

/// @dev WBNB is the only 1:1 wrapped native asset; the test funds the account by really wrapping BNB.
interface IWBNB {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @dev Minimal smart account: the executor requires `msg.sender == account` and `account.code.length != 0`,
/// so the call has to originate from a contract. It also owns the per-token approval the executor pulls.
/// No access control on purpose: this is a test double, not an account implementation.
contract MockSmartAccount {
    function executeRebalance(address executor, AtpExecutor.SwapStep[] calldata steps, uint256 deadline)
        external
    {
        AtpExecutor(executor).executeRebalance(address(this), steps, deadline);
    }

    function approveToken(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }

    receive() external payable { }
}

/// @notice First end-to-end `executeRebalance` path against real BSC mainnet state: the real PCS V3
/// Universal Router really swaps WBNB -> USDT out of a fork of the live WBNB/USDT 0.05% pool, and the
/// executor's floor, fee split and residual return are asserted on the resulting balances.
/// @dev Fork tests must never pass without an RPC. `BSC_RPC_URL` unset (or empty) means `vm.skip(true)`,
/// which forge reports as skipped, not passed.
/// @dev Payment leg, discovered on a live fork and now implemented in the executor: the PCS V3 Universal
/// Router does not pull ERC20 with a plain `transferFrom` from the caller. Its V3 swap callback calls
/// `Permit2.transferFrom(executor, pool, amount, token)`, and Permit2 only moves funds against an allowance
/// granted *inside Permit2* by the token owner (the executor). `AtpExecutor._swap` therefore grants both
/// legs - `tokenIn.forceApprove(permit2, amountIn)` plus `permit2.approve(tokenIn, router, amountIn,
/// deadline)` - and this test asserts the swap end to end with no skip on that path: a Permit2 revert is a
/// genuine failure here, not something to work around.
contract AtpExecutorForkTest is Test {
    // ---- BSC mainnet constants (verified against chain state, not guessed) ----
    uint256 internal constant BSC_MAINNET = 56;
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    /// @dev Binance-Peg BSC-USD, 18 decimals on BSC (not the 6-decimal Ethereum USDT).
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    /// @dev PancakeSwap V3 factory. `getPool` is the only call this test makes to it.
    address internal constant V3_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    /// @dev PancakeSwap V3 Universal Router (classic), pinned in the executor constructor.
    address internal constant V3_UNIVERSAL_ROUTER = 0x1A0A18AC4BECDDbd6389559687d1A73d8927E416;
    /// @dev The Permit2 the router above pays every ERC20 leg through (verified from the router's own
    /// swap callback, which calls this contract's `transferFrom(executor, pool, amount, token)`). Same
    /// address on BSC mainnet and testnet.
    address internal constant PERMIT2 = 0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768;

    /// @dev Preferred fee tier; the test falls back to 2500 only when 500 has no pool at all.
    uint24 internal constant PREFERRED_FEE = 500;
    uint24 internal constant FALLBACK_FEE = 2500;

    /// @dev Registry swap fee, so the split is observable. MAX_SWAP_FEE_BPS is 300.
    uint16 internal constant FEE_BPS = 50;
    uint16 internal constant BPS_DENOMINATOR = 10_000;

    address internal constant FEE_RECIPIENT = address(0xFEE);
    uint256 internal constant AMOUNT_IN = 0.01 ether;

    AtpRegistry internal registry;
    PancakeV3TwapOracle internal oracle;
    AtpExecutor internal executor;
    MockSmartAccount internal account;
    address internal pool;
    uint24 internal fee;
    uint256 internal strategyId;

    function setUp() public {
        // Fail closed on a missing endpoint: no RPC means skipped, never a green run.
        // The `string("")` cast is load-bearing: the bare literal is ambiguous across `Vm.envOr` overloads.
        string memory rpc = vm.envOr("BSC_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }

        vm.createSelectFork(rpc);
        assertEq(block.chainid, BSC_MAINNET, "fork is BSC mainnet (56)");

        // Resolve the pool at runtime; only if 500 has no pool at all do we move to 2500.
        fee = PREFERRED_FEE;
        pool = IV3Factory(V3_FACTORY).getPool(WBNB, USDT, fee);
        if (pool == address(0)) {
            fee = FALLBACK_FEE;
            pool = IV3Factory(V3_FACTORY).getPool(WBNB, USDT, fee);
        }
        assertTrue(pool != address(0), "no WBNB/USDT pool at 500 or 2500");
        assertEq(IPancakeV3Pool(pool).fee(), fee, "pool fee tier matches");
        assertGt(PERMIT2.code.length, 0, "PancakeSwap Permit2 present on the fork");

        registry = new AtpRegistry();
        // Non-zero fee so `feeRecipient` really receives a slice; the executor grosses the oracle floor up
        // over it, so `amountOutMin` still has to clear the floor after the split.
        registry.setDefaultFeeBps(FEE_BPS);
        oracle = new PancakeV3TwapOracle(pool, WBNB, USDT, 30 minutes, 100, 3600);
        executor = new AtpExecutor(
            registry, IUniversalRouter(V3_UNIVERSAL_ROUTER), oracle, PERMIT2, FEE_RECIPIENT
        );

        account = new MockSmartAccount();

        strategyId = registry.registerStrategy("WBNB/USDT", "ATP fork E2E", true);
        address[] memory assets = new address[](2);
        assets[0] = WBNB;
        assets[1] = USDT;
        uint16[] memory weights = new uint16[](2);
        weights[0] = 5_000;
        weights[1] = 5_000;
        registry.publishVersion(strategyId, assets, weights, bytes32(0), uint64(block.timestamp));
        registry.enroll(address(account), strategyId);
    }

    function test_executeRebalance_swapsOnRealPancakeV3UniversalRouter() public {
        // Fund the account with real WBNB: deal native BNB, then wrap it through the live WBNB contract.
        vm.deal(address(account), AMOUNT_IN);
        vm.prank(address(account));
        IWBNB(WBNB).deposit{ value: AMOUNT_IN }();
        assertEq(IERC20(WBNB).balanceOf(address(account)), AMOUNT_IN, "account funded with WBNB");

        // The oracle is the authority for the bound, but its quote only moves inside this pinned fork, so it
        // is also the correct `amountOutMin` to hand the router (the executor rejects anything below it).
        (, uint256 oracleFloor) = oracle.previewSwap(WBNB, USDT, AMOUNT_IN);
        uint256 amountOutMin = _minGross(oracleFloor, FEE_BPS);
        assertGt(amountOutMin, 0, "oracle produced a non-zero floor");

        AtpExecutor.SwapStep[] memory steps = new AtpExecutor.SwapStep[](1);
        steps[0] = AtpExecutor.SwapStep({
            tokenIn: WBNB,
            tokenOut: USDT,
            amountIn: AMOUNT_IN,
            amountOutMin: amountOutMin,
            commands: hex"00", // V3_SWAP_EXACT_IN
            inputs: _single(_v3SwapInput(address(executor), AMOUNT_IN, amountOutMin))
        });

        // The account must approve the executor, exactly like a real Kernel account would.
        account.approveToken(WBNB, address(executor), AMOUNT_IN);

        uint256 wbnbBefore = IERC20(WBNB).balanceOf(address(account));
        uint256 usdtAccountBefore = IERC20(USDT).balanceOf(address(account));
        uint256 usdtFeeBefore = IERC20(USDT).balanceOf(FEE_RECIPIENT);

        // The account is the only origin the executor accepts (`msg.sender == account` plus
        // `account.code.length != 0`); a direct EOA call would fail. No try/catch: the Permit2 payment leg
        // is implemented now, so any revert here - Permit2 included - is a real failure.
        uint256 deadline = block.timestamp + 300;
        account.executeRebalance(address(executor), steps, deadline);

        uint256 wbnbAfter = IERC20(WBNB).balanceOf(address(account));
        uint256 usdtAccountAfter = IERC20(USDT).balanceOf(address(account));
        uint256 usdtFeeAfter = IERC20(USDT).balanceOf(FEE_RECIPIENT);

        uint256 gross = (usdtAccountAfter - usdtAccountBefore) + (usdtFeeAfter - usdtFeeBefore);
        uint256 feeTaken = usdtFeeAfter - usdtFeeBefore;
        uint256 net = usdtAccountAfter - usdtAccountBefore;

        // 1) The swap happened and cleared the oracle floor the executor enforces.
        assertGt(gross, 0, "USDT bought");
        assertGe(gross, amountOutMin, "realised gross cleared the oracle floor");

        // 2) The buy landed on the executor, which split it and left nothing behind.
        assertGt(net, 0, "net USDT returned to the account");
        assertEq(IERC20(USDT).balanceOf(address(executor)), 0, "executor kept no USDT");
        assertEq(net + feeTaken, gross, "gross = net to account + fee");
        assertEq(feeTaken, gross * FEE_BPS / BPS_DENOMINATOR, "fee is floor(gross * 50/10000)");
        assertGt(feeTaken, 0, "fee reached feeRecipient");

        // 3) The exact-input leg consumed exactly `amountIn` and no WBNB was stranded in the executor.
        assertEq(wbnbBefore - wbnbAfter, AMOUNT_IN, "account paid exactly amountIn");
        assertEq(IERC20(WBNB).balanceOf(address(executor)), 0, "executor returned any residual WBNB");
        // The ERC20 leg to Permit2 is zeroed after the swap; Permit2's own allowance dies at the deadline.
        assertEq(IERC20(WBNB).allowance(address(executor), PERMIT2), 0, "token -> Permit2 allowance reset");
    }

    // ---- helpers ----

    /// @dev Universal Router `V3_SWAP_EXACT_IN`: (recipient, amountIn, amountOutMin, path, payerIsUser).
    /// Single hop, so `path = tokenIn | fee | tokenOut` packed. Recipient is the executor itself, which is
    /// what `_checkCommands` pins, and the executor takes the fee out of the USDT it already holds.
    function _v3SwapInput(address recipient, uint256 amountIn, uint256 amountOutMin)
        internal
        view
        returns (bytes memory)
    {
        bytes memory path = abi.encodePacked(WBNB, fee, USDT);
        return abi.encode(recipient, amountIn, amountOutMin, path, true);
    }

    function _single(bytes memory input) internal pure returns (bytes[] memory inputs) {
        inputs = new bytes[](1);
        inputs[0] = input;
    }

    /// @dev Mirrors `AtpExecutor._minGross`: ceil(floor * 10000 / (10000 - feeBps)).
    function _minGross(uint256 oracleFloor, uint16 feeBps) internal pure returns (uint256) {
        uint256 denominator = BPS_DENOMINATOR - feeBps;
        return (oracleFloor * BPS_DENOMINATOR + denominator - 1) / denominator;
    }
}
