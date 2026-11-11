// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { AtpExecutor } from "../../src/atp/AtpExecutor.sol";
import { AtpRegistry } from "../../src/atp/AtpRegistry.sol";
import { IOracleFloor } from "../../src/atp/interfaces/IOracleFloor.sol";
import { IUniversalRouter } from "../../src/atp/interfaces/IUniversalRouter.sol";

/// @dev Bare Universal Router stub: the executor constructor only needs code at that address.
contract MockUniversalRouter is IUniversalRouter {
    function execute(bytes calldata, bytes[] calldata, uint256) external payable { }
}

/// @dev Bare oracle stub: the executor constructor only needs code at that address.
contract MockOracleFloor is IOracleFloor {
    function previewSwap(address, address, uint256) external pure returns (uint256, uint256) {
        return (0, 0);
    }
}

/// @dev Permit2 stub that records every `approve` so the swap path's Permit2 leg can be asserted on the
/// exact arguments, not just "no revert". Same signature as the real contract; nothing else is needed.
contract MockPermit2 {
    struct Approval {
        address token;
        address spender;
        uint160 amount;
        uint48 expiration;
    }

    Approval[] internal approvals;

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        approvals.push(Approval({ token: token, spender: spender, amount: amount, expiration: expiration }));
    }

    function approvalCount() external view returns (uint256) {
        return approvals.length;
    }

    function approvalAt(uint256 index) external view returns (Approval memory) {
        return approvals[index];
    }
}

/// @dev Minimal ERC20 with mint, enough for `SafeERC20` (which reads the boolean return value).
contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev Router stub that records the allowances the executor set up *before* it is called, and mints the
/// output token back to the executor, so one `_swap` round trip is observable without a fork. It consumes
/// nothing on purpose: `_swap` must return the untouched `amountIn` residual to the account.
contract SwapRouterStub is IUniversalRouter {
    address public executor;
    address public tokenIn;
    address public tokenOut;
    address public permit2;
    uint256 public amountOut;

    uint256 public calls;
    uint256 public permit2AllowanceSeen;
    uint256 public routerAllowanceSeen;

    function configure(
        address executor_,
        address tokenIn_,
        address tokenOut_,
        address permit2_,
        uint256 amountOut_
    ) external {
        executor = executor_;
        tokenIn = tokenIn_;
        tokenOut = tokenOut_;
        permit2 = permit2_;
        amountOut = amountOut_;
    }

    function execute(bytes calldata, bytes[] calldata, uint256) external payable {
        ++calls;
        permit2AllowanceSeen = IERC20(tokenIn).allowance(executor, permit2);
        routerAllowanceSeen = IERC20(tokenIn).allowance(executor, address(this));
        MockERC20(tokenOut).mint(executor, amountOut);
    }
}

/// @dev Exposes the executor's internal decoders, floor arithmetic and the swap path so the byte layout and
/// the Permit2 leg can be pinned directly, without changing the production contract.
contract AtpExecutorHarness is AtpExecutor {
    constructor(
        AtpRegistry registry_,
        IUniversalRouter router_,
        IOracleFloor oracle_,
        address permit2_,
        address feeRecipient_
    ) AtpExecutor(registry_, router_, oracle_, permit2_, feeRecipient_) { }

    function checkCommands(bytes calldata commands, bytes[] calldata inputs) external view {
        _checkCommands(commands, inputs);
    }

    function checkRecipient(bytes calldata input, uint256 wordIndex) external view {
        _checkRecipient(input, wordIndex);
    }

    function minGross(uint256 oracleFloor, uint16 feeBps) external pure returns (uint256) {
        return _minGross(oracleFloor, feeBps);
    }

    function swap(address account, SwapStep calldata step, uint256 deadline)
        external
        returns (uint256 gross)
    {
        return _swap(account, step, deadline);
    }
}

