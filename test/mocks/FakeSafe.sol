// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Test double for the console's organizer check: a contract that answers like a Safe (owners, threshold)
///         without being one. The console must not label it a Safe or send anything to it.
contract FakeSafe {
    function getOwners() external pure returns (address[] memory owners) {
        owners = new address[](3);
        owners[0] = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
        owners[1] = address(2);
        owners[2] = address(3);
    }

    function getThreshold() external pure returns (uint256) {
        return 2;
    }
}
