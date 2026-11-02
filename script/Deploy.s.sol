// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {EventTicket} from "../src/EventTicket.sol";

/// @notice Env: TICKET_NAME, TICKET_SYMBOL, TICKET_SUPPLY, TICKET_PRICE_WEI, ORGANIZER.
contract Deploy is Script {
    function run() external returns (EventTicket ticket) {
        vm.startBroadcast();
        ticket = new EventTicket(
            vm.envString("TICKET_NAME"),
            vm.envString("TICKET_SYMBOL"),
            vm.envUint("TICKET_SUPPLY"),
            vm.envUint("TICKET_PRICE_WEI"),
            vm.envAddress("ORGANIZER")
        );
        vm.stopBroadcast();
        console.log("EventTicket:", address(ticket));
    }
}
