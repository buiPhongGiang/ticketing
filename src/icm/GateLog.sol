// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ITeleporterMessenger, TeleporterMessageInput, TeleporterFeeInfo} from "./ITeleporter.sol";

/// @title GateLog: the venue's door on its own Avalanche L1 (`vegoc`).
/// @notice A gate device scans the same QR the app shows for VeGoc on the C-Chain: the holder's EIP-712 signature of
///         `CheckIn(tokenId, deadline)` under VeGoc's domain on Fuji. GateLog checks the signature here and stores
///         who signed, paid for in the venue's own gas token. `attest` then sends the scans not yet sent to
///         VenueCheckIns on the C-Chain over ICM (Teleporter), which checks each one against VeGoc's ownership.
///         The gate cannot add a scan for a ticket without its holder's key, and the venue cannot either.
contract GateLog {
    struct Scan {
        uint256 tokenId;
        address holder;
        uint64 at;
    }

    bytes32 private constant CHECK_IN_TYPEHASH = keccak256("CheckIn(uint256 tokenId,uint256 deadline)");
    uint256 public constant MAX_QR_WINDOW = 5 minutes; // same as VeGoc
    uint256 public constant MAX_BATCH = 20;
    uint256 public constant RECEIVE_GAS = 1_000_000;

    address public immutable venue;
    ITeleporterMessenger public immutable teleporter;
    bytes32 public immutable settlementBlockchainID;
    /// VenueCheckIns on the C-Chain.
    address public immutable receiver;
    /// EIP-712 domain separator of VeGoc on the C-Chain: the holder signs the QR for that contract.
    bytes32 public immutable ticketDomain;

    mapping(address => bool) public isGate;
    mapping(uint256 => Scan[]) private _scans; // event → scans, in order
    mapping(uint256 => uint256) public sentUpTo; // event → scans already attested
    mapping(uint256 => uint256) public batches; // event → attestations sent
    mapping(uint256 => mapping(uint256 => bool)) public scanned; // event → token → scanned here

    event GateSet(address indexed gate, bool allowed);
    event Scanned(uint256 indexed eventId, uint256 indexed tokenId, address indexed holder, address gate);
    event Attested(uint256 indexed eventId, uint256 batch, uint256 scans, bytes32 indexed messageID);

    error NotVenue();
    error NotGate();
    error SignatureExpired();
    error DeadlineTooFar();
    error InvalidSignature();
    error AlreadyScanned();
    error NothingToSend();
    error LengthMismatch();

    constructor(
        address venue_,
        ITeleporterMessenger teleporter_,
        bytes32 settlementBlockchainID_,
        address receiver_,
        uint256 ticketChainId,
        address ticketContract
    ) {
        venue = venue_;
        teleporter = teleporter_;
        settlementBlockchainID = settlementBlockchainID_;
        receiver = receiver_;
        ticketDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("VeGoc"),
                keccak256("1"),
                ticketChainId,
                ticketContract
            )
        );
    }

    function setGate(address gate, bool allowed) external {
        if (msg.sender != venue) revert NotVenue();
        isGate[gate] = allowed;
        emit GateSet(gate, allowed);
    }

    /// @notice Records one scan. Reverts on a bad or stale QR, or a ticket already scanned for this event.
    function checkIn(uint256 eventId, uint256 tokenId, uint256 deadline, bytes calldata signature) public {
        if (!isGate[msg.sender]) revert NotGate();
        if (block.timestamp > deadline) revert SignatureExpired();
        if (deadline > block.timestamp + MAX_QR_WINDOW) revert DeadlineTooFar();
        if (scanned[eventId][tokenId]) revert AlreadyScanned();
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", ticketDomain, keccak256(abi.encode(CHECK_IN_TYPEHASH, tokenId, deadline)))
        );
        (address holder,,) = ECDSA.tryRecover(digest, signature);
        if (holder == address(0)) revert InvalidSignature();
        scanned[eventId][tokenId] = true;
        _scans[eventId].push(Scan(tokenId, holder, uint64(block.timestamp)));
        emit Scanned(eventId, tokenId, holder, msg.sender);
    }

    function checkInMany(
        uint256 eventId,
        uint256[] calldata tokenIds,
        uint256[] calldata deadlines,
        bytes[] calldata signatures
    ) external {
        if (tokenIds.length != deadlines.length || tokenIds.length != signatures.length) revert LengthMismatch();
        for (uint256 i = 0; i < tokenIds.length; i++) {
            checkIn(eventId, tokenIds[i], deadlines[i], signatures[i]);
        }
    }

    /// @notice Sends up to `MAX_BATCH` scans not yet sent for an event to the C-Chain. A gate or the venue calls it.
    function attest(uint256 eventId) external returns (bytes32 messageID) {
        if (!isGate[msg.sender] && msg.sender != venue) revert NotGate();
        Scan[] storage all = _scans[eventId];
        uint256 from = sentUpTo[eventId];
        uint256 n = all.length - from;
        if (n == 0) revert NothingToSend();
        if (n > MAX_BATCH) n = MAX_BATCH;
        Scan[] memory out = new Scan[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = all[from + i];
        }
        sentUpTo[eventId] = from + n;
        uint256 batch = ++batches[eventId];
        messageID = teleporter.sendCrossChainMessage(
            TeleporterMessageInput({
                destinationBlockchainID: settlementBlockchainID,
                destinationAddress: receiver,
                // No relayer fee: the team's ICM relayer delivers between vegoc and the C-Chain.
                feeInfo: TeleporterFeeInfo({feeTokenAddress: address(0), amount: 0}),
                requiredGasLimit: RECEIVE_GAS,
                allowedRelayerAddresses: new address[](0),
                message: abi.encode(eventId, batch, out)
            })
        );
        emit Attested(eventId, batch, n, messageID);
    }

    function scanCount(uint256 eventId) external view returns (uint256) {
        return _scans[eventId].length;
    }

    function scans(uint256 eventId) external view returns (Scan[] memory) {
        return _scans[eventId];
    }
}
