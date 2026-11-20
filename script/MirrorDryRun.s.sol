// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {AttendanceMirror} from "../src/icm/AttendanceMirror.sol";
import {TeleporterFeeInfo} from "../src/icm/ITeleporter.sol";

struct TeleporterMessageReceipt {
    uint256 receivedMessageNonce;
    address relayerRewardAddress;
}

struct TeleporterMessage {
    uint256 messageNonce;
    address originSenderAddress;
    bytes32 destinationBlockchainID;
    address destinationAddress;
    uint256 requiredGasLimit;
    address[] allowedRelayerAddresses;
    TeleporterMessageReceipt[] receipts;
    bytes message;
}

interface ITeleporterRetry {
    function receivedFailedMessageHashes(bytes32 messageID) external view returns (bytes32);
    function retryMessageExecution(bytes32 sourceBlockchainID, TeleporterMessage calldata message) external;
}

/// Run against a fork of the Dispatch test L1, no gas and no key needed:
///   SEND_LOG=<data of SendCrossChainMessage from the relay tx on the C-Chain> MESSAGE_ID=<id> \
///   forge script script/MirrorDryRun.s.sol --fork-url https://subnets.avax.network/dispatch/testnet/rpc
/// It checks that the message Teleporter stored on Dispatch is the one sent, places AttendanceMirror's code at the
/// address the relay sends to, and retries the stored message there. `scripts/fuji-icm-dryrun.sh` fills the inputs.
contract MirrorDryRun is Script {
    address constant TELEPORTER = 0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf;
    bytes32 constant FUJI_C_CHAIN = 0x7fc93d85c6d62c5b2ac0b519c87010ea5294012d1e407030d6acd0021cac10d5;

    function run() external {
        bytes32 id = vm.envBytes32("MESSAGE_ID");
        (TeleporterMessage memory m,) = abi.decode(vm.envBytes("SEND_LOG"), (TeleporterMessage, TeleporterFeeInfo));
        bytes32 stored = ITeleporterRetry(TELEPORTER).receivedFailedMessageHashes(id);
        require(stored != bytes32(0), "Teleporter on Dispatch has no stored failed message with this id");
        require(stored == keccak256(abi.encode(m)), "stored message differs from the one sent");
        require(m.destinationAddress.code.length == 0, "mirror already deployed: retry for real instead");

        AttendanceMirror tmp = new AttendanceMirror(TELEPORTER, FUJI_C_CHAIN, m.originSenderAddress);
        vm.etch(m.destinationAddress, address(tmp).code);
        AttendanceMirror mirror = AttendanceMirror(m.destinationAddress);

        ITeleporterRetry(TELEPORTER).retryMessageExecution(FUJI_C_CHAIN, m);
        (uint256 eventId,,,,) = abi.decode(m.message, (uint256, address, uint8, uint256, uint256));
        (address organizer, uint8 outcome, uint32 paidSold, uint32 paidCheckedIn) = mirror.records(eventId);
        require(outcome != 0, "retry did not store the record");
        console.log("event", eventId);
        console.log("organizer", organizer);
        console.log("outcome (1 happened, 2 no-show, 3 cancelled)", outcome);
        console.log("paid tickets sold / scanned", paidSold, paidCheckedIn);
    }
}
