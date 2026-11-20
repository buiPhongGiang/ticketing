// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {VeGoc} from "../VeGoc.sol";
import {ITeleporterReceiver} from "./ITeleporter.sol";
import {GateLog} from "./GateLog.sol";

/// @title VenueCheckIns: the C-Chain side of GateLog. Counts door scans sent from the venue's L1, checked against
///        VeGoc.
/// @notice Accepts a message only from Teleporter, only from the venue L1 and only from its GateLog. For each scan it
///         reads VeGoc: the ticket must exist, belong to the event, be held by the wallet that signed the QR, and
///         the scan must be before the event's end. Anything else is counted as rejected, with a reason. A ticket
///         counts once. The result is a per-event check-in count on the C-Chain that anyone can compare with
///         VeGoc's own count and its 50% paid-ticket quorum (`venueQuorum`). It does not change VeGoc or its
///         settlement: the deployed VeGoc keeps counting only its own `checkIn`.
contract VenueCheckIns is ITeleporterReceiver {
    struct Tally {
        uint32 accepted;
        uint32 paidAccepted; // tickets bought with USDC, the ones VeGoc's quorum counts
        uint32 rejected;
        uint32 batches;
    }

    enum Reject {
        None,
        NoTicket, // burned (refunded) or never minted
        WrongEvent,
        NotHolder, // the QR was signed by a wallet that does not hold the ticket now
        AfterEnd,
        Cancelled,
        Duplicate
    }

    address public immutable teleporter;
    bytes32 public immutable venueBlockchainID;
    address public immutable gateLog;
    VeGoc public immutable box;

    mapping(uint256 => Tally) public tallies; // event → counts
    mapping(uint256 => bool) public counted; // token → counted

    event BatchReceived(uint256 indexed eventId, uint256 batch, uint256 accepted, uint256 rejected);
    event ScanAccepted(uint256 indexed eventId, uint256 indexed tokenId, address holder, uint64 at);
    event ScanRejected(uint256 indexed eventId, uint256 indexed tokenId, Reject reason);

    error NotTeleporter();
    error WrongSource();

    constructor(address teleporter_, bytes32 venueBlockchainID_, address gateLog_, VeGoc box_) {
        teleporter = teleporter_;
        venueBlockchainID = venueBlockchainID_;
        gateLog = gateLog_;
        box = box_;
    }

    function receiveTeleporterMessage(bytes32 sourceBlockchainID, address originSenderAddress, bytes calldata message)
        external
    {
        if (msg.sender != teleporter) revert NotTeleporter();
        if (sourceBlockchainID != venueBlockchainID || originSenderAddress != gateLog) revert WrongSource();
        (uint256 eventId, uint256 batch, GateLog.Scan[] memory scans) =
            abi.decode(message, (uint256, uint256, GateLog.Scan[]));
        Tally storage t = tallies[eventId];
        (bool ok, uint64 endsAt, bool cancelled) = _event(eventId);
        uint256 accepted;
        for (uint256 i = 0; i < scans.length; i++) {
            Reject r = ok ? _check(eventId, scans[i], endsAt, cancelled) : Reject.WrongEvent;
            if (r == Reject.None) {
                accepted++;
                emit ScanAccepted(eventId, scans[i].tokenId, scans[i].holder, scans[i].at);
            } else {
                // A ticket already counted is logged but not held against the venue.
                if (r != Reject.Duplicate) t.rejected++;
                emit ScanRejected(eventId, scans[i].tokenId, r);
            }
        }
        t.batches++;
        emit BatchReceived(eventId, batch, accepted, scans.length - accepted);
    }

    function _event(uint256 eventId) private view returns (bool ok, uint64 endsAt, bool cancelled) {
        try box.getEvent(eventId) returns (VeGoc.EventView memory v) {
            return (true, v.data.endsAt, v.data.cancelled);
        } catch {
            return (false, 0, false);
        }
    }

    function _check(uint256 eventId, GateLog.Scan memory s, uint64 endsAt, bool cancelled) private returns (Reject) {
        if (counted[s.tokenId]) return Reject.Duplicate;
        if (cancelled) return Reject.Cancelled;
        if (s.at >= endsAt) return Reject.AfterEnd;
        try box.getTicket(s.tokenId) returns (VeGoc.TicketView memory v) {
            if (v.eventId != eventId) return Reject.WrongEvent;
            if (v.owner != s.holder) return Reject.NotHolder;
            counted[s.tokenId] = true;
            Tally storage t = tallies[eventId];
            t.accepted++;
            if (v.paid > 0) t.paidAccepted++;
            return Reject.None;
        } catch {
            return Reject.NoTicket;
        }
    }

    /// @notice Paid tickets scanned at the venue's door versus paid tickets sold on VeGoc, and whether that would
    ///         meet VeGoc's quorum. Also returns VeGoc's own count of scans made on the C-Chain.
    function venueQuorum(uint256 eventId)
        external
        view
        returns (uint256 venuePaidCheckedIn, uint256 paidSold, uint256 veGocPaidCheckedIn, bool met)
    {
        VeGoc.EventView memory v = box.getEvent(eventId);
        venuePaidCheckedIn = tallies[eventId].paidAccepted;
        paidSold = v.paidSold;
        veGocPaidCheckedIn = v.paidCheckedIn;
        met = paidSold > 0 && venuePaidCheckedIn * 10_000 >= paidSold * box.QUORUM_BPS();
    }
}
