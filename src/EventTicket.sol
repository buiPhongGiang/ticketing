// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title EventTicket: tickets for one event, each one an NFT.
/// @notice Tickets move freely between wallets. Entry requires a signature from whoever holds the
///         ticket at that moment, so a QR code made by a previous holder stops working once sold.
///         A checked-in ticket can no longer be transferred.
contract EventTicket is ERC721, Ownable, EIP712 {
    bytes32 private constant CHECK_IN_TYPEHASH = keccak256("CheckIn(uint256 tokenId,uint256 deadline)");

    error SoldOut();
    error SaleClosed();
    error WrongPayment();
    error NotScanner();
    error SignatureExpired();
    error InvalidSignature();
    error AlreadyCheckedIn();
    error TicketUsed();
    error WithdrawFailed();

    event CheckedIn(uint256 indexed tokenId, address indexed holder, address indexed scanner);
    event ScannerSet(address indexed scanner, bool allowed);

    uint256 public immutable maxSupply;
    /// @notice Price per ticket in wei for `buy`. Zero means no public sale, only organizer `mint`.
    uint256 public immutable price;
    uint256 public totalMinted;
    mapping(address => bool) public isScanner;
    mapping(uint256 => bool) public checkedIn;

    constructor(string memory name_, string memory symbol_, uint256 maxSupply_, uint256 price_, address organizer)
        ERC721(name_, symbol_)
        Ownable(organizer)
        EIP712("EventTicket", "1")
    {
        maxSupply = maxSupply_;
        price = price_;
    }

    /// @notice Organizer issues tickets without payment.
    function mint(address to, uint256 quantity) external onlyOwner {
        _issue(to, quantity);
    }

    /// @notice Public sale at the fixed price. Payment must be exact.
    function buy(uint256 quantity) external payable {
        if (price == 0) revert SaleClosed();
        if (msg.value != price * quantity) revert WrongPayment();
        _issue(msg.sender, quantity);
    }

    function setScanner(address scanner, bool allowed) external onlyOwner {
        isScanner[scanner] = allowed;
        emit ScannerSet(scanner, allowed);
    }

    /// @notice Called by gate staff with the holder's EIP-712 `CheckIn` signature.
    /// @dev Reads the holder from `ownerOf`, so a signature from anyone else fails. EOA and ERC-1271 wallets both work.
    function checkIn(uint256 tokenId, uint256 deadline, bytes calldata signature) external {
        if (!isScanner[msg.sender]) revert NotScanner();
        if (block.timestamp > deadline) revert SignatureExpired();
        if (checkedIn[tokenId]) revert AlreadyCheckedIn();

        address holder = ownerOf(tokenId);
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CHECK_IN_TYPEHASH, tokenId, deadline)));
        if (!SignatureChecker.isValidSignatureNow(holder, digest, signature)) revert InvalidSignature();

        checkedIn[tokenId] = true;
        emit CheckedIn(tokenId, holder, msg.sender);
    }

    function withdraw(address payable to) external onlyOwner {
        (bool sent,) = to.call{value: address(this).balance}("");
        if (!sent) revert WithdrawFailed();
    }

    function _issue(address to, uint256 quantity) private {
        uint256 next = totalMinted;
        if (quantity > maxSupply - next) revert SoldOut();
        totalMinted = next + quantity;
        for (uint256 i = 0; i < quantity; i++) {
            _mint(to, next + i);
        }
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (checkedIn[tokenId]) revert TicketUsed();
        return super._update(to, tokenId, auth);
    }
}
