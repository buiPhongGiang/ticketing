// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {VeGoc} from "../VeGoc.sol";
import {ITeleporterMessenger, TeleporterMessageInput, TeleporterFeeInfo} from "./ITeleporter.sol";

/// @title AttendanceRelay: tells another Avalanche L1, over ICM (Teleporter), how an event on VeGoc ended.
/// @notice The outcome is final once an event is cancelled or past its end: `cancelEvent` and `extendEvent` need a
///         running event, `checkIn` and purchases close at the end. Anyone may call `relay`; the contract reads the
///         numbers from VeGoc itself, so the caller cannot choose what is sent, and each event is sent once.
///         The receiver on the other chain trusts the message because Teleporter tells it the source chain and
///         this contract's address.
contract AttendanceRelay {
    enum Outcome {
        None,
        Happened, // ended with at least half of the paid tickets scanned at the gate
        NoShow, // ended below that quorum: holders can take refunds
        Cancelled
    }

    uint256 public constant RECEIVE_GAS = 150_000;

    VeGoc public immutable box;
    ITeleporterMessenger public immutable teleporter;
    bytes32 public immutable destinationBlockchainID;
    /// AttendanceMirror on the destination chain.
    address public immutable mirror;

    mapping(uint256 => bytes32) public messageOf;

    event AttendanceRelayed(
        uint256 indexed eventId, Outcome outcome, uint256 paidSold, uint256 paidCheckedIn, bytes32 indexed messageID
    );

    error NotFinal();
    error AlreadyRelayed();

    constructor(VeGoc box_, ITeleporterMessenger teleporter_, bytes32 destinationBlockchainID_, address mirror_) {
        box = box_;
        teleporter = teleporter_;
        destinationBlockchainID = destinationBlockchainID_;
        mirror = mirror_;
    }

    /// @notice The outcome VeGoc shows for an event now; `None` while it is still running.
    function outcomeOf(uint256 eventId) public view returns (Outcome, uint256 paidSold, uint256 paidCheckedIn) {
        VeGoc.EventView memory v = box.getEvent(eventId);
        paidSold = v.paidSold;
        paidCheckedIn = v.paidCheckedIn;
        if (v.data.cancelled) return (Outcome.Cancelled, paidSold, paidCheckedIn);
        if (block.timestamp < v.data.endsAt) return (Outcome.None, paidSold, paidCheckedIn);
        return (v.quorumMet ? Outcome.Happened : Outcome.NoShow, paidSold, paidCheckedIn);
    }

    function relay(uint256 eventId) external returns (bytes32 messageID) {
        if (messageOf[eventId] != bytes32(0)) revert AlreadyRelayed();
        (Outcome outcome, uint256 paidSold, uint256 paidCheckedIn) = outcomeOf(eventId);
        if (outcome == Outcome.None) revert NotFinal();
        address organizer = box.getEvent(eventId).data.organizer;
        messageID = teleporter.sendCrossChainMessage(
            TeleporterMessageInput({
                destinationBlockchainID: destinationBlockchainID,
                destinationAddress: mirror,
                // No relayer fee: on Fuji the public ICM relayer delivers between the C-Chain, Dispatch and Echo.
                feeInfo: TeleporterFeeInfo({feeTokenAddress: address(0), amount: 0}),
                requiredGasLimit: RECEIVE_GAS,
                allowedRelayerAddresses: new address[](0),
                message: abi.encode(eventId, organizer, uint8(outcome), paidSold, paidCheckedIn)
            })
        );
        messageOf[eventId] = messageID;
        emit AttendanceRelayed(eventId, outcome, paidSold, paidCheckedIn, messageID);
    }
}
