// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { AtpRegistry } from "../../src/atp/AtpRegistry.sol";

/// @notice Pins `AtpRegistry.publishVersion` validation: the weight sum, duplicate assets, the 16-asset
/// ceiling and the array-length match are the only gates between a provider and the asset allowlist the
/// executor trusts.
contract AtpRegistryTest is Test {
    address internal constant PROVIDER = address(0xBEEF);
    address internal constant OUTSIDER = address(0xCAFE);
    address internal constant ASSET_A = address(0xAAA1);
    address internal constant ASSET_B = address(0xAAA2);
    address internal constant ASSET_C = address(0xAAA3);

    AtpRegistry internal registry;
    uint256 internal strategyId;

    function setUp() public {
        registry = new AtpRegistry();
        vm.prank(PROVIDER);
        strategyId = registry.registerStrategy("bsc-index", "stock index v1", true);
    }

    // ---- fixtures ----

    function _assets(uint256 count) internal pure returns (address[] memory assets) {
        assets = new address[](count);
        for (uint256 i; i < count; ++i) {
            assets[i] = address(uint160(0x1000 + i));
        }
    }

    function _weights(uint256 count, uint16 weight) internal pure returns (uint16[] memory weights) {
        weights = new uint16[](count);
        for (uint256 i; i < count; ++i) {
            weights[i] = weight;
        }
    }

    function _publish(address[] memory assets, uint16[] memory weights) internal {
        vm.prank(PROVIDER);
        registry.publishVersion(strategyId, assets, weights, keccak256("schedule"), 0);
    }

    // ---- happy path ----

    function test_publishVersion_recordsVersionAndAllowlist() public {
        address[] memory assets = new address[](2);
        assets[0] = ASSET_A;
        assets[1] = ASSET_B;
        uint16[] memory weights = new uint16[](2);
        weights[0] = 6_000;
        weights[1] = 4_000;

        _publish(assets, weights);

        assertEq(registry.activeVersion(strategyId), 1);
        assertEq(registry.versionCount(strategyId), 1);
        assertTrue(registry.isAssetAllowed(strategyId, 0, ASSET_A));
        assertTrue(registry.isAssetAllowed(strategyId, 0, ASSET_B));
        assertFalse(registry.isAssetAllowed(strategyId, 0, ASSET_C));

        // Explicit pin behaves the same for the version it names.
        assertTrue(registry.isAssetAllowed(strategyId, 1, ASSET_A));
        assertFalse(registry.isAssetAllowed(strategyId, 1, ASSET_C));
    }

    function test_publishVersion_isAppendOnlyAndKeepsOldAllowlist() public {
        address[] memory first = new address[](1);
        first[0] = ASSET_A;
        _publish(first, _weights(1, 10_000));

        address[] memory second = new address[](1);
        second[0] = ASSET_B;
        _publish(second, _weights(1, 10_000));

        assertEq(registry.activeVersion(strategyId), 2);
        assertEq(registry.versionCount(strategyId), 2);
        // The old version still answers for its own assets; a stray asset is never allowed.
        assertTrue(registry.isAssetAllowed(strategyId, 1, ASSET_A));
        assertFalse(registry.isAssetAllowed(strategyId, 1, ASSET_B));
        assertFalse(registry.isAssetAllowed(strategyId, 2, ASSET_A));
        assertTrue(registry.isAssetAllowed(strategyId, 2, ASSET_B));
    }

    function test_publishVersion_acceptsFullSixteenAssets() public {
        address[] memory assets = _assets(registry.MAX_VERSION_ASSETS());
        _publish(assets, _weights(assets.length, 625));

        assertEq(registry.versionCount(strategyId), 1);
        assertTrue(registry.isAssetAllowed(strategyId, 0, assets[15]));
    }

    // ---- weight validation ----

    function test_publishVersion_revertsWhenWeightsMissTenThousand() public {
        uint16[] memory weights = new uint16[](2);
        weights[0] = 5_000;
        weights[1] = 4_999;

        vm.expectRevert(abi.encodeWithSelector(AtpRegistry.WeightsMismatch.selector, uint256(9_999)));
        _publish(_twoAssets(), weights);
    }

    function test_publishVersion_revertsWhenWeightsExceedTenThousand() public {
        uint16[] memory weights = new uint16[](2);
        weights[0] = 6_000;
        weights[1] = 4_001;

        vm.expectRevert(abi.encodeWithSelector(AtpRegistry.WeightsMismatch.selector, uint256(10_001)));
        _publish(_twoAssets(), weights);
    }

    function test_publishVersion_revertsWhenEqualWeightsMissTenThousand() public {
        vm.expectRevert(abi.encodeWithSelector(AtpRegistry.WeightsMismatch.selector, uint256(9_998)));
        _publish(_twoAssets(), _weights(2, 4_999));
    }

    // ---- duplicate / length / cap ----

    function test_publishVersion_revertsOnDuplicateAsset() public {
        address[] memory assets = new address[](2);
        assets[0] = ASSET_A;
        assets[1] = ASSET_A;

        vm.expectRevert(abi.encodeWithSelector(AtpRegistry.DuplicateAsset.selector, ASSET_A));
        _publish(assets, _weights(2, 5_000));
    }

    function test_publishVersion_revertsOnDuplicateAssetBeyondFirstSlot() public {
        address[] memory assets = new address[](3);
        assets[0] = ASSET_A;
        assets[1] = ASSET_B;
        assets[2] = ASSET_B;
        uint16[] memory weights = new uint16[](3);
        weights[0] = 3_000;
        weights[1] = 3_000;
        weights[2] = 4_000;

        vm.expectRevert(abi.encodeWithSelector(AtpRegistry.DuplicateAsset.selector, ASSET_B));
        _publish(assets, weights);
    }

    function test_publishVersion_revertsOnLengthMismatch() public {
        vm.expectRevert(AtpRegistry.LengthMismatch.selector);
        _publish(_twoAssets(), _weights(3, 3_333));
    }

    function test_publishVersion_revertsOnTooManyAssets() public {
        address[] memory assets = _assets(registry.MAX_VERSION_ASSETS() + 1);

        vm.expectRevert(abi.encodeWithSelector(AtpRegistry.TooManyAssets.selector, uint256(17)));
        _publish(assets, _weights(assets.length, 588));
    }

    function test_publishVersion_revertsOnEmptyAssets() public {
        vm.expectRevert(AtpRegistry.EmptyAssets.selector);
        _publish(new address[](0), new uint16[](0));
    }

    // ---- authorisation ----

    function test_publishVersion_revertsForNonProvider() public {
        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(AtpRegistry.NotStrategyProvider.selector, strategyId));
        registry.publishVersion(strategyId, _twoAssets(), _weights(2, 5_000), bytes32(0), 0);
    }

    function test_publishVersion_ownerMayPublish() public {
        // setUp deploys the registry from this test contract, so `address(this)` is the owner.
        registry.publishVersion(strategyId, _twoAssets(), _weights(2, 5_000), bytes32(0), 0);
        assertEq(registry.versionCount(strategyId), 1);
    }

    function test_publishVersion_revertsForUnknownStrategy() public {
        vm.expectRevert(abi.encodeWithSelector(AtpRegistry.UnknownStrategy.selector, uint256(999)));
        registry.publishVersion(999, _twoAssets(), _weights(2, 5_000), bytes32(0), 0);
    }

    // ---- allowlist defaults ----

    function test_isAssetAllowed_isFalseBeforeAnyPublish() public view {
        assertFalse(registry.isAssetAllowed(strategyId, 0, ASSET_A));
        assertEq(registry.activeVersion(strategyId), 0);
        assertEq(registry.versionCount(strategyId), 0);
    }

    function test_isAssetAllowed_isFalseForUnknownStrategyOrVersion() public view {
        assertFalse(registry.isAssetAllowed(999, 0, ASSET_A));
        assertFalse(registry.isAssetAllowed(strategyId, 7, ASSET_A));
    }

    function _twoAssets() internal pure returns (address[] memory assets) {
        assets = new address[](2);
        assets[0] = ASSET_A;
        assets[1] = ASSET_B;
    }
}
