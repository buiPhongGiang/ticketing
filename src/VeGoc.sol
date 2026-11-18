// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FloatVault} from "./FloatVault.sol";

/// @title VeGoc ("Vé Gốc", Vietnamese for "face-value ticket"): events, USDC tickets, capped resale, refunds on
///        cancel or no-show, signed check-in.
/// @notice Anyone can create an event and becomes its organizer. Tickets are ERC-721, held by plain wallets only,
///         and change hands only through the built-in marketplace, at most 10 % above face value. Ticket money
///         waits in FloatVault. A cancelled event refunds every buyer from that pot. An event that ends with fewer
///         than 20 % of its paid tickets scanned counts as a no-show: holders can take their money back and the
///         organizer has to wait 48 hours. Entry needs a fresh EIP-712 signature from the current holder, valid
///         for at most five minutes, so a QR made before a resale stops working and gate scans cannot be faked.
///         There is no owner, no pause and no upgrade key.
contract VeGoc is ERC721, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 private constant CHECK_IN_TYPEHASH = keccak256("CheckIn(uint256 tokenId,uint256 deadline)");
    uint256 public constant RESALE_CAP_BPS = 11_000; // face value + 10 %
    uint256 public constant MAX_TIERS = 4;
    /// @notice A check-in signature may not be valid further ahead than this, whatever the holder signed.
    uint256 public constant MAX_QR_WINDOW = 5 minutes;
    /// @notice Share of paid tickets that must be scanned at the gate for the show to count as having happened.
    uint256 public constant QUORUM_BPS = 2_000;
    /// @notice How long the organizer waits for the float after an event that did not reach the quorum.
    uint256 public constant SETTLE_GRACE = 48 hours;
    /// @notice An event must end within a year of its creation, which bounds how long money sits in escrow.
    uint256 public constant MAX_HORIZON = 365 days;
    uint256 public constant MAX_DURATION = 30 days;
    uint256 public constant MAX_TEXT = 120; // bytes, event name and venue
    uint256 public constant MAX_TIER_NAME = 32; // bytes
    uint256 public constant MAX_REFUND_BATCH = 100;
    uint256 public constant MAX_FEE_BPS = 1_000;

    IERC20 public immutable usdc;
    FloatVault public immutable vault;
    /// @notice Platform fee on primary sales, in basis points of whatever principal is paid out at settlement.
    ///         Money that goes back to buyers (cancel, no-show refunds) carries no fee.
    uint256 public immutable feeBps;
    address public immutable feeRecipient;

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

    /// @dev Paid tickets only: free tickets from the organizer do not count towards the gate quorum.
    struct Attendance {
        uint32 paidSold;
        uint32 paidCheckedIn;
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
        /// Earliest time the organizer may settle: `endsAt` if the quorum is met, else `endsAt + SETTLE_GRACE`.
        uint256 settleAt;
        /// True when holders can claim refunds now (cancelled, or ended below the quorum and not settled).
        bool refundOpen;
        bool quorumMet;
        uint256 paidSold;
        uint256 paidCheckedIn;
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
    mapping(uint256 => Attendance) private _attendance;
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
    error NotRefundable();
    error AlreadySettled();
    error DisputeWindow(uint256 opensAt);
    error SignatureExpired();
    error DeadlineTooFar();
    error HolderNotWallet();
    error CompNotResellable();
    error BatchTooLarge();
    error BadFee();
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
    event Settled(uint256 indexed eventId, address indexed to, uint256 principal, uint256 yieldPaid, uint256 fee);

    constructor(IERC20 usdc_, FloatVault vault_, address feeRecipient_, uint256 feeBps_)
        ERC721("Ve Goc Ticket", "VEGOC")
        EIP712("VeGoc", "1")
    {
        if (feeBps_ > MAX_FEE_BPS || (feeBps_ > 0 && feeRecipient_ == address(0))) revert BadFee();
        usdc = usdc_;
        vault = vault_;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
    }

    // ---------------------------------------------------------------- organizer

    function createEvent(
        string calldata name,
        string calldata venue,
        uint64 startsAt,
        uint64 endsAt,
        uint32 maxPerWallet,
        string[] memory tierNames,
        uint128[] memory prices,
        uint32[] memory supplies
    ) external returns (uint256 eventId) {
        eventId = _newEvent(name, venue, startsAt, endsAt, maxPerWallet);
        _addTiers(eventId, tierNames, prices, supplies);
        emit EventCreated(eventId, msg.sender, name);
    }

    function _newEvent(string calldata name, string calldata venue, uint64 startsAt, uint64 endsAt, uint32 maxPerWallet)
        private
        returns (uint256 eventId)
    {
        _checkEvent(bytes(name).length, bytes(venue).length, startsAt, endsAt);
        eventId = _events.length;
        EventData storage e = _events.push();
        e.organizer = msg.sender;
        e.startsAt = startsAt;
        e.endsAt = endsAt;
        e.maxPerWallet = maxPerWallet;
        e.name = name;
        e.venue = venue;
    }

    /// @dev Times: ends in the future, at most `MAX_HORIZON` ahead, lasts at most `MAX_DURATION`.
    function _checkEvent(uint256 nameLength, uint256 venueLength, uint64 startsAt, uint64 endsAt) private view {
        if (endsAt <= startsAt || endsAt <= block.timestamp) revert BadEvent();
        if (endsAt > block.timestamp + MAX_HORIZON || endsAt - startsAt > MAX_DURATION) revert BadEvent();
        if (nameLength == 0 || nameLength > MAX_TEXT || venueLength > MAX_TEXT) revert BadEvent();
    }

    /// @dev A tier with price 0 is valid: it can only be handed out with `issue`, never bought.
    function _addTiers(uint256 eventId, string[] memory tierNames, uint128[] memory prices, uint32[] memory supplies) private {
        uint256 n = tierNames.length;
        if (n == 0 || n > MAX_TIERS || prices.length != n || supplies.length != n) revert BadTier();
        for (uint256 i = 0; i < n; i++) {
            uint256 len = bytes(tierNames[i]).length;
            if (supplies[i] == 0 || len == 0 || len > MAX_TIER_NAME) revert BadTier();
            _tiers[eventId].push(Tier(tierNames[i], prices[i], supplies[i], 0));
        }
    }

    function setScanner(uint256 eventId, address scanner, bool allowed) external {
        _onlyOrganizer(eventId);
        if (isScanner[eventId][scanner] == allowed) return;
        isScanner[eventId][scanner] = allowed;
        if (allowed) scannerFor[scanner] += 1;
        else scannerFor[scanner] -= 1;
        emit ScannerSet(eventId, scanner, allowed);
    }

    /// @notice Free tickets from the organizer (guests, press). They refund nothing and cannot be listed for resale.
    function issue(uint256 eventId, uint256 tier, address to, uint256 quantity) external {
        _onlyOrganizer(eventId);
        _open(eventId);
        _mintTickets(eventId, tier, to, quantity, 0);
        emit Issued(eventId, to, tier, quantity);
    }

    /// @notice Cancels before the end. Every paid ticket can then be refunded at face value from the vault, and the
    ///         mock yield stops accruing, so delaying refunds earns the organizer nothing.
    function cancelEvent(uint256 eventId) external {
        _onlyOrganizer(eventId);
        _open(eventId);
        _events[eventId].cancelled = true;
        vault.freeze(eventId);
        emit Cancelled(eventId);
    }

    /// @notice After the event: the organizer takes the float (minus the platform fee) plus its yield. If the gate
    ///         quorum was not met this only opens `SETTLE_GRACE` after the end, and pays what holders did not take
    ///         back. After a cancel: only the yield accrued up to the cancel, because the principal belongs to the
    ///         buyers until they are refunded.
    function settle(uint256 eventId, address to) external nonReentrant {
        _onlyOrganizer(eventId);
        EventData storage e = _events[eventId];
        uint256 principal;
        uint256 fee;
        if (!e.cancelled) {
            if (block.timestamp < e.endsAt) revert EventNotEnded();
            uint256 opensAt = settleOpensAt(eventId);
            if (block.timestamp < opensAt) revert DisputeWindow(opensAt);
            if (e.settled) revert AlreadySettled();
            e.settled = true;
            principal = vault.principalOf(eventId);
            fee = (principal * feeBps) / 10_000;
            if (fee > 0) vault.withdraw(eventId, fee, feeRecipient);
            principal -= fee;
            if (principal > 0) vault.withdraw(eventId, principal, to);
        }
        uint256 paidYield = vault.withdrawYield(eventId, to);
        emit Settled(eventId, to, principal, paidYield, fee);
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
        // A free ticket put no money in the vault, so its buyer would have nothing to be refunded from.
        if (t.paid == 0) revert CompNotResellable();
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

    /// @notice Called by gate staff with the holder's EIP-712 `CheckIn(uint256 tokenId,uint256 deadline)` signature
    ///         (domain: name "VeGoc", version "1", this chain id, this contract).
    /// @dev Reads the holder from `ownerOf`, so a signature from a previous holder fails. Only an ECDSA signature
    ///      by the holding wallet's own key is accepted: ERC-1271 is deliberately not supported, because a contract
    ///      that can sign for whoever controls it could be sold off-market above the cap.
    function checkIn(uint256 tokenId, uint256 deadline, bytes calldata signature) external {
        TicketData storage t = _tickets[tokenId];
        address holder = ownerOf(tokenId);
        EventData storage e = _events[t.eventId];
        if (!isScanner[t.eventId][msg.sender]) revert NotScanner();
        if (e.cancelled) revert EventCancelled();
        if (block.timestamp >= e.endsAt) revert EventEnded();
        if (block.timestamp > deadline) revert SignatureExpired();
        if (deadline > block.timestamp + MAX_QR_WINDOW) revert DeadlineTooFar();
        if (t.checkedIn) revert AlreadyCheckedIn();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CHECK_IN_TYPEHASH, tokenId, deadline)));
        (address signer,,) = ECDSA.tryRecover(digest, signature);
        if (signer == address(0) || signer != holder) revert InvalidSignature();
        if (t.listPrice != 0) _clearListing(tokenId);
        t.checkedIn = true;
        e.checkedIn += 1;
        if (t.paid > 0) _attendance[t.eventId].paidCheckedIn += 1;
        emit CheckedIn(tokenId, holder, msg.sender);
    }

    // ---------------------------------------------------------------- refunds

    /// @notice Face value back to the holder. Open after a cancel, and after an event that ended below the gate
    ///         quorum (a no-show) until the organizer settles.
    function claimRefund(uint256 tokenId) external nonReentrant {
        if (ownerOf(tokenId) != msg.sender) revert NotHolder();
        _refund(tokenId);
    }

    /// @notice Pushes refunds to the current holders. Anyone may call it: the organizer right after cancelling, or
    ///         any bystander for a no-show. Skips tickets that are already refunded or, in a no-show, were scanned.
    function refundMany(uint256[] calldata tokenIds) external nonReentrant {
        if (tokenIds.length > MAX_REFUND_BATCH) revert BatchTooLarge();
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 id = tokenIds[i];
            if (_ownerOf(id) == address(0)) continue;
            TicketData storage t = _tickets[id];
            if (t.checkedIn && !_events[t.eventId].cancelled) continue;
            _refund(id);
        }
    }

    /// @notice True when at least `QUORUM_BPS` of the paid tickets were scanned at the gate. Every scan carries the
    ///         holder's signature, so an organizer cannot produce it for tickets other people hold.
    function quorumMet(uint256 eventId) public view returns (bool) {
        if (eventId >= _events.length) revert BadEvent();
        return _quorum(eventId);
    }

    /// @notice Earliest time `settle` works for an event that was not cancelled.
    function settleOpensAt(uint256 eventId) public view returns (uint256) {
        if (eventId >= _events.length) revert BadEvent();
        EventData storage e = _events[eventId];
        return _quorum(eventId) ? e.endsAt : e.endsAt + SETTLE_GRACE;
    }

    function refundOpen(uint256 eventId) public view returns (bool) {
        if (eventId >= _events.length) revert BadEvent();
        EventData storage e = _events[eventId];
        return e.cancelled || _noShow(eventId);
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
        v.settleAt = settleOpensAt(eventId);
        v.refundOpen = refundOpen(eventId);
        v.quorumMet = _quorum(eventId);
        v.paidSold = _attendance[eventId].paidSold;
        v.paidCheckedIn = _attendance[eventId].paidCheckedIn;
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
        _attendance[eventId].paidSold += uint32(quantity);
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
        address holder = ownerOf(tokenId);
        TicketData memory t = _tickets[tokenId];
        EventData storage e = _events[t.eventId];
        if (!e.cancelled) {
            if (!_noShow(t.eventId)) revert NotRefundable();
            if (t.checkedIn) revert TicketUsed(); // this holder was let in
        }
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

    function _quorum(uint256 eventId) private view returns (bool) {
        Attendance storage a = _attendance[eventId];
        return uint256(a.paidCheckedIn) * 10_000 >= uint256(a.paidSold) * QUORUM_BPS;
    }

    /// @dev Ended, not settled, and too few paid tickets were scanned. Check-in closes at `endsAt`, so the answer
    ///      cannot change once the event has ended.
    function _noShow(uint256 eventId) private view returns (bool) {
        EventData storage e = _events[eventId];
        return !e.cancelled && !e.settled && block.timestamp >= e.endsAt && !_quorum(eventId);
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
    ///      A ticket never goes to an address that has code: a contract could hand its controls to a new owner
    ///      for any price without the ticket moving. (A contract that buys from its own constructor slips past
    ///      this check and ends up with a ticket nobody can check in, because check-in takes ECDSA only.)
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (to != address(0) && to.code.length != 0) revert HolderNotWallet();
        if (from != address(0) && to != address(0)) {
            if (!_marketMove) revert TransferBlocked();
            if (_tickets[tokenId].checkedIn) revert TicketUsed();
        }
        if (from != address(0)) _clearListing(tokenId);
        return super._update(to, tokenId, auth);
    }
}
