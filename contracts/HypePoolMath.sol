// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import "@chainlink/contracts-ccip/contracts/libraries/Client.sol";

interface IFoundationPassMint {
    function poolMint(address to) external;
}

// ─── Types ───────────────────────────────────────────────────────────────────
enum RoundState { OPEN, DRAWING, DRAWN, SETTLED }

struct EntryInfo {
    address player;
    uint8[5] whites;
    uint8   goldNum;
    uint8   goldPos;
}

struct RoundInfo {
    uint256    prizePool;
    uint256    seedPool;
    uint256    feePool;
    uint256    entryCount;
    RoundState state;
    uint8[5]   drawnWhites;
    uint8      drawnGoldNum;
    uint8      drawnGoldPos;
    uint256    prizePoolWinners;
    uint256    superWinners;
    bytes32    ccipMessageId;
    uint256    prizePerWinner;
    uint256    superPrizePerWinner;
}

struct HypePoolStorage {
    address ccipRouter;
    uint64  sourceChainSelector;
    address vrfRequester;
    uint256 ccipGasLimit;
    uint256 currentRound;
    mapping(uint256 => RoundInfo)                       rounds;
    mapping(uint256 => mapping(uint256 => EntryInfo))   roundEntries;
    mapping(uint256 => mapping(address => uint256))     playerEntryCount;
    mapping(uint256 => mapping(address => uint256[]))   playerIndices;
    mapping(address => uint256)                         pendingPayouts;
    mapping(uint256 => mapping(uint256 => bool))        entryClaimed;
    uint256 ownerFees;
    mapping(bytes32 => uint256)                         pendingAdminActions;
    address pendingUpgradeImpl;
    uint256 upgradeProposalExecuteAfter;
    uint256 settlementBatchSize;
    mapping(uint256 => uint256) settlementProgress;
    mapping(uint256 => uint256) settleJCount;
    mapping(uint256 => uint256) settleSCount;
    uint256 upkeepInterval;
    uint256 lastUpkeepTime;
    uint256 pendingUpkeepInterval;
    uint256 upkeepIntervalProposalExecuteAfter;
    uint256 drawRequestedAt;
    mapping(address => uint256) freeEntryCredits;
    // ── V2: FoundationPass + Referral ────────────────────────────
    address foundationPassContract;
    uint256 nftRevenuePool;
    mapping(uint256 => uint256) nftClaimedRevenue;
    uint256 nftTotalDistributed;
    mapping(address => address) referrers;
    mapping(address => uint256) referralEarnings;
    bool foundationPassAwarded;
    // ── V3: New features (appended at end) ───────────────────────
    mapping(uint256 => uint256) earlyBirdSold;
    mapping(uint256 => address) lastBuyer;
    uint256 lastDropPool;
    mapping(uint256 => uint256) lastDropPrize;
    mapping(uint256 => bool)    lastDropClaimed;
    uint256 luckyDrawPool;
    mapping(uint256 => address) luckyDrawWinner;
    mapping(uint256 => uint256) luckyDrawPrize;
    mapping(uint256 => bool)    luckyDrawClaimed;
    mapping(uint256 => uint256) roundRandomWord;
    address freeEntryMinter;
    uint256 freeEntriesThisRound;
}

