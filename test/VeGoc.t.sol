// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {FloatVault} from "../src/FloatVault.sol";
import {VeGoc} from "../src/VeGoc.sol";

/// A contract that tries to hold a ticket and sign for it through ERC-1271.
contract SmartWallet is IERC1271 {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function buy(VeGoc box, IERC20 usdc, uint256 eventId, uint256 tier) external {
        usdc.approve(address(box), type(uint256).max);
        box.buy(eventId, tier, 1);
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        (bytes32 r, bytes32 s) = abi.decode(sig[:64], (bytes32, bytes32));
        return ecrecover(hash, uint8(sig[64]), r, s) == signer ? IERC1271.isValidSignature.selector : bytes4(0);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

/// Buys from its constructor, when its code size is still zero, and signs through ERC-1271 afterwards.
contract ConstructorBuyer is IERC1271 {
    address public immutable signer;

    constructor(VeGoc box, IERC20 usdc, uint256 eventId, address signer_) {
        signer = signer_;
        usdc.approve(address(box), type(uint256).max); // the test sent 25 USDC to this address beforehand
        box.buy(eventId, 0, 1);
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        (bytes32 r, bytes32 s) = abi.decode(sig[:64], (bytes32, bytes32));
        return ecrecover(hash, uint8(sig[64]), r, s) == signer ? IERC1271.isValidSignature.selector : bytes4(0);
    }
}

contract VeGocTest is Test {
    uint128 constant GA = 25e6; // 25 USDC
    uint128 constant VIP = 60e6;
    // Absolute times: with via_ir, block.timestamp read again after vm.warp can be stale inside one test.
    uint256 constant T0 = 1_800_000_000;
    uint256 constant DOORS = T0 + 1 days + 1 hours; // during the show
    uint256 constant END = T0 + 2 days; // endsAt of the default event

    MockUSDC usdc;
    FloatVault vault;
    VeGoc box;
    uint256 constant FEE_BPS = 300; // 3 %
    uint256 constant RESERVE = 500e6;
    address organizer = makeAddr("organizer");
    address scanner = makeAddr("scanner");
    address treasury = makeAddr("treasury");
    address alice;
    uint256 aliceKey;
    address bob;
    uint256 bobKey;
    uint256 eventId;

    function setUp() public {
        vm.warp(T0);
        (alice, aliceKey) = makeAddrAndKey("alice");
        (bob, bobKey) = makeAddrAndKey("bob");
        usdc = new MockUSDC();
        vault = new FloatVault(usdc);
        box = new VeGoc(usdc, vault, treasury, FEE_BPS);
        vault.setBox(address(box));
        eventId = _create(organizer, 4);
        address funder = makeAddr("reserve-funder");
        vm.startPrank(funder);
        usdc.faucet();
        usdc.approve(address(vault), RESERVE);
        vault.fundReserve(eventId, RESERVE); // mock yield for this event comes out of this pot
        vm.stopPrank();
        vm.prank(organizer);
        box.setScanner(eventId, scanner, true);
        for (uint256 i = 0; i < 2; i++) {
            address who = i == 0 ? alice : bob;
            vm.startPrank(who);
            usdc.faucet();
            usdc.approve(address(box), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _create(address org, uint32 maxPerWallet) internal returns (uint256 id) {
        string[] memory names = new string[](2);
        names[0] = "GA";
        names[1] = "VIP";
        uint128[] memory prices = new uint128[](2);
        prices[0] = GA;
        prices[1] = VIP;
        uint32[] memory supplies = new uint32[](2);
        supplies[0] = 5;
        supplies[1] = 2;
        vm.prank(org);
        id = box.createEvent("Demo Night", "Stage A", uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days), maxPerWallet, names, prices, supplies);
    }

    function _sign(uint256 key, uint256 tokenId, uint256 deadline) internal view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("VeGoc"),
                keccak256("1"),
                block.chainid,
                address(box)
            )
        );
        bytes32 structHash = keccak256(abi.encode(keccak256("CheckIn(uint256 tokenId,uint256 deadline)"), tokenId, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _buy(address who, uint256 tier, uint256 qty) internal {
        vm.prank(who);
        box.buy(eventId, tier, qty);
    }

    // ------------------------------------------------------------ create

    function test_createEvent_storesTiersAndOrganizer() public view {
        VeGoc.EventView memory v = box.getEvent(eventId);
        assertEq(v.data.organizer, organizer);
        assertEq(v.tiers.length, 2);
        assertEq(v.tiers[1].price, VIP);
        assertEq(box.eventCount(), 1);
    }

    function test_createEvent_rejectsBadInput() public {
        string[] memory names = new string[](0);
        uint128[] memory prices = new uint128[](0);
        uint32[] memory supplies = new uint32[](0);
        vm.expectRevert(VeGoc.BadTier.selector);
        box.createEvent("X", "Y", uint64(block.timestamp + 1), uint64(block.timestamp + 2), 0, names, prices, supplies);
        vm.expectRevert(VeGoc.BadEvent.selector);
        box.createEvent("X", "Y", uint64(block.timestamp - 10), uint64(block.timestamp - 1), 0, names, prices, supplies);
    }

    function _oneTier(string memory tierName, uint32 supply) internal pure returns (string[] memory n, uint128[] memory p, uint32[] memory q) {
        n = new string[](1);
        n[0] = tierName;
        p = new uint128[](1);
        p[0] = GA;
        q = new uint32[](1);
        q[0] = supply;
    }

    function test_createEvent_boundsTimesAndText() public {
        (string[] memory n, uint128[] memory p, uint32[] memory q) = _oneTier("GA", 10);
        uint64 t = uint64(block.timestamp);
        // Ends more than a year ahead: money would sit in escrow with no way out.
        vm.expectRevert(VeGoc.BadEvent.selector);
        box.createEvent("X", "Y", t + 365 days, t + 365 days + 1, 0, n, p, q);
        // Longer than 30 days.
        vm.expectRevert(VeGoc.BadEvent.selector);
        box.createEvent("X", "Y", t + 1, t + 31 days + 1, 0, n, p, q);
        // Name and venue are capped at 120 bytes.
        string memory long = string(new bytes(121));
        vm.expectRevert(VeGoc.BadEvent.selector);
        box.createEvent(long, "Y", t + 1, t + 2, 0, n, p, q);
        vm.expectRevert(VeGoc.BadEvent.selector);
        box.createEvent("X", long, t + 1, t + 2, 0, n, p, q);
        vm.expectRevert(VeGoc.BadEvent.selector);
        box.createEvent("", "Y", t + 1, t + 2, 0, n, p, q);
        // The longest allowed values pass.
        box.createEvent(string(new bytes(120)), string(new bytes(120)), t + 1, t + 30 days + 1, 0, n, p, q);
    }

    function test_createEvent_rejectsBadTiers() public {
        uint64 t = uint64(block.timestamp);
        (string[] memory n, uint128[] memory p, uint32[] memory q) = _oneTier("GA", 0);
        vm.expectRevert(VeGoc.BadTier.selector); // zero supply
        box.createEvent("X", "Y", t + 1, t + 2, 0, n, p, q);
        (n, p, q) = _oneTier("", 5);
        vm.expectRevert(VeGoc.BadTier.selector); // unnamed tier
        box.createEvent("X", "Y", t + 1, t + 2, 0, n, p, q);
        (n, p, q) = _oneTier(string(new bytes(33)), 5);
        vm.expectRevert(VeGoc.BadTier.selector); // tier name over 32 bytes
        box.createEvent("X", "Y", t + 1, t + 2, 0, n, p, q);
        string[] memory five = new string[](5);
        vm.expectRevert(VeGoc.BadTier.selector); // more than 4 tiers
        box.createEvent("X", "Y", t + 1, t + 2, 0, five, new uint128[](5), new uint32[](5));
    }

    function test_constructor_rejectsBadFee() public {
        vm.expectRevert(VeGoc.BadFee.selector);
        new VeGoc(usdc, vault, treasury, 1_001);
        vm.expectRevert(VeGoc.BadFee.selector);
        new VeGoc(usdc, vault, address(0), 300);
        new VeGoc(usdc, vault, address(0), 0);
    }

    // ------------------------------------------------------------ primary sale

    function test_buy_movesUsdcIntoVaultUnderTheEvent() public {
        _buy(alice, 0, 2);
        assertEq(box.balanceOf(alice), 2);
        assertEq(usdc.balanceOf(alice), 1_000e6 - 2 * GA);
        assertEq(usdc.balanceOf(address(vault)), 2 * GA + RESERVE);
        assertEq(usdc.balanceOf(address(box)), 0);
        assertEq(vault.principalOf(eventId), 2 * GA);
        assertEq(box.getEvent(eventId).data.sales, 2 * GA);
        assertEq(box.getTicket(0).paid, GA);
    }

    function test_buy_enforcesWalletLimit() public {
        _buy(alice, 0, 3);
        vm.expectRevert(VeGoc.WalletLimit.selector);
        _buy(alice, 1, 2);
        _buy(alice, 1, 1);
    }

    function test_buy_enforcesTierSupply() public {
        _buy(alice, 1, 2);
        vm.expectRevert(VeGoc.SoldOut.selector);
        _buy(bob, 1, 1);
    }

    function test_buy_withoutAllowanceFails() public {
        address carol = makeAddr("carol");
        vm.prank(carol);
        usdc.faucet();
        vm.prank(carol);
        vm.expectRevert();
        box.buy(eventId, 0, 1);
    }

    function test_buyWithPermit_oneTransaction() public {
        (address carol, uint256 carolKey) = makeAddrAndKey("carol");
        vm.prank(carol);
        usdc.faucet();
        uint256 deadline = block.timestamp + 600;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"), carol, address(box), uint256(GA), usdc.nonces(carol), deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(carolKey, digest);
        vm.prank(carol);
        box.buyWithPermit(eventId, 0, 1, deadline, v, r, s);
        assertEq(box.balanceOf(carol), 1);
        assertEq(vault.principalOf(eventId), GA);
    }

    function test_issue_onlyOrganizer_paysNothing() public {
        vm.expectRevert(VeGoc.NotOrganizer.selector);
        box.issue(eventId, 0, bob, 1);
        vm.prank(organizer);
        box.issue(eventId, 0, bob, 1);
        assertEq(box.getTicket(0).paid, 0);
        assertEq(vault.principalOf(eventId), 0);
    }

    // ------------------------------------------------------------ transfers blocked

    function test_transferOutsideMarket_blocked() public {
        _buy(alice, 0, 1);
        vm.startPrank(alice);
        vm.expectRevert(VeGoc.TransferBlocked.selector);
        box.transferFrom(alice, bob, 0);
        vm.expectRevert(VeGoc.TransferBlocked.selector);
        box.safeTransferFrom(alice, bob, 0);
        box.approve(bob, 0);
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(VeGoc.TransferBlocked.selector);
        box.transferFrom(alice, bob, 0);
    }

    // ------------------------------------------------------------ resale

    function test_list_capIsFacePlusTenPercent() public {
        _buy(alice, 0, 1);
        assertEq(box.resaleCap(0), 27_500_000);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VeGoc.AboveCap.selector, 27_500_000));
        box.list(0, 27_500_001);
        vm.prank(alice);
        box.list(0, 27_500_000);
        assertEq(box.getTicket(0).listPrice, 27_500_000);
        assertEq(box.getEvent(eventId).listed, 1);
    }

    function testFuzz_list_neverAboveCap(uint256 price) public {
        _buy(alice, 1, 1);
        uint256 cap = (uint256(VIP) * 11) / 10;
        vm.prank(alice);
        if (price == 0 || price > cap) vm.expectRevert(abi.encodeWithSelector(VeGoc.AboveCap.selector, cap));
        box.list(0, price);
    }

    function test_list_onlyHolder() public {
        _buy(alice, 0, 1);
        vm.prank(bob);
        vm.expectRevert(VeGoc.NotHolder.selector);
        box.list(0, GA);
    }

    function test_buyListing_paysSellerAndMovesTicket() public {
        _buy(alice, 0, 1);
        vm.prank(alice);
        box.list(0, 27e6);
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        box.buyListing(0, 27e6);
        assertEq(box.ownerOf(0), bob);
        assertEq(usdc.balanceOf(alice), aliceBefore + 27e6);
        assertEq(usdc.balanceOf(bob), bobBefore - 27e6);
        assertEq(vault.principalOf(eventId), GA); // the float is untouched by resale
        VeGoc.EventView memory v = box.getEvent(eventId);
        assertEq(v.data.resales, 1);
        assertEq(v.data.resaleVolume, 27e6);
        assertEq(v.listed, 0);
        assertEq(box.getTicket(0).listPrice, 0);
    }

    function test_buyListing_guardsAgainstPriceRaise() public {
        _buy(alice, 0, 1);
        vm.prank(alice);
        box.list(0, 26e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(VeGoc.PriceChanged.selector, 26e6));
        box.buyListing(0, 25e6);
    }

    function test_buyListing_rejectsUnlistedAndOwn() public {
        _buy(alice, 0, 1);
        vm.prank(bob);
        vm.expectRevert(VeGoc.NotListed.selector);
        box.buyListing(0, 30e6);
        vm.prank(alice);
        box.list(0, 25e6);
        vm.prank(alice);
        vm.expectRevert(VeGoc.OwnListing.selector);
        box.buyListing(0, 30e6);
        vm.prank(alice);
        box.unlist(0);
        vm.prank(bob);
        vm.expectRevert(VeGoc.NotListed.selector);
        box.buyListing(0, 30e6);
    }

    // ------------------------------------------------------------ check-in

    function test_checkIn_currentHolderOnly_thenLocked() public {
        _buy(alice, 0, 1);
        uint256 deadline = block.timestamp + 180;
        bytes memory oldQr = _sign(aliceKey, 0, deadline);
        vm.prank(alice);
        box.list(0, 25e6);
        vm.prank(bob);
        box.buyListing(0, 25e6);

        vm.prank(scanner);
        vm.expectRevert(VeGoc.InvalidSignature.selector);
        box.checkIn(0, deadline, oldQr);

        bytes memory qr = _sign(bobKey, 0, deadline);
        vm.prank(scanner);
        box.checkIn(0, deadline, qr);
        assertTrue(box.checkedIn(0));

        vm.prank(scanner);
        vm.expectRevert(VeGoc.AlreadyCheckedIn.selector);
        box.checkIn(0, deadline, qr);

        vm.prank(bob);
        vm.expectRevert(VeGoc.TicketUsed.selector);
        box.list(0, 25e6);
    }

    function test_checkIn_rules() public {
        _buy(alice, 0, 1);
        uint256 deadline = block.timestamp + 180;
        bytes memory qr = _sign(aliceKey, 0, deadline);
        vm.expectRevert(VeGoc.NotScanner.selector);
        box.checkIn(0, deadline, qr);
        vm.warp(deadline + 1);
        vm.prank(scanner);
        vm.expectRevert(VeGoc.SignatureExpired.selector);
        box.checkIn(0, deadline, qr);
    }

    function test_checkIn_refusesDeadlineMoreThanFiveMinutesAhead() public {
        _buy(alice, 0, 1);
        uint256 tooFar = block.timestamp + 5 minutes + 1;
        bytes memory qr = _sign(aliceKey, 0, tooFar);
        vm.prank(scanner);
        vm.expectRevert(VeGoc.DeadlineTooFar.selector);
        box.checkIn(0, tooFar, qr);
        uint256 edge = block.timestamp + 5 minutes;
        bytes memory ok = _sign(aliceKey, 0, edge);
        vm.prank(scanner);
        box.checkIn(0, edge, ok);
        assertTrue(box.checkedIn(0));
    }

    function test_checkIn_closesWhenTheEventEnds() public {
        _buy(alice, 0, 1);
        vm.warp(END);
        uint256 deadline = END + 180;
        bytes memory qr = _sign(aliceKey, 0, deadline);
        vm.prank(scanner);
        vm.expectRevert(VeGoc.EventEnded.selector);
        box.checkIn(0, deadline, qr);
    }

    function test_checkIn_rejectsMalformedSignature() public {
        _buy(alice, 0, 1);
        uint256 deadline = block.timestamp + 180;
        vm.startPrank(scanner);
        vm.expectRevert(VeGoc.InvalidSignature.selector);
        box.checkIn(0, deadline, hex"1234");
        vm.expectRevert(VeGoc.InvalidSignature.selector);
        box.checkIn(0, deadline, new bytes(65));
        vm.stopPrank();
    }

    // ------------------------------------------------------------ holders are plain wallets

    function test_contractsCannotReceiveTickets() public {
        (address owner,) = makeAddrAndKey("wallet-owner");
        SmartWallet w = new SmartWallet(owner);
        // free ticket to a contract
        vm.prank(organizer);
        vm.expectRevert(VeGoc.HolderNotWallet.selector);
        box.issue(eventId, 0, address(w), 1);
        // primary purchase by a contract
        vm.prank(alice);
        usdc.transfer(address(w), GA);
        vm.expectRevert(VeGoc.HolderNotWallet.selector);
        w.buy(box, IERC20(address(usdc)), eventId, 0);
        // resale purchase by a contract
        _buy(alice, 0, 1);
        vm.prank(alice);
        box.list(0, GA);
        vm.startPrank(address(w));
        usdc.approve(address(box), GA);
        vm.expectRevert(VeGoc.HolderNotWallet.selector);
        box.buyListing(0, GA);
        vm.stopPrank();
    }

    function test_contractThatBoughtInItsConstructorCannotEnter() public {
        (address owner, uint256 key) = makeAddrAndKey("wallet-owner");
        bytes memory init = abi.encodePacked(type(ConstructorBuyer).creationCode, abi.encode(box, usdc, eventId, owner));
        address predicted = vm.computeCreate2Address(bytes32(0), keccak256(init), address(this));
        vm.prank(alice);
        usdc.transfer(predicted, GA);
        ConstructorBuyer w = new ConstructorBuyer{salt: bytes32(0)}(box, IERC20(address(usdc)), eventId, owner);
        assertEq(address(w), predicted);
        assertEq(box.ownerOf(0), address(w)); // code size was zero during the constructor
        uint256 deadline = block.timestamp + 180;
        bytes memory qr = _sign(key, 0, deadline);
        vm.prank(scanner);
        vm.expectRevert(VeGoc.InvalidSignature.selector); // ERC-1271 is not consulted
        box.checkIn(0, deadline, qr);
    }

    function test_compsCannotBeListed() public {
        vm.prank(organizer);
        box.issue(eventId, 0, bob, 1);
        vm.prank(bob);
        vm.expectRevert(VeGoc.CompNotResellable.selector);
        box.list(0, GA);
        // a comp still gets its holder through the gate
        uint256 deadline = block.timestamp + 180;
        bytes memory qr = _sign(bobKey, 0, deadline);
        vm.prank(scanner);
        box.checkIn(0, deadline, qr);
        assertEq(box.getEvent(eventId).paidCheckedIn, 0); // and does not count towards the quorum
    }

    function test_checkIn_clearsListing() public {
        _buy(alice, 0, 1);
        vm.prank(alice);
        box.list(0, 25e6);
        uint256 deadline = block.timestamp + 180;
        vm.prank(scanner);
        box.checkIn(0, deadline, _sign(aliceKey, 0, deadline));
        assertEq(box.getEvent(eventId).listed, 0);
    }

    // ------------------------------------------------------------ cancel and refund

    function test_cancel_refundsFaceValueToCurrentHolder() public {
        _buy(alice, 0, 1);
        vm.prank(alice);
        box.list(0, 27e6);
        vm.prank(bob);
        box.buyListing(0, 27e6);
        _buy(alice, 1, 1);

        vm.prank(organizer);
        box.cancelEvent(eventId);

        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        box.claimRefund(0);
        assertEq(usdc.balanceOf(bob), bobBefore + GA);
        assertEq(box.balanceOf(bob), 0);

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 0; // already refunded: skipped
        ids[1] = 1;
        box.refundMany(ids);
        assertEq(usdc.balanceOf(alice), aliceBefore + VIP);
        assertEq(vault.principalOf(eventId), 0);
        assertEq(box.getEvent(eventId).data.refunded, 2);
    }

    function test_cancel_blocksSalesMarketAndGate() public {
        _buy(alice, 0, 1);
        vm.prank(organizer);
        box.cancelEvent(eventId);
        vm.expectRevert(VeGoc.EventCancelled.selector);
        _buy(bob, 0, 1);
        vm.prank(alice);
        vm.expectRevert(VeGoc.EventCancelled.selector);
        box.list(0, 25e6);
        uint256 deadline = block.timestamp + 180;
        bytes memory qr = _sign(aliceKey, 0, deadline);
        vm.prank(scanner);
        vm.expectRevert(VeGoc.EventCancelled.selector);
        box.checkIn(0, deadline, qr);
    }

    function test_refund_requiresCancel_andHolder() public {
        _buy(alice, 0, 1);
        vm.prank(alice);
        vm.expectRevert(VeGoc.NotRefundable.selector);
        box.claimRefund(0);
        vm.prank(organizer);
        box.cancelEvent(eventId);
        vm.prank(bob);
        vm.expectRevert(VeGoc.NotHolder.selector);
        box.claimRefund(0);
    }

    function test_cancel_compsRefundNothing() public {
        vm.prank(organizer);
        box.issue(eventId, 0, bob, 1);
        vm.prank(organizer);
        box.cancelEvent(eventId);
        uint256 before = usdc.balanceOf(bob);
        vm.prank(bob);
        box.claimRefund(0);
        assertEq(usdc.balanceOf(bob), before);
    }

    function test_cancel_onlyOrganizer_onlyBeforeEnd() public {
        vm.expectRevert(VeGoc.NotOrganizer.selector);
        box.cancelEvent(eventId);
        vm.warp(T0 + 3 days);
        vm.prank(organizer);
        vm.expectRevert(VeGoc.EventEnded.selector);
        box.cancelEvent(eventId);
    }

    // ------------------------------------------------------------ float, yield, settle

    function _checkIn(uint256 key, uint256 tokenId) internal {
        uint256 deadline = vm.getBlockTimestamp() + 180;
        bytes memory qr = _sign(key, tokenId, deadline);
        vm.prank(scanner);
        box.checkIn(tokenId, deadline, qr);
    }

    function test_settle_afterAShowThatHappened_paysPrincipalMinusFeePlusYield() public {
        _buy(alice, 0, 4);
        vm.prank(organizer);
        vm.expectRevert(VeGoc.EventNotEnded.selector);
        box.settle(eventId, organizer);

        vm.warp(DOORS); // the show is on
        _checkIn(aliceKey, 0); // 1 of 4 paid tickets scanned: not yet half
        assertFalse(box.quorumMet(eventId));
        _checkIn(aliceKey, 1); // 2 of 4 = the 50 % quorum
        assertTrue(box.quorumMet(eventId));

        vm.warp(END); // endsAt
        assertEq(box.settleOpensAt(eventId), END);
        uint256 yieldNow = vault.yieldOf(eventId);
        assertEq(yieldNow, (uint256(4 * GA) * 500 * 2 days) / (10_000 * 365 days)); // principal x 5 % x time / year
        vm.prank(organizer);
        box.settle(eventId, organizer);
        uint256 fee = (uint256(4 * GA) * FEE_BPS) / 10_000; // 3 USDC
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(organizer), 4 * GA - fee + yieldNow);
        assertEq(vault.principalOf(eventId), 0);
        assertEq(vault.reserve(), RESERVE - yieldNow); // yield came out of the reserve, nothing was minted
        assertEq(vault.reserveOf(eventId), RESERVE - yieldNow);
        assertEq(usdc.balanceOf(address(vault)), vault.totalPrincipal() + vault.reserve());

        vm.prank(organizer);
        vm.expectRevert(VeGoc.AlreadySettled.selector);
        box.settle(eventId, organizer);
        // a holder who stayed home has no refund once the show happened
        vm.prank(alice);
        vm.expectRevert(VeGoc.NotRefundable.selector);
        box.claimRefund(2);
    }

    function test_settle_afterCancel_onlyYield_principalStaysForRefunds() public {
        _buy(alice, 0, 2);
        vm.warp(T0 + 12 hours);
        vm.prank(organizer);
        box.cancelEvent(eventId);
        uint256 frozen = vault.yieldOf(eventId);
        assertEq(frozen, (uint256(2 * GA) * 500 * 12 hours) / (10_000 * 365 days));
        vm.warp(T0 + 30 days); // sitting on the refunds earns nothing more
        assertEq(vault.yieldOf(eventId), frozen);
        vm.prank(organizer);
        box.settle(eventId, organizer);
        assertEq(usdc.balanceOf(organizer), frozen);
        assertEq(usdc.balanceOf(treasury), 0); // no platform fee on a cancelled event
        assertEq(vault.principalOf(eventId), 2 * GA);
        vm.prank(organizer);
        box.settle(eventId, organizer); // a second call finds nothing
        assertEq(usdc.balanceOf(organizer), frozen);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 0;
        ids[1] = 1;
        box.refundMany(ids);
        assertEq(usdc.balanceOf(alice), 1_000e6);
        assertEq(usdc.balanceOf(address(vault)), vault.totalPrincipal() + vault.reserve());
    }

    // ------------------------------------------------------------ no-show

    function test_noShow_holdersRefund_organizerWaits48h_thenGetsOnlyTheRest() public {
        _buy(alice, 0, 2); // tickets 0, 1
        _buy(bob, 0, 1); // ticket 2
        vm.warp(END); // endsAt: nobody was scanned
        assertFalse(box.quorumMet(eventId));
        assertTrue(box.refundOpen(eventId));
        assertEq(box.settleOpensAt(eventId), END + 48 hours);

        vm.prank(organizer);
        vm.expectRevert(abi.encodeWithSelector(VeGoc.DisputeWindow.selector, END + 48 hours));
        box.settle(eventId, organizer);
        vm.prank(organizer);
        vm.expectRevert(VeGoc.EventEnded.selector); // too late to cancel, and no need to
        box.cancelEvent(eventId);

        vm.prank(alice);
        box.claimRefund(0);
        assertEq(usdc.balanceOf(alice), 1_000e6 - GA);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        vm.prank(makeAddr("bystander")); // anyone can push a refund to its holder
        box.refundMany(ids);
        assertEq(usdc.balanceOf(alice), 1_000e6);

        vm.warp(END + 48 hours);
        vm.prank(organizer);
        box.settle(eventId, organizer); // bob never claimed: only his 25 USDC are left
        uint256 fee = (uint256(GA) * FEE_BPS) / 10_000;
        assertEq(usdc.balanceOf(treasury), fee);
        assertGe(usdc.balanceOf(organizer), GA - fee);
        assertEq(vault.principalOf(eventId), 0);
        vm.prank(bob);
        vm.expectRevert(VeGoc.NotRefundable.selector);
        box.claimRefund(2);
    }

    function test_noShow_belowQuorum_scannedHoldersKeepNoClaim() public {
        // 6 paid tickets, 1 scanned = 16.7 %, below the 50 % quorum
        _buy(alice, 0, 3); // 0, 1, 2
        _buy(bob, 0, 2); // 3, 4
        _buy(bob, 1, 1); // 5 (VIP)
        vm.warp(DOORS);
        _checkIn(aliceKey, 0);
        vm.warp(END);
        assertFalse(box.quorumMet(eventId));
        vm.prank(alice);
        vm.expectRevert(VeGoc.TicketUsed.selector); // alice got in with ticket 0
        box.claimRefund(0);
        uint256[] memory ids = new uint256[](6);
        for (uint256 i = 0; i < 6; i++) ids[i] = i;
        box.refundMany(ids); // skips the scanned ticket
        assertEq(box.ownerOf(0), alice);
        assertEq(usdc.balanceOf(alice), 1_000e6 - GA);
        assertEq(usdc.balanceOf(bob), 1_000e6);
        assertEq(vault.principalOf(eventId), GA);
    }

    function test_noShow_compsDoNotMakeAQuorum() public {
        _buy(alice, 0, 2);
        vm.prank(organizer);
        box.issue(eventId, 0, bob, 3); // tokens 2, 3, 4, free
        vm.warp(DOORS);
        _checkIn(bobKey, 2);
        _checkIn(bobKey, 3);
        _checkIn(bobKey, 4);
        vm.warp(END);
        assertFalse(box.quorumMet(eventId)); // 0 of 2 paid tickets
        vm.prank(alice);
        box.claimRefund(0);
        assertEq(usdc.balanceOf(alice), 1_000e6 - GA);
    }

    function test_refundMany_isCappedAndNeedsARefundState() public {
        _buy(alice, 0, 1);
        uint256[] memory one = new uint256[](1);
        vm.expectRevert(VeGoc.NotRefundable.selector);
        box.refundMany(one);
        vm.expectRevert(VeGoc.BatchTooLarge.selector);
        box.refundMany(new uint256[](101));
    }

    // ------------------------------------------------------------ mock yield reserve

    function test_yield_isPaidFromTheReserve_neverFromPrincipal() public {
        // A second vault with an almost empty reserve: yield is paid as far as the reserve goes.
        FloatVault v2 = new FloatVault(usdc);
        VeGoc b2 = new VeGoc(usdc, v2, treasury, 0);
        v2.setBox(address(b2));
        (string[] memory n, uint128[] memory p, uint32[] memory q) = _oneTier("GA", 10);
        vm.prank(organizer);
        uint256 id = b2.createEvent("Thin", "Reserve", uint64(T0 + 1), uint64(T0 + 30 days), 0, n, p, q);
        vm.startPrank(alice);
        usdc.approve(address(b2), type(uint256).max);
        b2.buy(id, 0, 4);
        usdc.approve(address(v2), 1000);
        v2.fundReserve(id, 1000); // 0.001 USDC
        vm.stopPrank();
        vm.warp(T0 + 20 days);
        vm.prank(organizer);
        b2.cancelEvent(id);
        uint256 owed = v2.yieldOf(id);
        assertGt(owed, 1000);
        vm.prank(organizer);
        b2.settle(id, organizer);
        assertEq(usdc.balanceOf(organizer), 1000); // all the reserve had
        assertEq(v2.yieldOf(id), owed - 1000); // the rest stays owed
        assertEq(v2.reserve(), 0);
        assertEq(usdc.balanceOf(address(v2)), 4 * GA); // principal untouched
        vm.prank(alice);
        b2.claimRefund(0);
        assertEq(usdc.balanceOf(address(v2)), 3 * GA);
    }

    function testFuzz_vaultStaysSolvent(uint8 buys, uint8 refunds, uint32 wait, bool cancel) public {
        uint256 nBuy = bound(buys, 1, 4);
        uint256 nRefund = bound(refunds, 0, nBuy);
        _buy(alice, 0, nBuy);
        vm.warp(T0 + bound(wait, 1, 1 days - 1));
        if (cancel) {
            vm.prank(organizer);
            box.cancelEvent(eventId);
        } else {
            vm.warp(END); // ended with nobody scanned
        }
        for (uint256 i = 0; i < nRefund; i++) {
            vm.prank(alice);
            box.claimRefund(i);
        }
        assertEq(usdc.balanceOf(alice), 1_000e6 - (nBuy - nRefund) * GA);
        if (!cancel) vm.warp(END + 48 hours);
        vm.prank(organizer);
        box.settle(eventId, organizer);
        assertEq(vault.principalOf(eventId), cancel ? (nBuy - nRefund) * GA : 0);
        assertEq(usdc.balanceOf(address(vault)), vault.totalPrincipal() + vault.reserve());
        assertEq(usdc.balanceOf(alice) + usdc.balanceOf(organizer) + usdc.balanceOf(treasury) + usdc.balanceOf(address(vault)), 1_000e6 + RESERVE);
    }

    function test_settle_onlyOrganizer() public {
        vm.warp(T0 + 3 days);
        vm.prank(alice);
        vm.expectRevert(VeGoc.NotOrganizer.selector);
        box.settle(eventId, alice);
    }

    function test_vault_onlyBoxMovesMoney() public {
        _buy(alice, 0, 1);
        vm.expectRevert(FloatVault.NotBox.selector);
        vault.withdraw(eventId, GA, alice);
        vm.expectRevert(FloatVault.NotBox.selector);
        vault.withdrawYield(eventId, alice);
        vm.expectRevert(FloatVault.NotBox.selector);
        vault.freeze(eventId);
        vm.expectRevert(FloatVault.NotBox.selector);
        vault.deposit(eventId, 1);
        vm.expectRevert(FloatVault.AlreadyWired.selector);
        vault.setBox(alice);
    }

    function test_eventsAreIsolated() public {
        uint256 other = _create(bob, 0);
        _buy(alice, 0, 1);
        vm.prank(alice);
        box.buy(other, 0, 1);
        vm.prank(bob);
        box.cancelEvent(other);
        assertEq(vault.principalOf(eventId), GA);
        vm.prank(organizer);
        vm.expectRevert(VeGoc.NotOrganizer.selector);
        box.setScanner(other, scanner, true);
        uint256 deadline = block.timestamp + 180;
        bytes memory qr = _sign(aliceKey, 1, deadline);
        vm.prank(scanner); // a gate wallet of one event cannot scan another event's tickets
        vm.expectRevert(VeGoc.NotScanner.selector);
        box.checkIn(1, deadline, qr);
    }

    // ------------------------------------------------------------ views + faucet

    function test_views_ticketsOfAndListings() public {
        _buy(alice, 0, 2);
        _buy(bob, 1, 1);
        vm.prank(alice);
        box.list(1, 26e6);
        VeGoc.TicketView[] memory mine = box.ticketsOf(alice);
        assertEq(mine.length, 2);
        assertEq(mine[1].listPrice, 26e6);
        VeGoc.TicketView[] memory market = box.listings(eventId);
        assertEq(market.length, 1);
        assertEq(market[0].tokenId, 1);
        assertEq(box.getEvents().length, 1);
    }

    function test_faucet_cooldown() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.FaucetCooldown.selector, T0 + 5 minutes));
        usdc.faucet();
        vm.warp(T0 + 5 minutes);
        vm.prank(alice);
        usdc.faucet();
        assertEq(usdc.balanceOf(alice), 2_000e6);
    }

    function test_scannerFor_countsEvents() public {
        assertEq(box.scannerFor(scanner), 1);
        vm.prank(organizer);
        box.setScanner(eventId, scanner, true); // no double count
        assertEq(box.scannerFor(scanner), 1);
        vm.prank(organizer);
        box.setScanner(eventId, scanner, false);
        assertEq(box.scannerFor(scanner), 0);
    }
}
