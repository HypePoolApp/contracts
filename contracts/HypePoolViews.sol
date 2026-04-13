// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./HypePoolMath.sol";

/// @notice Minimal interface to check NFT ownership — avoids importing full ERC721.
interface IERC721Minimal {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/**
 * @title HypePoolViews
 * @notice View / admin-config functions split from HypePoolMath to keep each
 *         library under the 13 514-byte Hyperliquid runtime bytecode limit.
 *         Shares the same ERC-7201 storage slot as HypePoolMath.
 */
library HypePoolViews {

    bytes32 private constant _SLOT = keccak256("hypepool.v1.main.storage");

    uint256 private constant ADMIN_TIMELOCK           = 48 hours;
    uint256 private constant UPGRADE_TIMELOCK         = 72 hours;
    uint256 private constant UPGRADE_EXPIRY           = 1 hours;
    uint256 private constant UPKEEP_INTERVAL_TIMELOCK = 24 hours;
    uint256 private constant MIN_CCIP_GAS_LIMIT       = 100_000;
    uint256 private constant MAX_CCIP_GAS_LIMIT       = 2_000_000;
    uint256 private constant MAX_ROUND_ENTRIES        = 10_000;
    uint16  private constant ENTRY_PRICE_BPS          = 5;
    uint256 private constant MIN_ENTRY_PRICE          = 0.01 ether;
    uint256 private constant MAX_ENTRY_PRICE          = 0.5 ether;
    uint256 private constant EMERGENCY_CANCEL_DELAY   = 24 hours;
    uint8   private constant DRAW_TRIGGER_CREDITS     = 2;
    uint8   private constant NFT_MAX_SUPPLY           = 10;
    uint256 private constant LAST_DROP_THRESHOLD      = 50;
    uint8   private constant MAX_FREE_ENTRIES_PER_ROUND = 100;

    function _s() private pure returns (HypePoolStorage storage s) {
        bytes32 slot = _SLOT;
        assembly { s.slot := slot }
    }

    // ── View functions ────────────────────────────────────────────
    function entryPrice() external view returns (uint256) {
        HypePoolStorage storage s = _s();
        RoundInfo storage r = s.rounds[s.currentRound];
        uint256 pool = r.prizePool + r.seedPool;
        uint256 price = (pool * ENTRY_PRICE_BPS) / 10000;
        if (price < MIN_ENTRY_PRICE) return MIN_ENTRY_PRICE;
        if (price > MAX_ENTRY_PRICE) return MAX_ENTRY_PRICE;
        return price;
    }

    function getRoundInfo(uint256 rid) external view returns (
        uint256 prizePool, uint256 seedPool, uint256 entryCount, uint8 state,
        uint8[5] memory drawnWhites, uint8 drawnGoldNum, uint8 drawnGoldPos,
        uint256 prizePoolWinners, uint256 superWinners
    ) {
        RoundInfo storage r = _s().rounds[rid];
        return (r.prizePool, r.seedPool, r.entryCount, uint8(r.state), r.drawnWhites, r.drawnGoldNum, r.drawnGoldPos, r.prizePoolWinners, r.superWinners);
    }

    function getEntry(uint256 rid, uint256 idx) external view returns (address player, uint8[5] memory whites, uint8 goldNum, uint8 goldPos) {
        EntryInfo storage t = _s().roundEntries[rid][idx];
        return (t.player, t.whites, t.goldNum, t.goldPos);
    }

    function getPlayerEntryIndices(uint256 rid, address player) external view returns (uint256[] memory) {
        return _s().playerIndices[rid][player];
    }

    function getPlayerEntries(uint256 rid, address player) external view returns (EntryInfo[] memory) {
        HypePoolStorage storage s = _s();
        uint256[] storage indices = s.playerIndices[rid][player];
        EntryInfo[] memory result = new EntryInfo[](indices.length);
        for (uint256 i = 0; i < indices.length; i++) result[i] = s.roundEntries[rid][indices[i]];
        return result;
    }

    function getClaimableAmount(uint256 roundId, address player) external view returns (uint256 amount) {
        HypePoolStorage storage s = _s();
        RoundInfo storage r = s.rounds[roundId];
        if (r.state != RoundState.SETTLED) return 0;
        uint256[] storage indices = s.playerIndices[roundId][player];
        for (uint256 i = 0; i < indices.length; i++) {
            uint256 idx = indices[i];
            if (s.entryClaimed[roundId][idx]) continue;
            EntryInfo storage t = s.roundEntries[roundId][idx];
            if (_matchWhitesStor(t.whites, r.drawnWhites)) {
                amount += r.prizePerWinner;
                if (t.goldNum == r.drawnGoldNum && t.goldPos == r.drawnGoldPos) amount += r.superPrizePerWinner;
            }
        }
    }

    function getUpkeepIntervalProposal() external view returns (uint256 newInterval, uint256 executeAfter, uint8 status) {
        HypePoolStorage storage s = _s();
        newInterval = s.pendingUpkeepInterval;
        executeAfter = s.upkeepIntervalProposalExecuteAfter;
        if (newInterval == 0 || executeAfter == 0) status = 0;
        else if (block.timestamp < executeAfter) status = 1;
        else status = 2;
    }

    function getUpgradeProposal() external view returns (address impl, uint256 executeAfter, uint256 expiresAt, uint8 status) {
        HypePoolStorage storage s = _s();
        impl = s.pendingUpgradeImpl;
        executeAfter = s.upgradeProposalExecuteAfter;
        expiresAt = executeAfter > 0 ? executeAfter + UPGRADE_EXPIRY : 0;
        if (impl == address(0) || executeAfter == 0) status = 0;
        else if (block.timestamp < executeAfter) status = 1;
        else if (block.timestamp < expiresAt) status = 2;
        else status = 3;
    }

    function checkUpkeep() external view returns (bool upkeepNeeded, bytes memory) {
        HypePoolStorage storage s = _s();
        RoundInfo storage r = s.rounds[s.currentRound];
        if (r.state == RoundState.OPEN) {
            upkeepNeeded = (r.entryCount > 0 && block.timestamp >= s.lastUpkeepTime + s.upkeepInterval);
        } else if (r.state == RoundState.DRAWN) {
            upkeepNeeded = true;
        }
    }

    // ── New feature views ─────────────────────────────────────────
    function earlyBirdRemaining(uint256 roundId) external view returns (uint256) {
        HypePoolStorage storage s = _s();
        uint256 sold = s.earlyBirdSold[roundId];
        return sold >= 5 ? 0 : 5 - sold;
    }

    function lastDropInfo() external view returns (address lastBuyer, uint256 lastDropPool, uint256 threshold, bool isEligible) {
        HypePoolStorage storage s = _s();
        uint256 rid = s.currentRound;
        lastBuyer   = s.lastBuyer[rid];
        lastDropPool = s.lastDropPool;
        threshold   = LAST_DROP_THRESHOLD;
        isEligible  = s.rounds[rid].entryCount >= LAST_DROP_THRESHOLD;
    }

    function luckyDrawInfo(uint256 roundId) external view returns (address winner, uint256 prize, bool claimed) {
        HypePoolStorage storage s = _s();
        return (s.luckyDrawWinner[roundId], s.luckyDrawPrize[roundId], s.luckyDrawClaimed[roundId]);
    }

    function freeEntriesRemaining() external view returns (uint256) {
        HypePoolStorage storage s = _s();
        uint256 used = s.freeEntriesThisRound;
        return used >= MAX_FREE_ENTRIES_PER_ROUND ? 0 : MAX_FREE_ENTRIES_PER_ROUND - used;
    }

    function getFreeEntryMinter() external view returns (address) {
        return _s().freeEntryMinter;
    }

    // ── Simple state getters ──────────────────────────────────────
    function currentRound()        external view returns (uint256) { return _s().currentRound; }
    function ccipRouter()          external view returns (address) { return _s().ccipRouter; }
    function sourceChainSelector() external view returns (uint64)  { return _s().sourceChainSelector; }
    function vrfRequester()        external view returns (address) { return _s().vrfRequester; }
    function ccipGasLimit()        external view returns (uint256) { return _s().ccipGasLimit; }
    function ownerFees()           external view returns (uint256) { return _s().ownerFees; }
    function settlementBatchSize() external view returns (uint256) { return _s().settlementBatchSize; }
    function upkeepInterval()      external view returns (uint256) { return _s().upkeepInterval; }
    function lastUpkeepTime()      external view returns (uint256) { return _s().lastUpkeepTime; }
    function pendingAdminActions(bytes32 h) external view returns (uint256) { return _s().pendingAdminActions[h]; }
    function pendingPayouts(address a) external view returns (uint256) { return _s().pendingPayouts[a]; }
    function entryClaimed(uint256 r, uint256 i) external view returns (bool) { return _s().entryClaimed[r][i]; }
    function playerEntryCount(uint256 r, address p) external view returns (uint256) { return _s().playerEntryCount[r][p]; }
    function roundEntries(uint256 r, uint256 i) external view returns (address, uint8[5] memory, uint8, uint8) {
        EntryInfo storage t = _s().roundEntries[r][i];
        return (t.player, t.whites, t.goldNum, t.goldPos);
    }
    function settlementProgress(uint256 r) external view returns (uint256) { return _s().settlementProgress[r]; }
    function pendingUpgradeImpl()  external view returns (address) { return _s().pendingUpgradeImpl; }
    function pendingUpkeepInterval() external view returns (uint256) { return _s().pendingUpkeepInterval; }
    function upkeepIntervalProposalExecuteAfter() external view returns (uint256) { return _s().upkeepIntervalProposalExecuteAfter; }
    function freeEntryCredits(address a) external view returns (uint256) { return _s().freeEntryCredits[a]; }
    function drawRequestedAt()  external view returns (uint256) { return _s().drawRequestedAt; }
    function lastDropPool()     external view returns (uint256) { return _s().lastDropPool; }
    function luckyDrawPool()    external view returns (uint256) { return _s().luckyDrawPool; }
    function lastBuyer(uint256 roundId) external view returns (address) { return _s().lastBuyer[roundId]; }

    // ── V2 getters ────────────────────────────────────────────────────
    function foundationPassContract() external view returns (address) { return _s().foundationPassContract; }
    function nftRevenuePool()      external view returns (uint256) { return _s().nftRevenuePool; }
    function nftTotalDistributed() external view returns (uint256) { return _s().nftTotalDistributed; }
    function nftClaimedRevenue(uint256 tokenId) external view returns (uint256) { return _s().nftClaimedRevenue[tokenId]; }
    function referrers(address a)  external view returns (address) { return _s().referrers[a]; }
    function referralEarnings(address a) external view returns (uint256) { return _s().referralEarnings[a]; }
    function foundationPassAwarded() external view returns (bool) { return _s().foundationPassAwarded; }

    /// @notice Returns the claimable NFT revenue for a specific tokenId.
    function getClaimableNFTRevenue(uint256 tokenId) external view returns (uint256) {
        HypePoolStorage storage s = _s();
        uint256 perToken = s.nftTotalDistributed / NFT_MAX_SUPPLY;
        uint256 claimed  = s.nftClaimedRevenue[tokenId];
        return perToken > claimed ? perToken - claimed : 0;
    }

    // ── V2: NFT Revenue Claim ─────────────────────────────────
    function claimNFTRevenue(uint256 tokenId) external {
        HypePoolStorage storage s = _s();
        if (s.foundationPassContract == address(0)) revert ZeroAddress();
        address holder = IERC721Minimal(s.foundationPassContract).ownerOf(tokenId);
        if (holder != msg.sender) revert NotNFTOwner();
        uint256 perToken = s.nftTotalDistributed / NFT_MAX_SUPPLY;
        uint256 claimed  = s.nftClaimedRevenue[tokenId];
        uint256 claimable = perToken > claimed ? perToken - claimed : 0;
        if (claimable == 0) revert NoNFTRevenue();
        s.nftClaimedRevenue[tokenId] = perToken;
        s.nftRevenuePool -= claimable;
        (bool ok,) = payable(msg.sender).call{value: claimable}("");
        if (!ok) s.pendingPayouts[msg.sender] += claimable;
        emit NFTRevenueClaimed(tokenId, msg.sender, claimable);
    }

    // ── V2: Referral Earnings Claim ───────────────────────────
    function claimReferralEarnings() external {
        HypePoolStorage storage s = _s();
        uint256 amount = s.referralEarnings[msg.sender];
        if (amount == 0) revert NothingToClaim();
        s.referralEarnings[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) s.pendingPayouts[msg.sender] += amount;
        emit ReferralEarningsClaimed(msg.sender, amount);
    }

    // ── Admin config ─────────────────────────────────────────────
    function setCCIPGasLimit(uint256 newLimit) external {
        if (newLimit < MIN_CCIP_GAS_LIMIT || newLimit > MAX_CCIP_GAS_LIMIT) revert GasLimitOutOfRange();
        _s().ccipGasLimit = newLimit;
    }

    function proposeSetCCIPRouter(address newRouter) external {
        if (newRouter == address(0)) revert ZeroAddress();
        if (newRouter.code.length == 0) revert NotAContract();
        _proposeAdmin(keccak256(abi.encode("setCCIPRouter", newRouter)), ADMIN_TIMELOCK);
    }

    function executeSetCCIPRouter(address newRouter) external {
        if (newRouter.code.length == 0) revert NotAContract();
        HypePoolStorage storage s = _s();
        _executeAction(s, keccak256(abi.encode("setCCIPRouter", newRouter)));
        s.ccipRouter = newRouter;
    }

    function proposeSetVRFRequester(address newRequester) external {
        if (newRequester == address(0)) revert ZeroAddress();
        if (newRequester.code.length == 0) revert NotAContract();
        _proposeAdmin(keccak256(abi.encode("setVRFRequester", newRequester)), ADMIN_TIMELOCK);
    }

    function executeSetVRFRequester(address newRequester) external {
        if (newRequester.code.length == 0) revert NotAContract();
        HypePoolStorage storage s = _s();
        _executeAction(s, keccak256(abi.encode("setVRFRequester", newRequester)));
        s.vrfRequester = newRequester;
    }

    function proposeUpgrade(address newImpl) external {
        HypePoolStorage storage s = _s();
        if (s.pendingUpgradeImpl != address(0)) revert ExistingProposal();
        if (newImpl == address(0)) revert ZeroAddress();
        if (newImpl.code.length == 0) revert NotAContract();
        bytes32 h = keccak256(abi.encode("upgradeToAndCall", newImpl));
        uint256 ea = block.timestamp + UPGRADE_TIMELOCK;
        s.pendingAdminActions[h] = ea;
        s.pendingUpgradeImpl = newImpl;
        s.upgradeProposalExecuteAfter = ea;
        emit AdminActionProposed(h, ea);
        emit UpgradeProposed(newImpl, ea, ea + UPGRADE_EXPIRY);
    }

    function cancelAdminAction(bytes32 actionHash) external {
        HypePoolStorage storage s = _s();
        if (s.pendingAdminActions[actionHash] == 0) revert ActionNotProposed();
        if (s.pendingUpgradeImpl != address(0)) {
            bytes32 uh = keccak256(abi.encode("upgradeToAndCall", s.pendingUpgradeImpl));
            if (uh == actionHash) { s.pendingUpgradeImpl = address(0); s.upgradeProposalExecuteAfter = 0; }
        }
        if (s.pendingUpkeepInterval != 0) {
            bytes32 ih = keccak256(abi.encode("setUpkeepInterval", s.pendingUpkeepInterval));
            if (ih == actionHash) { s.pendingUpkeepInterval = 0; s.upkeepIntervalProposalExecuteAfter = 0; }
        }
        delete s.pendingAdminActions[actionHash];
        emit AdminActionCancelled(actionHash);
    }

    function withdrawFees() external {
        HypePoolStorage storage s = _s();
        uint256 amount = s.ownerFees;
        if (amount == 0) revert NoFees();
        s.ownerFees = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function topUpOwnerFees() external {
        if (msg.value == 0) revert NoValueSent();
        _s().ownerFees += msg.value;
        emit OwnerFeesTopUp(msg.sender, msg.value);
    }

    function seedPrizePool() external {
        HypePoolStorage storage s = _s();
        if (msg.value == 0) revert NoValueSent();
        s.rounds[s.currentRound].prizePool += msg.value;
    }

    function proposeSetUpkeepInterval(uint256 newInterval) external {
        if (newInterval == 0) revert IntervalMustBePositive();
        HypePoolStorage storage s = _s();
        bytes32 h = keccak256(abi.encode("setUpkeepInterval", newInterval));
        uint256 ea = block.timestamp + UPKEEP_INTERVAL_TIMELOCK;
        s.pendingAdminActions[h] = ea;
        s.pendingUpkeepInterval = newInterval;
        s.upkeepIntervalProposalExecuteAfter = ea;
        emit AdminActionProposed(h, ea);
        emit UpkeepIntervalProposed(newInterval, ea);
    }

    function executeSetUpkeepInterval(uint256 newInterval) external {
        HypePoolStorage storage s = _s();
        bytes32 h = keccak256(abi.encode("setUpkeepInterval", newInterval));
        if (s.pendingAdminActions[h] == 0) revert ActionNotProposed();
        if (block.timestamp < s.pendingAdminActions[h]) revert TimelockNotExpired();
        delete s.pendingAdminActions[h];
        s.pendingUpkeepInterval = 0;
        s.upkeepIntervalProposalExecuteAfter = 0;
        s.upkeepInterval = newInterval;
        emit AdminActionExecuted(h);
    }

    function authorizeUpgrade(address newImpl) external {
        HypePoolStorage storage s = _s();
        bytes32 h = keccak256(abi.encode("upgradeToAndCall", newImpl));
        if (s.pendingAdminActions[h] == 0) revert UpgradeNotProposed();
        uint256 ea = s.pendingAdminActions[h];
        if (block.timestamp < ea) revert TimelockNotExpired();
        if (block.timestamp >= ea + UPGRADE_EXPIRY) revert UpgradeProposalExpired();
        delete s.pendingAdminActions[h];
        s.pendingUpgradeImpl = address(0);
        s.upgradeProposalExecuteAfter = 0;
        emit AdminActionExecuted(h);
    }

    function proposeAction(bytes32 h, uint256 delay) external {
        _proposeAdmin(h, delay);
    }

    function executeSetSourceChainSelector(uint64 newSelector) external {
        HypePoolStorage storage s = _s();
        bytes32 h = keccak256(abi.encode("setSourceChainSelector", newSelector));
        _executeAction(s, h);
        s.sourceChainSelector = newSelector;
    }

    function setSettlementBatchSize(uint256 size) external {
        if (size == 0 || size > MAX_ROUND_ENTRIES) revert InvalidBatchSize();
        _s().settlementBatchSize = size;
    }

    function setFoundationPassContract(address addr) external {
        if (addr == address(0)) revert ZeroAddress();
        _s().foundationPassContract = addr;
    }

    function setFreeEntryMinter(address addr) external {
        _s().freeEntryMinter = addr;
    }

    function emergencyCancelDraw() external {
        HypePoolStorage storage s = _s();
        uint256 rid = s.currentRound;
        RoundInfo storage r = s.rounds[rid];
        if (r.state != RoundState.DRAWING) revert NotDrawing();
        if (block.timestamp < s.drawRequestedAt + 300) revert GracePeriodActive();
        r.ccipMessageId = bytes32(0);
        r.state = RoundState.OPEN;
        s.lastUpkeepTime = block.timestamp - s.upkeepInterval;
        emit DrawCancelled(rid);
    }

    function publicEmergencyCancelDraw() external {
        HypePoolStorage storage s = _s();
        uint256 rid = s.currentRound;
        RoundInfo storage r = s.rounds[rid];
        if (r.state != RoundState.DRAWING) revert NotDrawing();
        if (block.timestamp < s.drawRequestedAt + EMERGENCY_CANCEL_DELAY) revert EmergencyCancelDelayNotMet();
        r.ccipMessageId = bytes32(0);
        r.state = RoundState.OPEN;
        s.lastUpkeepTime = block.timestamp - s.upkeepInterval;
        emit DrawCancelled(rid);
        s.freeEntryCredits[msg.sender] += DRAW_TRIGGER_CREDITS;
        emit DrawTriggerRewarded(msg.sender, DRAW_TRIGGER_CREDITS);
    }

    // ── Private helpers ──────────────────────────────────────────
    function _matchWhitesStor(uint8[5] storage a, uint8[5] storage b) private view returns (bool) {
        for (uint8 i = 0; i < 5; i++) { if (a[i] != b[i]) return false; }
        return true;
    }

    function _proposeAdmin(bytes32 h, uint256 delay) private {
        HypePoolStorage storage s = _s();
        uint256 ea = block.timestamp + delay;
        s.pendingAdminActions[h] = ea;
        emit AdminActionProposed(h, ea);
    }

    function _executeAction(HypePoolStorage storage s, bytes32 h) private {
        if (s.pendingAdminActions[h] == 0) revert ActionNotProposed();
        if (block.timestamp < s.pendingAdminActions[h]) revert TimelockNotExpired();
        delete s.pendingAdminActions[h];
        emit AdminActionExecuted(h);
    }
}