// ─── Errors ──────────────────────────────────────────────────────────────────
error Unauthorized();
error NoIndirectCalls();
error ZeroAddress();
error NotAContract();
error OnlyCCIPRouter();
error WrongSourceChain();
error WrongRequester();
error WrongRound();
error UnexpectedState();
error UpgradePending();
error NoEntries();
error ArrayLengthMismatch();
error InsufficientPayment();
error RoundNotOpen();
error EntryLimitExceeded();
error RoundEntryCapReached();
error RoundNotSettled();
error NothingToClaim();
error NoEntriesSold();
error IntervalNotElapsed();
error NotDrawnYet();
error UseBatchSettlement();
error InvalidBatchSize();
error GasLimitOutOfRange();
error ActionNotProposed();
error TimelockNotExpired();
error ExistingProposal();
error NoFees();
error TransferFailed();
error NoValueSent();
error NotDrawing();
error GracePeriodActive();
error IntervalMustBePositive();
error UpgradeNotProposed();
error UpgradeProposalExpired();
error AlreadyClaimed();
error NotEntryOwner();
error NoPrize();
error InsufficientOwnerFees();
error GoldOutOfRange();
error GoldPosOutOfRange();
error WhiteOutOfRange();
error WhitesNotSortedUnique();
error NoUpkeepNeeded();
error EmergencyCancelDelayNotMet();
error SelfReferral();
error ReferrerAlreadySet();
error NotNFTOwner();
error NoNFTRevenue();
error MaxFreeEntriesReached();
error NotFreeEntryMinter();

