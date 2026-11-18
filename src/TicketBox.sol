// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FloatVault} from "./FloatVault.sol";

/// @title TicketBox: events, USDC tickets, capped resale, refunds on cancel, signed check-in.
/// @notice Anyone can create an event and becomes its organizer. Tickets are ERC-721 and can only change hands
///         through the built-in marketplace, at most 10 % above face value. Ticket money waits in FloatVault until
///         the event ends, so a cancelled event refunds every buyer from the same pot. Entry needs a fresh EIP-712
///         signature from the current holder, so a QR made before a resale stops working.
contract TicketBox is ERC721, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 private constant CHECK_IN_TYPEHASH = keccak256("CheckIn(uint256 tokenId,uint256 deadline)");
    uint256 public constant RESALE_CAP_BPS = 11_000; // face value + 10 %
    uint256 public constant MAX_TIERS = 4;

    IERC20 public immutable usdc;
    FloatVault public immutable vault;

    struct Tier {
        string name;
        uint128 price;
        uint32 supply;
        uint32 sold;
    }

    struct EventData {
        address organizer;
        uint64 startsAt;
        uint64 endsAt;
        uint32 maxPerWallet;
        bool cancelled;
        bool settled;
        uint32 issued;
        uint32 checkedIn;
        uint32 refunded;
        uint32 resales;
        uint128 sales;
        uint128 resaleVolume;
        uint128 resaleFaceVolume;
        string name;
        string venue;
    }

    struct TicketData {
        uint64 eventId;
        uint32 tier;
        bool checkedIn;
        uint128 paid;
        uint128 listPrice;
    }

    struct EventView {
        uint256 id;
        EventData data;
        Tier[] tiers;
        uint256 principal;
        uint256 yieldAccrued;
        uint256 listed;
    }

    struct TicketView {
        uint256 tokenId;
        uint256 eventId;
        uint256 tier;
        address owner;
        uint256 paid;
        uint256 face;
        uint256 cap;
        uint256 listPrice;
        bool checkedIn;
    }

    EventData[] private _events;
    mapping(uint256 => Tier[]) private _tiers;
    mapping(uint256 => TicketData) private _tickets;
    mapping(uint256 => uint256) private _listedCount;
    mapping(uint256 => mapping(address => uint256)) public boughtBy;
    mapping(uint256 => mapping(address => bool)) public isScanner;
    /// @notice Number of events a wallet may scan for; lets a client show the gate without knowing the event.
    mapping(address => uint256) public scannerFor;
    uint256 public totalMinted;
    bool private _marketMove;

    error BadEvent();
    error BadTier();
    error NotOrganizer();
    error NotScanner();
    error NotHolder();
    error SaleClosed();
    error SoldOut();
    error WalletLimit();
    error EventCancelled();
    error EventEnded();
    error EventNotEnded();
    error NotCancelled();
    error AlreadySettled();
    error SignatureExpired();
    error InvalidSignature();
    error AlreadyCheckedIn();
    error TicketUsed();
    error TransferBlocked();
    error AboveCap(uint256 cap);
    error NotListed();
    error PriceChanged(uint256 price);
    error OwnListing();

    event EventCreated(uint256 indexed eventId, address indexed organizer, string name);
    event Cancelled(uint256 indexed eventId);
    event ScannerSet(uint256 indexed eventId, address indexed scanner, bool allowed);
    event Purchased(uint256 indexed eventId, address indexed buyer, uint256 tier, uint256 quantity, uint256 amount);
    event Issued(uint256 indexed eventId, address indexed to, uint256 tier, uint256 quantity);
    event Listed(uint256 indexed tokenId, address indexed seller, uint256 price);
    event Unlisted(uint256 indexed tokenId);
    event Resold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price);
    event CheckedIn(uint256 indexed tokenId, address indexed holder, address indexed scanner);
    event Refunded(uint256 indexed tokenId, address indexed holder, uint256 amount);
    event Settled(uint256 indexed eventId, address indexed to, uint256 principal, uint256 yieldPaid);

    constructor(IERC20 usdc_, FloatVault vault_) ERC721("TicketBox", "TIX") EIP712("TicketBox", "1") {
        usdc = usdc_;
        vault = vault_;
    }

    // ---------------------------------------------------------------- organizer

    function createEvent(
        string calldata name,
        string calldata venue,
        uint64 startsAt,
        uint64 endsAt,
        uint32 maxPerWallet,
        string[] calldata tierNames,
        uint128[] calldata prices,
        uint32[] calldata supplies
    ) external returns (uint256 eventId) {
        uint256 n = tierNames.length;
        if (endsAt <= startsAt || endsAt <= block.timestamp || bytes(name).length == 0) revert BadEvent();
        if (n == 0 || n > MAX_TIERS || prices.length != n || supplies.length != n) revert BadTier();
        eventId = _events.length;
        EventData storage e = _events.push();
        e.organizer = msg.sender;
        e.startsAt = startsAt;
        e.endsAt = endsAt;
        e.maxPerWallet = maxPerWallet;
        e.name = name;
        e.venue = venue;
        for (uint256 i = 0; i < n; i++) {
            if (supplies[i] == 0) revert BadTier();
            _tiers[eventId].push(Tier(tierNames[i], prices[i], supplies[i], 0));
        }
        emit EventCreated(eventId, msg.sender, name);
    }

    function setScanner(uint256 eventId, address scanner, bool allowed) external {
        _onlyOrganizer(eventId);
        if (isScanner[eventId][scanner] == allowed) return;
        isScanner[eventId][scanner] = allowed;
        if (allowed) scannerFor[scanner] += 1;
        else scannerFor[scanner] -= 1;
        emit ScannerSet(eventId, scanner, allowed);
    }

    /// @notice Free tickets from the organizer (guests, press). They refund nothing on cancel.
    function issue(uint256 eventId, uint256 tier, address to, uint256 quantity) external {
        _onlyOrganizer(eventId);
        _open(eventId);
        _mintTickets(eventId, tier, to, quantity, 0);
        emit Issued(eventId, to, tier, quantity);
    }

    /// @notice Cancels before the end. Every paid ticket can then be refunded at face value from the vault.
    function cancelEvent(uint256 eventId) external {
        _onlyOrganizer(eventId);
        _open(eventId);
        _events[eventId].cancelled = true;
        emit Cancelled(eventId);
    }

    /// @notice After the event: the organizer takes the float plus its yield. After a cancel: only the yield,
    ///         because the principal belongs to the buyers until they are refunded.
    function settle(uint256 eventId, address to) external nonReentrant {
        _onlyOrganizer(eventId);
        EventData storage e = _events[eventId];
        uint256 principal;
        if (!e.cancelled) {
            if (block.timestamp < e.endsAt) revert EventNotEnded();
            if (e.settled) revert AlreadySettled();
            e.settled = true;
            principal = vault.principalOf(eventId);
            if (principal > 0) vault.withdraw(eventId, principal, to);
        }
        uint256 paidYield = vault.withdrawYield(eventId, to);
        emit Settled(eventId, to, principal, paidYield);
    }

    // ---------------------------------------------------------------- primary sale

    function buy(uint256 eventId, uint256 tier, uint256 quantity) external nonReentrant {
        _buy(eventId, tier, quantity);
    }

    /// @notice One transaction for wallets that sign an EIP-2612 permit instead of sending an approval first.
    function buyWithPermit(uint256 eventId, uint256 tier, uint256 quantity, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        _permit(_tierOf(eventId, tier).price * quantity, deadline, v, r, s);
        _buy(eventId, tier, quantity);
    }

    // ---------------------------------------------------------------- resale market

    function resaleCap(uint256 tokenId) public view returns (uint256) {
        TicketData memory t = _ticket(tokenId);
        return (uint256(_tiers[t.eventId][t.tier].price) * RESALE_CAP_BPS) / 10_000;
    }

    function list(uint256 tokenId, uint256 price) external {
        if (ownerOf(tokenId) != msg.sender) revert NotHolder();
        TicketData storage t = _tickets[tokenId];
        if (t.checkedIn) revert TicketUsed();
        _open(t.eventId);
        uint256 cap = resaleCap(tokenId);
        if (price == 0 || price > cap) revert AboveCap(cap);
        if (t.listPrice == 0) _listedCount[t.eventId] += 1;
        t.listPrice = uint128(price);
        emit Listed(tokenId, msg.sender, price);
    }

    function unlist(uint256 tokenId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotHolder();
        if (_tickets[tokenId].listPrice == 0) revert NotListed();
        _clearListing(tokenId);
        emit Unlisted(tokenId);
    }

    /// @param maxPrice Guards against the seller raising the price while the buyer's transaction is in flight.
    function buyListing(uint256 tokenId, uint256 maxPrice) external nonReentrant {
        _buyListing(tokenId, maxPrice);
    }

    function buyListingWithPermit(uint256 tokenId, uint256 maxPrice, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        _permit(maxPrice, deadline, v, r, s);
        _buyListing(tokenId, maxPrice);
    }

    // ---------------------------------------------------------------- gate

    /// @notice Called by gate staff with the holder's EIP-712 `CheckIn` signature.
    /// @dev Reads the holder from `ownerOf`, so a signature from a previous holder fails. EOA and ERC-1271 both work.
    function checkIn(uint256 tokenId, uint256 deadline, bytes calldata signature) external {
        TicketData storage t = _tickets[tokenId];
        address holder = ownerOf(tokenId);
        if (!isScanner[t.eventId][msg.sender]) revert NotScanner();
        if (_events[t.eventId].cancelled) revert EventCancelled();
        if (block.timestamp > deadline) revert SignatureExpired();
        if (t.checkedIn) revert AlreadyCheckedIn();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CHECK_IN_TYPEHASH, tokenId, deadline)));
        if (!SignatureChecker.isValidSignatureNow(holder, digest, signature)) revert InvalidSignature();
        if (t.listPrice != 0) _clearListing(tokenId);
        t.checkedIn = true;
        _events[t.eventId].checkedIn += 1;
        emit CheckedIn(tokenId, holder, msg.sender);
    }

    // ---------------------------------------------------------------- refunds

    function claimRefund(uint256 tokenId) external nonReentrant {
        if (ownerOf(tokenId) != msg.sender) revert NotHolder();
        _refund(tokenId);
    }

    /// @notice Pushes refunds to the current holders. Anyone may call it, typically the organizer right after cancelling.
    function refundMany(uint256[] calldata tokenIds) external nonReentrant {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            if (_ownerOf(tokenIds[i]) != address(0)) _refund(tokenIds[i]);
        }
    }

    // ---------------------------------------------------------------- views

    function eventCount() external view returns (uint256) {
        return _events.length;
    }

    function getEvent(uint256 eventId) public view returns (EventView memory v) {
        if (eventId >= _events.length) revert BadEvent();
        v.id = eventId;
        v.data = _events[eventId];
        v.tiers = _tiers[eventId];
        v.principal = vault.principalOf(eventId);
        v.yieldAccrued = vault.yieldOf(eventId);
        v.listed = _listedCount[eventId];
    }

    function getEvents() external view returns (EventView[] memory all) {
        all = new EventView[](_events.length);
        for (uint256 i = 0; i < all.length; i++) {
            all[i] = getEvent(i);
        }
    }

    function getTicket(uint256 tokenId) public view returns (TicketView memory v) {
        TicketData memory t = _ticket(tokenId);
        uint256 face = _tiers[t.eventId][t.tier].price;
        v = TicketView(tokenId, t.eventId, t.tier, ownerOf(tokenId), t.paid, face, (face * RESALE_CAP_BPS) / 10_000, t.listPrice, t.checkedIn);
    }

    /// @notice Every live ticket of one wallet. Linear in tickets minted, which is fine for a view at event scale.
    function ticketsOf(address holder) external view returns (TicketView[] memory out) {
        uint256 n = balanceOf(holder);
        out = new TicketView[](n);
        uint256 k;
        for (uint256 id = 0; id < totalMinted && k < n; id++) {
            if (_ownerOf(id) == holder) out[k++] = getTicket(id);
        }
    }

    function listings(uint256 eventId) external view returns (TicketView[] memory out) {
        out = new TicketView[](_listedCount[eventId]);
        uint256 k;
        for (uint256 id = 0; id < totalMinted && k < out.length; id++) {
            if (_tickets[id].listPrice != 0 && _tickets[id].eventId == eventId && _ownerOf(id) != address(0)) {
                out[k++] = getTicket(id);
            }
        }
    }

    function checkedIn(uint256 tokenId) external view returns (bool) {
        return _tickets[tokenId].checkedIn;
    }

    // ---------------------------------------------------------------- internals

    function _buy(uint256 eventId, uint256 tier, uint256 quantity) private {
        _open(eventId);
        uint256 price = _tierOf(eventId, tier).price;
        if (price == 0) revert SaleClosed();
        EventData storage e = _events[eventId];
        uint256 bought = boughtBy[eventId][msg.sender] + quantity;
        if (e.maxPerWallet != 0 && bought > e.maxPerWallet) revert WalletLimit();
        boughtBy[eventId][msg.sender] = bought;
        uint256 amount = price * quantity;
        e.sales += uint128(amount);
        _mintTickets(eventId, tier, msg.sender, quantity, price);
        usdc.safeTransferFrom(msg.sender, address(vault), amount);
        vault.deposit(eventId, amount);
        emit Purchased(eventId, msg.sender, tier, quantity, amount);
    }

    function _buyListing(uint256 tokenId, uint256 maxPrice) private {
        TicketData storage t = _tickets[tokenId];
        uint256 price = t.listPrice;
        if (price == 0) revert NotListed();
        if (price > maxPrice) revert PriceChanged(price);
        _open(t.eventId);
        address seller = ownerOf(tokenId);
        if (seller == msg.sender) revert OwnListing();
        EventData storage e = _events[t.eventId];
        e.resales += 1;
        e.resaleVolume += uint128(price);
        e.resaleFaceVolume += _tiers[t.eventId][t.tier].price;
        _marketMove = true;
        _transfer(seller, msg.sender, tokenId); // clears the listing in _update
        _marketMove = false;
        usdc.safeTransferFrom(msg.sender, seller, price);
        emit Resold(tokenId, seller, msg.sender, price);
    }

    function _refund(uint256 tokenId) private {
        TicketData memory t = _tickets[tokenId];
        EventData storage e = _events[t.eventId];
        if (!e.cancelled) revert NotCancelled();
        address holder = ownerOf(tokenId);
        e.refunded += 1;
        _burn(tokenId);
        delete _tickets[tokenId];
        if (t.paid > 0) vault.withdraw(t.eventId, t.paid, holder);
        emit Refunded(tokenId, holder, t.paid);
    }

    function _mintTickets(uint256 eventId, uint256 tier, address to, uint256 quantity, uint256 paid) private {
        Tier storage tr = _tierOf(eventId, tier);
        if (quantity == 0 || quantity > tr.supply - tr.sold) revert SoldOut();
        tr.sold += uint32(quantity);
        _events[eventId].issued += uint32(quantity);
        uint256 next = totalMinted;
        totalMinted = next + quantity;
        for (uint256 i = 0; i < quantity; i++) {
            _tickets[next + i] = TicketData(uint64(eventId), uint32(tier), false, uint128(paid), 0);
            _mint(to, next + i);
        }
    }

    function _permit(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) private {
        // A permit that was already used (or front-run) leaves the allowance in place, so the transfer decides.
        try IERC20Permit(address(usdc)).permit(msg.sender, address(this), value, deadline, v, r, s) {} catch {}
    }

    function _clearListing(uint256 tokenId) private {
        TicketData storage t = _tickets[tokenId];
        if (t.listPrice == 0) return;
        t.listPrice = 0;
        _listedCount[t.eventId] -= 1;
    }

    function _onlyOrganizer(uint256 eventId) private view {
        if (eventId >= _events.length) revert BadEvent();
        if (_events[eventId].organizer != msg.sender) revert NotOrganizer();
    }

    function _open(uint256 eventId) private view {
        if (eventId >= _events.length) revert BadEvent();
        EventData storage e = _events[eventId];
        if (e.cancelled) revert EventCancelled();
        if (block.timestamp >= e.endsAt) revert EventEnded();
    }

    function _tierOf(uint256 eventId, uint256 tier) private view returns (Tier storage) {
        if (eventId >= _events.length) revert BadEvent();
        if (tier >= _tiers[eventId].length) revert BadTier();
        return _tiers[eventId][tier];
    }

    function _ticket(uint256 tokenId) private view returns (TicketData memory) {
        _requireOwned(tokenId);
        return _tickets[tokenId];
    }

    /// @dev Mint and burn pass. A holder-to-holder move only passes inside `buyListing`, and never for a used ticket.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            if (!_marketMove) revert TransferBlocked();
            if (_tickets[tokenId].checkedIn) revert TicketUsed();
        }
        if (from != address(0)) _clearListing(tokenId);
        return super._update(to, tokenId, auth);
    }
}
