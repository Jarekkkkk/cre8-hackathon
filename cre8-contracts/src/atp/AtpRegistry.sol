// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title AtpRegistry
/// @notice On-chain record of ATP strategies: versioned asset/weight sets, the admin-controlled swap fee,
/// and which strategy version an account is enrolled in.
/// @dev Weights are data, not logic: the keeper reads them, the executor only uses the asset set of the
/// enrolled version as an allowlist. A published version is immutable; a provider changes weights by
/// publishing the next version, and existing enrollments keep the version they pinned until they re-enroll.
/// TODO: owner is a single key in v1 (multisig / timelock before mainnet), and `enroll` has no two-phase
/// signature check yet - see docs/atp-pivot-executor-spec.zh-TW.md §6.
contract AtpRegistry {
    // ---- types ----
    struct Version {
        /// @notice Admission list of tokens (bStock) this version may trade.
        address[] assets;
        /// @notice Portfolio weights per asset, same order and length as `assets`, summing to 10000.
        uint16[] weightsBps;
        /// @notice Off-chain encoding (interval | cron) of the rebalance schedule.
        bytes32 scheduleHash;
        /// @notice Unix timestamp from which this version may be executed.
        uint64 activeAt;
    }

    struct StrategyMeta {
        address provider;
        string name;
        string description;
        bool isPublic;
    }

    struct Enrollment {
        uint256 strategyId;
        /// @notice Version index pinned at enrollment time (1-based; 0 means "never enrolled").
        uint16 version;
        bool paused;
    }

    // ---- constants ----
    /// @notice Hard ceiling for both the default and the per-strategy swap fee (0-3%).
    uint16 public constant MAX_SWAP_FEE_BPS = 300;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant TOTAL_WEIGHT_BPS = 10_000;
    /// @notice Upper bound on a version's asset list. `isAssetAllowed` is read twice per swap step on-chain,
    /// so the list is kept short enough that the linear scan stays cheap.
    uint256 public constant MAX_VERSION_ASSETS = 16;

    // ---- admin / fee ----
    /// @notice Admin key (multisig before mainnet). Also the only address that may move `feeRecipient`.
    address public owner;
    /// @notice Default swap fee for strategies without an override.
    uint16 public defaultSwapFeeBps;
    /// @notice Per-strategy swap fee override; 0 means "use `defaultSwapFeeBps`".
    mapping(uint256 => uint16) public feeBps;

    // ---- strategy / version ----
    mapping(uint256 => StrategyMeta) public strategies;
    /// @dev 1-based version history: index 0 is an empty sentinel so that version 0 can mean "active".
    mapping(uint256 => Version[]) internal _versions;
    /// @notice Currently active version index for a strategy (0 = none published).
    mapping(uint256 => uint16) public activeVersion;
    /// @notice Next strategy id to be handed out; ids start at 1.
    uint256 public nextStrategyId;

    // ---- enrollment ----
    mapping(address => Enrollment) internal _enrollments;
    mapping(address => bool) public isEnrolled;

    // ---- events ----
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event DefaultFeeBpsUpdated(uint16 bps);
    event FeeBpsUpdated(uint256 indexed id, uint16 bps);
    event StrategyRegistered(uint256 indexed id, address indexed provider, string name);
    event VersionPublished(uint256 indexed id, uint16 version, bytes32 scheduleHash);
    event Enrolled(address indexed account, uint256 id, uint16 version);
    event EnrollmentPausedSet(address indexed account, bool paused);

    // ---- errors ----
    error NotOwner();
    error ZeroAddress();
    error FeeTooHigh(uint16 bps);
    error UnknownStrategy(uint256 id);
    error UnknownVersion(uint256 id, uint16 version);
    error NotStrategyProvider(uint256 id);
    error EmptyAssets();
    error LengthMismatch();
    error TooManyAssets(uint256 count);
    error DuplicateAsset(address asset);
    error WeightsMismatch(uint256 sum);
    error Unauthorized();
    error VersionNotPublished(uint256 id);

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ---- admin ----

    /// @notice Hand the admin role to `next`. Single-step on purpose in v1; a two-step handover lands with
    /// the multisig TODO.
    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, next);
        owner = next;
    }

    /// @notice Set the swap fee used by every strategy without an override.
    function setDefaultFeeBps(uint16 bps) external onlyOwner {
        _checkFee(bps);
        defaultSwapFeeBps = bps;
        emit DefaultFeeBpsUpdated(bps);
    }

    /// @notice Set (or with `bps == 0` clear) a strategy's swap fee override.
    function setStrategyFeeBps(uint256 id, uint16 bps) external onlyOwner {
        if (strategies[id].provider == address(0)) revert UnknownStrategy(id);
        _checkFee(bps);
        feeBps[id] = bps;
        emit FeeBpsUpdated(id, bps);
    }

    // ---- strategy / version ----

    /// @notice Register a new strategy owned by `msg.sender`. Provider admission (allowlisting who may
    /// register) is deliberately not enforced on-chain yet.
    function registerStrategy(string calldata name, string calldata description, bool isPublic)
        external
        returns (uint256 id)
    {
        id = ++nextStrategyId;
        strategies[id] =
            StrategyMeta({ provider: msg.sender, name: name, description: description, isPublic: isPublic });
        emit StrategyRegistered(id, msg.sender, name);
    }

    /// @notice Publish the next version of `id` and make it active for new enrollments.
    /// @dev Append-only: a version index can never be reused or overwritten, so the history of a strategy
    /// only grows. Only the strategy provider or the registry owner may publish.
    function publishVersion(
        uint256 id,
        address[] calldata assets,
        uint16[] calldata weightsBps,
        bytes32 scheduleHash,
        uint64 activeAt
    ) external returns (uint16 versionNumber) {
        StrategyMeta memory meta = strategies[id];
        if (meta.provider == address(0)) revert UnknownStrategy(id);
        if (msg.sender != meta.provider && msg.sender != owner) revert NotStrategyProvider(id);
        _validateVersion(assets, weightsBps);

        Version[] storage history = _versions[id];
        // 1-based: seed the sentinel on first publish so version 0 stays reserved for "active".
        if (history.length == 0) history.push();
        Version storage published = history.push();
        published.assets = assets;
        published.weightsBps = weightsBps;
        published.scheduleHash = scheduleHash;
        published.activeAt = activeAt;

        versionNumber = uint16(history.length - 1);
        activeVersion[id] = versionNumber;
        emit VersionPublished(id, versionNumber, scheduleHash);
    }

    // ---- enrollment ----

    /// @notice Enroll `account` into `id`, pinning the currently active version (and clearing any pause).
    /// @dev Callable by the account itself, or by the owner/backend. Re-enrolling is also how a follower
    /// moves to a newer version. TODO: replace the owner branch with the two-phase signed intent.
    function enroll(address account, uint256 id) external {
        if (msg.sender != account && msg.sender != owner) revert Unauthorized();
        if (account == address(0)) revert ZeroAddress();
        if (strategies[id].provider == address(0)) revert UnknownStrategy(id);
        uint16 version = activeVersion[id];
        if (version == 0) revert VersionNotPublished(id);

        _enrollments[account] = Enrollment({ strategyId: id, version: version, paused: false });
        isEnrolled[account] = true;
        emit Enrolled(account, id, version);
    }

    /// @notice Pause or resume an enrolled account. A paused account fails every `executeRebalance`.
    function setPaused(address account, bool paused) external onlyOwner {
        if (!isEnrolled[account]) revert Unauthorized();
        _enrollments[account].paused = paused;
        emit EnrollmentPausedSet(account, paused);
    }

    // ---- views ----

    /// @notice Enrollment record for `account` (all-zero when never enrolled).
    function enrollments(address account) external view returns (Enrollment memory) {
        return _enrollments[account];
    }

    /// @notice Fee in bps actually charged for `id`: its override, else the default.
    function effectiveFeeBps(uint256 id) public view returns (uint16) {
        uint16 strategyFee = feeBps[id];
        return strategyFee == 0 ? defaultSwapFeeBps : strategyFee;
    }

    /// @notice Version record; `versionNumber == 0` resolves to the active version.
    function version(uint256 id, uint16 versionNumber) public view returns (Version memory) {
        if (versionNumber == 0) versionNumber = activeVersion[id];
        if (versionNumber == 0 || versionNumber >= _versions[id].length) {
            revert UnknownVersion(id, versionNumber);
        }
        return _versions[id][versionNumber];
    }

    /// @notice Number of published versions (0 when the strategy has none).
    function versionCount(uint256 id) public view returns (uint256) {
        uint256 stored = _versions[id].length;
        return stored == 0 ? 0 : stored - 1;
    }

    /// @notice Whether `asset` is tradable in `id` at `versionNumber` (0 = active).
    /// @dev Returns false rather than reverting for an unknown strategy/version so the executor can fail one
    /// step with its own error; an empty asset list can therefore never be "allowed".
    function isAssetAllowed(uint256 id, uint16 versionNumber, address asset) public view returns (bool) {
        if (versionNumber == 0) versionNumber = activeVersion[id];
        if (versionNumber == 0 || versionNumber >= _versions[id].length) return false;
        address[] storage assets = _versions[id][versionNumber].assets;
        for (uint256 i; i < assets.length; ++i) {
            if (assets[i] == asset) return true;
        }
        return false;
    }

    // ---- internals ----

    function _checkFee(uint16 bps) internal pure {
        if (bps > MAX_SWAP_FEE_BPS) revert FeeTooHigh(bps);
    }

    /// @dev Duplicate-free, positive-length asset list with weights summing to exactly 10000.
    function _validateVersion(address[] calldata assets, uint16[] calldata weightsBps) internal pure {
        uint256 count = assets.length;
        if (count == 0) revert EmptyAssets();
        if (count != weightsBps.length) revert LengthMismatch();
        if (count > MAX_VERSION_ASSETS) revert TooManyAssets(count);
        uint256 sum;
        for (uint256 i; i < count; ++i) {
            address asset = assets[i];
            if (asset == address(0)) revert ZeroAddress();
            for (uint256 j; j < i; ++j) {
                if (assets[j] == asset) revert DuplicateAsset(asset);
            }
            sum += weightsBps[i];
        }
        if (sum != TOTAL_WEIGHT_BPS) revert WeightsMismatch(sum);
    }
}