// ─── Events ──────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
library HypePoolMath {

    bytes32 private constant _SLOT = keccak256("hypepool.v1.main.storage");

    uint16  private constant ENTRY_PRICE_BPS      = 5;
    uint256 private constant MIN_ENTRY_PRICE       = 0.01 ether;
    uint256 private constant MAX_ENTRY_PRICE       = 0.5 ether;
    uint8   private constant MAX_ENTRIES           = 25;
    uint256 private constant MAX_ROUND_ENTRIES     = 10_000;
    uint16  private constant PRIZE_POOL_BPS        = 5000;  // 50% → prizePool
    uint16  private constant SUPER_POOL_BPS        = 3000;  // 30% → seedPool
    uint16  private constant NFT_FEE_BPS           = 1000;  // 10% → nftRevenuePool
    uint16  private constant MINI_PRIZES_BPS       = 400;   // 4% → lastDrop/luckyDraw
    uint16  private constant REFERRAL_BPS          = 300;   // 3% referral
    uint256 private constant DRAW_GRACE_PERIOD     = 300;
    uint256 private constant UPGRADE_EXPIRY        = 1 hours;
    uint16  private constant SETTLE_REWARD_BPS     = 100;   // 1% of feePool
    uint8   private constant DRAW_TRIGGER_CREDITS  = 2;
    uint8   private constant EARLY_BIRD_LIMIT      = 5;
    uint256 private constant LAST_DROP_THRESHOLD   = 50;
    uint8   private constant MAX_FREE_ENTRIES_PER_ROUND = 100;

    function _s() private pure returns (HypePoolStorage storage s) {
        bytes32 slot = _SLOT;
        assembly { s.slot := slot }
    }

    // ── Init ─────────────────────────────────────────────────────
    function initStorage(address _ccipRouter, uint64 _selector, address _vrfRequester) external {
        HypePoolStorage storage s = _s();
        s.ccipRouter          = _ccipRouter;
        s.sourceChainSelector = _selector;
        s.vrfRequester        = _vrfRequester;
        s.ccipGasLimit        = 500_000;
        s.currentRound        = 1;
        s.rounds[1].state     = RoundState.OPEN;
        s.upkeepInterval      = 86400;
        s.lastUpkeepTime      = block.timestamp;
        s.settlementBatchSize = 500;
    }

    // ── CCIP ─────────────────────────────────────────────────────
    function ccipReceiveValidated(Client.Any2EVMMessage calldata message) external {
        HypePoolStorage storage s = _s();
        if (msg.sender != s.ccipRouter) revert OnlyCCIPRouter();
        if (message.sourceChainSelector != s.sourceChainSelector) revert WrongSourceChain();
        address sender = abi.decode(message.sender, (address));
        if (sender != s.vrfRequester) revert WrongRequester();

        (uint256 roundId, uint256 randomWord) = abi.decode(message.data, (uint256, uint256));
        if (roundId != s.currentRound) revert WrongRound();
        if (s.rounds[roundId].state != RoundState.DRAWING) revert UnexpectedState();
        emit CCIPDrawFulfilled(roundId, randomWord);
        _applyRandomness(s, roundId, randomWord);
    }

    // ── Player actions ───────────────────────────────────────────
    function buyEntries(
        uint8[5][] calldata whites,
        uint8[]    calldata goldNums,
        uint8[]    calldata goldPositions,
        address    referrer
    ) external {
        HypePoolStorage storage s = _s();
        if (_isUpgradeWindow(s)) revert UpgradePending();
        uint256 count = whites.length;
        if (count == 0) revert NoEntries();
        if (count != goldNums.length || count != goldPositions.length) revert ArrayLengthMismatch();

        uint256 rid = s.currentRound;
        RoundInfo storage r = s.rounds[rid];
        if (r.state != RoundState.OPEN) revert RoundNotOpen();
        if (s.playerEntryCount[rid][msg.sender] + count > MAX_ENTRIES) revert EntryLimitExceeded();
        if (r.entryCount + count > MAX_ROUND_ENTRIES) revert RoundEntryCapReached();

        if (r.entryCount == 0) s.lastUpkeepTime = block.timestamp;

        // Register referrer (once, permanent)
        if (s.referrers[msg.sender] == address(0) && referrer != address(0)) {
            if (referrer == msg.sender) revert SelfReferral();
            s.referrers[msg.sender] = referrer;
            emit ReferrerRegistered(msg.sender, referrer);
        }

        // Apply free entry credits
        uint256 credits   = s.freeEntryCredits[msg.sender];
        uint256 freeCount = credits >= count ? count : credits;
        if (freeCount > 0) s.freeEntryCredits[msg.sender] -= freeCount;
        uint256 paidCount = count - freeCount;

        // Early bird pricing: first EARLY_BIRD_LIMIT paid entries cost half price
        uint256 earlyBirdSlots = s.earlyBirdSold[rid];
        uint256 earlyAvail = earlyBirdSlots >= EARLY_BIRD_LIMIT ? 0 : EARLY_BIRD_LIMIT - earlyBirdSlots;
        uint256 earlyUsed  = paidCount <= earlyAvail ? paidCount : earlyAvail;
        uint256 normalPaid = paidCount - earlyUsed;

        uint256 price     = _entryPrice(s);
        uint256 totalCost = earlyUsed * (price / 2) + normalPaid * price;
        if (msg.value < totalCost) revert InsufficientPayment();

        s.earlyBirdSold[rid] += earlyUsed;

        for (uint256 i = 0; i < count; i++) {
            _validateEntry(whites[i], goldNums[i], goldPositions[i]);
            uint256 idx = r.entryCount;
            s.roundEntries[rid][idx] = EntryInfo({ player: msg.sender, whites: whites[i], goldNum: goldNums[i], goldPos: goldPositions[i] });
            s.playerIndices[rid][msg.sender].push(idx);
            r.entryCount++;
        }

        s.playerEntryCount[rid][msg.sender] += count;
        s.lastBuyer[rid] = msg.sender;

        // Fee split: 50% prize pool, 30% seed, 10% NFT, 4% mini (→lastDrop/luckyDraw), 3% referral, 3% owner
        uint256 prizePoolAdd  = (totalCost * PRIZE_POOL_BPS) / 10000;
        uint256 seedAdd     = (totalCost * SUPER_POOL_BPS)  / 10000;
        uint256 nftAdd      = (totalCost * NFT_FEE_BPS)     / 10000;
        uint256 miniAdd     = (totalCost * MINI_PRIZES_BPS) / 10000;
        uint256 referralAdd = (totalCost * REFERRAL_BPS)    / 10000;
        uint256 ownerAdd    = totalCost - prizePoolAdd - seedAdd - nftAdd - miniAdd - referralAdd;

        r.prizePool += prizePoolAdd;
        r.seedPool    += seedAdd;
        s.nftRevenuePool     += nftAdd;
        s.nftTotalDistributed += nftAdd;

        // Mini prizes → 60% luckyDraw, 40% lastDrop
        uint256 luckyShare = (miniAdd * 60) / 100;
        uint256 lastShare  = miniAdd - luckyShare;
        s.luckyDrawPool += luckyShare;
        s.lastDropPool  += lastShare;

        // Referral
        address ref = s.referrers[msg.sender];
        if (ref != address(0)) {
            s.referralEarnings[ref] += referralAdd;
            emit ReferralEarned(ref, msg.sender, referralAdd);
        } else {
            ownerAdd += referralAdd;
        }
        s.ownerFees += ownerAdd;
        r.feePool   += ownerAdd;

        uint256 refund = msg.value - totalCost;
        if (refund > 0) {
            (bool ok,) = payable(msg.sender).call{value: refund}("");
            if (!ok) s.pendingPayouts[msg.sender] += refund;
        }
        emit EntriesPurchased(rid, msg.sender, count);
    }

    function mintFreeEntry(address player, uint8[5] calldata whites, uint8 goldNum, uint8 goldPos) external {
        HypePoolStorage storage s = _s();
        if (msg.sender != s.freeEntryMinter) revert NotFreeEntryMinter();
        if (s.freeEntriesThisRound >= MAX_FREE_ENTRIES_PER_ROUND) revert MaxFreeEntriesReached();
        if (_isUpgradeWindow(s)) revert UpgradePending();

        uint256 rid = s.currentRound;
        RoundInfo storage r = s.rounds[rid];
        if (r.state != RoundState.OPEN) revert RoundNotOpen();
        if (s.playerEntryCount[rid][player] + 1 > MAX_ENTRIES) revert EntryLimitExceeded();
        if (r.entryCount + 1 > MAX_ROUND_ENTRIES) revert RoundEntryCapReached();

        _validateEntry(whites, goldNum, goldPos);
        uint256 idx = r.entryCount;
        s.roundEntries[rid][idx] = EntryInfo({ player: player, whites: whites, goldNum: goldNum, goldPos: goldPos });
        s.playerIndices[rid][player].push(idx);
        r.entryCount++;
        s.playerEntryCount[rid][player]++;
        s.freeEntriesThisRound++;
        s.lastBuyer[rid] = player;

        emit EntriesPurchased(rid, player, 1);
        emit FreeEntryMinted(rid, player);
    }

    function claimPrize(uint256 roundId, uint256 entryIdx) external {
        _claimEntry(_s(), roundId, entryIdx);
    }

    function claimPrizeBatch(uint256 roundId, uint256[] calldata entryIndices) external {
        HypePoolStorage storage s = _s();
        RoundInfo storage r = s.rounds[roundId];
        if (r.state != RoundState.SETTLED) revert RoundNotSettled();
        for (uint256 i = 0; i < entryIndices.length; i++) {
            uint256 idx = entryIndices[i];
            if (s.entryClaimed[roundId][idx]) continue;
            EntryInfo storage t = s.roundEntries[roundId][idx];
            if (t.player != msg.sender) continue;
            uint256 prize = _calcPrize(r, t);
            if (prize == 0) continue;
            _executePrize(s, roundId, idx, prize);
        }
    }

    function claimPendingPayout() external {
        HypePoolStorage storage s = _s();
        uint256 amount = s.pendingPayouts[msg.sender];
        if (amount == 0) revert NothingToClaim();
        s.pendingPayouts[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function claimLastDrop(uint256 roundId) external {
        HypePoolStorage storage s = _s();
        RoundInfo storage r = s.rounds[roundId];
        if (r.state != RoundState.SETTLED) revert RoundNotSettled();
        if (s.lastDropClaimed[roundId]) revert AlreadyClaimed();
        if (s.lastBuyer[roundId] != msg.sender) revert NotEntryOwner();
        uint256 prize = s.lastDropPrize[roundId];
        if (prize == 0) revert NoPrize();
        s.lastDropClaimed[roundId] = true;
        (bool ok,) = payable(msg.sender).call{value: prize}("");
        if (!ok) s.pendingPayouts[msg.sender] += prize;
        emit LastDropClaimed(roundId, msg.sender, prize);
    }

    function claimLuckyDraw(uint256 roundId) external {
        HypePoolStorage storage s = _s();
        RoundInfo storage r = s.rounds[roundId];
        if (r.state != RoundState.SETTLED) revert RoundNotSettled();
        if (s.luckyDrawClaimed[roundId]) revert AlreadyClaimed();
        if (s.luckyDrawWinner[roundId] != msg.sender) revert NotEntryOwner();
        uint256 prize = s.luckyDrawPrize[roundId];
        if (prize == 0) revert NoPrize();
        s.luckyDrawClaimed[roundId] = true;
        (bool ok,) = payable(msg.sender).call{value: prize}("");
        if (!ok) s.pendingPayouts[msg.sender] += prize;
        emit LuckyDrawClaimed(roundId, msg.sender, prize);
    }

    // ── Draw / settle ────────────────────────────────────────────
    function closeBettingAndDraw() external {
        HypePoolStorage storage s = _s();
        uint256 rid = s.currentRound;
        RoundInfo storage r = s.rounds[rid];
        if (r.state != RoundState.OPEN) revert RoundNotOpen();
        if (r.entryCount == 0) revert NoEntriesSold();
        if (block.timestamp < s.lastUpkeepTime + s.upkeepInterval) revert IntervalNotElapsed();
        s.lastUpkeepTime = block.timestamp;
        _triggerDraw(s);
    }

    function settleRound() external {
        HypePoolStorage storage s = _s();
        if (s.rounds[s.currentRound].state != RoundState.DRAWN) revert NotDrawnYet();
        if (s.rounds[s.currentRound].entryCount > s.settlementBatchSize) revert UseBatchSettlement();
        _settleCurrentRound(s);
    }

    function settleRoundBatch() external {
        HypePoolStorage storage s = _s();
        uint256 rid = s.currentRound;
        RoundInfo storage r = s.rounds[rid];
        if (r.state != RoundState.DRAWN) revert NotDrawnYet();

        uint8[5] memory dw = r.drawnWhites;
        uint8 dGN = r.drawnGoldNum;
        uint8 dGP = r.drawnGoldPos;
        uint256 tc = r.entryCount;

        uint256 start = s.settlementProgress[rid];
        uint256 end   = start + s.settlementBatchSize;
        if (end > tc) end = tc;

        uint256 jc = s.settleJCount[rid];
        uint256 sc = s.settleSCount[rid];

        for (uint256 i = start; i < end; i++) {
            EntryInfo storage t = s.roundEntries[rid][i];
            if (_matchWhitesMem(t.whites, dw)) {
                jc++;
                if (t.goldNum == dGN && t.goldPos == dGP) sc++;
            }
        }
        s.settlementProgress[rid] = end;
        s.settleJCount[rid]       = jc;
        s.settleSCount[rid]       = sc;

        if (end >= tc) {
            delete s.settlementProgress[rid];
            delete s.settleJCount[rid];
            delete s.settleSCount[rid];
            _finalizeSettlement(s, rid, r, jc, sc);
        }
    }

    // ── Automation ────────────────────────────────────────────────
    function performUpkeep() external {
        HypePoolStorage storage s = _s();
        uint256 rid = s.currentRound;
        RoundInfo storage r = s.rounds[rid];
        if (r.state == RoundState.OPEN) {
            if (r.entryCount == 0) revert NoEntriesSold();
            if (block.timestamp < s.lastUpkeepTime + s.upkeepInterval) revert IntervalNotElapsed();
            s.lastUpkeepTime = block.timestamp;
            emit UpkeepPerformed(rid, "draw");
            _triggerDraw(s);
        } else if (r.state == RoundState.DRAWN) {
            emit UpkeepPerformed(rid, "settle");
            _settleCurrentRound(s);
        } else {
            revert NoUpkeepNeeded();
        }
    }

    function triggerPublicDraw() external {
        HypePoolStorage storage s = _s();
        uint256 rid = s.currentRound;
        RoundInfo storage r = s.rounds[rid];
        if (r.state != RoundState.OPEN) revert RoundNotOpen();
        if (r.entryCount == 0) revert NoEntriesSold();
        if (block.timestamp < s.lastUpkeepTime + s.upkeepInterval + DRAW_GRACE_PERIOD) revert GracePeriodActive();
        s.lastUpkeepTime = block.timestamp;
        emit UpkeepPerformed(rid, "public-draw");
        _triggerDraw(s);
        s.freeEntryCredits[msg.sender] += DRAW_TRIGGER_CREDITS;
        emit DrawTriggerRewarded(msg.sender, DRAW_TRIGGER_CREDITS);
    }

    function generateDrawnNumbers(uint256 seed) external pure returns (uint8[5] memory whites, uint8 goldNum, uint8 goldPos) {
        return _generateDrawnNumbers(seed);
    }

    // ══════════════ INTERNAL HELPERS ══════════════════════════════
    function _entryPrice(HypePoolStorage storage s) private view returns (uint256) {
        RoundInfo storage r = s.rounds[s.currentRound];
        uint256 pool = r.prizePool + r.seedPool;
        uint256 price = (pool * ENTRY_PRICE_BPS) / 10000;
        if (price < MIN_ENTRY_PRICE) return MIN_ENTRY_PRICE;
        if (price > MAX_ENTRY_PRICE) return MAX_ENTRY_PRICE;
        return price;
    }

    function _isUpgradeWindow(HypePoolStorage storage s) private view returns (bool) {
        if (s.pendingUpgradeImpl == address(0)) return false;
        uint256 ea = s.upgradeProposalExecuteAfter;
        return block.timestamp >= ea && block.timestamp < ea + UPGRADE_EXPIRY;
    }

    function _triggerDraw(HypePoolStorage storage s) private {
        uint256 rid = s.currentRound;
        RoundInfo storage r = s.rounds[rid];
        r.state = RoundState.DRAWING;
        s.drawRequestedAt = block.timestamp;
        Client.EVM2AnyMessage memory msg_ = Client.EVM2AnyMessage({
            receiver:     abi.encode(s.vrfRequester),
            data:         abi.encode(rid),
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken:     address(0),
            extraArgs:    Client._argsToBytes(Client.EVMExtraArgsV1({gasLimit: s.ccipGasLimit}))
        });
        uint256 fee = IRouterClient(s.ccipRouter).getFee(s.sourceChainSelector, msg_);
        if (s.ownerFees < fee) revert InsufficientOwnerFees();
        s.ownerFees -= fee;
        bytes32 msgId = IRouterClient(s.ccipRouter).ccipSend{value: fee}(s.sourceChainSelector, msg_);
        r.ccipMessageId = msgId;
        emit DrawRequested(rid, msgId);
    }

    function _applyRandomness(HypePoolStorage storage s, uint256 rid, uint256 randomWord) private {
        RoundInfo storage r = s.rounds[rid];
        s.roundRandomWord[rid] = randomWord;
        (uint8[5] memory whites, uint8 goldNum, uint8 goldPos) = _generateDrawnNumbers(randomWord);
        r.drawnWhites  = whites;
        r.drawnGoldNum = goldNum;
        r.drawnGoldPos = goldPos;
        r.state        = RoundState.DRAWN;
        emit NumbersDrawn(rid, whites, goldNum, goldPos);
    }

    function _settleCurrentRound(HypePoolStorage storage s) private {
        uint256 rid = s.currentRound;
        RoundInfo storage r = s.rounds[rid];
        uint8[5] memory dw = r.drawnWhites;
        uint8 dGN = r.drawnGoldNum; uint8 dGP = r.drawnGoldPos;
        uint256 tc = r.entryCount;
        uint256 jc; uint256 sc;
        for (uint256 i = 0; i < tc; i++) {
            EntryInfo storage t = s.roundEntries[rid][i];
            if (_matchWhitesMem(t.whites, dw)) {
                jc++;
                if (t.goldNum == dGN && t.goldPos == dGP) sc++;
            }
        }
        _finalizeSettlement(s, rid, r, jc, sc);
    }

    function _finalizeSettlement(HypePoolStorage storage s, uint256 rid, RoundInfo storage r, uint256 jc, uint256 sc) private {
        r.prizePoolWinners = jc; r.superWinners = sc;
        // FoundationPass award: mint to first Super Pool winner
        if (sc > 0 && !s.foundationPassAwarded && s.foundationPassContract != address(0)) {
            for (uint256 i = 0; i < r.entryCount; i++) {
                EntryInfo storage t = s.roundEntries[rid][i];
                if (_matchWhitesMem(t.whites, r.drawnWhites) && t.goldNum == r.drawnGoldNum && t.goldPos == r.drawnGoldPos) {
                    try IFoundationPassMint(s.foundationPassContract).poolMint(t.player) {
                        s.foundationPassAwarded = true;
                        emit FoundationPassWon(rid, t.player);
                    } catch {}
                    break;
                }
            }
        }
        // Last Drop: assign if threshold met
        if (r.entryCount >= LAST_DROP_THRESHOLD && s.lastDropPool > 0) {
            address lb = s.lastBuyer[rid];
            s.lastDropPrize[rid] = s.lastDropPool;
            s.lastDropPool = 0;
            emit LastDropAssigned(rid, lb, s.lastDropPrize[rid]);
        }
        // Lucky Draw: assign a random winner
        if (r.entryCount > 0 && s.luckyDrawPool > 0) {
            uint256 rw = s.roundRandomWord[rid];
            uint256 luckyIdx = uint256(keccak256(abi.encodePacked(rw, "luckyDraw"))) % r.entryCount;
            address luckyWinner = s.roundEntries[rid][luckyIdx].player;
            s.luckyDrawWinner[rid] = luckyWinner;
            s.luckyDrawPrize[rid]  = s.luckyDrawPool;
            s.luckyDrawPool = 0;
            emit LuckyDrawAssigned(rid, luckyWinner, s.luckyDrawPrize[rid]);
        }
        uint256 jp = jc > 0 ? r.prizePool / jc : 0;
        uint256 sp = sc > 0 ? r.seedPool    / sc : 0;
        r.prizePerWinner = jp;
        r.superPrizePerWinner   = sp;
        uint256 nrid = rid + 1;
        if (jc == 0) { s.rounds[nrid].prizePool += r.prizePool; }
        else { uint256 d = r.prizePool - jp * jc; if (d > 0) s.rounds[nrid].prizePool += d; }
        if (sc == 0) { s.rounds[nrid].seedPool += r.seedPool; }
        else { uint256 d = r.seedPool - sp * sc; if (d > 0) s.rounds[nrid].seedPool += d; }
        r.state = RoundState.SETTLED;
        s.currentRound = nrid;
        s.rounds[nrid].state = RoundState.OPEN;
        s.freeEntriesThisRound = 0;
        emit RoundSettled(rid, jc, sc);
        // Settle reward: 1% of feePool (owner's contribution for the round)
        uint256 settleReward = (r.feePool * SETTLE_REWARD_BPS) / 10000;
        if (settleReward > 0) {
            if (settleReward > s.ownerFees) settleReward = s.ownerFees;
            if (settleReward > 0) {
                s.ownerFees -= settleReward;
                (bool ok,) = payable(msg.sender).call{value: settleReward}("");
                if (!ok) s.pendingPayouts[msg.sender] += settleReward;
                emit SettleRewarded(msg.sender, settleReward);
            }
        }
    }

    function _claimEntry(HypePoolStorage storage s, uint256 roundId, uint256 entryIdx) private {
        RoundInfo storage r = s.rounds[roundId];
        if (r.state != RoundState.SETTLED) revert RoundNotSettled();
        if (s.entryClaimed[roundId][entryIdx]) revert AlreadyClaimed();
        EntryInfo storage t = s.roundEntries[roundId][entryIdx];
        if (t.player != msg.sender) revert NotEntryOwner();
        uint256 prize = _calcPrize(r, t);
        if (prize == 0) revert NoPrize();
        _executePrize(s, roundId, entryIdx, prize);
    }

    function _calcPrize(RoundInfo storage r, EntryInfo storage t) private view returns (uint256 prize) {
        if (!_matchWhitesStor(t.whites, r.drawnWhites)) return 0;
        prize = r.prizePerWinner;
        if (t.goldNum == r.drawnGoldNum && t.goldPos == r.drawnGoldPos) prize += r.superPrizePerWinner;
    }

    function _executePrize(HypePoolStorage storage s, uint256 roundId, uint256 entryIdx, uint256 prize) private {
        s.entryClaimed[roundId][entryIdx] = true;
        (bool sent,) = payable(msg.sender).call{value: prize}("");
        if (!sent) s.pendingPayouts[msg.sender] += prize;
        emit PrizeClaimed(roundId, msg.sender, prize);
    }

    function _matchWhitesStor(uint8[5] storage a, uint8[5] storage b) private view returns (bool) {
        for (uint8 i = 0; i < 5; i++) { if (a[i] != b[i]) return false; }
        return true;
    }

    function _matchWhitesMem(uint8[5] storage a, uint8[5] memory b) private view returns (bool) {
        for (uint8 i = 0; i < 5; i++) { if (a[i] != b[i]) return false; }
        return true;
    }

    function _validateEntry(uint8[5] calldata whites, uint8 goldNum, uint8 goldPos) private pure {
        if (goldNum < 1 || goldNum > 90) revert GoldOutOfRange();
        if (goldPos > 4) revert GoldPosOutOfRange();
        for (uint8 i = 0; i < 5; i++) {
            if (whites[i] < 1 || whites[i] > 90) revert WhiteOutOfRange();
            if (i > 0 && whites[i] <= whites[i-1]) revert WhitesNotSortedUnique();
        }
    }

    function _generateDrawnNumbers(uint256 seed) private pure returns (uint8[5] memory whites, uint8 goldNum, uint8 goldPos) {
        uint256 ws  = uint256(keccak256(abi.encode(seed, "whites")));
        uint256 gns = uint256(keccak256(abi.encode(seed, "goldNum")));
        uint256 gps = uint256(keccak256(abi.encode(seed, "goldPos")));
        uint256 rng = ws; uint8 count = 0;
        while (count < 5) {
            rng = uint256(keccak256(abi.encode(rng, count)));
            uint8 num = uint8(rng % 90) + 1;
            bool dup = false;
            for (uint8 j = 0; j < count; j++) { if (whites[j] == num) { dup = true; break; } }
            if (!dup) { whites[count] = num; count++; }
        }
        for (uint8 i = 0; i < 4; i++) {
            for (uint8 j = 0; j < 4 - i; j++) {
                if (whites[j] > whites[j+1]) { (whites[j], whites[j+1]) = (whites[j+1], whites[j]); }
            }
        }
        goldNum = uint8(gns % 90) + 1;
        goldPos = uint8(gps % 5);
    }
}
