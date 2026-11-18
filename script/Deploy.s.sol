// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {FloatVault} from "../src/FloatVault.sol";
import {TicketBox} from "../src/TicketBox.sol";

/// @notice Deploys mock USDC, the float vault and TicketBox, and wires them. Events are created afterwards
///         by organizers (see scripts/fuji-deploy.sh for the demo events).
contract Deploy is Script {
    function run() external returns (MockUSDC usdc, FloatVault vault, TicketBox box) {
        vm.startBroadcast();
        usdc = new MockUSDC();
        vault = new FloatVault(usdc);
        box = new TicketBox(usdc, vault);
        vault.setBox(address(box));
        usdc.setMinter(address(vault));
        vm.stopBroadcast();
        console.log("MockUSDC:", address(usdc));
        console.log("FloatVault:", address(vault));
        console.log("TicketBox:", address(box));
    }
}