/// @notice Pins the command/recipient decoding of `AtpExecutor._checkCommands` against the Universal
/// Router payload layout, and the `_minGross` fee gross-up. Both are safety-critical: a decode that
/// reads the wrong word would let a swap pay out anywhere but this executor.
contract AtpExecutorTest is Test {
    // Universal Router command bytes (must match `UniversalRouterCommands`).
    bytes1 internal constant V3_SWAP_EXACT_IN = 0x00;
    bytes1 internal constant V2_SWAP_EXACT_IN = 0x08;
    bytes1 internal constant SWEEP = 0x04;
    bytes1 internal constant TRANSFER = 0x05;
    bytes1 internal constant PAY_PORTION = 0x06;
    bytes1 internal constant FLAG_BIT = 0x20;

    address internal constant PATH_TOKEN_IN = address(0xA11CE);
    address internal constant PATH_TOKEN_OUT = address(0xB0B);
    address internal constant FEE_RECIPIENT = address(0xFEE);
    address internal constant OTHER = address(0xCAFE);
    /// @dev Canonical Uniswap Permit2, the address the executor's constructor pins on chain ids 56 and 97.
    address internal constant CANONICAL_PERMIT2 = 0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768;

    AtpRegistry internal registry;
    AtpExecutorHarness internal executor;
    MockPermit2 internal permit2;
    SwapRouterStub internal routerStub;

    function setUp() public {
        registry = new AtpRegistry();
        permit2 = new MockPermit2();
        routerStub = new SwapRouterStub();
        executor = new AtpExecutorHarness(
            registry, routerStub, new MockOracleFloor(), address(permit2), FEE_RECIPIENT
        );
    }

    // ---- fixtures ----

    function _command(bytes1 command) internal pure returns (bytes memory commands) {
        commands = new bytes(1);
        commands[0] = command;
    }

    /// @dev Universal Router `V3_SWAP_EXACT_IN` payload: (recipient, amountIn, amountOutMin, path,
    /// payerIsUser). `recipient` is head word 0.
    function _v3SwapInput(address recipient, uint256 amountIn, uint256 amountOutMin)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory path = abi.encodePacked(PATH_TOKEN_IN, uint24(500), PATH_TOKEN_OUT);
        return abi.encode(recipient, amountIn, amountOutMin, path, true);
    }

    /// @dev Universal Router `SWEEP` / `TRANSFER` payload: (token, recipient, amountMin). `recipient` is
    /// head word 1.
    function _sweepInput(address token, address recipient, uint256 amountMin)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(token, recipient, amountMin);
    }

    function _one(bytes memory input) internal pure returns (bytes[] memory inputs) {
        inputs = new bytes[](1);
        inputs[0] = input;
    }

    // ---- _checkCommands: accepted shapes ----

    function test_checkCommands_acceptsV3SwapPayingExecutor() public view {
        executor.checkCommands(_command(V3_SWAP_EXACT_IN), _one(_v3SwapInput(address(executor), 1e18, 0)));
    }

    function test_checkCommands_acceptsV2SwapPayingExecutor() public view {
        executor.checkCommands(_command(V2_SWAP_EXACT_IN), _one(_v3SwapInput(address(executor), 1e18, 0)));
    }

    function test_checkCommands_acceptsSweepAndTransferPayingExecutor() public view {
        executor.checkCommands(_command(SWEEP), _one(_sweepInput(PATH_TOKEN_IN, address(executor), 0)));
        executor.checkCommands(_command(TRANSFER), _one(_sweepInput(PATH_TOKEN_IN, address(executor), 0)));
    }

    function test_checkCommands_acceptsBatchWhereEveryLegPaysExecutor() public view {
        bytes memory commands = abi.encodePacked(V3_SWAP_EXACT_IN, V3_SWAP_EXACT_IN, SWEEP);
        bytes[] memory inputs = new bytes[](3);
        inputs[0] = _v3SwapInput(address(executor), 1e18, 0);
        inputs[1] = _v3SwapInput(address(executor), 1e18, 0);
        inputs[2] = _sweepInput(PATH_TOKEN_IN, address(executor), 0);

        executor.checkCommands(commands, inputs);
    }

    // ---- _checkCommands: recipient pinned to the executor ----

    function test_checkCommands_rejectsSwapPayingThirdParty() public {
        vm.expectRevert(abi.encodeWithSelector(AtpExecutor.BadRecipient.selector, OTHER));
        executor.checkCommands(_command(V3_SWAP_EXACT_IN), _one(_v3SwapInput(OTHER, 1e18, 0)));
    }

    function test_checkCommands_rejectsSwapPayingZeroAddress() public {
        vm.expectRevert(abi.encodeWithSelector(AtpExecutor.BadRecipient.selector, address(0)));
        executor.checkCommands(_command(V3_SWAP_EXACT_IN), _one(_v3SwapInput(address(0), 1e18, 0)));
    }

    function test_checkCommands_rejectsSwapPayingTheCaller() public {
        // The caller (this test) is not the executor: an agent cannot route output to itself.
        vm.expectRevert(abi.encodeWithSelector(AtpExecutor.BadRecipient.selector, address(this)));
        executor.checkCommands(_command(V3_SWAP_EXACT_IN), _one(_v3SwapInput(address(this), 1e18, 0)));
    }

    /// @dev SWEEP/TRANSFER read head word 1, not word 0: a payload whose word 0 is the executor but whose
    /// recipient is someone else must still revert.
    function test_checkCommands_rejectsSweepWhoseRecipientIsNotExecutor() public {
        vm.expectRevert(abi.encodeWithSelector(AtpExecutor.BadRecipient.selector, OTHER));
        executor.checkCommands(_command(SWEEP), _one(_sweepInput(address(executor), OTHER, 0)));
    }

    function test_checkCommands_rejectsTransferWhoseRecipientIsNotExecutor() public {
        vm.expectRevert(abi.encodeWithSelector(AtpExecutor.BadRecipient.selector, OTHER));
        executor.checkCommands(_command(TRANSFER), _one(_sweepInput(address(executor), OTHER, 0)));
    }

    function test_checkRecipient_readsWord0OfASwapPayload() public view {
        executor.checkRecipient(_v3SwapInput(address(executor), 1e18, 0), 0);
    }

    function test_checkRecipient_readsWord1OfASweepPayload() public view {
        executor.checkRecipient(_sweepInput(PATH_TOKEN_IN, address(executor), 0), 1);
    }

    function test_checkRecipient_revertsOnTruncatedPayload() public {
        // One word is not enough when the recipient lives in word 1.
        vm.expectRevert(AtpExecutor.BadCommands.selector);
        executor.checkRecipient(abi.encode(PATH_TOKEN_IN), 1);
    }

    // ---- _checkCommands: command allowlist is exact bytes ----

    function test_checkCommands_rejectsPayPortion() public {
        bytes[] memory inputs = _one(_sweepInput(PATH_TOKEN_IN, address(executor), 0));
        vm.expectRevert(abi.encodeWithSelector(AtpExecutor.CommandNotAllowed.selector, PAY_PORTION));
        executor.checkCommands(_command(PAY_PORTION), inputs);
    }

    function test_checkCommands_rejectsSwapCarryingFlagBit() public {
        // V3_SWAP_EXACT_IN | FLAG_ALLOW_REVERT (0x20) is not the exact allowlisted byte.
        bytes1 flagged = V3_SWAP_EXACT_IN | FLAG_BIT;
        vm.expectRevert(abi.encodeWithSelector(AtpExecutor.CommandNotAllowed.selector, flagged));
        executor.checkCommands(_command(flagged), _one(_v3SwapInput(address(executor), 1e18, 0)));
    }

    function test_checkCommands_rejectsBareFlagBit() public {
        vm.expectRevert(abi.encodeWithSelector(AtpExecutor.CommandNotAllowed.selector, FLAG_BIT));
        executor.checkCommands(_command(FLAG_BIT), _one(_sweepInput(PATH_TOKEN_IN, address(executor), 0)));
    }

    function test_checkCommands_rejectsUnknownCommand() public {
        bytes1 unknown = 0x0a;
        vm.expectRevert(abi.encodeWithSelector(AtpExecutor.CommandNotAllowed.selector, unknown));
        executor.checkCommands(_command(unknown), _one(_sweepInput(PATH_TOKEN_IN, address(executor), 0)));
    }

    /// @dev A later leg being wrong must fail the whole batch, not only its own iteration.
    function test_checkCommands_rejectsBatchWithOneBadLeg() public {
        bytes memory commands = abi.encodePacked(V3_SWAP_EXACT_IN, SWEEP);
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = _v3SwapInput(address(executor), 1e18, 0);
        inputs[1] = _sweepInput(PATH_TOKEN_IN, OTHER, 0);

        vm.expectRevert(abi.encodeWithSelector(AtpExecutor.BadRecipient.selector, OTHER));
        executor.checkCommands(commands, inputs);
    }

    // ---- _checkCommands: shape checks ----

    function test_checkCommands_rejectsEmptyBatch() public {
        vm.expectRevert(AtpExecutor.BadCommands.selector);
        executor.checkCommands(new bytes(0), new bytes[](0));
    }

    function test_checkCommands_rejectsInputCountMismatch() public {
        bytes memory commands = abi.encodePacked(V3_SWAP_EXACT_IN, V3_SWAP_EXACT_IN);
        vm.expectRevert(AtpExecutor.BadCommands.selector);
        executor.checkCommands(commands, _one(_v3SwapInput(address(executor), 1e18, 0)));
    }

    function test_checkCommands_rejectsTruncatedSwapInput() public {
        // 31 bytes: not even the first head word, so the recipient cannot be read.
        bytes[] memory inputs = _one(new bytes(31));
        vm.expectRevert(AtpExecutor.BadCommands.selector);
        executor.checkCommands(_command(V3_SWAP_EXACT_IN), inputs);
    }

    function test_checkCommands_rejectsTruncatedSweepInput() public {
        bytes[] memory inputs = _one(abi.encode(PATH_TOKEN_IN));
        vm.expectRevert(AtpExecutor.BadCommands.selector);
        executor.checkCommands(_command(SWEEP), inputs);
    }

    // ---- _minGross: fee gross-up ----

    function test_minGross_grossesTheFloorBackOverTheFee() public view {
        // ceil(10000 * 10000 / 9950) = ceil(10050.25...) = 10051
        assertEq(executor.minGross(10_000, 50), 10_051);
    }

    function test_minGross_isIdentityWithoutFee() public view {
        assertEq(executor.minGross(100, 0), 100);
    }

    function test_minGross_roundsUpAnyRemainder() public view {
        // ceil(1 * 10000 / 9999) = 2
        assertEq(executor.minGross(1, 1), 2);
        // ceil(100 * 10000 / 9900) = 102
        assertEq(executor.minGross(100, 100), 102);
    }

    function test_minGross_rejectsFeeAtOrAboveOneHundredPercent() public {
        vm.expectRevert(abi.encodeWithSelector(AtpExecutor.FeeTooHigh.selector, uint256(10_000)));
        executor.minGross(10_000, 10_000);

        vm.expectRevert(abi.encodeWithSelector(AtpExecutor.FeeTooHigh.selector, uint256(65_535)));
        executor.minGross(10_000, type(uint16).max);
    }

    // ---- constructor ----

    function test_constructor_rejectsConfigWithoutCode() public {
        AtpRegistry freshRegistry = new AtpRegistry();
        MockOracleFloor oracleStub = new MockOracleFloor();
        // Build every stub first: `vm.expectRevert` binds to the very next external call.
        vm.expectRevert(AtpExecutor.InvalidConfig.selector);
        new AtpExecutorHarness(
            freshRegistry, IUniversalRouter(address(0)), oracleStub, address(permit2), FEE_RECIPIENT
        );
    }

    function test_constructor_rejectsPermit2WithoutCode() public {
        MockUniversalRouter routerStub_ = new MockUniversalRouter();
        MockOracleFloor oracleStub = new MockOracleFloor();
        vm.expectRevert(AtpExecutor.InvalidConfig.selector);
        new AtpExecutorHarness(registry, routerStub_, oracleStub, address(0), FEE_RECIPIENT);
    }

    function test_constructor_rejectsZeroFeeRecipient() public {
        MockUniversalRouter routerStub_ = new MockUniversalRouter();
        MockOracleFloor oracleStub = new MockOracleFloor();
        vm.expectRevert(AtpExecutor.InvalidConfig.selector);
        new AtpExecutorHarness(registry, routerStub_, oracleStub, address(permit2), address(0));
    }

    // ---- constructor: Permit2 is pinned on the BSC chain ids ----

    /// @dev `permit2` is a real MockPermit2 with code, so the code-length check passes and only the chain-id
    /// pin can reject it. This is the mis-wiring the pin exists for: a deployed Permit2 that is not the one
    /// the router pays through.
    function test_constructor_rejectsNonCanonicalPermit2OnBscMainnet() public {
        MockUniversalRouter routerStub_ = new MockUniversalRouter();
        MockOracleFloor oracleStub = new MockOracleFloor();
        vm.chainId(56);

        vm.expectRevert(AtpExecutor.InvalidConfig.selector);
        new AtpExecutorHarness(registry, routerStub_, oracleStub, address(permit2), FEE_RECIPIENT);
    }

    function test_constructor_rejectsNonCanonicalPermit2OnBscTestnet() public {
        MockUniversalRouter routerStub_ = new MockUniversalRouter();
        MockOracleFloor oracleStub = new MockOracleFloor();
        vm.chainId(97);

        vm.expectRevert(AtpExecutor.InvalidConfig.selector);
        new AtpExecutorHarness(registry, routerStub_, oracleStub, address(permit2), FEE_RECIPIENT);
    }

    /// @dev A bare EVM has nothing at the canonical address, so the mock's runtime code is etched there:
    /// the code-length check then passes and the accepted path is the one the pin is meant to allow.
    function test_constructor_acceptsCanonicalPermit2OnBsc() public {
        MockUniversalRouter routerStub_ = new MockUniversalRouter();
        MockOracleFloor oracleStub = new MockOracleFloor();
        vm.etch(CANONICAL_PERMIT2, address(permit2).code);
        vm.chainId(56);

        AtpExecutorHarness pinned =
            new AtpExecutorHarness(registry, routerStub_, oracleStub, CANONICAL_PERMIT2, FEE_RECIPIENT);
        assertEq(address(pinned.permit2()), CANONICAL_PERMIT2, "canonical Permit2 accepted on BSC");
    }

    /// @dev Off BSC the pin must not apply: any *contract* passes, which is the pre-existing rule that the
    /// other chains keep.
    function test_constructor_acceptsNonCanonicalPermit2OffBsc() public {
        MockUniversalRouter routerStub_ = new MockUniversalRouter();
        MockOracleFloor oracleStub = new MockOracleFloor();
        vm.chainId(1);

        AtpExecutorHarness offBsc =
            new AtpExecutorHarness(registry, routerStub_, oracleStub, address(permit2), FEE_RECIPIENT);
        assertEq(address(offBsc.permit2()), address(permit2), "off BSC only code length is checked");
    }

    // ---- _swap: the Permit2 payment leg ----

    /// @dev The router pays through Permit2, never with a direct `transferFrom` on the executor, so the
    /// executor must (1) approve the token to Permit2, (2) tell Permit2 the router may spend it for exactly
    /// `amountIn` until `deadline`, and (3) zero the ERC20 leg afterwards. Permit2's own allowance expires on
    /// its own, the ERC20 approval does not.
    function test_swap_paysTheRouterThroughPermit2AndResetsItsAllowance() public {
        MockERC20 tokenIn = new MockERC20();
        MockERC20 tokenOut = new MockERC20();
        uint256 amountIn = 1e18;
        uint256 amountOut = 0.5e18;
        uint256 deadline = block.timestamp + 300;

        tokenIn.mint(address(this), amountIn);
        tokenIn.approve(address(executor), amountIn);
        routerStub.configure(
            address(executor), address(tokenIn), address(tokenOut), address(permit2), amountOut
        );

        uint256 gross =
            executor.swap(address(this), _step(address(tokenIn), address(tokenOut), amountIn), deadline);

        // The swap itself: output measured as a delta, input untouched by the stub and so fully returned.
        assertEq(gross, amountOut, "gross is the output delta");
        assertEq(routerStub.calls(), 1, "router called once");
        assertEq(tokenOut.balanceOf(address(executor)), amountOut, "output held for the fee split");
        assertEq(tokenIn.balanceOf(address(this)), amountIn, "residual returned to the account");
        assertEq(tokenIn.balanceOf(address(executor)), 0, "nothing stranded in the executor");

        // 1) Permit2 was told the router may pull exactly `amountIn` until the batch deadline.
        assertEq(permit2.approvalCount(), 1, "exactly one Permit2 approval");
        MockPermit2.Approval memory approval = permit2.approvalAt(0);
        assertEq(approval.token, address(tokenIn), "Permit2 approval is for the input token");
        assertEq(approval.spender, address(routerStub), "Permit2 approval names the router");
        assertEq(uint256(approval.amount), amountIn, "Permit2 allowance equals amountIn");
        assertEq(uint256(approval.expiration), deadline, "Permit2 allowance expires with the batch");

        // 2) At router time the token -> Permit2 leg was in place and the router itself was never approved.
        assertEq(routerStub.permit2AllowanceSeen(), amountIn, "token -> Permit2 approved before the swap");
        assertEq(routerStub.routerAllowanceSeen(), 0, "executor never approves the router directly");

        // 3) The ERC20 leg to Permit2 is back to zero once the swap returns.
        assertEq(tokenIn.allowance(address(executor), address(permit2)), 0, "token -> Permit2 reset to zero");
    }

    function testFuzz_swap_grantsPermit2ExactlyAmountIn(uint256 amountIn, uint48 expiration) public {
        // Permit2 amounts are uint160; anything above that is not representable in its allowance model.
        amountIn = bound(amountIn, 1, type(uint160).max);
        uint256 deadline = uint256(expiration);

        MockERC20 tokenIn = new MockERC20();
        MockERC20 tokenOut = new MockERC20();
        tokenIn.mint(address(this), amountIn);
        tokenIn.approve(address(executor), amountIn);
        routerStub.configure(address(executor), address(tokenIn), address(tokenOut), address(permit2), 1);

        executor.swap(address(this), _step(address(tokenIn), address(tokenOut), amountIn), deadline);

        MockPermit2.Approval memory approval = permit2.approvalAt(0);
        assertEq(uint256(approval.amount), amountIn, "Permit2 allowance equals amountIn");
        assertEq(uint256(approval.expiration), deadline, "Permit2 expiration equals deadline");
        assertEq(tokenIn.allowance(address(executor), address(permit2)), 0, "token -> Permit2 reset to zero");
    }

    /// @dev `permit2.approve` takes a uint160, so anything above it would be truncated on the Permit2 leg
    /// while the ERC20 leg stays the full uint256. The guard must reject the step, and it must be the guard
    /// that reverts: the token balance and the ERC20 allowance are made large enough for the full amount.
    function test_swap_revertsWhenAmountInExceedsUint160() public {
        MockERC20 tokenIn = new MockERC20();
        MockERC20 tokenOut = new MockERC20();
        uint256 amountIn = uint256(type(uint160).max) + 1;
        uint256 deadline = block.timestamp + 300;

        tokenIn.mint(address(this), amountIn);
        tokenIn.approve(address(executor), amountIn);
        routerStub.configure(address(executor), address(tokenIn), address(tokenOut), address(permit2), 1);

        vm.expectRevert(AtpExecutor.AmountTooLarge.selector);
        executor.swap(address(this), _step(address(tokenIn), address(tokenOut), amountIn), deadline);

        assertEq(permit2.approvalCount(), 0, "no Permit2 allowance for an unrepresentable amount");
        assertEq(routerStub.calls(), 0, "the router was never called");
    }

    /// @dev The guard is `>`, not `>=`: `type(uint160).max` is the largest amount Permit2 can represent and
    /// must still swap.
    function test_swap_acceptsAmountInAtTheUint160Ceiling() public {
        MockERC20 tokenIn = new MockERC20();
        MockERC20 tokenOut = new MockERC20();
        uint256 amountIn = uint256(type(uint160).max);
        uint256 deadline = block.timestamp + 300;

        tokenIn.mint(address(this), amountIn);
        tokenIn.approve(address(executor), amountIn);
        routerStub.configure(address(executor), address(tokenIn), address(tokenOut), address(permit2), 1);

        uint256 gross =
            executor.swap(address(this), _step(address(tokenIn), address(tokenOut), amountIn), deadline);

        assertEq(gross, 1, "swap at the ceiling goes through");
        MockPermit2.Approval memory approval = permit2.approvalAt(0);
        assertEq(uint256(approval.amount), amountIn, "Permit2 allowance equals the uint160 ceiling");
    }

    /// @dev Swap payload the executor's own allowlist would accept for this pair (the stub ignores it).
    function _step(address tokenIn, address tokenOut, uint256 amountIn)
        internal
        view
        returns (AtpExecutor.SwapStep memory step)
    {
        step.tokenIn = tokenIn;
        step.tokenOut = tokenOut;
        step.amountIn = amountIn;
        step.amountOutMin = 0;
        step.commands = hex"00";
        step.inputs = _one(
            abi.encode(
                address(executor),
                amountIn,
                uint256(0),
                abi.encodePacked(tokenIn, uint24(500), tokenOut),
                true
            )
        );
    }
}
