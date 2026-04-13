const { expect } = require('chai');
const { ethers } = require('hardhat');
const {
    loadFixture,
    time,
} = require('@nomicfoundation/hardhat-toolbox/network-helpers');

describe('HypePool', function () {
    // ── Shared library instances (deployed once, reused for error matching) ──
    let hypePoolMathLib, hypePoolViewsLib;
    before(async function () {
        hypePoolMathLib = await (await ethers.getContractFactory('HypePoolMath')).deploy();
        await hypePoolMathLib.waitForDeployment();
        hypePoolViewsLib = await (await ethers.getContractFactory('HypePoolViews')).deploy();
        await hypePoolViewsLib.waitForDeployment();
    });

    // ─── Fixture ────────────────────────────────────────────────────
    //
    // Uses @chainlink/local's CCIPLocalSimulator which provides a real
    // synchronous MockCCIPRouter.  When ccipSend() is called it immediately
    // delivers the message to the receiver in the same transaction, so a single
    // call to mockVRF.fulfillRandomWords() exercises the full 2-hop CCIP
    // pipeline:
    //
    //   closeDraw()
    //     → HypePoolV1._triggerDraw()  ──ccipSend──►  HypePoolVRFRequester.ccipReceive()
    //       → MockVRFCoordinator.requestRandomWords()
    //
    //   mockVRF.fulfillRandomWords(requestId, [seed])
    //     → HypePoolVRFRequester.fulfillRandomWords()  ──ccipSend──►  HypePoolV1.ccipReceive()
    //       → _applyRandomness()  →  round DRAWN
    //
    // The CCIPLocalSimulator's MockRouter hardcodes sourceChainSelector =
    // 16015286601757825753 (Sepolia simulator selector) in all delivered
    // messages, so both contracts must be configured with that value.
    async function deployFixture() {
        const [owner, alice, bob, charlie] = await ethers.getSigners();

        // ── 1. Deploy CCIPLocalSimulator and read its config ───────────
        const CCIPLocalSimulator = await ethers.getContractFactory('CCIPLocalSimulator');
        const simulator = await CCIPLocalSimulator.deploy();
        await simulator.waitForDeployment();
        const config = await simulator.configuration();
        // chainSelector_ and both routers are the same single MockCCIPRouter instance
        const CHAIN_SELECTOR = config.chainSelector_;           // 16015286601757825753n
        const mockRouter     = config.sourceRouter_;            // MockCCIPRouter address
        const routerAddr     = mockRouter;                       // address string from configuration()

        // ── 2. Deploy MockVRFCoordinator ───────────────────────────────
        const MockVRF = await ethers.getContractFactory('MockVRFCoordinator');
        const mockVRF = await MockVRF.deploy();
        await mockVRF.waitForDeployment();

        // ── 3. Deploy HypePoolVRFRequester (source-chain side) ──────────
        //    Temporary poolContract = owner.address; updated in step 5.
        const HypePoolVRFRequesterFactory = await ethers.getContractFactory('HypePoolVRFRequester');
        const vrfRequester = await HypePoolVRFRequesterFactory.deploy(
            await mockVRF.getAddress(),   // VRF coordinator
            routerAddr,                   // CCIP router (same MockRouter)
            CHAIN_SELECTOR,               // destChainSelector → HypePoolV1 "chain"
            owner.address,                // poolContract placeholder (updated below)
            1n,                           // subscriptionId
            ethers.ZeroHash,              // keyHash
            500_000,                      // callbackGasLimit
            3,                             // requestConfirmations
        );
        await vrfRequester.waitForDeployment();

        // ── 4. Deploy libraries + HypePoolV1 UUPS proxy ──────────
        const hypePoolMathLib = await (await ethers.getContractFactory('HypePoolMath')).deploy();
        await hypePoolMathLib.waitForDeployment();
        const hypePoolViewsLib = await (await ethers.getContractFactory('HypePoolViews')).deploy();
        await hypePoolViewsLib.waitForDeployment();
        const HypePoolV1 = await ethers.getContractFactory('HypePoolV1', {
            libraries: {
                HypePoolMath: await hypePoolMathLib.getAddress(),
                HypePoolViews: await hypePoolViewsLib.getAddress(),
            },
        });
        const impl = await HypePoolV1.deploy();
        await impl.waitForDeployment();

        const initData = HypePoolV1.interface.encodeFunctionData('initialize', [
            owner.address,
            routerAddr,                         // CCIP router (same MockRouter)
            CHAIN_SELECTOR,                     // sourceChainSelector (HypePoolVRFRequester's chain)
            await vrfRequester.getAddress(),    // vrfRequester
        ]);
        const ERC1967Proxy = await ethers.getContractFactory('ERC1967Proxy');
        const proxy = await ERC1967Proxy.deploy(await impl.getAddress(), initData);
        await proxy.waitForDeployment();
        const pool = HypePoolV1.attach(await proxy.getAddress());

        // ── 5. Wire: tell vrfRequester the real pool address ────────
        await vrfRequester.connect(owner).setPoolContract(await pool.getAddress());

        return {
            simulator, mockRouter, routerAddr, CHAIN_SELECTOR,
            mockVRF, vrfRequester,
            pool, impl, owner, alice, bob, charlie,
            hypePoolMathLib, hypePoolViewsLib,
        };
    }

    // ─── Helpers ────────────────────────────────────────────────────
    function makeEntry(whites, goldNum, goldPos) {
        return { whites, goldNum, goldPos };
    }

    const MIN_ENTRY_PRICE = ethers.parseEther('0.01');
    const ENTRY_PRICE_BPS = 5n; // 0.05 %

    // Match the contract's upkeepInterval default (24 h) and DRAW_GRACE_PERIOD (5 min).
    const UPKEEP_INTERVAL = 86400n;  // seconds – contract default
    const DRAW_GRACE      = 300n;    // seconds – contract DRAW_GRACE_PERIOD

    // Arbitrary large seed unlikely to produce whites [1,2,3,4,5]
    const NON_MATCHING_SEED = ethers.toBigInt(
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );

    /** Compute expected entry price from pool values */
    function expectedPrice(prizePool, seedPool) {
        const pool = prizePool + seedPool;
        const price = (pool * ENTRY_PRICE_BPS) / 10000n;
        return price > MIN_ENTRY_PRICE ? price : MIN_ENTRY_PRICE;
    }

    async function buyEntries(pool, signer, entries, valueOverride) {
        const whites = entries.map((t) => t.whites);
        const golds = entries.map((t) => t.goldNum);
        const positions = entries.map((t) => t.goldPos);
        const value =
      valueOverride !== undefined
          ? valueOverride
          : (await pool.entryPrice()) * BigInt(entries.length);
        return pool
            .connect(signer)
            .buyEntries(whites, golds, positions, ethers.ZeroAddress, { value });
    }

    // Advance time past upkeepInterval so closeBettingAndDraw() passes the interval check.
    async function closeDraw(l) {
        await time.increase(Number(UPKEEP_INTERVAL));
        return l.closeBettingAndDraw();
    }

    /**
   * Simulate the cross-chain VRF fulfillment using the real @chainlink/local
   * MockCCIPRouter pipeline.
   *
   * closeDraw() has already triggered the full chain:
   *   HypePoolV1._triggerDraw() → ccipSend → HypePoolVRFRequester.ccipReceive()
   *   → MockVRFCoordinator.requestRandomWords() → requestId stored
   *
   * fulfillDraw() completes the second hop:
   *   MockVRFCoordinator.fulfillRandomWords(requestId, [seed])
   *   → HypePoolVRFRequester.fulfillRandomWords() → ccipSend
   *   → HypePoolV1.ccipReceive() → _applyRandomness() → DRAWN
   *
   * @param mockVRF    MockVRFCoordinator instance.
   * @param requestId  VRF request ID (1-based, auto-increments per draw request).
   * @param seed       Random word to use as the VRF output.
   */
    async function fulfillDraw(mockVRF, requestId, seed) {
        return mockVRF.fulfillRandomWords(requestId, [BigInt(seed)]);
    }

    // ─── Tests ──────────────────────────────────────────────────────

    describe('Deployment', function () {
        it('should start at round 1 in OPEN state', async function () {
            const { pool } = await loadFixture(deployFixture);
            expect(await pool.currentRound()).to.equal(1);
            const info = await pool.getRoundInfo(1);
            expect(info.state).to.equal(0); // OPEN
        });

        it('should have correct constants', async function () {
            const { pool } = await loadFixture(deployFixture);
            expect(await pool.ENTRY_PRICE_BPS()).to.equal(5);
            expect(await pool.MIN_ENTRY_PRICE()).to.equal(MIN_ENTRY_PRICE);
            expect(await pool.MAX_ENTRIES()).to.equal(25);
            expect(await pool.PRIZE_POOL_BPS()).to.equal(5000);
            expect(await pool.SUPER_POOL_BPS()).to.equal(3000);
            expect(await pool.NFT_FEE_BPS()).to.equal(1000);
            expect(await pool.MINI_PRIZES_BPS()).to.equal(400);
            expect(await pool.REFERRAL_BPS()).to.equal(300);
            expect(await pool.OWNER_BPS()).to.equal(300);
        });
    });

    describe('Dynamic entry pricing', function () {
        it('should return MIN_ENTRY_PRICE when pools are empty', async function () {
            const { pool } = await loadFixture(deployFixture);
            expect(await pool.entryPrice()).to.equal(MIN_ENTRY_PRICE);
        });

        it('should return percentage-based price when pools are large enough', async function () {
            const { pool, alice } = await loadFixture(deployFixture);

            // Seed the prize pool via a direct transfer + manual pool setup
            // is not possible; instead buy entries to build up the pool then
            // check that subsequent price reflects the pools.
            // With empty pools the first entry costs MIN_ENTRY_PRICE.
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);

            const info = await pool.getRoundInfo(1);
            const price = await pool.entryPrice();
            const expected = expectedPrice(info.prizePool, info.seedPool);
            expect(price).to.equal(expected);
        });

        it('should increase price as more entries are sold and pools grow', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);

            const priceBefore = await pool.entryPrice();
            expect(priceBefore).to.equal(MIN_ENTRY_PRICE);

            // Buy first entry at MIN_ENTRY_PRICE
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);

            // Price may still be MIN if pool is too small for 2% to exceed it
            const priceAfterOne = await pool.entryPrice();
            expect(priceAfterOne).to.be.gte(MIN_ENTRY_PRICE);
        });

        it('should accept overpayment and refund the difference', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);

            const price = await pool.entryPrice();
            // First entry gets early bird: actual cost = price/2
            const actualCost = price / 2n;
            const overpay = actualCost + ethers.parseEther('1');

            const balBefore = await ethers.provider.getBalance(alice.address);
            const tx = await buyEntries(pool, alice, [t], overpay);
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(alice.address);

            // Alice should have paid only half the entry price (early bird) + gas
            expect(balBefore - balAfter - gasCost).to.equal(actualCost);
        });

        it('should reject insufficient payment', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);

            // Send less than MIN_ENTRY_PRICE
            await expect(
                buyEntries(pool, alice, [t], ethers.parseEther('0.001')),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'InsufficientPayment');
        });
    });

    describe('Buying entries', function () {
        it('should accept a valid single entry', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t = makeEntry([1, 20, 33, 55, 90], 42, 2);

            await expect(buyEntries(pool, alice, [t]))
                .to.emit(pool, 'EntriesPurchased')
                .withArgs(1, alice.address, 1);

            const info = await pool.getRoundInfo(1);
            expect(info.entryCount).to.equal(1n);

            // Revenue split: 50% prize pool, 30% seed
            // First entry gets early bird half-price: totalCost = MIN_ENTRY_PRICE / 2
            const totalCost = MIN_ENTRY_PRICE / 2n;
            const prizePool = (totalCost * 5000n) / 10000n;
            const seed = (totalCost * 3000n) / 10000n;
            expect(info.prizePool).to.equal(prizePool);
            expect(info.seedPool).to.equal(seed);
        });

        it('should accept multiple entries at once', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t1 = makeEntry([1, 2, 3, 4, 5], 10, 0);
            const t2 = makeEntry([10, 20, 30, 40, 50], 60, 4);
            const t3 = makeEntry([85, 86, 87, 88, 89], 90, 3);

            await buyEntries(pool, alice, [t1, t2, t3]);

            const info = await pool.getRoundInfo(1);
            expect(info.entryCount).to.equal(3);
            expect(await pool.playerEntryCount(1, alice.address)).to.equal(3);
        });

        it('should reject if whites are not sorted', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t = makeEntry([5, 3, 1, 2, 4], 10, 0);
            await expect(buyEntries(pool, alice, [t])).to.be.revertedWithCustomError(hypePoolMathLib, 'WhitesNotSortedUnique');
        });

        it('should reject if whites have duplicates', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t = makeEntry([1, 1, 2, 3, 4], 10, 0);
            await expect(buyEntries(pool, alice, [t])).to.be.revertedWithCustomError(hypePoolMathLib, 'WhitesNotSortedUnique');
        });

        it('should reject if white number out of range', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t = makeEntry([0, 1, 2, 3, 4], 10, 0);
            await expect(buyEntries(pool, alice, [t])).to.be.revertedWithCustomError(hypePoolMathLib, 'WhiteOutOfRange');
        });

        it('should reject if gold number out of range', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 91, 0);
            await expect(buyEntries(pool, alice, [t])).to.be.revertedWithCustomError(hypePoolMathLib, 'GoldOutOfRange');
        });

        it('should reject if gold position out of range', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 5);
            await expect(buyEntries(pool, alice, [t])).to.be.revertedWithCustomError(hypePoolMathLib, 'GoldPosOutOfRange');
        });

        it('should reject insufficient payment', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await expect(
                pool
                    .connect(alice)
                    .buyEntries([t.whites], [t.goldNum], [t.goldPos], ethers.ZeroAddress, {
                        value: 0,
                    }),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'InsufficientPayment');
        });

        it('should reject if exceeding max entries per address', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const maxEntries = Number(await pool.MAX_ENTRIES()); // 25 per address per round
            const entries = [];
            for (let i = 0; i <= maxEntries; i++) {  // maxEntries + 1 entries → over the limit
                entries.push(makeEntry([1, 2, 3, 4, 5], 10, 0));
            }
            await expect(buyEntries(pool, alice, entries)).to.be.revertedWithCustomError(hypePoolMathLib, 'EntryLimitExceeded');
        });

        it('should track player entries correctly', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t1 = makeEntry([1, 2, 3, 4, 5], 10, 0);
            const t2 = makeEntry([10, 20, 30, 40, 50], 60, 4);

            await buyEntries(pool, alice, [t1, t2]);

            const indices = await pool.getPlayerEntryIndices(1, alice.address);
            expect(indices.length).to.equal(2);

            const entries = await pool.getPlayerEntries(1, alice.address);
            expect(entries.length).to.equal(2);
            expect(entries[0].whites[0]).to.equal(1);
            expect(entries[1].whites[0]).to.equal(10);
        });
    });

    describe('Draw and settlement', function () {
        it('should reject draw if no entries sold', async function () {
            const { pool, owner } = await loadFixture(deployFixture);
            await expect(pool.closeBettingAndDraw()).to.be.revertedWithCustomError(hypePoolMathLib, 'NoEntriesSold');
        });

        it('should reject draw from non-admin', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);
            await expect(
                pool.connect(alice).closeBettingAndDraw(),
            ).to.be.revertedWithCustomError(pool, 'Unauthorized');
        });

        it('should reject buying after draw is requested', async function () {
            const { pool, alice, owner } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);
            await closeDraw(pool);

            await expect(buyEntries(pool, alice, [t])).to.be.revertedWithCustomError(hypePoolMathLib, 'RoundNotOpen');
        });

        it('should reject settlement before draw is fulfilled', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);
            await closeDraw(pool);

            await expect(pool.settleRound()).to.be.revertedWithCustomError(hypePoolMathLib, 'NotDrawnYet');
        });

        it('full flow: no winners → pools roll over', async function () {
            const { pool, mockVRF, alice, owner } = await loadFixture(
                deployFixture,
            );

            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);

            // Capture pools before draw
            const infoBefore = await pool.getRoundInfo(1);

            // Close and request draw
            await closeDraw(pool);

            // Fulfill via CCIP with random word that generates DIFFERENT numbers
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);

            // Verify state is DRAWN
            const infoDrawn = await pool.getRoundInfo(1);
            expect(infoDrawn.state).to.equal(2); // DRAWN

            // Settle
            await pool.settleRound();

            // Round should be settled
            const infoSettled = await pool.getRoundInfo(1);
            expect(infoSettled.state).to.equal(3); // SETTLED
            expect(infoSettled.prizePoolWinners).to.equal(0);
            expect(infoSettled.superWinners).to.equal(0);

            // Next round should have rolled-over pools
            expect(await pool.currentRound()).to.equal(2);
            const info2 = await pool.getRoundInfo(2);
            expect(info2.prizePool).to.equal(infoBefore.prizePool);
            expect(info2.seedPool).to.equal(infoBefore.seedPool);
            expect(info2.state).to.equal(0); // OPEN
        });

        it('full flow: prize pool winner (5/5 whites, no gold)', async function () {
            const { pool, mockVRF, alice, owner } = await loadFixture(
                deployFixture,
            );

            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);

            await closeDraw(pool);

            // Fulfill via CCIP with a random word
            const randomWord = 42n;
            await fulfillDraw(mockVRF, 1, randomWord);

            // Settle (no inline payments any more)
            await pool.settleRound();

            const infoSettled = await pool.getRoundInfo(1);

            // Check if it was a win – if so, Alice can *claim* her prize
            if (infoSettled.prizePoolWinners > 0n) {
                // Prize is claimable, not auto-sent
                const claimable = await pool.getClaimableAmount(1, alice.address);
                expect(claimable).to.be.greaterThan(0n);

                const aliceBalBefore = await ethers.provider.getBalance(alice.address);
                const indices = await pool.getPlayerEntryIndices(1, alice.address);
                const claimTx = await pool.connect(alice).claimPrizeBatch(1, indices);
                const receipt = await claimTx.wait();
                const gasCost = receipt.gasUsed * receipt.gasPrice;
                const aliceBalAfter = await ethers.provider.getBalance(alice.address);

                expect(aliceBalAfter - aliceBalBefore + gasCost).to.equal(claimable);
                // Claimable is now 0
                expect(await pool.getClaimableAmount(1, alice.address)).to.equal(0n);
            }

            // Either way, next round should be open
            expect(await pool.currentRound()).to.equal(2);
        });

        it('claim-based: prize stays in contract until claimed', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);

            // Buy a entry with the drawn numbers that seed 42 produces
            // We'll use the seed to find what numbers are drawn and buy those
            // For simplicity, use NON_MATCHING_SEED → no winners → rollover
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);

            // Capture prize pool
            const infoBefore = await pool.getRoundInfo(1);
            const contractBalBefore = await ethers.provider.getBalance(
                await pool.getAddress(),
            );

            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            // No winners → ETH stays in contract (rolled to next round; minus CCIP fee)
            const contractBalAfter = await ethers.provider.getBalance(
                await pool.getAddress(),
            );
            // Contract balance includes carried-over prize pool + seed (minus fees already in ownerFees and CCIP fee)
            expect(contractBalAfter).to.be.gte(
                infoBefore.prizePool + infoBefore.seedPool,
            );
        });

        it('claimPrize reverts for non-owner', async function () {
            const { pool, mockVRF, alice, bob } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, 42n);
            await pool.settleRound();

            const infoSettled = await pool.getRoundInfo(1);
            if (infoSettled.prizePoolWinners > 0n) {
                // Bob tries to claim Alice's entry (index 0)
                await expect(
                    pool.connect(bob).claimPrize(1, 0),
                ).to.be.revertedWithCustomError(hypePoolMathLib, 'NotEntryOwner');
            }
        });

        it('claimPrize reverts if entry has no prize', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);
            await closeDraw(pool);
            // Non-matching seed → no winners
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            await expect(
                pool.connect(alice).claimPrize(1, 0),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'NoPrize');
        });

        it('claimPrize reverts for double-claim', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);

            // Use seed 42 and check if alice wins; skip test if not
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, 42n);
            await pool.settleRound();

            const info = await pool.getRoundInfo(1);
            if (info.prizePoolWinners === 0n) return; // seed 42 produced no match – skip

            const indices = await pool.getPlayerEntryIndices(1, alice.address);
            // First claim succeeds
            await pool.connect(alice).claimPrizeBatch(1, indices);
            // Second claim reverts
            await expect(
                pool.connect(alice).claimPrizeBatch(1, indices),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'AlreadyClaimed');
        });

        it('emergencyCancelDraw invalidates draw state, late CCIP callback is silently discarded', async function () {
            const { pool, vrfRequester, mockVRF, alice } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);
            await closeDraw(pool);

            // Cancel the draw
            await time.increase(Number(DRAW_GRACE));
            await pool.emergencyCancelDraw();
            expect((await pool.getRoundInfo(1)).state).to.equal(0); // OPEN

            // A late VRF fulfillment arrives after emergency cancel.
            // fulfillRandomWords now uses try/catch: ccipReceive() rejects the
            // message (r.state != DRAWING) but the callback itself no longer reverts.
            // The random word is stored in pendingRandomWords for potential cleanup.
            await expect(
                fulfillDraw(mockVRF, 1, NON_MATCHING_SEED),
            ).to.not.be.reverted;

            // Pool state must remain OPEN — the rejected CCIP had no effect.
            expect((await pool.getRoundInfo(1)).state).to.equal(0); // still OPEN

            // The random word should be stored in pendingRandomWords (resilience mechanism).
            expect(await vrfRequester.pendingRandomWords(1n)).to.equal(NON_MATCHING_SEED);
        });
    }); // end describe("Draw and settlement")

    describe('Owner fees', function () {
        it('should accumulate and be withdrawable', async function () {
            const { pool, alice, owner } = await loadFixture(deployFixture);

            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);

            // First entry on empty pool → price = MIN_ENTRY_PRICE
            // New fee structure: 6% owner fees when no referrer
            // First entry gets early bird: totalCost = MIN_ENTRY_PRICE / 2
            const totalCost = MIN_ENTRY_PRICE / 2n;
            const expectedFee = (totalCost * 600n) / 10000n;
            expect(await pool.ownerFees()).to.equal(expectedFee);

            const balBefore = await ethers.provider.getBalance(owner.address);
            const tx = await pool.withdrawFees();
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(owner.address);

            expect(balAfter - balBefore + gasCost).to.equal(expectedFee);
            expect(await pool.ownerFees()).to.equal(0);
        });

        it('should reject fee withdrawal from non-admin', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);

            await expect(
                pool.connect(alice).withdrawFees(),
            ).to.be.revertedWithCustomError(pool, 'Unauthorized');
        });

        it('topUpOwnerFees: credits sent ETH to ownerFees', async function () {
            const { pool, alice } = await loadFixture(deployFixture);

            const topUpAmount = ethers.parseEther('0.5');
            const feesBefore = await pool.ownerFees();

            await pool.connect(alice).topUpOwnerFees({ value: topUpAmount });

            expect(await pool.ownerFees()).to.equal(feesBefore + topUpAmount);
        });

        it('topUpOwnerFees: reverts with zero value', async function () {
            const { pool, alice } = await loadFixture(deployFixture);

            await expect(
                pool.connect(alice).topUpOwnerFees({ value: 0n }),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'NoValueSent');
        });

        it('topUpOwnerFees: emits OwnerFeesTopUp event', async function () {
            const { pool, alice } = await loadFixture(deployFixture);

            const topUpAmount = ethers.parseEther('0.1');
            await expect(
                pool.connect(alice).topUpOwnerFees({ value: topUpAmount }),
            ).to.emit(pool, 'OwnerFeesTopUp').withArgs(alice.address, topUpAmount);
        });

        it('topUpOwnerFees: does NOT affect prize pool or seed pool accounting', async function () {
            const { pool, alice } = await loadFixture(deployFixture);

            // Buy a entry to establish pool balances
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);

            const roundBefore = await pool.getRoundInfo(1);
            const prizePoolBefore = roundBefore.prizePool;
            const seedBefore    = roundBefore.seedPool;

            // Top up ownerFees — must not touch prize pool/seed pools
            await pool.connect(alice).topUpOwnerFees({ value: ethers.parseEther('1') });

            const roundAfter = await pool.getRoundInfo(1);
            expect(roundAfter.prizePool).to.equal(prizePoolBefore);
            expect(roundAfter.seedPool).to.equal(seedBefore);
        });

        it('topUpOwnerFees: direct receive() does NOT update ownerFees', async function () {
            const { pool, alice } = await loadFixture(deployFixture);

            const feesBefore = await pool.ownerFees();

            // Send ETH directly via a plain transfer — must NOT update ownerFees
            await alice.sendTransaction({ to: await pool.getAddress(), value: ethers.parseEther('1') });

            expect(await pool.ownerFees()).to.equal(feesBefore);
        });
    });

    describe('seedPrizePool', function () {
        it('admin can seed the prize pool', async function () {
            const { pool } = await loadFixture(deployFixture);

            await pool.seedPrizePool({ value: ethers.parseEther('1') });

            const info = await pool.getRoundInfo(1);
            expect(info.prizePool).to.equal(ethers.parseEther('1'));
        });

        it('non-admin cannot seed the prize pool', async function () {
            const { pool, alice } = await loadFixture(deployFixture);

            await expect(
                pool.connect(alice).seedPrizePool({ value: ethers.parseEther('1') }),
            ).to.be.revertedWithCustomError(pool, 'Unauthorized');
        });

        it('reverts with zero value', async function () {
            const { pool } = await loadFixture(deployFixture);

            await expect(
                pool.seedPrizePool({ value: 0n }),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'NoValueSent');
        });

        it('seed accumulates across multiple calls', async function () {
            const { pool } = await loadFixture(deployFixture);

            await pool.seedPrizePool({ value: ethers.parseEther('1') });
            await pool.seedPrizePool({ value: ethers.parseEther('2') });

            const info = await pool.getRoundInfo(1);
            expect(info.prizePool).to.equal(ethers.parseEther('3'));
        });

        it('seed increases entryPrice', async function () {
            const { pool } = await loadFixture(deployFixture);

            const priceBefore = await pool.entryPrice();

            // Seed a large amount so the 0.05% calculation exceeds MIN_ENTRY_PRICE
            await pool.seedPrizePool({ value: ethers.parseEther('100') });

            const priceAfter = await pool.entryPrice();
            expect(priceAfter).to.be.gt(priceBefore);
        });

        it('seeded amount rolls over to round 2 when no winner', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);

            // Seed round 1 prize pool
            await pool.seedPrizePool({ value: ethers.parseEther('1') });

            // Buy a entry so the round can be drawn
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);

            const infoBefore = await pool.getRoundInfo(1);

            // Complete round with no winner
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            expect(await pool.currentRound()).to.equal(2);
            const info2 = await pool.getRoundInfo(2);
            expect(info2.prizePool).to.equal(infoBefore.prizePool);
        });
    });

    describe('CCIP fee deducted from ownerFees', function () {
        it('ownerFees is unchanged after draw when MockRouter fee is 0', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);

            // New fee structure: 6% owner fees when no referrer; early bird = half price
            const totalCost = MIN_ENTRY_PRICE / 2n;
            const expectedFee = (totalCost * 600n) / 10000n;
            expect(await pool.ownerFees()).to.equal(expectedFee);

            // Trigger draw — MockRouter charges 0 fee so ownerFees stays the same
            await closeDraw(pool);
            expect(await pool.ownerFees()).to.equal(expectedFee);

            // Complete round
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();
        });

        it('closeBettingAndDraw succeeds when ownerFees covers the CCIP fee', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);

            // New fee structure: 6% owner fees; early bird = half price for first entry
            const totalCost = MIN_ENTRY_PRICE / 2n;
            const expectedFee = (totalCost * 600n) / 10000n;

            // ownerFees > 0 after entry purchase
            const feesBefore = await pool.ownerFees();
            expect(feesBefore).to.equal(expectedFee);

            await closeDraw(pool);

            // MockRouter CCIP fee is 0, so ownerFees should remain unchanged
            const feesAfter = await pool.ownerFees();
            expect(feesAfter).to.equal(feesBefore);
        });
    });

    describe('Emergency cancel draw', function () {
        it('should allow admin to cancel a stuck draw', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);
            await closeDraw(pool);

            // Now in DRAWING state, simulate VRF never responding
            await time.increase(Number(DRAW_GRACE));
            await pool.emergencyCancelDraw();

            const info = await pool.getRoundInfo(1);
            expect(info.state).to.equal(0); // back to OPEN
        });

        it('emergencyCancelDraw reverts during DRAW_GRACE_PERIOD', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            // drawRequestedAt is just set; 300 s haven't elapsed yet
            await expect(pool.emergencyCancelDraw()).to.be.revertedWithCustomError(hypePoolMathLib, 'GracePeriodActive');
        });

        it('emergencyCancelDraw succeeds exactly at DRAW_GRACE_PERIOD boundary', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await time.increase(Number(DRAW_GRACE));
            await expect(pool.emergencyCancelDraw()).to.not.be.reverted;
            expect((await pool.getRoundInfo(1)).state).to.equal(0); // OPEN
        });

        it('emergencyCancelDraw emits DrawCancelled event', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await time.increase(Number(DRAW_GRACE));
            await expect(pool.emergencyCancelDraw())
                .to.emit(pool, 'DrawCancelled')
                .withArgs(1n);
        });

        it('emergencyCancelDraw resets lastUpkeepTime so draw can be re-triggered immediately', async function () {
            const { pool, vrfRequester, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool); // advances time by UPKEEP_INTERVAL, triggers draw

            const requestIdBefore = await vrfRequester.latestVrfRequestId();

            await time.increase(Number(DRAW_GRACE));
            await pool.emergencyCancelDraw(); // resets lastUpkeepTime to allow immediate retry

            // closeBettingAndDraw() should now succeed WITHOUT advancing time further.
            // (lastUpkeepTime was set to block.timestamp - upkeepInterval in emergencyCancelDraw)
            await expect(pool.closeBettingAndDraw()).to.not.be.reverted;

            // Confirm a new draw was actually triggered (round → DRAWING, new VRF request).
            expect((await pool.getRoundInfo(1)).state).to.equal(1); // DRAWING
            expect(await vrfRequester.latestVrfRequestId()).to.equal(requestIdBefore + 1n);
        });
    });

    describe('publicEmergencyCancelDraw', function () {
        const EMERGENCY_DELAY = 86400n; // 24 hours in seconds

        it('reverts when round is not in DRAWING state', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            // Round is OPEN, not DRAWING
            await expect(
                pool.connect(alice).publicEmergencyCancelDraw(),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'NotDrawing');
        });

        it('reverts before 24-hour delay has elapsed', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            // Only 1 hour has passed
            await time.increase(3600);
            await expect(
                pool.connect(bob).publicEmergencyCancelDraw(),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'EmergencyCancelDelayNotMet');
        });

        it('reverts at 23h59m (just before 24h boundary)', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await time.increase(Number(EMERGENCY_DELAY) - 60); // 23h59m
            await expect(
                pool.connect(bob).publicEmergencyCancelDraw(),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'EmergencyCancelDelayNotMet');
        });

        it('succeeds for any user after 24 hours', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await time.increase(Number(EMERGENCY_DELAY));
            // bob (non-admin) can cancel
            await expect(pool.connect(bob).publicEmergencyCancelDraw()).to.not.be.reverted;
            expect((await pool.getRoundInfo(1)).state).to.equal(0); // back to OPEN
        });

        it('emits DrawCancelled event', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await time.increase(Number(EMERGENCY_DELAY));
            await expect(pool.connect(bob).publicEmergencyCancelDraw())
                .to.emit(pool, 'DrawCancelled')
                .withArgs(1n);
        });

        it('awards 2 free entry credits to caller', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await time.increase(Number(EMERGENCY_DELAY));
            expect(await pool.freeEntryCredits(bob.address)).to.equal(0n);
            await pool.connect(bob).publicEmergencyCancelDraw();
            expect(await pool.freeEntryCredits(bob.address)).to.equal(2n);
        });

        it('emits DrawTriggerRewarded event with 2 credits', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await time.increase(Number(EMERGENCY_DELAY));
            await expect(pool.connect(bob).publicEmergencyCancelDraw())
                .to.emit(pool, 'DrawTriggerRewarded')
                .withArgs(bob.address, 2n);
        });

        it('resets lastUpkeepTime so draw can be re-triggered immediately', async function () {
            const { pool, vrfRequester, alice, bob } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            const requestIdBefore = await vrfRequester.latestVrfRequestId();
            await time.increase(Number(EMERGENCY_DELAY));
            await pool.connect(bob).publicEmergencyCancelDraw();
            // closeBettingAndDraw() should now succeed WITHOUT advancing time further
            await expect(pool.closeBettingAndDraw()).to.not.be.reverted;
            expect((await pool.getRoundInfo(1)).state).to.equal(1); // DRAWING
            expect(await vrfRequester.latestVrfRequestId()).to.equal(requestIdBefore + 1n);
        });

        it('admin emergencyCancelDraw still works with 5min grace (admin privilege preserved)', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await time.increase(Number(DRAW_GRACE));
            // Admin can still cancel with 5-minute grace period
            await expect(pool.emergencyCancelDraw()).to.not.be.reverted;
            expect((await pool.getRoundInfo(1)).state).to.equal(0);
        });

        it('drawRequestedAt view returns correct timestamp', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            const ts = await pool.drawRequestedAt();
            expect(ts).to.be.gt(0n);
            // Should be close to the latest block timestamp
            const block = await ethers.provider.getBlock('latest');
            expect(ts).to.be.lte(BigInt(block.timestamp));
        });
    });

    describe('closeBettingAndDraw interval enforcement', function () {
        it('reverts when upkeepInterval has not elapsed', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await expect(pool.closeBettingAndDraw()).to.be.revertedWithCustomError(hypePoolMathLib, 'IntervalNotElapsed');
        });

        it('succeeds after upkeepInterval has elapsed', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await time.increase(86400);
            await expect(pool.closeBettingAndDraw()).to.not.be.reverted;
        });
    });

    describe('View functions', function () {
        it('getEntry should return correct data', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t = makeEntry([10, 20, 30, 40, 50], 77, 3);
            await buyEntries(pool, alice, [t]);

            const entry = await pool.getEntry(1, 0);
            expect(entry.player).to.equal(alice.address);
            expect(entry.whites).to.deep.equal([10, 20, 30, 40, 50]);
            expect(entry.goldNum).to.equal(77);
            expect(entry.goldPos).to.equal(3);
        });

        it('getPlayerEntries should return all of a player\'s entries', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);

            await buyEntries(pool, alice, [
                makeEntry([1, 2, 3, 4, 5], 10, 0),
                makeEntry([6, 7, 8, 9, 10], 20, 1),
            ]);
            await buyEntries(pool, bob, [
                makeEntry([11, 12, 13, 14, 15], 30, 2),
            ]);

            const aliceEntries = await pool.getPlayerEntries(1, alice.address);
            expect(aliceEntries.length).to.equal(2);

            const bobEntries = await pool.getPlayerEntries(1, bob.address);
            expect(bobEntries.length).to.equal(1);
        });

        it('getRoundInfo should return complete round data', async function () {
            const { pool, alice } = await loadFixture(deployFixture);

            await buyEntries(pool, alice, [
                makeEntry([1, 2, 3, 4, 5], 10, 0),
            ]);

            const info = await pool.getRoundInfo(1);
            expect(info.entryCount).to.equal(1n);
            expect(info.state).to.equal(0); // OPEN
            expect(info.prizePool).to.be.greaterThan(0);
            expect(info.seedPool).to.be.greaterThan(0);
        });
    });

    describe('Multi-round carry-over', function () {
        it('should accumulate pools across rounds with no winners', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);

            // Round 1: buy entry, draw, no winner, settle
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);

            const r1info = await pool.getRoundInfo(1);
            const r1PrizePool = r1info.prizePool;
            const r1Seed = r1info.seedPool;

            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            // Round 2: buy another entry
            expect(await pool.currentRound()).to.equal(2);

            // Get the entry price for round 2 (now pools are carried over)
            const r2price = await pool.entryPrice();
            // First entry in round 2 also gets early bird half price
            const r2cost = r2price / 2n;

            await buyEntries(pool, alice, [
                makeEntry([10, 20, 30, 40, 50], 60, 4),
            ]);

            const r2info = await pool.getRoundInfo(2);
            // Round 2 pools = round 1 carried-over + round 2 entry fees
            const expectedPrizePool = r1PrizePool + (r2cost * 5000n) / 10000n;
            const expectedSeed = r1Seed + (r2cost * 3000n) / 10000n;

            expect(r2info.prizePool).to.equal(expectedPrizePool);
            expect(r2info.seedPool).to.equal(expectedSeed);
        });
    });

    // ─── Chainlink Automation ───────────────────────────────────────


    describe('checkUpkeep', function () {
        it('returns false before the interval has elapsed', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            // Buy a entry so entryCount > 0, but don't advance time
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            const [needed] = await pool.checkUpkeep('0x');
            expect(needed).to.equal(false);
        });

        it('returns false when interval elapsed but no entries sold', async function () {
            const { pool } = await loadFixture(deployFixture);
            await time.increase(Number(UPKEEP_INTERVAL));
            const [needed] = await pool.checkUpkeep('0x');
            expect(needed).to.equal(false);
        });

        it('returns true after interval elapsed and entries sold', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await time.increase(Number(UPKEEP_INTERVAL));
            const [needed] = await pool.checkUpkeep('0x');
            expect(needed).to.equal(true);
        });

        it('returns true when round is DRAWN (regardless of time)', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);

            const [needed] = await pool.checkUpkeep('0x');
            expect(needed).to.equal(true);
        });

        it('returns false when round is DRAWING', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            const [needed] = await pool.checkUpkeep('0x');
            expect(needed).to.equal(false);
        });
    });

    describe('performUpkeep', function () {
        it('triggers draw when interval elapsed and entries sold', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await time.increase(Number(UPKEEP_INTERVAL));

            await expect(pool.performUpkeep('0x'))
                .to.emit(pool, 'UpkeepPerformed')
                .withArgs(1, 'draw')
                .and.to.emit(pool, 'DrawRequested');

            const info = await pool.getRoundInfo(1);
            expect(info.state).to.equal(1); // DRAWING
        });

        it('settles round when state is DRAWN', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);

            await expect(pool.performUpkeep('0x'))
                .to.emit(pool, 'UpkeepPerformed')
                .withArgs(1, 'settle')
                .and.to.emit(pool, 'RoundSettled');

            expect(await pool.currentRound()).to.equal(2);
        });

        it('reverts when round is OPEN but interval not elapsed', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await expect(pool.performUpkeep('0x')).to.be.revertedWithCustomError(hypePoolMathLib, 'IntervalNotElapsed');
        });

        it('reverts when round is OPEN but no entries sold', async function () {
            const { pool } = await loadFixture(deployFixture);
            await time.increase(Number(UPKEEP_INTERVAL));
            await expect(pool.performUpkeep('0x')).to.be.revertedWithCustomError(hypePoolMathLib, 'NoEntriesSold');
        });

        it('reverts when round is DRAWING (neither condition met)', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await expect(pool.performUpkeep('0x')).to.be.revertedWithCustomError(hypePoolMathLib, 'NoUpkeepNeeded');
        });

        it('full automated lifecycle: OPEN → DRAWING → DRAWN → SETTLED', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);

            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await time.increase(Number(UPKEEP_INTERVAL));

            // Automation triggers draw
            await pool.performUpkeep('0x');
            expect((await pool.getRoundInfo(1)).state).to.equal(1); // DRAWING

            // CCIP fulfills
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            expect((await pool.getRoundInfo(1)).state).to.equal(2); // DRAWN

            // Automation settles
            await pool.performUpkeep('0x');
            expect((await pool.getRoundInfo(1)).state).to.equal(3); // SETTLED
            expect(await pool.currentRound()).to.equal(2);
        });
    });

    describe('triggerPublicDraw', function () {
        it('reverts during the grace period', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);

            // Advance past the interval but NOT past the grace period
            await time.increase(Number(UPKEEP_INTERVAL) + Number(DRAW_GRACE) - 10);
            await expect(
                pool.connect(alice).triggerPublicDraw(),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'GracePeriodActive');
        });

        it('reverts if no entries sold', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await time.increase(Number(UPKEEP_INTERVAL) + Number(DRAW_GRACE));
            await expect(
                pool.connect(alice).triggerPublicDraw(),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'NoEntriesSold');
        });

        it('succeeds for any caller after grace period', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await time.increase(Number(UPKEEP_INTERVAL) + Number(DRAW_GRACE));

            // bob (non-admin) can trigger
            await expect(pool.connect(bob).triggerPublicDraw())
                .to.emit(pool, 'UpkeepPerformed')
                .withArgs(1, 'public-draw')
                .and.to.emit(pool, 'DrawRequested');

            expect((await pool.getRoundInfo(1)).state).to.equal(1); // DRAWING
        });

        it('reverts when round is not OPEN', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool); // now DRAWING
            await time.increase(Number(UPKEEP_INTERVAL) + Number(DRAW_GRACE));
            await expect(pool.triggerPublicDraw()).to.be.revertedWithCustomError(hypePoolMathLib, 'RoundNotOpen');
        });
    });

    describe('Upkeep interval proposal (24 h timelock)', function () {
        it('proposeSetUpkeepInterval emits AdminActionProposed and UpkeepIntervalProposed', async function () {
            const { pool, owner } = await loadFixture(deployFixture);
            await expect(pool.connect(owner).proposeSetUpkeepInterval(3600))
                .to.emit(pool, 'AdminActionProposed')
                .and.to.emit(pool, 'UpkeepIntervalProposed');
        });

        it('proposeSetUpkeepInterval reverts for zero interval', async function () {
            const { pool } = await loadFixture(deployFixture);
            await expect(pool.proposeSetUpkeepInterval(0)).to.be.revertedWithCustomError(hypePoolViewsLib, 'IntervalMustBePositive');
        });

        it('proposeSetUpkeepInterval reverts for non-admin', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await expect(
                pool.connect(alice).proposeSetUpkeepInterval(3600),
            ).to.be.revertedWithCustomError(pool, 'Unauthorized');
        });

        it('executeSetUpkeepInterval reverts before timelock expires', async function () {
            const { pool, owner } = await loadFixture(deployFixture);
            await pool.connect(owner).proposeSetUpkeepInterval(3600);
            await expect(
                pool.connect(owner).executeSetUpkeepInterval(3600),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'TimelockNotExpired');
        });

        it('executeSetUpkeepInterval succeeds after timelock expires', async function () {
            const { pool, owner } = await loadFixture(deployFixture);
            await pool.connect(owner).proposeSetUpkeepInterval(3600);
            await time.increase(24 * 60 * 60 + 1);
            await expect(
                pool.connect(owner).executeSetUpkeepInterval(3600),
            ).to.emit(pool, 'AdminActionExecuted');
            expect(await pool.upkeepInterval()).to.equal(3600);
        });

        it('executeSetUpkeepInterval reverts if not proposed', async function () {
            const { pool, owner } = await loadFixture(deployFixture);
            await expect(
                pool.connect(owner).executeSetUpkeepInterval(7200),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'ActionNotProposed');
        });

        it('executeSetUpkeepInterval reverts for non-admin', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await expect(
                pool.connect(alice).executeSetUpkeepInterval(3600),
            ).to.be.revertedWithCustomError(pool, 'Unauthorized');
        });

        it('cancelAdminAction clears upkeep interval proposal state', async function () {
            const { pool, owner } = await loadFixture(deployFixture);
            await pool.connect(owner).proposeSetUpkeepInterval(3600);
            const actionHash = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ['string', 'uint256'],
                    ['setUpkeepInterval', 3600],
                ),
            );
            await expect(pool.connect(owner).cancelAdminAction(actionHash))
                .to.emit(pool, 'AdminActionCancelled');
            // Proposal state should be cleared
            expect(await pool.pendingUpkeepInterval()).to.equal(0);
            expect(await pool.upkeepIntervalProposalExecuteAfter()).to.equal(0);
            // After cancellation, execution must fail
            await time.increase(24 * 60 * 60 + 1);
            await expect(
                pool.connect(owner).executeSetUpkeepInterval(3600),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'ActionNotProposed');
        });

        it('getUpkeepIntervalProposal returns status 0 when no proposal', async function () {
            const { pool } = await loadFixture(deployFixture);
            const [newInterval, executeAfter, status] = await pool.getUpkeepIntervalProposal();
            expect(status).to.equal(0);
            expect(newInterval).to.equal(0);
            expect(executeAfter).to.equal(0);
        });

        it('getUpkeepIntervalProposal returns status 1 when pending', async function () {
            const { pool, owner } = await loadFixture(deployFixture);
            await pool.connect(owner).proposeSetUpkeepInterval(3600);
            const [newInterval, , status] = await pool.getUpkeepIntervalProposal();
            expect(status).to.equal(1);
            expect(newInterval).to.equal(3600);
        });

        it('getUpkeepIntervalProposal returns status 2 when ready', async function () {
            const { pool, owner } = await loadFixture(deployFixture);
            await pool.connect(owner).proposeSetUpkeepInterval(3600);
            await time.increase(24 * 60 * 60 + 1);
            const [newInterval, , status] = await pool.getUpkeepIntervalProposal();
            expect(status).to.equal(2);
            expect(newInterval).to.equal(3600);
        });

        it('setLastUpkeepTime is no longer externally accessible', async function () {
            const { pool } = await loadFixture(deployFixture);
            expect(pool.setLastUpkeepTime).to.be.undefined;
        });
    });

    // ─── Bug Fix 2: First-entry draw-timer reset ───────────────────

    describe('First-entry draw-timer reset (Bug Fix 2)', function () {
        it('lastUpkeepTime resets to block.timestamp when first entry is bought', async function () {
            const { pool, alice } = await loadFixture(deployFixture);

            // Advance time significantly before buying the first entry
            await time.increase(Number(UPKEEP_INTERVAL) * 3); // 3 days

            const tsBefore = await time.latest();
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            const tsAfter = await time.latest();

            const lastUpkeep = await pool.lastUpkeepTime();
            // lastUpkeepTime should be reset to ~current block time (not deployment time)
            expect(Number(lastUpkeep)).to.be.gte(tsBefore);
            expect(Number(lastUpkeep)).to.be.lte(tsAfter + 1);

            // Timer just reset, so upkeep should NOT be needed yet
            const [needed] = await pool.checkUpkeep('0x');
            expect(needed).to.equal(false);
        });

        it('subsequent entries in the same round do NOT reset the timer', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);

            // Alice buys first entry → timer resets
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            const timerAfterFirst = await pool.lastUpkeepTime();

            // Advance half the interval
            await time.increase(Number(UPKEEP_INTERVAL) / 2);

            // Bob buys second entry → timer should NOT reset again
            await buyEntries(pool, bob, [makeEntry([2, 3, 4, 5, 6], 20, 1)]);
            const timerAfterSecond = await pool.lastUpkeepTime();

            expect(timerAfterSecond).to.equal(timerAfterFirst);
        });

        it('triggerPublicDraw is NOT immediately available after stale timer + first entry', async function () {
            const { pool, alice } = await loadFixture(deployFixture);

            // Simulate 3 days passing with no entry activity
            await time.increase(Number(UPKEEP_INTERVAL) * 3);

            // Now buy the first entry – timer resets to NOW
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);

            // Even though 3 days have passed since deployment, the grace period
            // hasn't elapsed since the entry purchase → public draw should fail
            await expect(
                pool.connect(alice).triggerPublicDraw(),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'GracePeriodActive');
        });

        it('triggerPublicDraw works after interval+grace elapses from first entry', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);

            // Simulate 3 days of inactivity, then first entry
            await time.increase(Number(UPKEEP_INTERVAL) * 3);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);

            // Now advance past interval + grace from first entry purchase
            await time.increase(Number(UPKEEP_INTERVAL) + Number(DRAW_GRACE));

            await expect(pool.connect(bob).triggerPublicDraw())
                .to.emit(pool, 'UpkeepPerformed')
                .withArgs(1, 'public-draw');
        });
    });

    // ─── Trigger rewards ────────────────────────────────────────────────────────

    describe('Trigger rewards', function () {
    // Helper: buy one entry, advance time past interval+grace, call triggerPublicDraw.
        async function setupPublicDraw(pool, signer) {
            await buyEntries(pool, signer, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await time.increase(Number(UPKEEP_INTERVAL) + Number(DRAW_GRACE));
        }

        it('freeEntryCredits starts at 0 for a new address', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            expect(await pool.freeEntryCredits(alice.address)).to.equal(0n);
        });

        it('triggerPublicDraw emits DrawTriggerRewarded with 2 credits', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);
            await setupPublicDraw(pool, alice);
            await expect(pool.connect(bob).triggerPublicDraw())
                .to.emit(pool, 'DrawTriggerRewarded')
                .withArgs(bob.address, 2n);
        });

        it('triggerPublicDraw adds 2 free entry credits to caller', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);
            await setupPublicDraw(pool, alice);
            await pool.connect(bob).triggerPublicDraw();
            expect(await pool.freeEntryCredits(bob.address)).to.equal(2n);
        });

        it('free entry credits allow buying entries at no cost', async function () {
            const { pool, mockVRF, alice, bob } = await loadFixture(deployFixture);
            // Bob earns 2 credits by triggering a public draw
            await setupPublicDraw(pool, alice);
            await pool.connect(bob).triggerPublicDraw();
            await mockVRF.fulfillRandomWords(1n, [NON_MATCHING_SEED]);
            await pool.settleRound();

            // Round 2: Bob buys 2 entries using his credits (sends 0 ETH)
            expect(await pool.freeEntryCredits(bob.address)).to.equal(2n);
            const price = await pool.entryPrice();
            await expect(
                pool.connect(bob).buyEntries(
                    [[1, 2, 3, 4, 5], [2, 3, 4, 5, 6]], [10, 11], [0, 1],
                    ethers.ZeroAddress, { value: 0n },
                ),
            ).to.emit(pool, 'EntriesPurchased').withArgs(2n, bob.address, 2n);

            // Credits should be consumed
            expect(await pool.freeEntryCredits(bob.address)).to.equal(0n);
        });

        it('free entry credits partially cover when buying more than credit balance', async function () {
            const { pool, mockVRF, alice, bob } = await loadFixture(deployFixture);
            await setupPublicDraw(pool, alice);
            await pool.connect(bob).triggerPublicDraw();
            await mockVRF.fulfillRandomWords(1n, [NON_MATCHING_SEED]);
            await pool.settleRound();

            // Bob has 2 credits; buys 3 entries → pays for 1 entry
            const price = await pool.entryPrice();
            await expect(
                pool.connect(bob).buyEntries(
                    [[1, 2, 3, 4, 5], [2, 3, 4, 5, 6], [3, 4, 5, 6, 7]],
                    [10, 11, 12], [0, 1, 2],
                    ethers.ZeroAddress, { value: price },   // pays for 1 of 3 entries
                ),
            ).to.emit(pool, 'EntriesPurchased');

            expect(await pool.freeEntryCredits(bob.address)).to.equal(0n);
        });

        it('buying with credits reverts if user pays too little for paid portion', async function () {
            const { pool, mockVRF, alice, bob } = await loadFixture(deployFixture);
            await setupPublicDraw(pool, alice);
            await pool.connect(bob).triggerPublicDraw();
            await mockVRF.fulfillRandomWords(1n, [NON_MATCHING_SEED]);
            await pool.settleRound();

            // Bob has 2 credits; tries to buy 3 entries with 0 ETH (should pay for 1)
            await expect(
                pool.connect(bob).buyEntries(
                    [[1, 2, 3, 4, 5], [2, 3, 4, 5, 6], [3, 4, 5, 6, 7]],
                    [10, 11, 12], [0, 1, 2],
                    ethers.ZeroAddress, { value: 0n },   // insufficient — needs to pay for 1 entry
                ),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'InsufficientPayment');
        });

        it('settleRound emits SettleRewarded event', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await expect(pool.settleRound()).to.emit(pool, 'SettleRewarded');
        });

        it('settleRoundBatch emits SettleRewarded on final batch', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await expect(pool.settleRoundBatch()).to.emit(pool, 'SettleRewarded');
        });

        it('settle reward equals 1% of fee pool sent to caller', async function () {
            const { pool, mockVRF, alice, bob } = await loadFixture(deployFixture);
            const price = await pool.entryPrice();
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);

            // feePool = ownerAdd: early bird means first entry costs price/2
            // owner gets 6% of totalCost (no referrer); reward = feePool / 100
            const totalCost = price / 2n;
            const feePool = (totalCost * 600n) / 10000n;
            const expectedReward = feePool / 100n;

            const bobBalBefore = await ethers.provider.getBalance(bob.address);
            const tx = await pool.connect(bob).settleRound();
            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed * tx.gasPrice;
            const bobBalAfter = await ethers.provider.getBalance(bob.address);

            // Bob's balance change should equal reward minus gas cost
            expect(bobBalAfter - bobBalBefore + gasUsed).to.equal(expectedReward);
        });
    });

    // ─── HypePoolV1 (upgradeable proxy) ────────────────────────

    describe('HypePoolV1 via UUPS proxy', function () {
        async function deployV1Fixture() {
            const [owner, alice, bob] = await ethers.getSigners();

            // Same CCIPLocalSimulator-based setup as the outer deployFixture.
            const CCIPLocalSimulator = await ethers.getContractFactory('CCIPLocalSimulator');
            const simulator = await CCIPLocalSimulator.deploy();
            await simulator.waitForDeployment();
            const config = await simulator.configuration();
            const CHAIN_SELECTOR = config.chainSelector_;
            const mockRouter     = config.sourceRouter_;
            const routerAddr     = mockRouter;

            const MockVRF = await ethers.getContractFactory('MockVRFCoordinator');
            const mockVRF = await MockVRF.deploy();
            await mockVRF.waitForDeployment();

            const HypePoolVRFRequesterFactory = await ethers.getContractFactory('HypePoolVRFRequester');
            const vrfRequester = await HypePoolVRFRequesterFactory.deploy(
                await mockVRF.getAddress(), routerAddr, CHAIN_SELECTOR,
                owner.address, 1n, ethers.ZeroHash, 500_000, 3,
            );
            await vrfRequester.waitForDeployment();

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('HypePoolMath')).deploy(),
                (await ethers.getContractFactory('HypePoolViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const HypePoolV1 = await ethers.getContractFactory('HypePoolV1', {
                libraries: {
                    HypePoolMath: await __mathLib.getAddress(),
                    HypePoolViews: await __viewsLib.getAddress(),
                },
            });
            const impl = await HypePoolV1.deploy();
            await impl.waitForDeployment();
            const implAddr = await impl.getAddress();

            const initData = HypePoolV1.interface.encodeFunctionData(
                'initialize',
                [
                    owner.address,
                    routerAddr,
                    CHAIN_SELECTOR,
                    await vrfRequester.getAddress(),
                ],
            );

            const ERC1967Proxy = await ethers.getContractFactory('ERC1967Proxy');
            const proxy = await ERC1967Proxy.deploy(implAddr, initData);
            await proxy.waitForDeployment();
            const proxyAddr = await proxy.getAddress();

            const pool = HypePoolV1.attach(proxyAddr);
            await vrfRequester.connect(owner).setPoolContract(proxyAddr);

            return {
                simulator, mockRouter, routerAddr, CHAIN_SELECTOR,
                mockVRF, vrfRequester, impl, implAddr, proxyAddr,
                pool, owner, alice, bob,
            };
        }

        it('initializes correctly via proxy', async function () {
            const { pool, owner } = await loadFixture(deployV1Fixture);
            expect(await pool.currentRound()).to.equal(1);
            expect((await pool.getRoundInfo(1)).state).to.equal(0); // OPEN
            expect(
                await pool.hasRole(await pool.DEFAULT_ADMIN_ROLE(), owner.address),
            ).to.equal(true);
        });

        it('implementation cannot be re-initialized', async function () {
            const { impl, owner, routerAddr, CHAIN_SELECTOR, vrfRequester } = await loadFixture(deployV1Fixture);
            // Calling initialize on the implementation directly should revert
            // because _disableInitializers() was called in the constructor.
            await expect(
                impl.initialize(
                    owner.address, routerAddr, CHAIN_SELECTOR, await vrfRequester.getAddress(),
                ),
            ).to.be.reverted;
        });

        it('full pool flow works through proxy', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployV1Fixture);

            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            expect(await pool.currentRound()).to.equal(2);
        });

        it('settle reward reduces proxy ETH balance by 1% of fee pool', async function () {
            const { pool, mockVRF, alice, proxyAddr } = await loadFixture(
                deployV1Fixture,
            );

            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            const balBefore = await ethers.provider.getBalance(proxyAddr);

            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);

            // 1 entry at MIN_ENTRY_PRICE/2 (early bird); feePool = 6%; settleReward = 1%
            const expectedSettleReward = (MIN_ENTRY_PRICE / 2n * 600n / 10000n) / 100n;
            await expect(pool.settleRound()).to.emit(pool, 'SettleRewarded');

            const balAfter = await ethers.provider.getBalance(proxyAddr);
            // MockRouter charges 0 CCIP fee; only the settle reward leaves the contract
            expect(balAfter).to.equal(balBefore - expectedSettleReward);
        });

        it('admin can upgrade to a new implementation (via timelock)', async function () {
            const { pool, proxyAddr, owner } = await loadFixture(deployV1Fixture);

            // Deploy a new implementation (same V1 for simplicity)
            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('HypePoolMath')).deploy(),
                (await ethers.getContractFactory('HypePoolViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const HypePoolV1 = await ethers.getContractFactory('HypePoolV1', {
                libraries: {
                    HypePoolMath: await __mathLib.getAddress(),
                    HypePoolViews: await __viewsLib.getAddress(),
                },
            });
            const newImpl = await HypePoolV1.deploy();
            await newImpl.waitForDeployment();
            const newImplAddr = await newImpl.getAddress();

            // Step 1: propose the upgrade
            await pool.connect(owner).proposeUpgrade(newImplAddr);

            // Step 2: advance time past the 72-hour timelock (into execution window)
            await time.increase(72 * 60 * 60 + 1);

            // Step 3: execute the upgrade via the proxy
            await expect(
                pool.connect(owner).upgradeToAndCall(newImplAddr, '0x'),
            ).to.not.be.reverted;
        });

        it('upgrade reverts if timelock has not elapsed', async function () {
            const { pool, owner } = await loadFixture(deployV1Fixture);

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('HypePoolMath')).deploy(),
                (await ethers.getContractFactory('HypePoolViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const HypePoolV1 = await ethers.getContractFactory('HypePoolV1', {
                libraries: {
                    HypePoolMath: await __mathLib.getAddress(),
                    HypePoolViews: await __viewsLib.getAddress(),
                },
            });
            const newImpl = await HypePoolV1.deploy();
            await newImpl.waitForDeployment();
            const newImplAddr = await newImpl.getAddress();

            // Propose but do NOT advance time
            await pool.connect(owner).proposeUpgrade(newImplAddr);

            await expect(
                pool.connect(owner).upgradeToAndCall(newImplAddr, '0x'),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'TimelockNotExpired');
        });

        it('upgrade reverts if the 1-hour execution window has expired', async function () {
            const { pool, owner } = await loadFixture(deployV1Fixture);

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('HypePoolMath')).deploy(),
                (await ethers.getContractFactory('HypePoolViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const HypePoolV1 = await ethers.getContractFactory('HypePoolV1', {
                libraries: {
                    HypePoolMath: await __mathLib.getAddress(),
                    HypePoolViews: await __viewsLib.getAddress(),
                },
            });
            const newImpl = await HypePoolV1.deploy();
            await newImpl.waitForDeployment();
            const newImplAddr = await newImpl.getAddress();

            await pool.connect(owner).proposeUpgrade(newImplAddr);

            // Advance past both the 72-hour timelock AND the 1-hour execution window
            await time.increase(72 * 60 * 60 + 60 * 60 + 1);

            await expect(
                pool.connect(owner).upgradeToAndCall(newImplAddr, '0x'),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'UpgradeProposalExpired');
        });

        it('upgrade reverts without a prior proposeUpgrade call', async function () {
            const { pool, owner } = await loadFixture(deployV1Fixture);

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('HypePoolMath')).deploy(),
                (await ethers.getContractFactory('HypePoolViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const HypePoolV1 = await ethers.getContractFactory('HypePoolV1', {
                libraries: {
                    HypePoolMath: await __mathLib.getAddress(),
                    HypePoolViews: await __viewsLib.getAddress(),
                },
            });
            const newImpl = await HypePoolV1.deploy();
            await newImpl.waitForDeployment();

            await expect(
                pool.connect(owner).upgradeToAndCall(await newImpl.getAddress(), '0x'),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'UpgradeNotProposed');
        });

        it('non-admin cannot upgrade', async function () {
            const { pool, alice } = await loadFixture(deployV1Fixture);

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('HypePoolMath')).deploy(),
                (await ethers.getContractFactory('HypePoolViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const HypePoolV1 = await ethers.getContractFactory('HypePoolV1', {
                libraries: {
                    HypePoolMath: await __mathLib.getAddress(),
                    HypePoolViews: await __viewsLib.getAddress(),
                },
            });
            const newImpl = await HypePoolV1.deploy();
            await newImpl.waitForDeployment();

            await expect(
                pool.connect(alice).upgradeToAndCall(await newImpl.getAddress(), '0x'),
            ).to.be.revertedWithCustomError(pool, 'Unauthorized');
        });

        it('getUpgradeProposal returns correct status at each stage', async function () {
            const { pool, owner } = await loadFixture(deployV1Fixture);

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('HypePoolMath')).deploy(),
                (await ethers.getContractFactory('HypePoolViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const HypePoolV1 = await ethers.getContractFactory('HypePoolV1', {
                libraries: {
                    HypePoolMath: await __mathLib.getAddress(),
                    HypePoolViews: await __viewsLib.getAddress(),
                },
            });
            const newImpl = await HypePoolV1.deploy();
            await newImpl.waitForDeployment();
            const newImplAddr = await newImpl.getAddress();

            // Before any proposal: status = 0 (none)
            let p = await pool.getUpgradeProposal();
            expect(p.impl).to.equal(ethers.ZeroAddress);
            expect(p.status).to.equal(0);

            // After proposal: status = 1 (pending — timelock running)
            await pool.connect(owner).proposeUpgrade(newImplAddr);
            p = await pool.getUpgradeProposal();
            expect(p.impl).to.equal(newImplAddr);
            expect(p.status).to.equal(1);
            expect(p.expiresAt).to.equal(p.executeAfter + 3600n);

            // After 72 h but within expiry window: status = 2 (ready)
            await time.increase(72 * 60 * 60 + 1);
            p = await pool.getUpgradeProposal();
            expect(p.status).to.equal(2);

            // After 72 h + 1 h (expired): status = 3
            await time.increase(60 * 60);
            p = await pool.getUpgradeProposal();
            expect(p.status).to.equal(3);
        });

        it('buyEntries is blocked during the upgrade execution window', async function () {
            const { pool, owner, alice } = await loadFixture(deployV1Fixture);

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('HypePoolMath')).deploy(),
                (await ethers.getContractFactory('HypePoolViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const HypePoolV1 = await ethers.getContractFactory('HypePoolV1', {
                libraries: {
                    HypePoolMath: await __mathLib.getAddress(),
                    HypePoolViews: await __viewsLib.getAddress(),
                },
            });
            const newImpl = await HypePoolV1.deploy();
            await newImpl.waitForDeployment();
            const newImplAddr = await newImpl.getAddress();

            await pool.connect(owner).proposeUpgrade(newImplAddr);
            const entry = makeEntry([1, 2, 3, 4, 5], 10, 0);

            // Still in timelock period — buy should succeed
            await expect(buyEntries(pool, alice, [entry])).to.not.be.reverted;

            // Advance into the execution window
            await time.increase(72 * 60 * 60 + 1);

            await expect(
                buyEntries(pool, alice, [entry]),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'UpgradePending');

            // After the window expires, buys should be allowed again
            await time.increase(60 * 60 + 1);
            await expect(buyEntries(pool, alice, [entry])).to.not.be.reverted;
        });

        it('cancelAdminAction clears upgrade proposal state', async function () {
            const { pool, owner } = await loadFixture(deployV1Fixture);

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('HypePoolMath')).deploy(),
                (await ethers.getContractFactory('HypePoolViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const HypePoolV1 = await ethers.getContractFactory('HypePoolV1', {
                libraries: {
                    HypePoolMath: await __mathLib.getAddress(),
                    HypePoolViews: await __viewsLib.getAddress(),
                },
            });
            const newImpl = await HypePoolV1.deploy();
            await newImpl.waitForDeployment();
            const newImplAddr = await newImpl.getAddress();

            await pool.connect(owner).proposeUpgrade(newImplAddr);

            // Confirm proposal is active
            let p = await pool.getUpgradeProposal();
            expect(p.impl).to.equal(newImplAddr);

            // Cancel it
            const actionHash = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ['string', 'address'],
                    ['upgradeToAndCall', newImplAddr],
                ),
            );
            await pool.connect(owner).cancelAdminAction(actionHash);

            // Proposal state should be cleared
            p = await pool.getUpgradeProposal();
            expect(p.impl).to.equal(ethers.ZeroAddress);
            expect(p.status).to.equal(0);
        });

        it('proposeUpgrade emits UpgradeProposed event with correct fields', async function () {
            const { pool, owner } = await loadFixture(deployV1Fixture);

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('HypePoolMath')).deploy(),
                (await ethers.getContractFactory('HypePoolViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const HypePoolV1 = await ethers.getContractFactory('HypePoolV1', {
                libraries: {
                    HypePoolMath: await __mathLib.getAddress(),
                    HypePoolViews: await __viewsLib.getAddress(),
                },
            });
            const newImpl = await HypePoolV1.deploy();
            await newImpl.waitForDeployment();
            const newImplAddr = await newImpl.getAddress();

            const tx = await pool.connect(owner).proposeUpgrade(newImplAddr);
            const receipt = await tx.wait();
            const block = await ethers.provider.getBlock(receipt.blockNumber);

            const expectedExecuteAfter = BigInt(block.timestamp) + BigInt(72 * 3600);
            const expectedExpiresAt    = expectedExecuteAfter + BigInt(3600);

            await expect(tx)
                .to.emit(pool, 'UpgradeProposed')
                .withArgs(newImplAddr, expectedExecuteAfter, expectedExpiresAt);
        });

        it('proposeUpgrade reverts when a proposal is already pending', async function () {
            const { pool, owner } = await loadFixture(deployV1Fixture);

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('HypePoolMath')).deploy(),
                (await ethers.getContractFactory('HypePoolViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const HypePoolV1 = await ethers.getContractFactory('HypePoolV1', {
                libraries: {
                    HypePoolMath: await __mathLib.getAddress(),
                    HypePoolViews: await __viewsLib.getAddress(),
                },
            });
            const implA = await HypePoolV1.deploy();
            await implA.waitForDeployment();
            const implB = await HypePoolV1.deploy();
            await implB.waitForDeployment();

            // First proposal goes through
            await pool.connect(owner).proposeUpgrade(await implA.getAddress());

            // Second proposal with a different address must revert until A is cancelled
            await expect(
                pool.connect(owner).proposeUpgrade(await implB.getAddress()),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'ExistingProposal');
        });

        it('proposeUpgrade succeeds after cancelling the previous proposal', async function () {
            const { pool, owner } = await loadFixture(deployV1Fixture);

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('HypePoolMath')).deploy(),
                (await ethers.getContractFactory('HypePoolViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const HypePoolV1 = await ethers.getContractFactory('HypePoolV1', {
                libraries: {
                    HypePoolMath: await __mathLib.getAddress(),
                    HypePoolViews: await __viewsLib.getAddress(),
                },
            });
            const implA = await HypePoolV1.deploy();
            await implA.waitForDeployment();
            const implAAddr = await implA.getAddress();
            const implB = await HypePoolV1.deploy();
            await implB.waitForDeployment();
            const implBAddr = await implB.getAddress();

            await pool.connect(owner).proposeUpgrade(implAAddr);

            // Cancel A
            const actionHashA = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ['string', 'address'],
                    ['upgradeToAndCall', implAAddr],
                ),
            );
            await pool.connect(owner).cancelAdminAction(actionHashA);

            // Now proposing B must succeed
            await expect(
                pool.connect(owner).proposeUpgrade(implBAddr),
            ).to.not.be.reverted;

            const p = await pool.getUpgradeProposal();
            expect(p.impl).to.equal(implBAddr);
        });

        it('claim-based prizes work through proxy', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployV1Fixture);

            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, 42n);
            await pool.settleRound();

            const info = await pool.getRoundInfo(1);
            if (info.prizePoolWinners > 0n) {
                const claimable = await pool.getClaimableAmount(1, alice.address);
                expect(claimable).to.be.gt(0n);

                const aliceBalBefore = await ethers.provider.getBalance(alice.address);
                const indices = await pool.getPlayerEntryIndices(1, alice.address);
                const tx = await pool.connect(alice).claimPrizeBatch(1, indices);
                const receipt = await tx.wait();
                const gasCost = receipt.gasUsed * receipt.gasPrice;
                const aliceBalAfter = await ethers.provider.getBalance(alice.address);

                expect(aliceBalAfter - aliceBalBefore + gasCost).to.equal(claimable);
            }
        });

        it('MAX_ROUND_ENTRIES cap is enforced', async function () {
            const { pool } = await loadFixture(deployV1Fixture);
            expect(await pool.MAX_ROUND_ENTRIES()).to.equal(10_000);
        });
    });

    // ─── Deterministic winner (computed seed) ──────────────────────

    /**
   * JS replica of the Solidity _generateDrawnNumbers(seed):
   * lets us pre-compute winning numbers and buy a guaranteed-win entry.
   * LOW-2: Updated to use domain-separated nonces matching the Solidity implementation.
   */
    function generateDrawnNumbers(seed) {
        const abiCoder = ethers.AbiCoder.defaultAbiCoder();
        const bigSeed = BigInt(seed);

        // Derive independent seeds for each output domain (mirrors Solidity).
        const whitesSeed  = BigInt(ethers.keccak256(abiCoder.encode(['uint256', 'string'], [bigSeed, 'whites'])));
        const goldNumSeed = BigInt(ethers.keccak256(abiCoder.encode(['uint256', 'string'], [bigSeed, 'goldNum'])));
        const goldPosSeed = BigInt(ethers.keccak256(abiCoder.encode(['uint256', 'string'], [bigSeed, 'goldPos'])));

        // Generate whites using the whites domain seed.
        let rng = whitesSeed;
        const whites = [];
        let count = 0;

        while (whites.length < 5) {
            rng = BigInt(ethers.keccak256(abiCoder.encode(['uint256', 'uint8'], [rng, count])));
            const num = Number(rng % 90n) + 1;
            if (!whites.includes(num)) {
                whites.push(num);
                count++;
            }
        }

        // Bubble sort (same as Solidity)
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4 - i; j++) {
                if (whites[j] > whites[j + 1]) {
                    [whites[j], whites[j + 1]] = [whites[j + 1], whites[j]];
                }
            }
        }

        const goldNum = Number(goldNumSeed % 90n) + 1;
        const goldPos = Number(goldPosSeed % 5n);

        return { whites, goldNum, goldPos };
    }

    const DETERMINISTIC_SEED = 1n; // small, predictable seed

    describe('Deterministic winner (computed seed)', function () {
        it('prize pool winner when entry exactly matches computed drawn numbers', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);
            const losGold = goldNum === 1 ? 2 : 1; // different gold → prizePool but not super

            await buyEntries(pool, alice, [makeEntry(whites, losGold, goldPos)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await pool.settleRound();

            const info = await pool.getRoundInfo(1);
            expect(info.prizePoolWinners).to.equal(1);

            const claimable = await pool.getClaimableAmount(1, alice.address);
            expect(claimable).to.be.gt(0n);
        });

        it('super pool winner when entry matches whites + gold exactly', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);

            await buyEntries(pool, alice, [makeEntry(whites, goldNum, goldPos)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await pool.settleRound();

            const info = await pool.getRoundInfo(1);
            expect(info.prizePoolWinners).to.equal(1);
            expect(info.superWinners).to.equal(1);

            const claimable = await pool.getClaimableAmount(1, alice.address);
            // Prize = prizePool (sole winner) + seedPool (sole super winner)
            expect(claimable).to.equal(info.prizePool + info.seedPool);
        });

        it('prize pool split equally between two winners with the same whites', async function () {
            const { pool, mockVRF, alice, bob } = await loadFixture(deployFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);
            // Both use a different gold → prize pool winners, not super winners
            const otherGold = goldNum === 1 ? 2 : 1;

            await buyEntries(pool, alice, [makeEntry(whites, otherGold, goldPos)]);
            await buyEntries(pool, bob,   [makeEntry(whites, otherGold, goldPos)]);

            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await pool.settleRound();

            const info = await pool.getRoundInfo(1);
            expect(info.prizePoolWinners).to.equal(2);

            const aliceClaimable = await pool.getClaimableAmount(1, alice.address);
            const bobClaimable   = await pool.getClaimableAmount(1, bob.address);

            // Both halves should be equal
            expect(aliceClaimable).to.equal(bobClaimable);
            // Each half equals prizePool / 2 (two winners split the pool)
            expect(aliceClaimable).to.equal(info.prizePool / 2n);
        });

        it('claimPrizeBatch claims both winning entries in a single call', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);

            // Buy two winning entries for alice
            await buyEntries(pool, alice, [
                makeEntry(whites, goldNum, goldPos),
                makeEntry(whites, goldNum, goldPos),
            ]);

            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await pool.settleRound();

            const info = await pool.getRoundInfo(1);
            expect(info.prizePoolWinners).to.equal(2); // both alice's entries win

            const totalClaimable = await pool.getClaimableAmount(1, alice.address);
            expect(totalClaimable).to.be.gt(0n);

            const indices = [...(await pool.getPlayerEntryIndices(1, alice.address))];
            const balBefore = await ethers.provider.getBalance(alice.address);
            const tx = await pool.connect(alice).claimPrizeBatch(1, indices);
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(alice.address);

            expect(balAfter - balBefore + gasCost).to.equal(totalClaimable);
            expect(await pool.getClaimableAmount(1, alice.address)).to.equal(0n);
        });

        it('claimPrizeBatch silently skips already-claimed entries', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);

            await buyEntries(pool, alice, [
                makeEntry(whites, goldNum, goldPos),
                makeEntry(whites, goldNum, goldPos),
            ]);

            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await pool.settleRound();

            const indices = [...(await pool.getPlayerEntryIndices(1, alice.address))];

            // First batch claim — transfers prizes
            await pool.connect(alice).claimPrizeBatch(1, indices);

            // Second batch claim on the same (already-claimed) indices must NOT revert,
            // but also must not transfer any additional funds.
            const balBefore = await ethers.provider.getBalance(alice.address);
            const tx = await pool.connect(alice).claimPrizeBatch(1, indices);
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(alice.address);

            // Net balance change should be negative (only gas cost, no prize received)
            expect(balBefore - balAfter).to.equal(gasCost);
            expect(await pool.getClaimableAmount(1, alice.address)).to.equal(0n);
        });

        it('claimPrizeBatch skips non-prize entries and claims only winners', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);

            // Buy one winning and one losing entry
            await buyEntries(pool, alice, [
                makeEntry(whites, goldNum, goldPos),
                makeEntry([1, 2, 3, 4, 5], 88, 0), // losing entry (numbers won't match drawn)
            ]);

            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await pool.settleRound();

            const totalClaimable = await pool.getClaimableAmount(1, alice.address);
            expect(totalClaimable).to.be.gt(0n);

            const indices = [...(await pool.getPlayerEntryIndices(1, alice.address))];
            // Batch includes both the winner and the loser — should not revert
            const balBefore = await ethers.provider.getBalance(alice.address);
            const tx = await pool.connect(alice).claimPrizeBatch(1, indices);
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(alice.address);

            // Winner prize received despite the loser being in the same batch
            expect(balAfter - balBefore + gasCost).to.equal(totalClaimable);
        });

        it('getClaimableAmount returns 0 after all prizes are claimed', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);
            await buyEntries(pool, alice, [makeEntry(whites, goldNum, goldPos)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await pool.settleRound();

            const indices = [...(await pool.getPlayerEntryIndices(1, alice.address))];
            await pool.connect(alice).claimPrizeBatch(1, indices);

            expect(await pool.getClaimableAmount(1, alice.address)).to.equal(0n);
        });
    });

    // ─── CCIP authorization ─────────────────────────────────────────

    describe('CCIP authorization', function () {
        it('ccipReceive reverts when called by a non-router (direct call)', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);
            await closeDraw(pool);

            // alice calls ccipReceive directly (not through the router)
            const message = {
                messageId:           ethers.ZeroHash,
                sourceChainSelector: 16015286601757825753n,
                sender:              ethers.AbiCoder.defaultAbiCoder().encode(['address'], [alice.address]),
                data:                ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [1n, 42n]),
                destTokenAmounts:    [],
            };
            await expect(
                pool.connect(alice).ccipReceive(message),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'OnlyCCIPRouter');
        });

        it('ccipReceive reverts for wrong source chain (direct call bypasses router)', async function () {
            const { pool, vrfRequester, alice } = await loadFixture(deployFixture);
            // Calling ccipReceive directly with wrong selector (bypasses the real router).
            // This also proves the router-only guard fires first; the second guard would
            // fire if we could craft a delivery with wrong selector via MockRouter.
            const message = {
                messageId:           ethers.ZeroHash,
                sourceChainSelector: 999n, // wrong
                sender:              ethers.AbiCoder.defaultAbiCoder().encode(['address'], [await vrfRequester.getAddress()]),
                data:                ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [1n, 42n]),
                destTokenAmounts:    [],
            };
            await expect(
                pool.connect(alice).ccipReceive(message),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'OnlyCCIPRouter');
        });

        it('ccipReceive reverts for wrong vrfRequester (direct call)', async function () {
            const { pool, CHAIN_SELECTOR, alice } = await loadFixture(deployFixture);
            const message = {
                messageId:           ethers.ZeroHash,
                sourceChainSelector: CHAIN_SELECTOR,
                sender:              ethers.AbiCoder.defaultAbiCoder().encode(['address'], [alice.address]), // wrong sender
                data:                ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [1n, 42n]),
                destTokenAmounts:    [],
            };
            await expect(
                pool.connect(alice).ccipReceive(message),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'OnlyCCIPRouter');
        });
    });

    // ─── Admin configuration setters ───────────────────────────────

    describe('Admin configuration setters', function () {
        it('admin can update setCCIPGasLimit', async function () {
            const { pool, owner } = await loadFixture(deployFixture);
            await expect(
                pool.connect(owner).setCCIPGasLimit(300_000),
            ).to.not.be.reverted;
        });

        it('setCCIPGasLimit reverts below MIN_CCIP_GAS_LIMIT', async function () {
            const { pool } = await loadFixture(deployFixture);
            const min = await pool.MIN_CCIP_GAS_LIMIT();
            await expect(
                pool.setCCIPGasLimit(Number(min) - 1),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'GasLimitOutOfRange');
        });

        it('setCCIPGasLimit reverts above MAX_CCIP_GAS_LIMIT', async function () {
            const { pool } = await loadFixture(deployFixture);
            const max = await pool.MAX_CCIP_GAS_LIMIT();
            await expect(
                pool.setCCIPGasLimit(Number(max) + 1),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'GasLimitOutOfRange');
        });

        it('non-admin cannot call setCCIPGasLimit', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await expect(
                pool.connect(alice).setCCIPGasLimit(300_000),
            ).to.be.revertedWithCustomError(pool, 'Unauthorized');
        });

        it('non-admin cannot call proposeSetCCIPRouter', async function () {
            const { pool, routerAddr, alice } = await loadFixture(deployFixture);
            await expect(
                pool.connect(alice).proposeSetCCIPRouter(routerAddr),
            ).to.be.revertedWithCustomError(pool, 'Unauthorized');
        });

        it('non-admin cannot call proposeSetVRFRequester', async function () {
            const { pool, routerAddr, alice } = await loadFixture(deployFixture);
            await expect(
                pool.connect(alice).proposeSetVRFRequester(routerAddr),
            ).to.be.revertedWithCustomError(pool, 'Unauthorized');
        });

        it('non-admin cannot call emergencyCancelDraw', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);
            await closeDraw(pool);

            await expect(
                pool.connect(alice).emergencyCancelDraw(),
            ).to.be.revertedWithCustomError(pool, 'Unauthorized');
        });
    });

    // ─── Pool carry-over exact ETH amounts ─────────────────────────

    describe('Pool carry-over exact ETH amounts', function () {
        it('entire prizePool carries over to the next round when no winner', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);

            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            const r1 = await pool.getRoundInfo(1);
            const prizePool1 = r1.prizePool;
            const seedPool1   = r1.seedPool;

            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            const r2 = await pool.getRoundInfo(2);
            expect(r2.prizePool).to.equal(prizePool1);
            expect(r2.seedPool).to.equal(seedPool1);
        });

        it('fee is not included in the carried-over pools', async function () {
            const { pool, alice } = await loadFixture(deployFixture);

            const price = await pool.entryPrice();
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);

            const r1 = await pool.getRoundInfo(1);
            // First entry gets early bird: totalCost = price / 2
            const totalCost = price / 2n;
            const expectedPrizePool = (totalCost * 5000n) / 10000n;
            const expectedSeed    = (totalCost * 3000n) / 10000n;
            const expectedFee     = (totalCost * 600n) / 10000n; // 6% owner when no referrer

            expect(r1.prizePool).to.equal(expectedPrizePool);
            expect(r1.seedPool).to.equal(expectedSeed);
            expect(await pool.ownerFees()).to.equal(expectedFee);
        });

        it('pool accumulates correctly over two no-winner rounds', async function () {
            const { pool, mockVRF, alice, bob } = await loadFixture(deployFixture);

            const price = await pool.entryPrice();
            // First entries each round get early bird (half price)
            const cost1 = price / 2n;

            // Round 1
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            // Round 2 – fresh entry (price may have changed but fetch it)
            const price2 = await pool.entryPrice();
            const cost2 = price2 / 2n;
            await buyEntries(pool, bob, [makeEntry([2, 3, 4, 5, 6], 20, 1)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 2, NON_MATCHING_SEED);
            await pool.settleRound();

            // Round 3 should have the sum of both rounds' pools
            const r3 = await pool.getRoundInfo(3);
            const expectedPrizePool = (cost1 * 5000n / 10000n) + (cost2 * 5000n / 10000n);
            const expectedSeed    = (cost1 * 3000n / 10000n) + (cost2 * 3000n / 10000n);

            expect(r3.prizePool).to.equal(expectedPrizePool);
            expect(r3.seedPool).to.equal(expectedSeed);
        });

        it('dust from integer division is added to next round prizePool', async function () {
            const { pool, mockVRF, alice, bob, charlie } = await loadFixture(
                deployFixture,
            );

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);

            // Three players all win → prizePool / 3 may leave dust
            await buyEntries(pool, alice,   [makeEntry(whites, goldNum, goldPos)]);
            await buyEntries(pool, bob,     [makeEntry(whites, goldNum, goldPos)]);
            await buyEntries(pool, charlie, [makeEntry(whites, goldNum, goldPos)]);

            const r1 = await pool.getRoundInfo(1);
            const prizePool1 = r1.prizePool;

            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await pool.settleRound();

            const r1settled = await pool.getRoundInfo(1);
            expect(r1settled.prizePoolWinners).to.equal(3);

            // Compute expected prize per winner and dust from the reported pool
            const prizePerWinner = r1settled.prizePool / 3n;
            const dust = r1settled.prizePool - prizePerWinner * 3n;

            const r2 = await pool.getRoundInfo(2);
            // Dust should have rolled to round 2's prize pool
            expect(r2.prizePool).to.be.gte(dust);
        });
    });

    // ─── claimPendingPayout ─────────────────────────────────────────

    describe('claimPendingPayout', function () {
        it('returns 0 for an address with no pending payout', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            expect(await pool.pendingPayouts(alice.address)).to.equal(0n);
        });
    });

    // ─── Audit fixes ────────────────────────────────────────────────

    describe('HIGH: Admin timelock for CCIP config changes', function () {
        it('proposeSetCCIPRouter emits AdminActionProposed', async function () {
            const { pool, owner, routerAddr: fixtureRouterAddr } = await loadFixture(deployFixture);
            const routerAddr = fixtureRouterAddr;
            await expect(pool.connect(owner).proposeSetCCIPRouter(routerAddr))
                .to.emit(pool, 'AdminActionProposed');
        });

        it('executeSetCCIPRouter reverts before timelock expires', async function () {
            const { pool, owner, routerAddr: fixtureRouterAddr } = await loadFixture(deployFixture);
            const routerAddr = fixtureRouterAddr;
            await pool.connect(owner).proposeSetCCIPRouter(routerAddr);
            await expect(
                pool.connect(owner).executeSetCCIPRouter(routerAddr),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'TimelockNotExpired');
        });

        it('executeSetCCIPRouter succeeds after timelock expires', async function () {
            const { pool, owner, routerAddr: fixtureRouterAddr } = await loadFixture(deployFixture);
            const routerAddr = fixtureRouterAddr;
            await pool.connect(owner).proposeSetCCIPRouter(routerAddr);
            await time.increase(48 * 60 * 60 + 1);
            await expect(
                pool.connect(owner).executeSetCCIPRouter(routerAddr),
            ).to.emit(pool, 'AdminActionExecuted');
            expect(await pool.ccipRouter()).to.equal(routerAddr);
        });

        it('executeSetCCIPRouter reverts if not proposed', async function () {
            const { pool, owner, routerAddr: fixtureRouterAddr } = await loadFixture(deployFixture);
            const routerAddr = fixtureRouterAddr;
            await expect(
                pool.connect(owner).executeSetCCIPRouter(routerAddr),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'ActionNotProposed');
        });

        it('cancelAdminAction removes a pending CCIP router action', async function () {
            const { pool, owner, routerAddr: fixtureRouterAddr } = await loadFixture(deployFixture);
            const routerAddr = fixtureRouterAddr;
            await pool.connect(owner).proposeSetCCIPRouter(routerAddr);
            const actionHash = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ['string', 'address'],
                    ['setCCIPRouter', routerAddr],
                ),
            );
            await expect(pool.connect(owner).cancelAdminAction(actionHash))
                .to.emit(pool, 'AdminActionCancelled');
            // After cancellation, execution must fail
            await time.increase(48 * 60 * 60 + 1);
            await expect(
                pool.connect(owner).executeSetCCIPRouter(routerAddr),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'ActionNotProposed');
        });

        it('non-admin cannot propose CCIP router change', async function () {
            const { pool, routerAddr, alice } = await loadFixture(deployFixture);
            await expect(
                pool.connect(alice).proposeSetCCIPRouter(routerAddr),
            ).to.be.revertedWithCustomError(pool, 'Unauthorized');
        });

        it('proposeSetCCIPRouter reverts for zero address', async function () {
            const { pool, owner } = await loadFixture(deployFixture);
            await expect(
                pool.connect(owner).proposeSetCCIPRouter(ethers.ZeroAddress),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'ZeroAddress');
        });

        it('proposeSetCCIPRouter reverts for EOA', async function () {
            const { pool, owner, alice } = await loadFixture(deployFixture);
            await expect(
                pool.connect(owner).proposeSetCCIPRouter(alice.address),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'NotAContract');
        });

        it('proposeSetVRFRequester emits AdminActionProposed', async function () {
            const { pool, owner, routerAddr: requesterRouterAddr } = await loadFixture(deployFixture);
            const requesterAddr = requesterRouterAddr;
            await expect(pool.connect(owner).proposeSetVRFRequester(requesterAddr))
                .to.emit(pool, 'AdminActionProposed');
        });

        it('executeSetVRFRequester succeeds after timelock expires', async function () {
            const { pool, owner, routerAddr: requesterRouterAddr } = await loadFixture(deployFixture);
            const requesterAddr = requesterRouterAddr;
            await pool.connect(owner).proposeSetVRFRequester(requesterAddr);
            await time.increase(48 * 60 * 60 + 1);
            await expect(
                pool.connect(owner).executeSetVRFRequester(requesterAddr),
            ).to.emit(pool, 'AdminActionExecuted');
            expect(await pool.vrfRequester()).to.equal(requesterAddr);
        });
    });

    describe('MEDIUM-1: CCIP draw state validation', function () {
        it('after emergencyCancelDraw + re-draw, fulfilling earlier VRF request still works', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);
            // Buy and draw for round 1 → VRF request #1 issued
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            // Cancel round 1 → back to OPEN.  HypePoolVRFRequester still has pendingRoundId=1.
            await time.increase(Number(DRAW_GRACE));
            await pool.emergencyCancelDraw();
            // Re-draw round 1 → VRF request #2 issued (same round, pendingRoundId check relaxed)
            await closeDraw(pool);
            // VRF request #1 can still be fulfilled (round 1 is DRAWING).
            // The full pipeline: fulfillRandomWords(1) → HypePoolVRFRequester.fulfillRandomWords
            // → ccipSend → HypePoolV1.ccipReceive → _applyRandomness.
            await expect(
                fulfillDraw(mockVRF, 1, NON_MATCHING_SEED),
            ).to.not.be.reverted;
        });

        it('ccipReceive succeeds for the current drawing round', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await expect(
                fulfillDraw(mockVRF, 1, NON_MATCHING_SEED),
            ).to.not.be.reverted;
        });
    });

    describe('MEDIUM-1 (audit 2): noContract blocks contract callers', function () {
        it('contract caller is rejected when buying entries', async function () {
            const { pool } = await loadFixture(deployFixture);

            const MockCaller = await ethers.getContractFactory('MockContractCaller');
            const caller = await MockCaller.deploy();
            await caller.waitForDeployment();

            const price = await pool.entryPrice();
            await expect(
                caller.tryBuyEntries(await pool.getAddress(), { value: price }),
            ).to.be.revertedWithCustomError(pool, 'NoIndirectCalls');
        });
    });

    describe('MEDIUM-2: Batch settlement', function () {
        it('settleRoundBatch completes settlement in one call when entries <= batchSize', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRoundBatch();
            expect((await pool.getRoundInfo(1)).state).to.equal(3); // SETTLED
        });

        it('settleRoundBatch can be called multiple times for large rounds', async function () {
            const { pool, mockVRF, alice, bob } = await loadFixture(deployFixture);

            // Reduce batch size to 1 to force multiple calls
            await pool.setSettlementBatchSize(1);

            // Buy 3 entries from different accounts
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await buyEntries(pool, bob,   [makeEntry([2, 3, 4, 5, 6], 20, 1)]);
            await buyEntries(pool, alice, [makeEntry([3, 4, 5, 6, 7], 30, 2)]);

            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);

            // With batchSize=1 and 3 entries, need 3 calls
            expect((await pool.getRoundInfo(1)).state).to.equal(2); // DRAWN
            await pool.settleRoundBatch();
            expect((await pool.getRoundInfo(1)).state).to.equal(2); // still DRAWN
            await pool.settleRoundBatch();
            expect((await pool.getRoundInfo(1)).state).to.equal(2); // still DRAWN
            await pool.settleRoundBatch();
            expect((await pool.getRoundInfo(1)).state).to.equal(3); // SETTLED
        });

        it('settleRoundBatch and settleRound produce identical results', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);
            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);

            await buyEntries(pool, alice, [makeEntry(whites, goldNum, goldPos)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);

            await pool.settleRoundBatch();

            const r = await pool.getRoundInfo(1);
            expect(r.state).to.equal(3);            // SETTLED
            expect(r.prizePoolWinners).to.equal(1);
        });

        it('settleRoundBatch reverts when round is not DRAWN', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await expect(pool.settleRoundBatch()).to.be.revertedWithCustomError(hypePoolMathLib, 'NotDrawnYet');
        });

        it('setSettlementBatchSize can be changed by admin', async function () {
            const { pool, owner } = await loadFixture(deployFixture);
            await pool.connect(owner).setSettlementBatchSize(50);
            expect(await pool.settlementBatchSize()).to.equal(50);
        });

        it('setSettlementBatchSize reverts for size 0', async function () {
            const { pool, owner } = await loadFixture(deployFixture);
            await expect(
                pool.connect(owner).setSettlementBatchSize(0),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'InvalidBatchSize');
        });

        it('non-admin cannot call setSettlementBatchSize', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await expect(
                pool.connect(alice).setSettlementBatchSize(50),
            ).to.be.revertedWithCustomError(pool, 'Unauthorized');
        });

        it('MEDIUM-2: settleRound reverts when entryCount > settlementBatchSize', async function () {
            const { pool, mockVRF, alice, bob } = await loadFixture(deployFixture);

            // Reduce batch size to 1 so that 2 entries exceed the limit
            await pool.setSettlementBatchSize(1);

            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await buyEntries(pool, bob,   [makeEntry([2, 3, 4, 5, 6], 20, 1)]);

            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);

            // entryCount (2) > settlementBatchSize (1) → must use batch
            await expect(pool.settleRound()).to.be.revertedWithCustomError(hypePoolMathLib, 'UseBatchSettlement');

            // settleRoundBatch still works
            await pool.settleRoundBatch();
            await pool.settleRoundBatch();
            expect((await pool.getRoundInfo(1)).state).to.equal(3); // SETTLED
        });
    });

    describe('LOW-2: Improved randomness (domain-separated nonces)', function () {
        it('generateDrawnNumbers JS matches Solidity _generateDrawnNumbers output', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);
            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);

            // Buy the exact winning entry according to JS helper
            await buyEntries(pool, alice, [makeEntry(whites, goldNum, goldPos)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await pool.settleRound();

            const info = await pool.getRoundInfo(1);
            // If JS and Solidity agree, alice is a winner
            expect(info.prizePoolWinners).to.equal(1);
            expect(info.superWinners).to.equal(1);
        });

        it('different seeds produce different white numbers', async function () {
            const r1 = generateDrawnNumbers(1n);
            const r2 = generateDrawnNumbers(2n);
            const same = r1.whites.every((w, i) => w === r2.whites[i]);
            expect(same).to.be.false;
        });
    });

    // ═══════════════════════════════════════════════════════════════
    //  V2: FoundationPass NFT + Referral System
    // ═══════════════════════════════════════════════════════════════

    describe('V2: FoundationPass contract', function () {
        async function deployFoundationPassFixture() {
            const base = await deployFixture();
            const { pool, owner, alice, bob } = base;
            const mintPrice = ethers.parseEther('0.1');
            const FoundationPass = await ethers.getContractFactory('FoundationPass');
            const nft = await FoundationPass.deploy(mintPrice, 'https://example.com/meta/');
            await nft.waitForDeployment();
            // Unlock full supply so existing public-mint tests work as before
            await nft.connect(owner).setMintableSupply(10);
            // Wire: FoundationPass → pool (so mint() can call seedPrizePool)
            await nft.connect(owner).setPoolContract(await pool.getAddress());
            await pool.connect(owner).setFoundationPassContract(await nft.getAddress());
            return { ...base, nft, mintPrice };
        }

        it('should have correct name, symbol, and MAX_SUPPLY', async function () {
            const { nft } = await loadFixture(deployFoundationPassFixture);
            expect(await nft.name()).to.equal('FoundationPass');
            expect(await nft.symbol()).to.equal('FPASS');
            expect(await nft.MAX_SUPPLY()).to.equal(10);
        });

        it('public mint succeeds with correct payment', async function () {
            const { nft, alice, mintPrice } = await loadFixture(deployFoundationPassFixture);
            await nft.connect(alice).mint({ value: mintPrice });
            expect(await nft.ownerOf(0)).to.equal(alice.address);
            expect(await nft.totalMinted()).to.equal(1);
        });

        it('public mint reverts with insufficient payment', async function () {
            const { nft, alice } = await loadFixture(deployFoundationPassFixture);
            await expect(
                nft.connect(alice).mint({ value: ethers.parseEther('0.01') }),
            ).to.be.revertedWithCustomError(nft, 'InsufficientPayment');
        });

        it('adminMint succeeds for owner', async function () {
            const { nft, owner, alice } = await loadFixture(deployFoundationPassFixture);
            await nft.connect(owner).adminMint(alice.address);
            expect(await nft.ownerOf(0)).to.equal(alice.address);
            expect(await nft.totalMinted()).to.equal(1);
        });

        it('adminMint reverts for non-owner', async function () {
            const { nft, alice } = await loadFixture(deployFoundationPassFixture);
            await expect(
                nft.connect(alice).adminMint(alice.address),
            ).to.be.revertedWithCustomError(nft, 'OwnableUnauthorizedAccount');
        });

        it('max supply is enforced', async function () {
            const { nft, owner, alice } = await loadFixture(deployFoundationPassFixture);
            // Mint all 10
            for (let i = 0; i < 10; i++) {
                await nft.connect(owner).adminMint(alice.address);
            }
            expect(await nft.totalMinted()).to.equal(10);
            // 11th mint reverts
            await expect(
                nft.connect(owner).adminMint(alice.address),
            ).to.be.revertedWithCustomError(nft, 'AlreadyMintedOut');
        });

        it('mint forwards payment to prize pool (no proceeds in FoundationPass)', async function () {
            const { nft, pool, owner, alice, mintPrice } = await loadFixture(deployFoundationPassFixture);
            const infoBefore = await pool.getRoundInfo(1);
            await nft.connect(alice).mint({ value: mintPrice });

            // Mint payment goes to prize pool, not to _proceeds
            const infoAfter = await pool.getRoundInfo(1);
            expect(infoAfter.prizePool - infoBefore.prizePool).to.equal(mintPrice);

            // withdrawProceeds reverts because _proceeds is 0
            await expect(
                nft.connect(owner).withdrawProceeds(),
            ).to.be.revertedWithCustomError(nft, 'NoValueToWithdraw');
        });

        it('withdrawProceeds reverts when no proceeds', async function () {
            const { nft, owner } = await loadFixture(deployFoundationPassFixture);
            await expect(
                nft.connect(owner).withdrawProceeds(),
            ).to.be.revertedWithCustomError(nft, 'NoValueToWithdraw');
        });

        it('setBaseURI updates metadata URI', async function () {
            const { nft, owner, alice, mintPrice } = await loadFixture(deployFoundationPassFixture);
            await nft.connect(alice).mint({ value: mintPrice });
            await nft.connect(owner).setBaseURI('https://new-uri.com/');
            expect(await nft.tokenURI(0)).to.equal('https://new-uri.com/0');
        });
    });

    describe('V2: FoundationPass mintableSupply and pricing', function () {
        async function deployFoundationPassBaseFixture() {
            const base = await deployFixture();
            const { pool, owner, alice, bob } = base;
            const mintPrice = ethers.parseEther('2');
            const FoundationPass = await ethers.getContractFactory('FoundationPass');
            const nft = await FoundationPass.deploy(mintPrice, 'https://example.com/meta/');
            await nft.waitForDeployment();
            // Wire: FoundationPass → pool (so mint() can call seedPrizePool)
            await nft.connect(owner).setPoolContract(await pool.getAddress());
            await pool.connect(owner).setFoundationPassContract(await nft.getAddress());
            // mintableSupply starts at 0 — not set here
            return { ...base, nft, mintPrice };
        }

        it('mintableSupply starts at 0', async function () {
            const { nft } = await loadFixture(deployFoundationPassBaseFixture);
            expect(await nft.mintableSupply()).to.equal(0);
        });

        it('mint() reverts when mintableSupply is 0', async function () {
            const { nft, alice, mintPrice } = await loadFixture(deployFoundationPassBaseFixture);
            await expect(
                nft.connect(alice).mint({ value: mintPrice }),
            ).to.be.revertedWithCustomError(nft, 'MintableSupplyReached');
        });

        it('setMintableSupply sets the value', async function () {
            const { nft, owner } = await loadFixture(deployFoundationPassBaseFixture);
            await nft.connect(owner).setMintableSupply(3);
            expect(await nft.mintableSupply()).to.equal(3);
        });

        it('setMintableSupply reverts for non-owner', async function () {
            const { nft, alice } = await loadFixture(deployFoundationPassBaseFixture);
            await expect(
                nft.connect(alice).setMintableSupply(1),
            ).to.be.revertedWithCustomError(nft, 'OwnableUnauthorizedAccount');
        });

        it('setMintableSupply reverts if n > MAX_SUPPLY', async function () {
            const { nft, owner } = await loadFixture(deployFoundationPassBaseFixture);
            await expect(
                nft.connect(owner).setMintableSupply(11),
            ).to.be.revertedWithCustomError(nft, 'ExceedsMaxSupply');
        });

        it('mint() succeeds after setMintableSupply(1)', async function () {
            const { nft, owner, alice, mintPrice } = await loadFixture(deployFoundationPassBaseFixture);
            await nft.connect(owner).setMintableSupply(1);
            await nft.connect(alice).mint({ value: mintPrice });
            expect(await nft.ownerOf(0)).to.equal(alice.address);
            expect(await nft.publicMinted()).to.equal(1);
        });

        it('mint() reverts after mintableSupply is reached', async function () {
            const { nft, owner, alice, bob, mintPrice } = await loadFixture(deployFoundationPassBaseFixture);
            await nft.connect(owner).setMintableSupply(1);
            await nft.connect(alice).mint({ value: mintPrice });
            await expect(
                nft.connect(bob).mint({ value: mintPrice }),
            ).to.be.revertedWithCustomError(nft, 'MintableSupplyReached');
        });

        it('setMintPrice updates the mint price', async function () {
            const { nft, owner, alice } = await loadFixture(deployFoundationPassBaseFixture);
            const newPrice = ethers.parseEther('5');
            await nft.connect(owner).setMintPrice(newPrice);
            expect(await nft.mintPrice()).to.equal(newPrice);
            await nft.connect(owner).setMintableSupply(1);
            await nft.connect(alice).mint({ value: newPrice });
            expect(await nft.ownerOf(0)).to.equal(alice.address);
        });

        it('setMintPrice reverts for non-owner', async function () {
            const { nft, alice } = await loadFixture(deployFoundationPassBaseFixture);
            await expect(
                nft.connect(alice).setMintPrice(ethers.parseEther('1')),
            ).to.be.revertedWithCustomError(nft, 'OwnableUnauthorizedAccount');
        });

        it('adminMint bypasses mintableSupply', async function () {
            const { nft, owner, alice } = await loadFixture(deployFoundationPassBaseFixture);
            // mintableSupply is 0, adminMint still works
            await nft.connect(owner).adminMint(alice.address);
            expect(await nft.ownerOf(0)).to.equal(alice.address);
            expect(await nft.totalMinted()).to.equal(1);
            expect(await nft.publicMinted()).to.equal(0);
        });

        it('poolMint bypasses mintableSupply', async function () {
            const { nft, owner, alice } = await loadFixture(deployFoundationPassBaseFixture);
            await nft.connect(owner).setPoolContract(owner.address);
            // mintableSupply is 0, poolMint still works
            await nft.connect(owner).poolMint(alice.address);
            expect(await nft.ownerOf(0)).to.equal(alice.address);
            expect(await nft.publicMinted()).to.equal(0);
        });

        it('progressive mint flow: price 2 ETH then 5 ETH', async function () {
            const { nft, owner, alice, bob } = await loadFixture(deployFoundationPassBaseFixture);
            const price1 = ethers.parseEther('2');
            const price2 = ethers.parseEther('5');

            // Step 1: Unlock 1 token at 2 ETH
            await nft.connect(owner).setMintableSupply(1);
            await nft.connect(alice).mint({ value: price1 });
            expect(await nft.publicMinted()).to.equal(1);

            // Step 2: Raise price to 5 ETH and unlock 2nd slot
            await nft.connect(owner).setMintPrice(price2);
            await nft.connect(owner).setMintableSupply(2);
            await nft.connect(bob).mint({ value: price2 });
            expect(await nft.publicMinted()).to.equal(2);
            expect(await nft.ownerOf(1)).to.equal(bob.address);
        });

        it('adminMint does not count toward publicMinted', async function () {
            const { nft, owner, alice, bob, mintPrice } = await loadFixture(deployFoundationPassBaseFixture);
            // adminMint pushes _totalMinted to 1 but _publicMinted stays 0
            await nft.connect(owner).adminMint(alice.address);
            // With mintableSupply=1, public mint should still work
            await nft.connect(owner).setMintableSupply(1);
            await nft.connect(bob).mint({ value: mintPrice });
            expect(await nft.publicMinted()).to.equal(1);
            expect(await nft.totalMinted()).to.equal(2);
        });
    });

    describe('V2: setFoundationPassContract', function () {
        it('admin can set foundation pass contract', async function () {
            const { pool, owner, alice } = await loadFixture(deployFixture);
            // Deploy a FoundationPass
            const FoundationPass = await ethers.getContractFactory('FoundationPass');
            const nft = await FoundationPass.deploy(ethers.parseEther('0.1'), '');
            await nft.waitForDeployment();

            await pool.connect(owner).setFoundationPassContract(await nft.getAddress());
            expect(await pool.foundationPassContract()).to.equal(await nft.getAddress());
        });

        it('non-admin cannot set foundation pass contract', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await expect(
                pool.connect(alice).setFoundationPassContract(alice.address),
            ).to.be.revertedWithCustomError(pool, 'Unauthorized');
        });

        it('reverts when setting zero address', async function () {
            const { pool, owner } = await loadFixture(deployFixture);
            await expect(
                pool.connect(owner).setFoundationPassContract(ethers.ZeroAddress),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'ZeroAddress');
        });
    });

    describe('V2: Referral registration', function () {
        it('referrer is set on first buyEntries with referrer', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            const price = await pool.entryPrice();

            await expect(
                pool.connect(alice).buyEntries(
                    [t.whites], [t.goldNum], [t.goldPos], bob.address,
                    { value: price },
                ),
            ).to.emit(pool, 'ReferrerRegistered').withArgs(alice.address, bob.address);
        });

        it('self-referral reverts', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            const price = await pool.entryPrice();

            await expect(
                pool.connect(alice).buyEntries(
                    [t.whites], [t.goldNum], [t.goldPos], alice.address,
                    { value: price },
                ),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'SelfReferral');
        });

        it('referrer is permanent — cannot be changed', async function () {
            const { pool, alice, bob, charlie } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            const price = await pool.entryPrice();

            // Set Bob as referrer
            await pool.connect(alice).buyEntries(
                [t.whites], [t.goldNum], [t.goldPos], bob.address,
                { value: price },
            );

            // Try to set Charlie — should NOT emit ReferrerRegistered (referrer stays Bob)
            const t2 = makeEntry([2, 3, 4, 5, 6], 11, 1);
            const price2 = await pool.entryPrice();
            await expect(
                pool.connect(alice).buyEntries(
                    [t2.whites], [t2.goldNum], [t2.goldPos], charlie.address,
                    { value: price2 },
                ),
            ).to.not.emit(pool, 'ReferrerRegistered');
        });

        it('ZeroAddress referrer does not register', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);

            await expect(buyEntries(pool, alice, [t]))
                .to.not.emit(pool, 'ReferrerRegistered');
        });
    });

    describe('V2: Fee split without referrer', function () {
        it('10% goes to nftRevenuePool, 10% to ownerFees, 0% to referral', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, alice, [t]);

            const price = MIN_ENTRY_PRICE;  // first entry on empty pool
            // First entry: early bird half price
            const totalCost = price / 2n;
            const nftShare = (totalCost * 1000n) / 10000n;    // 10% NFT
            const adminShare = (totalCost * 600n) / 10000n;   // 6% owner when no referrer          // 10% of totalCost

            expect(await pool.nftRevenuePool()).to.equal(nftShare);
            expect(await pool.nftTotalDistributed()).to.equal(nftShare);
            expect(await pool.ownerFees()).to.equal(adminShare);
            expect(await pool.referralEarnings(alice.address)).to.equal(0n);
        });
    });

    describe('V2: Fee split with referrer', function () {
        it('10% NFT, 7% admin, 3% referral when referrer is set', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            const price = await pool.entryPrice();

            // Alice buys with Bob as referrer
            await pool.connect(alice).buyEntries(
                [t.whites], [t.goldNum], [t.goldPos], bob.address,
                { value: price },
            );

            // Early bird: first entry costs price/2 regardless of msg.value
            const totalCost = price / 2n;
            const nftShare = (totalCost * 1000n) / 10000n;    // 10% NFT
            const refShare = (totalCost * 300n) / 10000n;     // 3% referral
            const adminShare = (totalCost * 300n) / 10000n;   // 3% owner (no extra since referrer set)

            expect(await pool.nftRevenuePool()).to.equal(nftShare);
            expect(await pool.ownerFees()).to.equal(adminShare);
            expect(await pool.referralEarnings(bob.address)).to.equal(refShare);
        });

        it('ReferralEarned event is emitted with correct amounts', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            const price = await pool.entryPrice();

            // Early bird: first entry costs price/2; fees computed on totalCost = price/2
            const refShare = (price / 2n * 300n) / 10000n; // 3% of actualCost

            await expect(
                pool.connect(alice).buyEntries(
                    [t.whites], [t.goldNum], [t.goldPos], bob.address,
                    { value: price },
                ),
            ).to.emit(pool, 'ReferralEarned').withArgs(bob.address, alice.address, refShare);
        });
    });

    describe('V2: claimReferralEarnings', function () {
        it('referrer can claim accumulated earnings', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            const price = await pool.entryPrice();

            // Alice buys with Bob as referrer
            await pool.connect(alice).buyEntries(
                [t.whites], [t.goldNum], [t.goldPos], bob.address,
                { value: price },
            );

            // Early bird: first entry totalCost = price/2
            const refShare = (price / 2n * 300n) / 10000n;
            expect(await pool.referralEarnings(bob.address)).to.equal(refShare);

            const balBefore = await ethers.provider.getBalance(bob.address);
            const tx = await pool.connect(bob).claimReferralEarnings();
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(bob.address);

            expect(balAfter - balBefore + gasCost).to.equal(refShare);
            expect(await pool.referralEarnings(bob.address)).to.equal(0n);
        });

        it('emits ReferralEarningsClaimed event', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            const price = await pool.entryPrice();

            await pool.connect(alice).buyEntries(
                [t.whites], [t.goldNum], [t.goldPos], bob.address,
                { value: price },
            );

            // Early bird: first entry actual cost = price/2
            const refShare = (price / 2n * 300n) / 10000n;
            await expect(pool.connect(bob).claimReferralEarnings())
                .to.emit(pool, 'ReferralEarningsClaimed')
                .withArgs(bob.address, refShare);
        });

        it('reverts when no earnings to claim', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await expect(
                pool.connect(alice).claimReferralEarnings(),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'NothingToClaim');
        });
    });

    describe('V2: claimNFTRevenue', function () {
        async function deployWithNFTFixture() {
            const base = await deployFixture();
            const { pool, owner, alice, bob } = base;

            // Deploy FoundationPass and mint token 0 to alice
            const FoundationPass = await ethers.getContractFactory('FoundationPass');
            const nft = await FoundationPass.deploy(ethers.parseEther('0.1'), '');
            await nft.waitForDeployment();

            await nft.connect(owner).adminMint(alice.address); // tokenId 0

            // Wire NFT contract to pool
            await pool.connect(owner).setFoundationPassContract(await nft.getAddress());

            return { ...base, nft };
        }

        it('NFT holder can claim 1/10 of revenue pool', async function () {
            const { pool, nft, alice, bob } = await loadFixture(deployWithNFTFixture);

            // Buy some entries to generate NFT revenue
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, bob, [t]);

            const price = MIN_ENTRY_PRICE;
            // Early bird: first entry totalCost = price/2; NFT revenue is 10% of totalCost
            const nftShare = (price / 2n * 1000n) / 10000n;
            const perToken = nftShare / 10n;

            expect(await pool.getClaimableNFTRevenue(0)).to.equal(perToken);

            const balBefore = await ethers.provider.getBalance(alice.address);
            const tx = await pool.connect(alice).claimNFTRevenue(0);
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(alice.address);

            expect(balAfter - balBefore + gasCost).to.equal(perToken);
        });

        it('emits NFTRevenueClaimed event', async function () {
            const { pool, nft, alice, bob } = await loadFixture(deployWithNFTFixture);

            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, bob, [t]);

            const price = MIN_ENTRY_PRICE;
            // Early bird: first entry totalCost = price/2; NFT revenue is 10% of totalCost
            const nftShare = (price / 2n * 1000n) / 10000n;
            const perToken = nftShare / 10n;

            await expect(pool.connect(alice).claimNFTRevenue(0))
                .to.emit(pool, 'NFTRevenueClaimed')
                .withArgs(0, alice.address, perToken);
        });

        it('non-owner of NFT cannot claim', async function () {
            const { pool, nft, bob } = await loadFixture(deployWithNFTFixture);

            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, bob, [t]);

            // Bob doesn't own token 0
            await expect(
                pool.connect(bob).claimNFTRevenue(0),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'NotNFTOwner');
        });

        it('reverts when no revenue to claim', async function () {
            const { pool, alice } = await loadFixture(deployWithNFTFixture);

            // No entries bought, no revenue
            await expect(
                pool.connect(alice).claimNFTRevenue(0),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'NoNFTRevenue');
        });

        it('reverts when foundationPassContract not set', async function () {
            const { pool, alice } = await loadFixture(deployFixture);

            await expect(
                pool.connect(alice).claimNFTRevenue(0),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'ZeroAddress');
        });

        it('double claim reverts (no new revenue)', async function () {
            const { pool, nft, alice, bob } = await loadFixture(deployWithNFTFixture);

            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, bob, [t]);

            // First claim succeeds
            await pool.connect(alice).claimNFTRevenue(0);

            // Second claim with no new revenue reverts
            await expect(
                pool.connect(alice).claimNFTRevenue(0),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'NoNFTRevenue');
        });

        it('revenue accumulates across multiple entry purchases', async function () {
            const { pool, nft, alice, bob } = await loadFixture(deployWithNFTFixture);

            const t1 = makeEntry([1, 2, 3, 4, 5], 10, 0);
            const t2 = makeEntry([2, 3, 4, 5, 6], 11, 1);
            const price = await pool.entryPrice();

            // Two separate purchases
            await buyEntries(pool, bob, [t1]);
            await buyEntries(pool, bob, [t2]);

            const nftPool = await pool.nftRevenuePool();
            const claimable = await pool.getClaimableNFTRevenue(0);
            expect(claimable).to.equal(nftPool / 10n);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    //  V2: FoundationPass Super Pool Prize
    // ═══════════════════════════════════════════════════════════════

    describe('FoundationPass Super Pool Prize', function () {
        async function deployWithSuperPoolFixture() {
            const base = await deployFixture();
            const { pool, owner } = base;

            const FoundationPass = await ethers.getContractFactory('FoundationPass');
            const nft = await FoundationPass.deploy(ethers.parseEther('0.1'), '');
            await nft.waitForDeployment();
            const nftAddr = await nft.getAddress();

            // Wire both sides
            await pool.connect(owner).setFoundationPassContract(nftAddr);
            await nft.connect(owner).setPoolContract(await pool.getAddress());

            return { ...base, nft };
        }

        it('should auto-mint FoundationPass to first super pool winner', async function () {
            const { pool, mockVRF, alice, nft } = await loadFixture(deployWithSuperPoolFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);
            await buyEntries(pool, alice, [makeEntry(whites, goldNum, goldPos)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await pool.settleRound();

            // Alice should own tokenId 0
            expect(await nft.ownerOf(0)).to.equal(alice.address);
            expect(await nft.totalMinted()).to.equal(1);
        });

        it('should emit FoundationPassAwarded event on first super pool', async function () {
            const { pool, mockVRF, alice, nft } = await loadFixture(deployWithSuperPoolFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);
            await buyEntries(pool, alice, [makeEntry(whites, goldNum, goldPos)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);

            // FoundationPassAwarded event is emitted directly by the FoundationPass contract
            await expect(pool.settleRound())
                .to.emit(nft, 'FoundationPassAwarded')
                .withArgs(0, alice.address);
        });

        it('should only mint once (foundationPassAwarded flag prevents second mint)', async function () {
            const { pool, mockVRF, alice, bob, nft, hypePoolMathLib } = await loadFixture(deployWithSuperPoolFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);

            // Round 1: alice wins super pool → gets NFT
            await buyEntries(pool, alice, [makeEntry(whites, goldNum, goldPos)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await pool.settleRound();
            expect(await nft.totalMinted()).to.equal(1);

            // Round 2: bob also hits super pool → no second NFT mint
            const { whites: w2, goldNum: gn2, goldPos: gp2 } = generateDrawnNumbers(DETERMINISTIC_SEED);
            await buyEntries(pool, bob, [makeEntry(w2, gn2, gp2)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 2, DETERMINISTIC_SEED);

            // Should NOT emit FoundationPassWon again
            await expect(pool.settleRound())
                .to.not.emit(hypePoolMathLib, 'FoundationPassWon');

            // Still only 1 NFT minted
            expect(await nft.totalMinted()).to.equal(1);
        });

        it('should not revert settlement if FoundationPass supply is exhausted', async function () {
            const { pool, mockVRF, alice, owner, nft } = await loadFixture(deployWithSuperPoolFixture);

            // Mint all 10 via adminMint to owner
            for (let i = 0; i < 10; i++) {
                await nft.connect(owner).adminMint(owner.address);
            }
            expect(await nft.totalMinted()).to.equal(10);

            // Super pool winner — settlement should succeed silently
            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);
            await buyEntries(pool, alice, [makeEntry(whites, goldNum, goldPos)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);

            // Should not revert
            await expect(pool.settleRound()).to.not.be.reverted;

            // No extra NFTs minted
            expect(await nft.totalMinted()).to.equal(10);
        });

        it('poolMint reverts when called by non-pool address', async function () {
            const { nft, alice } = await loadFixture(deployWithSuperPoolFixture);
            await expect(
                nft.connect(alice).poolMint(alice.address),
            ).to.be.revertedWithCustomError(nft, 'OnlyPool');
        });

        it('setPoolContract only callable by owner', async function () {
            const { nft, alice } = await loadFixture(deployWithSuperPoolFixture);
            await expect(
                nft.connect(alice).setPoolContract(alice.address),
            ).to.be.revertedWithCustomError(nft, 'OwnableUnauthorizedAccount');
        });

        it('poolMint reverts with AlreadyMintedOut if supply exhausted', async function () {
            const { nft, owner } = await loadFixture(deployWithSuperPoolFixture);
            // Temporarily point poolContract to owner so we can call poolMint directly
            await nft.connect(owner).setPoolContract(owner.address);
            for (let i = 0; i < 10; i++) {
                await nft.connect(owner).poolMint(owner.address);
            }
            await expect(
                nft.connect(owner).poolMint(owner.address),
            ).to.be.revertedWithCustomError(nft, 'AlreadyMintedOut');
        });

        it('foundationPassAwarded flag prevents mint in subsequent rounds (explicit flag check)', async function () {
            const { pool, mockVRF, alice, bob, nft } = await loadFixture(deployWithSuperPoolFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);

            // Round 1: alice wins super pool → foundationPassAwarded becomes true internally
            await buyEntries(pool, alice, [makeEntry(whites, goldNum, goldPos)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await pool.settleRound();

            // Verify the flag is set by reading storage directly (slot BASE+30)
            const baseSlot = BigInt(ethers.keccak256(ethers.toUtf8Bytes('hypepool.v1.main.storage')));
            const flagRaw = await ethers.provider.getStorage(await pool.getAddress(), baseSlot + 30n);
            expect(flagRaw).to.not.equal(ethers.ZeroHash); // foundationPassAwarded == true
            expect(await nft.totalMinted()).to.equal(1);

            // Round 2: bob also hits super pool → flag is still true, no second mint
            const { whites: whites2, goldNum: goldNum2, goldPos: goldPos2 } = generateDrawnNumbers(DETERMINISTIC_SEED);
            await buyEntries(pool, bob, [makeEntry(whites2, goldNum2, goldPos2)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 2, DETERMINISTIC_SEED);
            await pool.settleRound();

            const flagRaw2 = await ethers.provider.getStorage(await pool.getAddress(), baseSlot + 30n);
            expect(flagRaw2).to.not.equal(ethers.ZeroHash); // still true
            expect(await nft.totalMinted()).to.equal(1);
        });

        it('FoundationPass is awarded when settlement uses settleRoundBatch path', async function () {
            const { pool, mockVRF, alice, nft } = await loadFixture(deployWithSuperPoolFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);
            await buyEntries(pool, alice, [makeEntry(whites, goldNum, goldPos)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);

            // Use batch settlement path instead of settleRound()
            await pool.settleRoundBatch();

            expect(await nft.totalMinted()).to.equal(1);
            expect(await nft.ownerOf(0)).to.equal(alice.address);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    //  V2: FoundationPass mint → seedPrizePool forwarding
    // ═══════════════════════════════════════════════════════════════

    describe('V2: FoundationPass mint → seedPrizePool', function () {
        async function deployMintSeedFixture() {
            const base = await deployFixture();
            const { pool, owner, alice, bob } = base;
            const mintPrice = ethers.parseEther('1');
            const FoundationPass = await ethers.getContractFactory('FoundationPass');
            const nft = await FoundationPass.deploy(mintPrice, '');
            await nft.waitForDeployment();
            await nft.connect(owner).setMintableSupply(10);
            // Wire both sides
            await nft.connect(owner).setPoolContract(await pool.getAddress());
            await pool.connect(owner).setFoundationPassContract(await nft.getAddress());
            return { ...base, nft, mintPrice };
        }

        it('FoundationPass mint forwards HYPE to pool prize pool', async function () {
            const { pool, nft, alice, mintPrice } = await loadFixture(deployMintSeedFixture);
            const infoBefore = await pool.getRoundInfo(1);

            await nft.connect(alice).mint({ value: mintPrice });

            const infoAfter = await pool.getRoundInfo(1);
            expect(infoAfter.prizePool - infoBefore.prizePool).to.equal(mintPrice);
        });

        it('FoundationPass mint reverts if poolContract not set', async function () {
            const { owner, alice } = await loadFixture(deployMintSeedFixture);
            const mintPrice = ethers.parseEther('1');
            const FoundationPass = await ethers.getContractFactory('FoundationPass');
            const nftNoPool = await FoundationPass.deploy(mintPrice, '');
            await nftNoPool.waitForDeployment();
            await nftNoPool.connect(owner).setMintableSupply(10);
            // poolContract is address(0) — mint must revert
            await expect(
                nftNoPool.connect(alice).mint({ value: mintPrice }),
            ).to.be.reverted;
        });

        it('multiple mints accumulate in prize pool', async function () {
            const { pool, nft, alice, bob, mintPrice } = await loadFixture(deployMintSeedFixture);
            const infoBefore = await pool.getRoundInfo(1);

            await nft.connect(alice).mint({ value: mintPrice });
            await nft.connect(bob).mint({ value: mintPrice });

            const infoAfter = await pool.getRoundInfo(1);
            expect(infoAfter.prizePool - infoBefore.prizePool).to.equal(mintPrice * 2n);
        });

        it('seedPrizePool callable by admin', async function () {
            const { pool } = await loadFixture(deployMintSeedFixture);
            const infoBefore = await pool.getRoundInfo(1);
            const amount = ethers.parseEther('5');

            await pool.seedPrizePool({ value: amount });

            const infoAfter = await pool.getRoundInfo(1);
            expect(infoAfter.prizePool - infoBefore.prizePool).to.equal(amount);
        });

        it('seedPrizePool callable by foundationPassContract', async function () {
            const { pool, nft, alice, mintPrice } = await loadFixture(deployMintSeedFixture);
            // Minting triggers seedPrizePool from the FoundationPass contract address,
            // which is set as foundationPassContract on the pool
            const infoBefore = await pool.getRoundInfo(1);

            await nft.connect(alice).mint({ value: mintPrice });

            const infoAfter = await pool.getRoundInfo(1);
            expect(infoAfter.prizePool - infoBefore.prizePool).to.equal(mintPrice);
            expect(await nft.totalMinted()).to.equal(1);
        });

        it('seedPrizePool reverts for unauthorized callers', async function () {
            const { pool, alice } = await loadFixture(deployMintSeedFixture);

            await expect(
                pool.connect(alice).seedPrizePool({ value: ethers.parseEther('1') }),
            ).to.be.revertedWithCustomError(pool, 'Unauthorized');
        });
    });

    // ═══════════════════════════════════════════════════════════════
    //  V2: claimNFTRevenue multi-round accumulation
    // ═══════════════════════════════════════════════════════════════

    describe('V2: claimNFTRevenue multi-round accumulation', function () {
        async function deployWithNFTMultiRoundFixture() {
            const base = await deployFixture();
            const { pool, owner, alice } = base;

            const FoundationPass = await ethers.getContractFactory('FoundationPass');
            const nft = await FoundationPass.deploy(ethers.parseEther('0.1'), '');
            await nft.waitForDeployment();

            await nft.connect(owner).adminMint(alice.address); // tokenId 0

            await pool.connect(owner).setFoundationPassContract(await nft.getAddress());

            return { ...base, nft };
        }

        it('NFT revenue accumulates correctly across multiple rounds', async function () {
            const { pool, mockVRF, alice, bob, nft } = await loadFixture(deployWithNFTMultiRoundFixture);

            // Round 1: buy entries and complete the round with no winners
            const t1 = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, bob, [t1]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            // Round 2: buy entries and complete the round with no winners
            const t2 = makeEntry([2, 3, 4, 5, 6], 11, 1);
            await buyEntries(pool, bob, [t2]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 2, NON_MATCHING_SEED);
            await pool.settleRound();

            // Total nftTotalDistributed includes revenue from both rounds
            const totalDistributed = await pool.nftTotalDistributed();
            const perToken = totalDistributed / 10n;

            expect(await pool.getClaimableNFTRevenue(0)).to.equal(perToken);

            // Alice claims and should receive the full accumulated amount
            const balBefore = await ethers.provider.getBalance(alice.address);
            const tx = await pool.connect(alice).claimNFTRevenue(0);
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(alice.address);

            expect(balAfter - balBefore + gasCost).to.equal(perToken);
            expect(await pool.getClaimableNFTRevenue(0)).to.equal(0n);
        });

        it('claim between rounds: partial claim then new revenue', async function () {
            const { pool, mockVRF, alice, bob, nft } = await loadFixture(deployWithNFTMultiRoundFixture);

            // Round 1: buy entries to generate revenue
            const t1 = makeEntry([1, 2, 3, 4, 5], 10, 0);
            await buyEntries(pool, bob, [t1]);
            const distributed1 = await pool.nftTotalDistributed();
            const perToken1 = distributed1 / 10n;

            // Alice claims her share from round 1 revenue
            await pool.connect(alice).claimNFTRevenue(0);
            expect(await pool.getClaimableNFTRevenue(0)).to.equal(0n);

            // Complete round 1
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            // Round 2: buy entries to generate new revenue
            const t2 = makeEntry([2, 3, 4, 5, 6], 11, 1);
            await buyEntries(pool, bob, [t2]);

            // Only round 2's share should be claimable now
            const distributed2 = await pool.nftTotalDistributed();
            const perToken2 = distributed2 / 10n;
            const expectedClaimable = perToken2 - perToken1;

            expect(await pool.getClaimableNFTRevenue(0)).to.equal(expectedClaimable);

            // Alice claims again and gets only the new revenue
            const balBefore = await ethers.provider.getBalance(alice.address);
            const tx = await pool.connect(alice).claimNFTRevenue(0);
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(alice.address);

            expect(balAfter - balBefore + gasCost).to.equal(expectedClaimable);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    //  V2: Fee split with free entry credits
    // ═══════════════════════════════════════════════════════════════

    describe('V2: Fee split with free entry credits', function () {
        // Helper: buy one entry as alice, advance time past UPKEEP_INTERVAL + DRAW_GRACE,
        // call triggerPublicDraw as bob (awarding him 2 free entry credits), then fulfill
        // and settle round 1 so we enter round 2 with bob holding 2 free credits.
        async function setupFreeCredits(pool, mockVRF, alice, bob) {
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await time.increase(Number(UPKEEP_INTERVAL) + Number(DRAW_GRACE));
            await pool.connect(bob).triggerPublicDraw();
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();
        }

        it('fee split is correct when all entries are free (0 paid)', async function () {
            const { pool, mockVRF, alice, bob } = await loadFixture(deployFixture);

            await setupFreeCredits(pool, mockVRF, alice, bob);

            // Bob has 2 free credits; note pools and fees before buying
            expect(await pool.freeEntryCredits(bob.address)).to.equal(2n);
            const nftPoolBefore = await pool.nftRevenuePool();
            const ownerFeesBefore = await pool.ownerFees();
            const refEarningsBefore = await pool.referralEarnings(bob.address);

            // Round 2: bob buys exactly 2 entries with 0 ETH (all free)
            await buyEntries(pool, bob, [
                makeEntry([1, 2, 3, 4, 5], 10, 0),
                makeEntry([2, 3, 4, 5, 6], 11, 1),
            ], 0n);

            // No new fees since totalCost == 0
            expect(await pool.nftRevenuePool()).to.equal(nftPoolBefore);
            expect(await pool.ownerFees()).to.equal(ownerFeesBefore);
            expect(await pool.referralEarnings(bob.address)).to.equal(refEarningsBefore);

            // Entries are still registered
            expect(await pool.playerEntryCount(2, bob.address)).to.equal(2n);
        });

        it('fee split is correct when mixing free credits and paid entries', async function () {
            const { pool, mockVRF, alice, bob } = await loadFixture(deployFixture);

            await setupFreeCredits(pool, mockVRF, alice, bob);

            // Bob has 2 free credits; buys 3 entries paying for only 1
            const price = await pool.entryPrice();

            const nftPoolBefore = await pool.nftRevenuePool();
            const ownerFeesBefore = await pool.ownerFees();

            await pool.connect(bob).buyEntries(
                [[1, 2, 3, 4, 5], [2, 3, 4, 5, 6], [3, 4, 5, 6, 7]],
                [10, 11, 12], [0, 1, 2],
                ethers.ZeroAddress, { value: price },
            );

            // Fee split is computed only on the 1 paid entry's actual cost
            // First paid entry in round 2 gets early bird: totalCost = price/2
            const totalCost = price / 2n;
            const nftShare = (totalCost * 1000n) / 10000n;
            const adminShare = (totalCost * 600n) / 10000n; // 6% owner no referrer

            expect(await pool.nftRevenuePool()).to.equal(nftPoolBefore + nftShare);
            expect(await pool.ownerFees()).to.equal(ownerFeesBefore + adminShare);
        });

        it('fee split with free credits AND a referrer', async function () {
            const { pool, mockVRF, alice, bob, charlie } = await loadFixture(deployFixture);

            await setupFreeCredits(pool, mockVRF, alice, bob);

            // Bob has 2 free credits; buys 3 entries with charlie as referrer, pays for 1
            const price = await pool.entryPrice();

            const refEarningsBefore = await pool.referralEarnings(charlie.address);
            const nftPoolBefore = await pool.nftRevenuePool();
            const ownerFeesBefore = await pool.ownerFees();

            await pool.connect(bob).buyEntries(
                [[1, 2, 3, 4, 5], [2, 3, 4, 5, 6], [3, 4, 5, 6, 7]],
                [10, 11, 12], [0, 1, 2],
                charlie.address, { value: price },
            );

            // Fee split on 1 paid entry only; first paid entry in round 2 = early bird price/2
            const totalCost = price / 2n;
            const nftShare = (totalCost * 1000n) / 10000n;    // 10% NFT
            const refShare = (totalCost * 300n) / 10000n;     // 3% referral
            const adminShare = (totalCost * 300n) / 10000n;   // 3% owner (referrer set, no double)

            expect(await pool.referralEarnings(charlie.address)).to.equal(refEarningsBefore + refShare);
            expect(await pool.nftRevenuePool()).to.equal(nftPoolBefore + nftShare);
            expect(await pool.ownerFees()).to.equal(ownerFeesBefore + adminShare);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    //  V2: Referral persistence across rounds
    // ═══════════════════════════════════════════════════════════════

    describe('V2: Referral persistence across rounds', function () {
        it('referrer earns commission in round 2 after being set in round 1', async function () {
            const { pool, mockVRF, alice, bob } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            const price1 = await pool.entryPrice();

            // Round 1: Alice sets Bob as referrer
            await pool.connect(alice).buyEntries(
                [t.whites], [t.goldNum], [t.goldPos], bob.address,
                { value: price1 },
            );
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            const earningsAfterR1 = await pool.referralEarnings(bob.address);

            // Round 2: Alice buys more entries (no referrer param — doesn't matter, referrer is permanent)
            const price2 = await pool.entryPrice();
            await buyEntries(pool, alice, [makeEntry([2, 3, 4, 5, 6], 11, 1)]);

            // Round 2: first entry also gets early bird (totalCost = price2/2)
            const expectedRefShare = (price2 / 2n * 300n) / 10000n;
            expect(await pool.referralEarnings(bob.address)).to.equal(earningsAfterR1 + expectedRefShare);
        });

        it('referrer accumulates earnings across multiple rounds before claiming', async function () {
            const { pool, mockVRF, alice, bob } = await loadFixture(deployFixture);
            const t = makeEntry([1, 2, 3, 4, 5], 10, 0);
            const price1 = await pool.entryPrice();

            // Round 1: Alice buys with Bob as referrer
            await pool.connect(alice).buyEntries(
                [t.whites], [t.goldNum], [t.goldPos], bob.address,
                { value: price1 },
            );
            // Early bird: first entry in each round costs half price
            const refShare1 = (price1 / 2n * 300n) / 10000n;

            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            // Round 2: Alice buys again (Bob's referrer persists automatically)
            const price2 = await pool.entryPrice();
            await buyEntries(pool, alice, [makeEntry([2, 3, 4, 5, 6], 11, 1)]);
            const refShare2 = (price2 / 2n * 300n) / 10000n;

            // Bob's total earnings = round 1 + round 2
            expect(await pool.referralEarnings(bob.address)).to.equal(refShare1 + refShare2);

            // Bob claims once and gets the full accumulated amount
            const balBefore = await ethers.provider.getBalance(bob.address);
            const tx = await pool.connect(bob).claimReferralEarnings();
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(bob.address);

            expect(balAfter - balBefore + gasCost).to.equal(refShare1 + refShare2);
            expect(await pool.referralEarnings(bob.address)).to.equal(0n);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    //  V2: pendingPayouts fallback on failed ETH transfer
    // ═══════════════════════════════════════════════════════════════

    describe('V2: pendingPayouts fallback on failed ETH transfer', function () {
        async function deployWithNFTAndRejectETHFixture() {
            const base = await deployFixture();
            const { pool, owner } = base;

            const FoundationPass = await ethers.getContractFactory('FoundationPass');
            const nft = await FoundationPass.deploy(ethers.parseEther('0.1'), '');
            await nft.waitForDeployment();

            const RejectETH = await ethers.getContractFactory('RejectETH');
            const rejecter = await RejectETH.deploy();
            await rejecter.waitForDeployment();

            // Mint token 0 to the ETH-rejecting contract
            await nft.connect(owner).adminMint(await rejecter.getAddress());

            await pool.connect(owner).setFoundationPassContract(await nft.getAddress());

            return { ...base, nft, rejecter };
        }

        it('claimNFTRevenue falls back to pendingPayouts when transfer fails', async function () {
            const { pool, rejecter, bob } = await loadFixture(deployWithNFTAndRejectETHFixture);

            // Generate NFT revenue by buying a entry
            await buyEntries(pool, bob, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);

            const claimable = await pool.getClaimableNFTRevenue(0);
            expect(claimable).to.be.gt(0n);

            const pendingBefore = await pool.pendingPayouts(await rejecter.getAddress());

            // The rejecting contract calls claimNFTRevenue — transfer fails, should not revert
            await rejecter.callClaimNFTRevenue(await pool.getAddress(), 0);

            // pendingPayouts should have increased by the claimable amount
            expect(await pool.pendingPayouts(await rejecter.getAddress()))
                .to.equal(pendingBefore + claimable);

            // Revenue is no longer claimable
            expect(await pool.getClaimableNFTRevenue(0)).to.equal(0n);
        });

        it('claimReferralEarnings falls back to pendingPayouts when transfer fails', async function () {
            const { pool, rejecter, alice } = await loadFixture(deployWithNFTAndRejectETHFixture);

            // Register the ETH-rejecting contract as referrer and generate earnings
            await pool.connect(alice).buyEntries(
                [[1, 2, 3, 4, 5]], [10], [0],
                await rejecter.getAddress(),
                { value: MIN_ENTRY_PRICE },
            );

            const earnings = await pool.referralEarnings(await rejecter.getAddress());
            expect(earnings).to.be.gt(0n);

            const pendingBefore = await pool.pendingPayouts(await rejecter.getAddress());

            // The rejecting contract calls claimReferralEarnings — transfer fails, should not revert
            await rejecter.callClaimReferralEarnings(await pool.getAddress());

            // pendingPayouts should have increased by the earnings amount
            expect(await pool.pendingPayouts(await rejecter.getAddress()))
                .to.equal(pendingBefore + earnings);

            // Referral earnings are cleared
            expect(await pool.referralEarnings(await rejecter.getAddress())).to.equal(0n);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    //  V2: End-to-end integration
    // ═══════════════════════════════════════════════════════════════

    describe('V2: End-to-end integration', function () {
        async function deployWithSuperPoolAndNFTFixture() {
            const base = await deployFixture();
            const { pool, owner, charlie } = base;

            const FoundationPass = await ethers.getContractFactory('FoundationPass');
            const nft = await FoundationPass.deploy(ethers.parseEther('0.1'), '');
            await nft.waitForDeployment();

            // Mint token 0 to charlie (the NFT revenue recipient)
            await nft.connect(owner).adminMint(charlie.address);

            // Wire both sides
            await pool.connect(owner).setFoundationPassContract(await nft.getAddress());
            await nft.connect(owner).setPoolContract(await pool.getAddress());

            return { ...base, nft };
        }

        it('full V2 flow: referral + NFT revenue + super pool prize + claim', async function () {
            const { pool, mockVRF, alice, bob, charlie, nft, owner } = await loadFixture(deployWithSuperPoolAndNFTFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);
            const price = await pool.entryPrice();

            // Alice buys the winning entry with Bob as referrer
            await pool.connect(alice).buyEntries(
                [whites], [goldNum], [goldPos], bob.address,
                { value: price },
            );

            // Complete the round using the deterministic seed so Alice wins
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await pool.settleRound();

            // ── Referral: Bob should have 3% of actual cost (early bird: price/2) ──
            const expectedRefShare = (price / 2n * 300n) / 10000n;
            expect(await pool.referralEarnings(bob.address)).to.equal(expectedRefShare);

            // ── NFT revenue: charlie (token 0 holder) should have 1/10 of nftTotalDistributed ──
            const totalDistributed = await pool.nftTotalDistributed();
            const expectedNFTShare = totalDistributed / 10n;
            expect(await pool.getClaimableNFTRevenue(0)).to.equal(expectedNFTShare);

            // ── Prize: Alice should have prize pool + super pool ──
            const roundInfo = await pool.getRoundInfo(1);
            expect(roundInfo.prizePoolWinners).to.equal(1);
            expect(roundInfo.superWinners).to.equal(1);

            const contractBalBefore = await ethers.provider.getBalance(await pool.getAddress());

            // Bob claims referral earnings
            await pool.connect(bob).claimReferralEarnings();
            expect(await pool.referralEarnings(bob.address)).to.equal(0n);

            // Charlie claims NFT revenue
            await pool.connect(charlie).claimNFTRevenue(0);
            expect(await pool.getClaimableNFTRevenue(0)).to.equal(0n);

            // Alice claims her prize
            const alicePrize = await pool.getClaimableAmount(1, alice.address);
            expect(alicePrize).to.be.gt(0n);
            await pool.connect(alice).claimPrize(1, 0);

            // Contract balance should have decreased by claimed amounts
            const contractBalAfter = await ethers.provider.getBalance(await pool.getAddress());
            expect(contractBalAfter).to.be.lt(contractBalBefore);
        });

    // ===============================================================
    //  New V1 Features: Early Bird, Last Drop, Lucky Draw, Free Entry
    // ===============================================================

    describe('Early Bird pricing', function () {
        it('first 5 paid entries per round cost half price', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const price = await pool.entryPrice();
            const halfPrice = price / 2n;

            const ws = [[1,2,3,4,5],[1,2,3,4,5],[1,2,3,4,5],[1,2,3,4,5],[1,2,3,4,5]];
            const gn = [10,10,10,10,10];
            const gp = [0,0,0,0,0];
            await expect(
                pool.connect(alice).buyEntries(ws, gn, gp, ethers.ZeroAddress, { value: halfPrice * 5n })
            ).to.not.be.reverted;

            expect(await pool.playerEntryCount(1, alice.address)).to.equal(5n);
        });

        it('6th paid entry costs full price', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);
            const price = await pool.entryPrice();
            const halfPrice = price / 2n;

            const ws5 = [[1,2,3,4,5],[1,2,3,4,5],[1,2,3,4,5],[1,2,3,4,5],[1,2,3,4,5]];
            const gn5 = [10,10,10,10,10]; const gp5 = [0,0,0,0,0];
            await pool.connect(alice).buyEntries(ws5, gn5, gp5, ethers.ZeroAddress, { value: halfPrice * 5n });

            await expect(
                pool.connect(bob).buyEntries([[2,3,4,5,6]], [11], [1], ethers.ZeroAddress, { value: price })
            ).to.not.be.reverted;
        });

        it('6th paid entry reverts if only half price sent', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);
            const price = await pool.entryPrice();
            const halfPrice = price / 2n;

            const ws5 = [[1,2,3,4,5],[1,2,3,4,5],[1,2,3,4,5],[1,2,3,4,5],[1,2,3,4,5]];
            const gn5 = [10,10,10,10,10]; const gp5 = [0,0,0,0,0];
            await pool.connect(alice).buyEntries(ws5, gn5, gp5, ethers.ZeroAddress, { value: halfPrice * 5n });

            await expect(
                pool.connect(bob).buyEntries([[2,3,4,5,6]], [11], [1], ethers.ZeroAddress, { value: halfPrice })
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'InsufficientPayment');
        });

        it('earlyBirdRemaining decreases as paid entries are bought', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            expect(await pool.earlyBirdRemaining(1)).to.equal(5n);

            const price = await pool.entryPrice();
            await pool.connect(alice).buyEntries([[1,2,3,4,5]], [10], [0], ethers.ZeroAddress, { value: price / 2n });

            expect(await pool.earlyBirdRemaining(1)).to.equal(4n);
        });

        it('earlyBirdRemaining returns 0 after 5 paid entries', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            const price = await pool.entryPrice();
            const ws5 = [[1,2,3,4,5],[1,2,3,4,5],[1,2,3,4,5],[1,2,3,4,5],[1,2,3,4,5]];
            await pool.connect(alice).buyEntries(ws5, [10,10,10,10,10], [0,0,0,0,0], ethers.ZeroAddress, { value: price / 2n * 5n });
            expect(await pool.earlyBirdRemaining(1)).to.equal(0n);
        });

        it('free entry credits do NOT consume early bird slots', async function () {
            const { pool, mockVRF, alice, bob } = await loadFixture(deployFixture);

            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await time.increase(Number(UPKEEP_INTERVAL) + Number(DRAW_GRACE));
            await pool.connect(bob).triggerPublicDraw();
            await mockVRF.fulfillRandomWords(1n, [NON_MATCHING_SEED]);
            await pool.settleRound();

            expect(await pool.freeEntryCredits(bob.address)).to.equal(2n);
            const remaining1 = await pool.earlyBirdRemaining(2);

            await pool.connect(bob).buyEntries(
                [[1,2,3,4,5],[2,3,4,5,6]], [10,11], [0,1],
                ethers.ZeroAddress, { value: 0n }
            );

            const remaining2 = await pool.earlyBirdRemaining(2);
            expect(remaining2).to.equal(remaining1);
        });

        it('EARLY_BIRD_LIMIT constant is 5', async function () {
            const { pool } = await loadFixture(deployFixture);
            expect(await pool.EARLY_BIRD_LIMIT()).to.equal(5n);
        });

        it('early bird resets in new round', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);
            const price = await pool.entryPrice();
            const ws5 = [[1,2,3,4,5],[1,2,3,4,5],[1,2,3,4,5],[1,2,3,4,5],[1,2,3,4,5]];
            await pool.connect(alice).buyEntries(ws5, [10,10,10,10,10], [0,0,0,0,0], ethers.ZeroAddress, { value: price / 2n * 5n });
            expect(await pool.earlyBirdRemaining(1)).to.equal(0n);

            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            expect(await pool.earlyBirdRemaining(2)).to.equal(5n);
        });
    });

    describe('Last Drop', function () {
        it('lastDropInfo shows not eligible when threshold not reached', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1,2,3,4,5], 10, 0)]);

            const info = await pool.lastDropInfo();
            expect(info.isEligible).to.equal(false);
            expect(info.threshold).to.equal(50n);
        });

        it('lastBuyer updates on each purchase', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1,2,3,4,5], 10, 0)]);
            await buyEntries(pool, bob, [makeEntry([2,3,4,5,6], 11, 1)]);

            const info = await pool.lastDropInfo();
            expect(info.lastBuyer).to.equal(bob.address);
        });

        it('claimLastDrop fails if threshold not reached', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1,2,3,4,5], 10, 0)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            await expect(
                pool.connect(alice).claimLastDrop(1),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'NoPrize');
        });

        it('LAST_DROP_THRESHOLD constant is 50', async function () {
            const { pool } = await loadFixture(deployFixture);
            expect(await pool.LAST_DROP_THRESHOLD()).to.equal(50n);
        });

        it('lastDropPool accumulates from mini prizes split (40% of 4%)', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1,2,3,4,5], 10, 0)]);

            const totalCost = MIN_ENTRY_PRICE / 2n;
            const miniAdd = (totalCost * 400n) / 10000n;
            const expectedLastDrop = (miniAdd * 40n) / 100n;

            const info = await pool.lastDropInfo();
            expect(info.lastDropPool).to.equal(expectedLastDrop);
        });
    });

    describe('Lucky Draw', function () {
        it('luckyDrawInfo after settlement shows winner', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1,2,3,4,5], 10, 0)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            const info = await pool.luckyDrawInfo(1);
            expect(info.winner).to.equal(alice.address);
            expect(info.prize).to.be.gt(0n);
            expect(info.claimed).to.equal(false);
        });

        it('claimLuckyDraw pays out the winner', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1,2,3,4,5], 10, 0)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            const info = await pool.luckyDrawInfo(1);
            const prize = info.prize;
            expect(prize).to.be.gt(0n);

            const balBefore = await ethers.provider.getBalance(alice.address);
            const tx = await pool.connect(alice).claimLuckyDraw(1);
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(alice.address);

            expect(balAfter - balBefore + gasCost).to.equal(prize);
        });

        it('claimLuckyDraw reverts for non-winner', async function () {
            const { pool, mockVRF, alice, bob } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1,2,3,4,5], 10, 0)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            await expect(
                pool.connect(bob).claimLuckyDraw(1),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'NotEntryOwner');
        });

        it('claimLuckyDraw reverts on double claim', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1,2,3,4,5], 10, 0)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            await pool.connect(alice).claimLuckyDraw(1);
            await expect(
                pool.connect(alice).claimLuckyDraw(1),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'AlreadyClaimed');
        });
    });

    describe('mintFreeEntry', function () {
        async function deployWithMinterFixture() {
            const base = await loadFixture(deployFixture);
            const { pool, owner, alice } = base;
            await pool.connect(owner).setFreeEntryMinter(alice.address);
            return { ...base, minter: alice };
        }

        it('setFreeEntryMinter can only be called by admin', async function () {
            const { pool, alice, bob } = await loadFixture(deployFixture);
            await expect(
                pool.connect(alice).setFreeEntryMinter(bob.address),
            ).to.be.revertedWithCustomError(pool, 'Unauthorized');
        });

        it('setFreeEntryMinter stores the address', async function () {
            const { pool, owner, alice } = await loadFixture(deployFixture);
            await pool.connect(owner).setFreeEntryMinter(alice.address);
            expect(await pool.getFreeEntryMinter()).to.equal(alice.address);
        });

        it('mintFreeEntry reverts if caller is not freeEntryMinter', async function () {
            const { pool, bob } = await deployWithMinterFixture();
            await expect(
                pool.connect(bob).mintFreeEntry(bob.address, [1,2,3,4,5], 10, 0),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'NotFreeEntryMinter');
        });

        it('mintFreeEntry mints entry for player at no cost', async function () {
            const { pool, minter, bob } = await deployWithMinterFixture();
            await expect(
                pool.connect(minter).mintFreeEntry(bob.address, [1,2,3,4,5], 10, 0),
            ).to.emit(pool, 'EntriesPurchased').withArgs(1n, bob.address, 1n);

            expect(await pool.playerEntryCount(1, bob.address)).to.equal(1n);
        });

        it('mintFreeEntry does NOT consume early bird slots', async function () {
            const { pool, minter, bob } = await deployWithMinterFixture();
            const earlyBirdBefore = await pool.earlyBirdRemaining(1);
            await pool.connect(minter).mintFreeEntry(bob.address, [1,2,3,4,5], 10, 0);
            expect(await pool.earlyBirdRemaining(1)).to.equal(earlyBirdBefore);
        });

        it('freeEntriesRemaining starts at 100', async function () {
            const { pool } = await loadFixture(deployFixture);
            expect(await pool.freeEntriesRemaining()).to.equal(100n);
        });

        it('freeEntriesRemaining decreases with each mintFreeEntry', async function () {
            const { pool, minter, bob } = await deployWithMinterFixture();
            await pool.connect(minter).mintFreeEntry(bob.address, [1,2,3,4,5], 10, 0);
            expect(await pool.freeEntriesRemaining()).to.equal(99n);
        });

        it('MAX_FREE_ENTRIES_PER_ROUND is 100', async function () {
            const { pool } = await loadFixture(deployFixture);
            expect(await pool.MAX_FREE_ENTRIES_PER_ROUND()).to.equal(100n);
        });

        it('mintFreeEntry reverts when MAX_FREE_ENTRIES_PER_ROUND reached', async function () {
            const { pool, minter } = await deployWithMinterFixture();
            // MAX_ENTRIES per address is 25, so we need 4+ unique addresses for 100 mints
            const signers = await ethers.getSigners();
            // Use 4 addresses x 25 = 100 mints
            const players = signers.slice(0, 4).map(s => s.address);
            for (let i = 0; i < 100; i++) {
                await pool.connect(minter).mintFreeEntry(players[i % 4], [1,2,3,4,5], 10, 0);
            }
            await expect(
                pool.connect(minter).mintFreeEntry(players[0], [1,2,3,4,5], 10, 0),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'MaxFreeEntriesReached');
        });

        it('freeEntriesThisRound resets after settlement', async function () {
            const { pool, mockVRF, minter, bob } = await deployWithMinterFixture();
            await pool.connect(minter).mintFreeEntry(bob.address, [1,2,3,4,5], 10, 0);
            await buyEntries(pool, bob, [makeEntry([2,3,4,5,6], 11, 1)]);
            expect(await pool.freeEntriesRemaining()).to.equal(99n);

            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            expect(await pool.freeEntriesRemaining()).to.equal(100n);
        });

        it('mintFreeEntry entry is eligible for lucky draw', async function () {
            const { pool, mockVRF, minter, alice, bob } = await deployWithMinterFixture();
            // Buy a paid entry first to seed the luckyDrawPool
            await buyEntries(pool, alice, [makeEntry([1,2,3,4,5], 10, 0)]);
            // Mint a free entry for bob
            await pool.connect(minter).mintFreeEntry(bob.address, [2,3,4,5,6], 11, 1);

            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            // Lucky draw winner should be alice or bob (both are eligible)
            const info = await pool.luckyDrawInfo(1);
            expect(info.winner).to.not.equal(ethers.ZeroAddress);
            expect([alice.address, bob.address]).to.include(info.winner);
        });

        it('mintFreeEntry updates lastBuyer', async function () {
            const { pool, minter, alice, bob } = await deployWithMinterFixture();
            await buyEntries(pool, alice, [makeEntry([1,2,3,4,5], 10, 0)]);
            expect((await pool.lastDropInfo()).lastBuyer).to.equal(alice.address);

            await pool.connect(minter).mintFreeEntry(bob.address, [2,3,4,5,6], 11, 1);
            expect((await pool.lastDropInfo()).lastBuyer).to.equal(bob.address);
        });
    });

    describe('New fee structure (50/30/10/4/3/3)', function () {
        it('NFT revenue pool receives 10% of actual cost', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1,2,3,4,5], 10, 0)]);
            const totalCost = MIN_ENTRY_PRICE / 2n;
            const expectedNFT = (totalCost * 1000n) / 10000n;
            expect(await pool.nftRevenuePool()).to.equal(expectedNFT);
        });

        it('lastDropPool receives 40% of 4% mini prizes', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1,2,3,4,5], 10, 0)]);
            const totalCost = MIN_ENTRY_PRICE / 2n;
            const miniAdd = (totalCost * 400n) / 10000n;
            const expectedLastDrop = (miniAdd * 40n) / 100n;
            expect((await pool.lastDropInfo()).lastDropPool).to.equal(expectedLastDrop);
        });

        it('all fee shares sum to totalCost', async function () {
            const { pool, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1,2,3,4,5], 10, 0)]);
            const totalCost = MIN_ENTRY_PRICE / 2n;
            const info = await pool.getRoundInfo(1);
            const prizePool = info.prizePool;
            const seed = info.seedPool;
            const nft = await pool.nftRevenuePool();
            const owner = await pool.ownerFees();
            const miniAdd = (totalCost * 400n) / 10000n;
            const lastDrop = (miniAdd * 40n) / 100n;
            const luckyDraw = (miniAdd * 60n) / 100n;
            const total = prizePool + seed + nft + owner + lastDrop + luckyDraw;
            expect(total).to.equal(totalCost);
        });
    });

    });

    describe('claimPendingPayout — positive balance', function () {
        it('claimPendingPayout pays out the stored amount and clears it', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);

            // Deploy RejectETH
            const RejectETH = await ethers.getContractFactory('RejectETH');
            const rejecter = await RejectETH.deploy();
            await rejecter.waitForDeployment();

            // Alice buys a entry
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);

            // Seed ownerFees so settle reward is non-zero
            const feesBefore = await pool.ownerFees();
            expect(feesBefore).to.be.gt(0n);

            // Register rejecter as alice's referrer via a entry purchase (while round is still OPEN)
            const price = await pool.entryPrice();
            await pool.connect(alice).buyEntries(
                [[2, 3, 4, 5, 6]], [11], [1],
                await rejecter.getAddress(),
                { value: price },
            );
            const earnings = await pool.referralEarnings(await rejecter.getAddress());
            expect(earnings).to.be.gt(0n);

            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);

            // Rejecter claims referral earnings → ETH rejected → pendingPayouts[rejecter] += earnings
            await rejecter.callClaimReferralEarnings(await pool.getAddress());
            const pending = await pool.pendingPayouts(await rejecter.getAddress());
            expect(pending).to.equal(earnings);

            // pendingPayouts is positive
            expect(pending).to.be.gt(0n);

            // claimPendingPayout reverts because rejecter still rejects ETH (TransferFailed)
            await expect(
                rejecter.callClaimPendingPayout(await pool.getAddress()),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'TransferFailed');

            // pendingPayouts should NOT have been cleared (tx reverted)
            expect(await pool.pendingPayouts(await rejecter.getAddress())).to.equal(earnings);
        });

        it('claimPendingPayout NothingToClaim fires for zero balance', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            // Alice is an EOA; settle reward went inline, so no pendingPayout for her
            expect(await pool.pendingPayouts(alice.address)).to.equal(0n);
            await expect(
                pool.connect(alice).claimPendingPayout(),
            ).to.be.revertedWithCustomError(hypePoolViewsLib, 'NothingToClaim');
        });
    });

    describe('mintFreeEntry state guard', function () {
        async function deployWithMinterFixtureInner() {
            const base = await loadFixture(deployFixture);
            const { pool, owner } = base;
            await pool.connect(owner).setFreeEntryMinter(owner.address);
            return { ...base, minter: owner };
        }

        it('mintFreeEntry reverts when round is DRAWING', async function () {
            const { pool, mockVRF, minter, alice } = await deployWithMinterFixtureInner();
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool); // state → DRAWING

            await expect(
                pool.connect(minter).mintFreeEntry(alice.address, [2, 3, 4, 5, 6], 11, 1),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'RoundNotOpen');
        });

        it('mintFreeEntry reverts when round is DRAWN', async function () {
            const { pool, mockVRF, minter, alice } = await deployWithMinterFixtureInner();
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED); // state → DRAWN

            await expect(
                pool.connect(minter).mintFreeEntry(alice.address, [2, 3, 4, 5, 6], 11, 1),
            ).to.be.revertedWithCustomError(hypePoolMathLib, 'RoundNotOpen');
        });

        it('mintFreeEntry succeeds after settlement when new round is OPEN', async function () {
            const { pool, mockVRF, minter, alice } = await deployWithMinterFixtureInner();
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound(); // state → SETTLED, currentRound advances to 2

            // Round 2 is OPEN now — minting into the new round should succeed
            await expect(
                pool.connect(minter).mintFreeEntry(alice.address, [2, 3, 4, 5, 6], 11, 1),
            ).to.not.be.reverted;
            expect(await pool.playerEntryCount(2, alice.address)).to.equal(1n);
        });
    });

    describe('ETH conservation invariant', function () {
        it('invariant: total ETH in contract equals outstanding prizes + pools + ownerFees after a full round with winner', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);
            await buyEntries(pool, alice, [makeEntry(whites, goldNum, goldPos)]);

            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await pool.settleRound();

            const contractBal = await ethers.provider.getBalance(await pool.getAddress());

            const r2 = await pool.getRoundInfo(2);
            const ownerFees = await pool.ownerFees();
            const aliceClaimable = await pool.getClaimableAmount(1, alice.address);
            const luckyInfo = await pool.luckyDrawInfo(1);
            const luckyPrize = luckyInfo.claimed ? 0n : luckyInfo.prize;

            const nftRevenuePool = await pool.nftRevenuePool();
            const lastDropPoolBal = await pool.lastDropPool();
            const expectedBal = r2.prizePool + r2.seedPool + ownerFees + aliceClaimable + luckyPrize + nftRevenuePool + lastDropPoolBal;

            expect(contractBal).to.equal(expectedBal);
        });

        it('invariant: after all claims, contract balance equals only carried-over pools + ownerFees', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);
            await buyEntries(pool, alice, [makeEntry(whites, goldNum, goldPos)]);

            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await pool.settleRound();

            // Alice claims her prize
            const indices = await pool.getPlayerEntryIndices(1, alice.address);
            await pool.connect(alice).claimPrizeBatch(1, [...indices]);

            // Alice claims lucky draw (she's the only player so she wins it)
            const luckyInfo = await pool.luckyDrawInfo(1);
            if (luckyInfo.winner === alice.address && !luckyInfo.claimed) {
                await pool.connect(alice).claimLuckyDraw(1);
            }

            const contractBal = await ethers.provider.getBalance(await pool.getAddress());
            const r2 = await pool.getRoundInfo(2);
            const ownerFees = await pool.ownerFees();
            const nftRevenuePool = await pool.nftRevenuePool();
            const lastDropPoolBal = await pool.lastDropPool();

            expect(contractBal).to.equal(r2.prizePool + r2.seedPool + ownerFees + nftRevenuePool + lastDropPoolBal);
        });

        it('invariant: no-winner round — all ETH rolls over to next round', async function () {
            const { pool, mockVRF, alice } = await loadFixture(deployFixture);

            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            const r1Before = await pool.getRoundInfo(1);

            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            // Alice claims lucky draw if she won
            const luckyInfo = await pool.luckyDrawInfo(1);
            if (luckyInfo.winner === alice.address && !luckyInfo.claimed && luckyInfo.prize > 0n) {
                await pool.connect(alice).claimLuckyDraw(1);
            }

            const r2 = await pool.getRoundInfo(2);
            const ownerFees = await pool.ownerFees();
            const contractBal = await ethers.provider.getBalance(await pool.getAddress());
            const nftRevenuePool = await pool.nftRevenuePool();
            const lastDropPoolBal = await pool.lastDropPool();

            // r1 prize pool and seed rolled to r2 (no winners)
            expect(r2.prizePool).to.equal(r1Before.prizePool);
            expect(r2.seedPool).to.equal(r1Before.seedPool);

            // Contract balance = r2 pools + ownerFees + nftRevenue + lastDropPool (lucky draw claimed)
            expect(contractBal).to.equal(r2.prizePool + r2.seedPool + ownerFees + nftRevenuePool + lastDropPoolBal);
        });
    });

    describe('UUPS storage layout compatibility', function () {
        it('storage slot for foundationPassAwarded matches expected EIP-7201 derived slot', async function () {
            const { pool, mockVRF, alice, owner } = await loadFixture(deployFixture);

            // Deploy FoundationPass and wire it
            const FoundationPass = await ethers.getContractFactory('FoundationPass');
            const nft = await FoundationPass.deploy(ethers.parseEther('0.1'), '');
            await nft.waitForDeployment();
            await nft.connect(owner).setPoolContract(await pool.getAddress());
            await pool.connect(owner).setFoundationPassContract(await nft.getAddress());

            const BASE_SLOT = BigInt(ethers.keccak256(ethers.toUtf8Bytes('hypepool.v1.main.storage')));

            // Before any super winner, foundationPassAwarded should be false (slot = 0x0)
            const flagBefore = await ethers.provider.getStorage(await pool.getAddress(), BASE_SLOT + 30n);
            expect(flagBefore).to.equal(ethers.ZeroHash);

            // Run a round with a super winner
            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);
            await buyEntries(pool, alice, [makeEntry(whites, goldNum, goldPos)]);
            await closeDraw(pool);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await pool.settleRound();

            // After super winner, foundationPassAwarded should be true (slot != 0x0)
            const flagAfter = await ethers.provider.getStorage(await pool.getAddress(), BASE_SLOT + 30n);
            expect(flagAfter).to.not.equal(ethers.ZeroHash);
        });

        it('storage slot for currentRound is stable across proxy reads', async function () {
            const { pool } = await loadFixture(deployFixture);
            // currentRound is at BASE_SLOT + 3: slot 0 packs ccipRouter+sourceChainSelector,
            // slot 1 = vrfRequester, slot 2 = ccipGasLimit, slot 3 = currentRound
            const BASE_SLOT = BigInt(ethers.keccak256(ethers.toUtf8Bytes('hypepool.v1.main.storage')));
            const rawSlot = await ethers.provider.getStorage(await pool.getAddress(), BASE_SLOT + 3n);
            const fromStorage = BigInt(rawSlot);
            const fromView = await pool.currentRound();
            expect(fromStorage).to.equal(fromView);
        });

        it('proxy implementation slot (ERC-1967) points to the deployed implementation', async function () {
            const { pool, impl } = await loadFixture(deployFixture);
            const implAddr = await impl.getAddress();
            // ERC-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1
            const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
            const raw = await ethers.provider.getStorage(await pool.getAddress(), IMPL_SLOT);
            // raw is a 32-byte hex string (66 chars with '0x' prefix).
            // An Ethereum address occupies the lowest 20 bytes (rightmost 40 hex chars).
            // Slice from position 26 = 2 ('0x') + 24 (12 zero-padding bytes) to get the address.
            const storedImpl = '0x' + raw.slice(26).toLowerCase();
            expect(storedImpl).to.equal(implAddr.toLowerCase());
        });

        it('upgrading to a new implementation preserves all storage values', async function () {
            const { pool, owner, alice, mockVRF } = await loadFixture(deployFixture);

            // Buy a entry to populate storage
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            const roundBefore = await pool.getRoundInfo(1);
            const prizePoolBefore = roundBefore.prizePool;
            const entryCountBefore = roundBefore.entryCount;

            // Deploy a new implementation (same V1 bytecode — simulates a no-op upgrade)
            const [mathLib, viewsLib] = await Promise.all([
                (await ethers.getContractFactory('HypePoolMath')).deploy(),
                (await ethers.getContractFactory('HypePoolViews')).deploy(),
            ]);
            await Promise.all([mathLib.waitForDeployment(), viewsLib.waitForDeployment()]);
            const HypePoolV1 = await ethers.getContractFactory('HypePoolV1', {
                libraries: {
                    HypePoolMath: await mathLib.getAddress(),
                    HypePoolViews: await viewsLib.getAddress(),
                },
            });
            const newImpl = await HypePoolV1.deploy();
            await newImpl.waitForDeployment();
            const newImplAddr = await newImpl.getAddress();

            // Propose + execute upgrade
            await pool.connect(owner).proposeUpgrade(newImplAddr);
            await time.increase(72 * 60 * 60 + 1);
            await pool.connect(owner).upgradeToAndCall(newImplAddr, '0x');

            // Verify storage is preserved after upgrade
            const roundAfter = await pool.getRoundInfo(1);
            expect(roundAfter.prizePool).to.equal(prizePoolBefore);
            expect(roundAfter.entryCount).to.equal(entryCountBefore);
            expect(await pool.currentRound()).to.equal(1n);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    //  Extra coverage: FoundationPass edge cases
    // ═══════════════════════════════════════════════════════════════

    describe('FoundationPass extra coverage', function () {
        async function deployFPFixture() {
            const base = await loadFixture(deployFixture);
            const { owner, alice } = base;
            const mintPrice = ethers.parseEther('0.1');
            const FoundationPass = await ethers.getContractFactory('FoundationPass');
            const nft = await FoundationPass.deploy(mintPrice, 'https://example.com/meta/');
            await nft.waitForDeployment();
            await nft.connect(owner).setMintableSupply(10);
            return { ...base, nft, mintPrice };
        }

        it('setBaseURI reverts for non-owner', async function () {
            const { nft, alice } = await deployFPFixture();
            await expect(
                nft.connect(alice).setBaseURI('https://evil.com/'),
            ).to.be.revertedWithCustomError(nft, 'OwnableUnauthorizedAccount');
        });

        it('withdrawProceeds reverts with TransferFailed when ETH transfer to owner fails', async function () {
            const { nft, owner } = await deployFPFixture();

            // _proceeds is a private uint256 in FoundationPass.
            // Storage layout (OZ v5 ERC721 + Ownable + FoundationPass vars):
            //   slot 0: _name, slot 1: _symbol, slot 2: _owners, slot 3: _balances,
            //   slot 4: _tokenApprovals, slot 5: _operatorApprovals  (ERC721)
            //   slot 6: _owner  (Ownable)
            //   slot 7: mintPrice, slot 8: mintableSupply, slot 9: _totalMinted,
            //   slot 10: _publicMinted, slot 11: _proceeds  (FoundationPass)
            const PROCEEDS_SLOT = 11n;
            const amount = ethers.parseEther('1');

            // Inject _proceeds = 1 ETH directly into storage
            await ethers.provider.send('hardhat_setStorageAt', [
                await nft.getAddress(),
                '0x' + PROCEEDS_SLOT.toString(16).padStart(64, '0'),
                '0x' + amount.toString(16).padStart(64, '0'),
            ]);

            // Fund the contract so it actually has ETH to attempt the transfer
            await ethers.provider.send('hardhat_setBalance', [
                await nft.getAddress(),
                '0x' + amount.toString(16),
            ]);

            // Deploy a RejectETH contract and transfer ownership to it
            const RejectETH = await ethers.getContractFactory('RejectETH');
            const rejecter = await RejectETH.deploy();
            await rejecter.waitForDeployment();
            await nft.connect(owner).transferOwnership(await rejecter.getAddress());

            // rejecter calls withdrawProceeds → ETH transfer to rejecter fails → TransferFailed
            await expect(
                rejecter.callWithdrawProceeds(await nft.getAddress()),
            ).to.be.revertedWithCustomError(nft, 'TransferFailed');
        });
    });

    // ═══════════════════════════════════════════════════════════════
    //  Extra coverage: entryPrice MAX_ENTRY_PRICE cap
    // ═══════════════════════════════════════════════════════════════

    describe('entryPrice MAX_ENTRY_PRICE cap', function () {
        it('entryPrice is capped at 0.5 ETH when pool exceeds 1000 ETH', async function () {
            const { pool } = await loadFixture(deployFixture);

            // Compute the storage slot of rounds[1].prizePool and rounds[1].seedPool.
            // HypePoolStorage EIP-7201 base slot:
            const BASE_SLOT = BigInt(ethers.keccak256(ethers.toUtf8Bytes('hypepool.v1.main.storage')));
            // rounds mapping is the 5th field (slot offset 4) after:
            //   slot 0: ccipRouter(20B) + sourceChainSelector(8B) packed
            //   slot 1: vrfRequester
            //   slot 2: ccipGasLimit
            //   slot 3: currentRound
            //   slot 4: rounds (mapping)
            const ROUNDS_MAPPING_SLOT = BASE_SLOT + 4n;
            const roundSlot = BigInt(
                ethers.keccak256(
                    ethers.AbiCoder.defaultAbiCoder().encode(
                        ['uint256', 'uint256'],
                        [1n, ROUNDS_MAPPING_SLOT],
                    ),
                ),
            );

            // prizePool = RoundInfo field 0, seedPool = field 1.
            // Inject prizePool = 600 ETH and seedPool = 600 ETH (total 1200 ETH).
            // price = 1200 * 5 / 10000 = 0.6 ETH > MAX_ENTRY_PRICE (0.5 ETH) → capped.
            const HUGE = ethers.parseEther('600');
            await ethers.provider.send('hardhat_setStorageAt', [
                await pool.getAddress(),
                '0x' + (roundSlot + 0n).toString(16).padStart(64, '0'),
                '0x' + HUGE.toString(16).padStart(64, '0'),
            ]);
            await ethers.provider.send('hardhat_setStorageAt', [
                await pool.getAddress(),
                '0x' + (roundSlot + 1n).toString(16).padStart(64, '0'),
                '0x' + HUGE.toString(16).padStart(64, '0'),
            ]);

            expect(await pool.entryPrice()).to.equal(ethers.parseEther('0.5'));
        });
    });

    // ═══════════════════════════════════════════════════════════════
    //  Extra coverage: freeEntryCredits == count exact equality
    // ═══════════════════════════════════════════════════════════════

    describe('freeEntryCredits exact equality branch', function () {
        it('buyEntries uses ALL credits when freeEntryCredits == count exactly', async function () {
            const { pool, mockVRF, alice, bob } = await loadFixture(deployFixture);

            // Bob earns exactly 2 free credits by triggering a public draw
            await buyEntries(pool, alice, [makeEntry([1, 2, 3, 4, 5], 10, 0)]);
            await time.increase(Number(UPKEEP_INTERVAL) + Number(DRAW_GRACE));
            await pool.connect(bob).triggerPublicDraw();
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await pool.settleRound();

            expect(await pool.freeEntryCredits(bob.address)).to.equal(2n);

            // Round 2 is now OPEN. Bob buys exactly 2 entries (credits == count).
            // The ternary `credits >= count ? count : credits` takes the TRUE branch
            // because credits (2) >= count (2), so freeCount = count = 2, paidCount = 0.
            await pool.connect(bob).buyEntries(
                [[1, 2, 3, 4, 5], [2, 3, 4, 5, 6]], [10, 11], [0, 1],
                ethers.ZeroAddress,
                { value: 0n },
            );

            // All credits consumed, balance = 0
            expect(await pool.freeEntryCredits(bob.address)).to.equal(0n);
            // Both entries are recorded
            expect(await pool.playerEntryCount(2, bob.address)).to.equal(2n);
        });
    });

});