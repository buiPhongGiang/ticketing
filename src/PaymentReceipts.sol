// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title PaymentReceipts: proof that a ticket was paid for in VND, without putting the bank details on chain.
/// @notice Ticket money moves in VND through a bank or an e-wallet, off chain. When the payment gateway reports a
///         payment, the backend records `keccak256(abi.encodePacked(bankCode, amountVnd, salt))` for the tickets it
///         paid for. The buyer holds `bankCode`, `amountVnd` and `salt` (the receipt in the app) and can recompute
///         the hash against this contract; nobody else learns the bank reference from the chain.
///         The contract cannot see or move VND. It proves which payment record a ticket is tied to, that the record
///         was written once and when, and it gives the organizer a public list to reconcile against the bank
///         statement. Whether the money arrived is the gateway's and the backend's word.
contract PaymentReceipts {
    /// What the payment was for. Payout kinds are money going back to a holder or a seller.
    enum Kind {
        Purchase,
        Resale,
        RefundPayout,
        SalePayout
    }

    struct Receipt {
        bytes32 receiptHash;
        Kind kind;
        uint64 at;
    }

    /// The backend wallets allowed to record, fixed at deployment.
    mapping(address => bool) public isRecorder;
    /// A receipt hash is recorded once.
    mapping(bytes32 => bool) public recorded;
    mapping(uint256 => Receipt[]) private _receipts; // ticket → its payment records, oldest first
    uint256 public count;

    event PaymentRecorded(uint256 indexed tokenId, Kind kind, bytes32 indexed receiptHash, address indexed recorder);

    error NotRecorder();
    error AlreadyRecorded();
    error NoTickets();
    error EmptyHash();
    error TooMany();

    uint256 public constant MAX_TICKETS = 20;

    constructor(address[] memory recorders) {
        for (uint256 i = 0; i < recorders.length; i++) {
            isRecorder[recorders[i]] = true;
        }
    }

    /// @notice Ties one payment record to the tickets it paid for. One bank transfer can pay for several tickets
    ///         of one order; a ticket gets one more record each time it is paid for again (resale) or paid back.
    function record(uint256[] calldata tokenIds, Kind kind, bytes32 receiptHash) external {
        if (!isRecorder[msg.sender]) revert NotRecorder();
        if (receiptHash == bytes32(0)) revert EmptyHash();
        if (tokenIds.length == 0) revert NoTickets();
        if (tokenIds.length > MAX_TICKETS) revert TooMany();
        if (recorded[receiptHash]) revert AlreadyRecorded();
        recorded[receiptHash] = true;
        count++;
        for (uint256 i = 0; i < tokenIds.length; i++) {
            _receipts[tokenIds[i]].push(Receipt(receiptHash, kind, uint64(block.timestamp)));
            emit PaymentRecorded(tokenIds[i], kind, receiptHash, msg.sender);
        }
    }

    function receiptsOf(uint256 tokenId) external view returns (Receipt[] memory) {
        return _receipts[tokenId];
    }

    /// @notice The hash a receipt must have. Same formula the app runs in the browser.
    function hashOf(string calldata bankCode, uint256 amountVnd, bytes32 salt) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(bankCode, amountVnd, salt));
    }
}
