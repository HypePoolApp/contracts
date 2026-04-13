// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IPoolSeed {
    function seedPrizePool() external payable;
}

/**
 * @title FoundationPass
 * @notice 10 founder NFTs for HypePool. Each token earns 1% of all
 *         protocol fees (10% total). Revenue is claimed via the pool
 *         contract's claimNFTRevenue(tokenId) function.
 */
contract FoundationPass is ERC721, Ownable {

    uint256 public constant MAX_SUPPLY = 10;

    uint256 public mintPrice;
    uint256 public mintableSupply;
    uint256 private _totalMinted;
    uint256 private _publicMinted;
    uint256 private _proceeds;
    string  private _baseTokenURI;
    address public poolContract;

    error AlreadyMintedOut();
    error InsufficientPayment();
    error NoValueToWithdraw();
    error TransferFailed();
    error InvalidTokenId();
    error OnlyPool();
    error MintableSupplyReached();
    error ExceedsMaxSupply();

    event FoundationPassAwarded(uint256 indexed tokenId, address indexed winner);

    constructor(uint256 _mintPrice, string memory baseTokenURI_)
        ERC721("FoundationPass", "FPASS")
        Ownable(msg.sender)
    {
        mintPrice     = _mintPrice;
        _baseTokenURI = baseTokenURI_;
    }

    // ── Public mint ──────────────────────────────────────────────
    function mint() external payable {
        if (_publicMinted >= mintableSupply) revert MintableSupplyReached();
        if (_totalMinted >= MAX_SUPPLY)      revert AlreadyMintedOut();
        if (msg.value < mintPrice)           revert InsufficientPayment();
        uint256 tokenId = _totalMinted;
        _totalMinted++;
        _publicMinted++;
        IPoolSeed(poolContract).seedPrizePool{value: msg.value}();
        _safeMint(msg.sender, tokenId);
    }

    // ── Admin mint (free) ────────────────────────────────────────
    function adminMint(address to) external onlyOwner {
        if (_totalMinted >= MAX_SUPPLY) revert AlreadyMintedOut();
        uint256 tokenId = _totalMinted;
        _totalMinted++;
        _safeMint(to, tokenId);
    }

    /// @notice Mint callable only by the pool contract (for Super Pool prize).
    function poolMint(address to) external {
        if (msg.sender != poolContract) revert OnlyPool();
        if (_totalMinted >= MAX_SUPPLY) revert AlreadyMintedOut();
        uint256 tokenId = _totalMinted;
        _totalMinted++;
        _safeMint(to, tokenId);
        emit FoundationPassAwarded(tokenId, to);
    }

    /// @notice Set the pool contract address (can call poolMint).
    function setPoolContract(address addr) external onlyOwner {
        poolContract = addr;
    }

    // ── Admin controls ───────────────────────────────────────────
    function setMintPrice(uint256 newPrice) external onlyOwner {
        mintPrice = newPrice;
    }

    function setMintableSupply(uint256 n) external onlyOwner {
        if (n > MAX_SUPPLY) revert ExceedsMaxSupply();
        mintableSupply = n;
    }

    // ── Owner withdraw ───────────────────────────────────────────
    function withdrawProceeds() external onlyOwner {
        uint256 amount = _proceeds;
        if (amount == 0) revert NoValueToWithdraw();
        _proceeds = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ── Metadata ─────────────────────────────────────────────────
    function setBaseURI(string calldata newURI) external onlyOwner {
        _baseTokenURI = newURI;
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    // ── Supply info ──────────────────────────────────────────────
    function totalMinted() external view returns (uint256) {
        return _totalMinted;
    }

    function publicMinted() external view returns (uint256) {
        return _publicMinted;
    }
}
