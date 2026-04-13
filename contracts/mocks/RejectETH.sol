// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IPool {
    function claimNFTRevenue(uint256 tokenId) external;
    function claimReferralEarnings() external;
    function claimPendingPayout() external;
    function pendingPayouts(address) external view returns (uint256);
}

interface IFoundationPass {
    function withdrawProceeds() external;
}

contract RejectETH {
    receive() external payable { revert("no ETH"); }

    /// @dev Accept ERC721 safe transfers so the contract can hold NFTs.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function callClaimNFTRevenue(address pool, uint256 tokenId) external {
        IPool(pool).claimNFTRevenue(tokenId);
    }

    function callClaimReferralEarnings(address pool) external {
        IPool(pool).claimReferralEarnings();
    }

    function callClaimPendingPayout(address pool) external {
        IPool(pool).claimPendingPayout();
    }

    function callWithdrawProceeds(address nft) external {
        IFoundationPass(nft).withdrawProceeds();
    }
}
