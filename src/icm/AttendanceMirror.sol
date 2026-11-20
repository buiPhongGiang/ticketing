// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ITeleporterReceiver} from "./ITeleporter.sol";

/// @title AttendanceMirror: the receiving side of AttendanceRelay, for a venue's or an artist's own Avalanche L1.
/// @notice Stores how each VeGoc event ended, as sent from the C-Chain. A contract on that L1 can then act on it
///         without an oracle, for example return a venue deposit or issue a fan badge only for shows that happened.
///         It accepts a message only from Teleporter, only from the configured source chain and only from the
///         configured AttendanceRelay.
contract AttendanceMirror is ITeleporterReceiver {
    struct Record {
        address organizer;
        uint8 outcome; // AttendanceRelay.Outcome: 1 happened, 2 no-show, 3 cancelled
        uint32 paidSold;
        uint32 paidCheckedIn;
    }

    address public immutable teleporter;
    bytes32 public immutable sourceBlockchainID;
    address public immutable relay;

    mapping(uint256 => Record) public records;

    event AttendanceReceived(uint256 indexed eventId, uint8 outcome, uint256 paidSold, uint256 paidCheckedIn);

    error NotTeleporter();
    error WrongSource();
    error Duplicate();

    constructor(address teleporter_, bytes32 sourceBlockchainID_, address relay_) {
        teleporter = teleporter_;
        sourceBlockchainID = sourceBlockchainID_;
        relay = relay_;
    }

    function receiveTeleporterMessage(bytes32 sourceBlockchainID_, address originSenderAddress, bytes calldata message)
        external
    {
        if (msg.sender != teleporter) revert NotTeleporter();
        if (sourceBlockchainID_ != sourceBlockchainID || originSenderAddress != relay) revert WrongSource();
        (uint256 eventId, address organizer, uint8 outcome, uint256 paidSold, uint256 paidCheckedIn) =
            abi.decode(message, (uint256, address, uint8, uint256, uint256));
        if (records[eventId].outcome != 0) revert Duplicate();
        records[eventId] = Record(organizer, outcome, uint32(paidSold), uint32(paidCheckedIn));
        emit AttendanceReceived(eventId, outcome, paidSold, paidCheckedIn);
    }

    function happened(uint256 eventId) external view returns (bool) {
        return records[eventId].outcome == 1;
    }
}
