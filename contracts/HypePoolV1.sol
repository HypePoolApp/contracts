// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@chainlink/contracts-ccip/contracts/interfaces/IAny2EVMMessageReceiver.sol";
import "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import "./HypePoolMath.sol";
import "./HypePoolViews.sol";

/**
 * @title HypePoolV1
 * @notice Thin upgradeable wrapper – all game logic lives in HypePoolMath
 *         and HypePoolViews (deployed as separate libraries) to stay under
 *         the 13 514-byte runtime bytecode limit on Hyperliquid.
 */
contract HypePoolV1 is
    Initializable,
    OwnableUpgradeable,
    ReentrancyGuard,
    UUPSUpgradeable,
    IAny2EVMMessageReceiver
{
    // ── Public constants (kept on-contract for ABI visibility) ────
    uint16  public constant ENTRY_PRICE_BPS          = 5;
    uint256 public constant MIN_ENTRY_PRICE          = 0.01 ether;
    uint8   public constant MAX_ENTRIES              = 25;
    uint256 public constant MAX_ROUND_ENTRIES        = 10_000;
    uint16  public constant PRIZE_POOL_BPS           = 5000;
    uint16  public constant SUPER_POOL_BPS           = 3000;
    uint16  public constant NFT_FEE_BPS              = 1000;
    uint16  public constant MINI_PRIZES_BPS          = 400;
    uint16  public constant REFERRAL_BPS             = 300;
    uint16  public constant OWNER_BPS                = 300;
    uint8   public constant EARLY_BIRD_LIMIT         = 5;
    uint256 public constant LAST_DROP_THRESHOLD      = 50;
    uint8   public constant MAX_FREE_ENTRIES_PER_ROUND = 100;
    uint256 public constant ADMIN_TIMELOCK           = 48 hours;
    uint256 public constant MIN_CCIP_GAS_LIMIT       = 100_000;
    uint256 public constant MAX_CCIP_GAS_LIMIT       = 2_000_000;
    bytes32 public constant DEFAULT_ADMIN_ROLE       = bytes32(0);

    // ── Events (re-declared for ABI visibility; emitted by libraries) ──
    event EntriesPurchased(uint256 indexed roundId, address indexed player, uint256 count);
    event DrawRequested(uint256 indexed roundId, bytes32 ccipMessageId);
    event NumbersDrawn(uint256 indexed roundId, uint8[5] whites, uint8 goldNum, uint8 goldPos);
    event RoundSettled(uint256 indexed roundId, uint256 prizePoolWinners, uint256 superWinners);
    event PrizeClaimed(uint256 indexed roundId, address indexed player, uint256 amount);
    event UpkeepPerformed(uint256 indexed roundId, string action);
    event CCIPDrawFulfilled(uint256 indexed roundId, uint256 randomWord);
    event DrawCancelled(uint256 indexed roundId);
    event AdminActionProposed(bytes32 indexed actionHash, uint256 executeAfter);
    event AdminActionExecuted(bytes32 indexed actionHash);
    event AdminActionCancelled(bytes32 indexed actionHash);
    event UpgradeProposed(address indexed newImplementation, uint256 executeAfter, uint256 expiresAt);
    event UpkeepIntervalProposed(uint256 newInterval, uint256 executeAfter);
    event OwnerFeesTopUp(address indexed sender, uint256 amount);
    event DrawTriggerRewarded(address indexed caller, uint256 credits);
    event SettleRewarded(address indexed caller, uint256 amount);
    event ReferrerRegistered(address indexed player, address indexed referrer);
    event ReferralEarned(address indexed referrer, address indexed player, uint256 amount);
    event NFTRevenueClaimed(uint256 indexed tokenId, address indexed holder, uint256 amount);
    event ReferralEarningsClaimed(address indexed referrer, uint256 amount);
    event FoundationPassWon(uint256 indexed roundId, address indexed winner);
    event LastDropClaimed(uint256 indexed roundId, address indexed winner, uint256 amount);
    event LuckyDrawClaimed(uint256 indexed roundId, address indexed winner, uint256 amount);
    event FreeEntryMinted(uint256 indexed roundId, address indexed player);
    event LastDropAssigned(uint256 indexed roundId, address indexed winner, uint256 amount);
    event LuckyDrawAssigned(uint256 indexed roundId, address indexed winner, uint256 amount);

    // ── Modifiers ────────────────────────────────────────────────
    modifier onlyAdmin() { if (_msgSender() != owner()) revert Unauthorized(); _; }
    modifier noContract() { if (tx.origin != msg.sender) revert NoIndirectCalls(); _; }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(
        address _owner, address _ccipRouter, uint64 _sourceChainSelector, address _vrfRequester
    ) external initializer {
        if (_owner == address(0) || _ccipRouter == address(0) || _vrfRequester == address(0)) revert ZeroAddress();
        __Ownable_init(_owner);
        HypePoolMath.initStorage(_ccipRouter, _sourceChainSelector, _vrfRequester);
    }

    receive() external payable {}

    // ── AccessControl shim ───────────────────────────────────────
    function hasRole(bytes32, address addr) public view returns (bool) { return addr == owner(); }
    function supportsInterface(bytes4 id) public pure returns (bool) {
        return id == type(IAny2EVMMessageReceiver).interfaceId || id == 0x01ffc9a7;
    }

    // ═══════════════════ CCIP ════════════════════════════════════
    function ccipReceive(Client.Any2EVMMessage calldata message) external override nonReentrant {
        HypePoolMath.ccipReceiveValidated(message);
    }

    // ═══════════════════ PLAYER ACTIONS ══════════════════════════
    function buyEntries(uint8[5][] calldata w, uint8[] calldata g, uint8[] calldata p, address referrer)
        external payable noContract nonReentrant { HypePoolMath.buyEntries(w, g, p, referrer); }
    function claimPrize(uint256 rid, uint256 idx) external nonReentrant { HypePoolMath.claimPrize(rid, idx); }
    function claimPrizeBatch(uint256 rid, uint256[] calldata idxs) external nonReentrant { HypePoolMath.claimPrizeBatch(rid, idxs); }
    function claimPendingPayout() external nonReentrant { HypePoolMath.claimPendingPayout(); }
    function claimLastDrop(uint256 roundId) external nonReentrant { HypePoolMath.claimLastDrop(roundId); }
    function claimLuckyDraw(uint256 roundId) external nonReentrant { HypePoolMath.claimLuckyDraw(roundId); }

    // ═══════════════════ FREE ENTRY MINTER ═══════════════════════
    function mintFreeEntry(address player, uint8[5] calldata whites, uint8 goldNum, uint8 goldPos)
        external nonReentrant { HypePoolMath.mintFreeEntry(player, whites, goldNum, goldPos); }

    // ═══════════════════ V2: NFT + REFERRAL CLAIMS ═══════════════
    function claimNFTRevenue(uint256 tokenId) external nonReentrant { HypePoolViews.claimNFTRevenue(tokenId); }
    function claimReferralEarnings() external nonReentrant { HypePoolViews.claimReferralEarnings(); }

    // ═══════════════════ GAME ADMIN ═════════════════════════════
    function closeBettingAndDraw()  external onlyAdmin { HypePoolMath.closeBettingAndDraw(); }
    function settleRound()          external nonReentrant { HypePoolMath.settleRound(); }
    function settleRoundBatch()     external nonReentrant { HypePoolMath.settleRoundBatch(); }

    // ═══════════════════ AUTOMATION ══════════════════════════════
    function performUpkeep(bytes calldata) external nonReentrant { HypePoolMath.performUpkeep(); }
    function triggerPublicDraw()           external nonReentrant { HypePoolMath.triggerPublicDraw(); }
    function publicEmergencyCancelDraw()   external nonReentrant { HypePoolViews.publicEmergencyCancelDraw(); }

    // ═══════════════════ ADMIN CONFIG (via HypePoolViews) ════════
    function setSettlementBatchSize(uint256 s)       external onlyAdmin { HypePoolViews.setSettlementBatchSize(s); }
    function emergencyCancelDraw()                   external onlyAdmin { HypePoolViews.emergencyCancelDraw(); }
    function setCCIPGasLimit(uint256 v)              external onlyAdmin { HypePoolViews.setCCIPGasLimit(v); }
    function proposeSetCCIPRouter(address a)         external onlyAdmin { HypePoolViews.proposeSetCCIPRouter(a); }
    function executeSetCCIPRouter(address a)         external onlyAdmin { HypePoolViews.executeSetCCIPRouter(a); }
    function proposeSetSourceChainSelector(uint64 v) external onlyAdmin { HypePoolViews.proposeAction(keccak256(abi.encode("setSourceChainSelector", v)), ADMIN_TIMELOCK); }
    function executeSetSourceChainSelector(uint64 v) external onlyAdmin { HypePoolViews.executeSetSourceChainSelector(v); }
    function proposeSetVRFRequester(address a)       external onlyAdmin { HypePoolViews.proposeSetVRFRequester(a); }
    function executeSetVRFRequester(address a)       external onlyAdmin { HypePoolViews.executeSetVRFRequester(a); }
    function proposeUpgrade(address a)               external onlyAdmin { HypePoolViews.proposeUpgrade(a); }
    function cancelAdminAction(bytes32 h)            external onlyAdmin { HypePoolViews.cancelAdminAction(h); }
    function withdrawFees()                          external onlyAdmin nonReentrant { HypePoolViews.withdrawFees(); }
    function topUpOwnerFees()                        external payable { HypePoolViews.topUpOwnerFees(); }
    function proposeSetUpkeepInterval(uint256 v)     external onlyAdmin { HypePoolViews.proposeSetUpkeepInterval(v); }
    function executeSetUpkeepInterval(uint256 v)     external onlyAdmin { HypePoolViews.executeSetUpkeepInterval(v); }
    function setFoundationPassContract(address a)      external onlyAdmin { HypePoolViews.setFoundationPassContract(a); }
    function setFreeEntryMinter(address a)           external onlyAdmin { HypePoolViews.setFreeEntryMinter(a); }
    function seedPrizePool() external payable {
        if (_msgSender() != owner() && _msgSender() != HypePoolViews.foundationPassContract()) revert Unauthorized();
        HypePoolViews.seedPrizePool();
    }

    // ═══════════════════ VIEW (via HypePoolViews) ════════════════
    function checkUpkeep(bytes calldata) external view returns (bool n, bytes memory d) { return HypePoolViews.checkUpkeep(); }
    function entryPrice() public view returns (uint256) { return HypePoolViews.entryPrice(); }
    function getRoundInfo(uint256 rid) external view returns (
        uint256 prizePool, uint256 seedPool, uint256 entryCount, uint8 state,
        uint8[5] memory drawnWhites, uint8 drawnGoldNum, uint8 drawnGoldPos,
        uint256 prizePoolWinners, uint256 superWinners
    ) { return HypePoolViews.getRoundInfo(rid); }
    function getEntry(uint256 rid, uint256 idx) external view returns (address player, uint8[5] memory whites, uint8 goldNum, uint8 goldPos) { return HypePoolViews.getEntry(rid, idx); }
    function getPlayerEntryIndices(uint256 rid, address p) external view returns (uint256[] memory) { return HypePoolViews.getPlayerEntryIndices(rid, p); }
    function getPlayerEntries(uint256 rid, address p) external view returns (EntryInfo[] memory) { return HypePoolViews.getPlayerEntries(rid, p); }
    function getClaimableAmount(uint256 rid, address p) external view returns (uint256) { return HypePoolViews.getClaimableAmount(rid, p); }
    function getUpkeepIntervalProposal() external view returns (uint256 newInterval, uint256 executeAfter, uint8 status) { return HypePoolViews.getUpkeepIntervalProposal(); }
    function getUpgradeProposal() external view returns (address impl, uint256 executeAfter, uint256 expiresAt, uint8 status) { return HypePoolViews.getUpgradeProposal(); }
    function earlyBirdRemaining(uint256 roundId) external view returns (uint256) { return HypePoolViews.earlyBirdRemaining(roundId); }
    function lastDropInfo() external view returns (address lastBuyer, uint256 lastDropPool, uint256 threshold, bool isEligible) { return HypePoolViews.lastDropInfo(); }
    function luckyDrawInfo(uint256 roundId) external view returns (address winner, uint256 prize, bool claimed) { return HypePoolViews.luckyDrawInfo(roundId); }
    function freeEntriesRemaining() external view returns (uint256) { return HypePoolViews.freeEntriesRemaining(); }
    function getFreeEntryMinter() external view returns (address) { return HypePoolViews.getFreeEntryMinter(); }

    // ── V2 Views ──────────────────────────────────────────────────
    function getClaimableNFTRevenue(uint256 tokenId) external view returns (uint256) { return HypePoolViews.getClaimableNFTRevenue(tokenId); }

    // ── State-variable getters ───────────────────────────────────
    function currentRound()        external view returns (uint256) { return HypePoolViews.currentRound(); }
    function ccipRouter()          external view returns (address) { return HypePoolViews.ccipRouter(); }
    function sourceChainSelector() external view returns (uint64)  { return HypePoolViews.sourceChainSelector(); }
    function vrfRequester()        external view returns (address) { return HypePoolViews.vrfRequester(); }
    function ccipGasLimit()        external view returns (uint256) { return HypePoolViews.ccipGasLimit(); }
    function ownerFees()           external view returns (uint256) { return HypePoolViews.ownerFees(); }
    function settlementBatchSize() external view returns (uint256) { return HypePoolViews.settlementBatchSize(); }
    function upkeepInterval()      external view returns (uint256) { return HypePoolViews.upkeepInterval(); }
    function lastUpkeepTime()      external view returns (uint256) { return HypePoolViews.lastUpkeepTime(); }
    function pendingUpkeepInterval() external view returns (uint256) { return HypePoolViews.pendingUpkeepInterval(); }
    function upkeepIntervalProposalExecuteAfter() external view returns (uint256) { return HypePoolViews.upkeepIntervalProposalExecuteAfter(); }
    function pendingAdminActions(bytes32 h)   external view returns (uint256) { return HypePoolViews.pendingAdminActions(h); }
    function pendingPayouts(address a)        external view returns (uint256) { return HypePoolViews.pendingPayouts(a); }
    function entryClaimed(uint256 r, uint256 i) external view returns (bool) { return HypePoolViews.entryClaimed(r, i); }
    function playerEntryCount(uint256 r, address p) external view returns (uint256) { return HypePoolViews.playerEntryCount(r, p); }
    function pendingUpgradeImpl()  external view returns (address) { return HypePoolViews.pendingUpgradeImpl(); }
    function settlementProgress(uint256 r) external view returns (uint256) { return HypePoolViews.settlementProgress(r); }
    function freeEntryCredits(address a)  external view returns (uint256) { return HypePoolViews.freeEntryCredits(a); }
    function drawRequestedAt()             external view returns (uint256) { return HypePoolViews.drawRequestedAt(); }
    function lastDropPool()                external view returns (uint256) { return HypePoolViews.lastDropPool(); }
    function luckyDrawPool()               external view returns (uint256) { return HypePoolViews.luckyDrawPool(); }
    function lastBuyer(uint256 roundId)    external view returns (address) { return HypePoolViews.lastBuyer(roundId); }

    // ── V2 State getters ──────────────────────────────────────────
    function foundationPassContract() external view returns (address) { return HypePoolViews.foundationPassContract(); }
    function nftRevenuePool()      external view returns (uint256) { return HypePoolViews.nftRevenuePool(); }
    function nftTotalDistributed() external view returns (uint256) { return HypePoolViews.nftTotalDistributed(); }
    function referralEarnings(address a) external view returns (uint256) { return HypePoolViews.referralEarnings(a); }
    function foundationPassAwarded() external view returns (bool) { return HypePoolViews.foundationPassAwarded(); }

    // ═══════════════════ UUPS ════════════════════════════════════
    function _authorizeUpgrade(address newImpl) internal override onlyAdmin {
        HypePoolViews.authorizeUpgrade(newImpl);
    }
}
