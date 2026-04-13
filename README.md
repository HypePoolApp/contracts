# HypePool Contracts

Smart contracts and tests for [HypePool](https://hypepool.app) — a trustless prize pool protocol on Hyperliquid L1 powered by Chainlink VRF and CCIP.

> **No house. No operator. No trust required.**

## Deployed Contracts

### Hyperliquid L1 (Chain ID 999)

| Contract | Address | Description |
|---|---|---|
| `HypePoolProxy` | [`0x58fD7df705b5c2e1C05070e0e94f831bb263cDEe`](https://hyperevmscan.io/address/0x58fD7df705b5c2e1C05070e0e94f831bb263cDEe) | ERC-1967 proxy — all user interactions go here |
| `HypePoolV1` | [`0x19345B384335DdC616089C393d613Cd4fcFe086A`](https://hyperevmscan.io/address/0x19345B384335DdC616089C393d613Cd4fcFe086A) | UUPS implementation behind the proxy |
| `HypePoolMath` | [`0xF8D14D282cf770e541Cf9e7D11d66013055596D7`](https://hyperevmscan.io/address/0xF8D14D282cf770e541Cf9e7D11d66013055596D7) | Core game logic library |
| `HypePoolViews` | [`0xbfe233CF8C2a9D5A5c2F5d330790dde1eaC66563`](https://hyperevmscan.io/address/0xbfe233CF8C2a9D5A5c2F5d330790dde1eaC66563) | Views and admin library |
| `FoundationPass` | [`0xc69A6F6bBD4056b82a6745B29B4D0fF081f293e8`](https://hyperevmscan.io/address/0xc69A6F6bBD4056b82a6745B29B4D0fF081f293e8) | ERC-721 founder NFT — 10 max supply, 1% protocol fees each |

### Base

| Contract | Address | Description |
|---|---|---|
| `HypePoolVRFRequester` | [`0x42BA7432597db90AA63329061e5b22B67e299f5f`](https://basescan.org/address/0x42BA7432597db90AA63329061e5b22B67e299f5f) | Chainlink VRF v2.5 + CCIP bridge |

## Source Files

| File | Description |
|---|---|
| `HypePoolV1.sol` | Thin UUPS wrapper — delegates to HypePoolMath and HypePoolViews |
| `HypePoolMath.sol` | Core game logic: entry purchase, draw, settlement, claiming, CCIP |
| `HypePoolViews.sol` | View functions, admin setters, timelocks, emergency cancel |
| `HypePoolProxy.sol` | Minimal ERC-1967 proxy wrapper |
| `HypePoolVRFRequester.sol` | Deployed on Base — CCIP receiver → VRF request → CCIP fulfillment |
| `FoundationPass.sol` | ERC-721 NFT with admin mint, pool mint, and fee revenue claiming |

## Fee Structure

Every entry purchase is split on-chain:

| Destination | Share | Description |
|---|---|---|
| Prize Pool | 50% | Paid to players who match all 5 numbers |
| Super Pool | 30% | Grows until someone matches 5 + gold exact position |
| FoundationPass holders | 10% | Split equally among all 10 NFTs |
| Mini Prizes | 4% | Lucky Draw (60%) + Last Drop (40%) |
| Referral | 3% | Paid to referrer, or protocol if none |
| Owner | 3% | Covers CCIP fees, VRF costs, infrastructure |

## Build & Test

```bash
npm install
npx hardhat test
```

The test suite includes **319 automated unit and integration tests** covering core mechanics, edge cases, security boundaries, ETH conservation invariants, and all V2 features.

## Security

- All sensitive admin operations are protected by **24–72 hour timelocks**
- Protocol upgrades require a **72-hour public timelock + 1-hour execution window**
- `buyEntries` is blocked during upgrade windows to prevent state corruption
- Emergency cancel is **permissionless** after 24 hours — the protocol cannot be permanently stuck
- Randomness is sourced from **Chainlink VRF v2.5** on Base, relayed via CCIP — tamper-proof and verifiable on-chain
- No formal third-party audit has been conducted — interact at your own risk

Full security documentation: [docs.hypepool.app/security](https://docs.hypepool.app/security)

## Documentation

Full documentation: [docs.hypepool.app](https://docs.hypepool.app)

## License

MIT