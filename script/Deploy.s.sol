// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {FloatVault} from "../src/FloatVault.sol";
import {VeGoc} from "../src/VeGoc.sol";

/// @notice Deploys the float vault and VeGoc and wires them. The payment token is a parameter:
///         USDC_ADDRESS=<token> uses an existing ERC-20 (Circle's USDC on Fuji is
///         0x5425890298aed601595a70AB815c96711a31Bc65); without it a MockUSDC with a faucet is deployed first.
///         FEE_RECIPIENT (default: the deployer) receives FEE_BPS (default 300 = 3 %) of each settled event.
///         Events are created afterwards by organizers (see scripts/fuji-deploy.sh for the demo events).
contract Deploy is Script {
    function run() external returns (IERC20 usdc, FloatVault vault, VeGoc box) {
        address token = vm.envOr("USDC_ADDRESS", address(0));
        uint256 feeBps = vm.envOr("FEE_BPS", uint256(300));
        vm.startBroadcast();
        address feeRecipient = vm.envOr("FEE_RECIPIENT", msg.sender);
        usdc = token == address(0) ? IERC20(address(new MockUSDC())) : IERC20(token);
        vault = new FloatVault(usdc);
        box = new VeGoc(usdc, vault, feeRecipient, feeBps);
        vault.setBox(address(box));
        vm.stopBroadcast();
        console.log("USDC:", address(usdc));
        console.log("FloatVault:", address(vault));
        console.log("VeGoc:", address(box));
    }
}
