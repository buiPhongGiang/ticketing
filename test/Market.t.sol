// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {FloatVault} from "../src/FloatVault.sol";
import {VeGoc} from "../src/VeGoc.sol";

/// @notice Waitlist (resale goes to the first in line), relayed purchase (`buyFor`) and event extension.
contract MarketTest is Test {
    uint128 constant GA = 25e6;
    uint128 constant VIP = 60e6;
    uint256 constant CAP = 27_500_000; // GA face + 10 %
    uint256 constant T0 = 1_800_000_000;
    uint256 constant END = T0 + 2 days;

    MockUSDC usdc;
    FloatVault vault;
    VeGoc box;
    address organizer = makeAddr("organizer");
    address scanner = makeAddr("scanner");
    address treasury = makeAddr("treasury");
    address relayer = makeAddr("relayer");
    address seller;
    uint256 sellerKey;
    address ann;
    uint256 annKey;
    address ben;
    address cho;
    uint256 eventId;

    function setUp() public {
        vm.warp(T0);
        usdc = new MockUSDC();
        vault = new FloatVault(usdc);
        box = new VeGoc(usdc, vault, treasury, 300);
        vault.setBox(address(box));
        string[] memory names = new string[](2);
        names[0] = "GA";
        names[1] = "VIP";
        uint128[] memory prices = new uint128[](2);
        prices[0] = GA;
        prices[1] = VIP;
        uint32[] memory supplies = new uint32[](2);
        supplies[0] = 50;
        supplies[1] = 5;
        vm.prank(organizer);
        eventId = box.createEvent("Demo Night", "Stage A", uint64(T0 + 1 days), uint64(END), 4, names, prices, supplies);
        vm.prank(organizer);
        box.setScanner(eventId, scanner, true);
        (seller, sellerKey) = _wallet("seller");
        (ann, annKey) = _wallet("ann");
        (ben,) = _wallet("ben");
        (cho,) = _wallet("cho");
        vm.prank(seller);
        box.buy(eventId, 0, 2); // tickets 0 and 1
    }

    function _wallet(string memory name) internal returns (address a, uint256 k) {
        (a, k) = makeAddrAndKey(name);
        vm.startPrank(a);
        usdc.faucet();
        usdc.approve(address(box), type(uint256).max);
        vm.stopPrank();
    }

    function _domain() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("VeGoc"),
                keccak256("1"),
                block.chainid,
                address(box)
            )
        );
    }

    function _qr(uint256 key, uint256 tokenId, uint256 deadline) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(keccak256("CheckIn(uint256 tokenId,uint256 deadline)"), tokenId, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", _domain(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------ waitlist

    function test_waitlist_joinPaysInTheCap_andKeepsOrder() public {
        vm.prank(ann);
        box.joinWaitlist(eventId, 0);
        vm.prank(ben);
        box.joinWaitlist(eventId, 0);
        assertEq(usdc.balanceOf(ann), 1_000e6 - CAP);
        assertEq(usdc.balanceOf(address(box)), 2 * CAP); // deposits sit in the ticket contract, not in the float
        assertEq(box.waitlistFunds(), 2 * CAP);
        assertEq(box.waiting(eventId, 0), 2);
        assertEq(box.getEvent(eventId).waiting[0], 2);
        assertEq(box.getEvent(eventId).waiting[1], 0);
        (uint256 position, uint256 deposit) = box.waitlistPlace(eventId, 0, ben);
        assertEq(position, 2);
        assertEq(deposit, CAP);
        (position,) = box.waitlistPlace(eventId, 0, cho);
        assertEq(position, 0);
        vm.prank(ann);
        vm.expectRevert(VeGoc.AlreadyWaiting.selector);
        box.joinWaitlist(eventId, 0);
    }

    function test_waitlist_aListingGoesToTheFirstInLine_atTheSellersPrice() public {
        vm.prank(ann);
        box.joinWaitlist(eventId, 0);
        vm.prank(ben);
        box.joinWaitlist(eventId, 0);
        uint256 sellerBefore = usdc.balanceOf(seller);

        vm.prank(seller);
        box.list(0, 26e6); // below the cap
        assertEq(box.ownerOf(0), ann); // the seller did not choose; ann waited longest
        assertEq(usdc.balanceOf(seller), sellerBefore + 26e6);
        assertEq(box.getTicket(0).listPrice, 0);
        assertEq(box.getEvent(eventId).listed, 0);
        assertEq(box.getEvent(eventId).data.resales, 1);
        assertEq(box.getEvent(eventId).data.resaleVolume, 26e6);
        assertEq(box.credit(ann), CAP - 26e6); // what the deposit exceeded the price by
        assertEq(box.waiting(eventId, 0), 1);
        (uint256 position,) = box.waitlistPlace(eventId, 0, ben);
        assertEq(position, 1); // ben is next
        assertEq(usdc.balanceOf(address(box)), box.waitlistFunds());

        vm.prank(ann);
        box.withdrawCredit();
        assertEq(usdc.balanceOf(ann), 1_000e6 - 26e6);
        assertEq(box.credit(ann), 0);
        assertEq(usdc.balanceOf(address(box)), CAP); // only ben's deposit is left
        assertEq(vault.principalOf(eventId), 2 * GA); // the float is untouched by resale

        // ann can use the ticket: her signature opens the gate
        vm.warp(T0 + 1 days + 1 hours);
        uint256 deadline = T0 + 1 days + 1 hours + 180;
        bytes memory qr = _qr(annKey, 0, deadline);
        vm.prank(scanner);
        box.checkIn(0, deadline, qr);
        assertTrue(box.checkedIn(0));
    }

    function test_waitlist_noJoiningWhileAListingIsOpen_noBuyingPastTheLine() public {
        vm.prank(seller);
        box.list(0, CAP); // nobody is waiting: the listing stays open
        assertEq(box.getTicket(0).listPrice, CAP);
        vm.prank(ann);
        vm.expectRevert(VeGoc.ListingsOpen.selector); // nothing to wait for: buy it
        box.joinWaitlist(eventId, 0);
        vm.prank(ann);
        box.joinWaitlist(eventId, 1); // another tier has its own line
        vm.prank(ann);
        box.buyListing(0, CAP);
        assertEq(box.ownerOf(0), ann);
    }

    function test_waitlist_leaveReturnsTheDeposit_andTheLineSkipsThePlace() public {
        vm.prank(ann);
        box.joinWaitlist(eventId, 0);
        vm.prank(ben);
        box.joinWaitlist(eventId, 0);
        vm.prank(ann);
        box.leaveWaitlist(eventId, 0);
        assertEq(usdc.balanceOf(ann), 1_000e6);
        assertEq(box.waiting(eventId, 0), 1);
        vm.prank(ann);
        vm.expectRevert(VeGoc.NotWaiting.selector);
        box.leaveWaitlist(eventId, 0);
        vm.prank(seller);
        box.list(0, CAP);
        assertEq(box.ownerOf(0), ben);
        assertEq(box.credit(ben), 0);
        assertEq(box.waiting(eventId, 0), 0);
        assertEq(usdc.balanceOf(address(box)), 0);
        // ann may queue again, at the back
        vm.prank(ann);
        box.joinWaitlist(eventId, 0);
        (uint256 position,) = box.waitlistPlace(eventId, 0, ann);
        assertEq(position, 1);
    }

    function test_waitlist_depositComesBackAfterTheEventEndsOrIsCancelled() public {
        vm.prank(ann);
        box.joinWaitlist(eventId, 0);
        vm.prank(organizer);
        box.cancelEvent(eventId);
        vm.prank(ben);
        vm.expectRevert(VeGoc.EventCancelled.selector);
        box.joinWaitlist(eventId, 0);
        vm.prank(ann);
        box.leaveWaitlist(eventId, 0);
        assertEq(usdc.balanceOf(ann), 1_000e6);
    }

    function test_waitlist_contractsCannotQueue_andAWalletThatGotCodeIsPassedOver() public {
        vm.prank(ann);
        box.joinWaitlist(eventId, 0);
        vm.prank(ben);
        box.joinWaitlist(eventId, 0);
        vm.etch(ann, hex"00"); // ann's address has code now (an EIP-7702 delegation looks like this)
        vm.prank(seller);
        box.list(0, CAP);
        assertEq(box.ownerOf(0), ben); // the ticket skipped ann
        assertEq(box.credit(ann), CAP); // and her deposit is hers to take back
        vm.prank(ann);
        box.withdrawCredit();
        assertEq(usdc.balanceOf(ann), 1_000e6);
        vm.prank(ann);
        vm.expectRevert(VeGoc.HolderNotWallet.selector);
        box.joinWaitlist(eventId, 0);
    }

    function test_waitlist_aSellerCannotStandInTheSameLine() public {
        vm.prank(seller);
        box.joinWaitlist(eventId, 0);
        vm.prank(seller);
        vm.expectRevert(VeGoc.AlreadyWaiting.selector);
        box.list(0, CAP);
    }

    function test_waitlist_manyLeftPlaces_matchListingFinishesTheJob() public {
        // 33 wallets queue and leave; then ann queues. One `list` looks at 32 places only.
        for (uint256 i = 0; i < 33; i++) {
            (address w,) = _wallet(string.concat("ghost", vm.toString(i)));
            vm.prank(w);
            box.joinWaitlist(eventId, 0);
            vm.prank(w);
            box.leaveWaitlist(eventId, 0);
        }
        vm.prank(ann);
        box.joinWaitlist(eventId, 0);
        vm.prank(seller);
        box.list(0, CAP);
        assertEq(box.ownerOf(0), seller); // not matched yet
        vm.prank(ben);
        vm.expectRevert(VeGoc.WaitlistFirst.selector); // ben cannot take it while ann waits
        box.buyListing(0, CAP);
        vm.prank(ben);
        box.matchListing(0); // anyone can push the line forward
        assertEq(box.ownerOf(0), ann);
        assertEq(usdc.balanceOf(address(box)), box.waitlistFunds());
        vm.expectRevert(VeGoc.NotListed.selector);
        box.matchListing(0);
    }

    function test_waitlist_joinWithPermit_oneTransaction() public {
        (address dee, uint256 deeKey) = makeAddrAndKey("dee");
        vm.prank(dee);
        usdc.faucet();
        uint256 deadline = T0 + 600;
        bytes32 structHash = keccak256(
            abi.encode(keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"), dee, address(box), CAP, usdc.nonces(dee), deadline)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(deeKey, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(dee);
        box.joinWaitlistWithPermit(eventId, 0, deadline, v, r, s);
        assertEq(box.waiting(eventId, 0), 1);
        assertEq(usdc.balanceOf(dee), 1_000e6 - CAP);
    }

    function testFuzz_waitlist_fundsAlwaysMatchTheBalance(uint8 joiners, uint8 leavers, uint96 price) public {
        uint256 nJoin = bound(joiners, 0, 6);
        uint256 nLeave = bound(leavers, 0, nJoin);
        uint256 p = bound(price, 1, CAP);
        address[] memory ws = new address[](nJoin);
        for (uint256 i = 0; i < nJoin; i++) {
            (ws[i],) = _wallet(string.concat("fan", vm.toString(i)));
            vm.prank(ws[i]);
            box.joinWaitlist(eventId, 0);
        }
        for (uint256 i = 0; i < nLeave; i++) {
            vm.prank(ws[i]);
            box.leaveWaitlist(eventId, 0);
        }
        vm.prank(seller);
        box.list(0, p);
        if (nJoin > nLeave) {
            assertEq(box.ownerOf(0), ws[nLeave]); // the first who stayed
            assertEq(box.credit(ws[nLeave]), CAP - p);
        } else {
            assertEq(box.ownerOf(0), seller);
        }
        assertEq(usdc.balanceOf(address(box)), box.waitlistFunds());
        assertEq(box.waiting(eventId, 0), nJoin > nLeave ? nJoin - nLeave - 1 : 0);
    }

    // ------------------------------------------------------------ relayed purchase

    function _buySig(uint256 key, address buyer, uint256 tier, uint256 qty, uint256 nonce, uint256 deadline) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Buy(address buyer,uint256 eventId,uint256 tier,uint256 quantity,uint256 nonce,uint256 deadline)"),
                buyer,
                eventId,
                tier,
                qty,
                nonce,
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", _domain(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _permitSig(uint256 key, address owner, uint256 value, uint256 deadline) internal view returns (VeGoc.PermitSig memory p) {
        bytes32 structHash = keccak256(
            abi.encode(keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"), owner, address(box), value, usdc.nonces(owner), deadline)
        );
        (p.v, p.r, p.s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
    }

    function test_buyFor_relayerPaysGas_buyerNeedsNoCoin() public {
        (address fan, uint256 fanKey) = makeAddrAndKey("gasless-fan");
        vm.prank(ann);
        usdc.transfer(fan, 100e6); // the fan holds USDC and nothing else
        assertEq(fan.balance, 0);
        uint256 deadline = T0 + 600;
        bytes memory sig = _buySig(fanKey, fan, 0, 2, 0, deadline);
        VeGoc.PermitSig memory permit = _permitSig(fanKey, fan, 2 * GA, deadline);

        vm.prank(relayer);
        box.buyFor(fan, eventId, 0, 2, deadline, sig, permit);
        assertEq(box.balanceOf(fan), 2);
        assertEq(box.ownerOf(2), fan);
        assertEq(usdc.balanceOf(fan), 100e6 - 2 * GA);
        assertEq(usdc.balanceOf(relayer), 0); // the relayer touches no money
        assertEq(vault.principalOf(eventId), 4 * GA);
        assertEq(box.boughtBy(eventId, fan), 2); // the wallet limit is counted on the buyer
        assertEq(box.nonces(fan), 1);

        // the same signatures cannot be sent twice
        vm.prank(relayer);
        vm.expectRevert(VeGoc.InvalidSignature.selector);
        box.buyFor(fan, eventId, 0, 2, deadline, sig, permit);
    }

    function test_buyFor_theRelayerCannotChangeTheOrder() public {
        (address fan, uint256 fanKey) = makeAddrAndKey("gasless-fan");
        vm.prank(ann);
        usdc.transfer(fan, 200e6);
        uint256 deadline = T0 + 600;
        bytes memory sig = _buySig(fanKey, fan, 0, 1, 0, deadline);
        VeGoc.PermitSig memory permit = _permitSig(fanKey, fan, GA, deadline);
        vm.startPrank(relayer);
        vm.expectRevert(VeGoc.InvalidSignature.selector); // more tickets
        box.buyFor(fan, eventId, 0, 2, deadline, sig, permit);
        vm.expectRevert(VeGoc.InvalidSignature.selector); // dearer tier
        box.buyFor(fan, eventId, 1, 1, deadline, sig, permit);
        vm.expectRevert(VeGoc.InvalidSignature.selector); // someone else's wallet
        box.buyFor(ben, eventId, 0, 1, deadline, sig, permit);
        vm.expectRevert(VeGoc.InvalidSignature.selector); // longer validity
        box.buyFor(fan, eventId, 0, 1, deadline + 1, sig, permit);
        vm.stopPrank();
        vm.warp(deadline + 1);
        vm.prank(relayer);
        vm.expectRevert(VeGoc.SignatureExpired.selector);
        box.buyFor(fan, eventId, 0, 1, deadline, sig, permit);
        assertEq(box.balanceOf(fan), 0);
        assertEq(usdc.balanceOf(fan), 200e6);
    }

    function test_buyFor_respectsTheWalletLimit() public {
        (address fan, uint256 fanKey) = makeAddrAndKey("gasless-fan");
        vm.prank(ann);
        usdc.transfer(fan, 200e6);
        uint256 deadline = T0 + 600;
        bytes memory sig = _buySig(fanKey, fan, 0, 5, 0, deadline);
        VeGoc.PermitSig memory permit = _permitSig(fanKey, fan, 5 * GA, deadline);
        vm.prank(relayer);
        vm.expectRevert(VeGoc.WalletLimit.selector);
        box.buyFor(fan, eventId, 0, 5, deadline, sig, permit);
    }

    // ------------------------------------------------------------ extending a running event

    function test_extendEvent_keepsTheGateOpen_upTo24Hours() public {
        vm.prank(ann);
        vm.expectRevert(VeGoc.NotOrganizer.selector);
        box.extendEvent(eventId, uint64(END + 1 hours));
        vm.startPrank(organizer);
        vm.expectRevert(VeGoc.BadEvent.selector); // not earlier
        box.extendEvent(eventId, uint64(END));
        vm.expectRevert(VeGoc.BadEvent.selector); // more than 24 hours
        box.extendEvent(eventId, uint64(END + 24 hours + 1));
        box.extendEvent(eventId, uint64(END + 12 hours));
        vm.stopPrank();
        assertEq(box.getEvent(eventId).data.endsAt, END + 12 hours);

        // the gate was down until after the original end: scanning still works and counts
        vm.warp(END + 1 hours);
        uint256 deadline = END + 1 hours + 180;
        bytes memory qr = _qr(sellerKey, 0, deadline);
        vm.prank(scanner);
        box.checkIn(0, deadline, qr);
        assertTrue(box.quorumMet(eventId)); // 1 of 2 paid tickets

        vm.startPrank(organizer);
        vm.expectRevert(VeGoc.BadEvent.selector); // 12 h used, 13 h more is over the limit
        box.extendEvent(eventId, uint64(END + 25 hours));
        box.extendEvent(eventId, uint64(END + 24 hours));
        vm.stopPrank();
        vm.warp(END + 24 hours);
        vm.prank(organizer);
        vm.expectRevert(VeGoc.EventEnded.selector); // an ended event cannot be reopened
        box.extendEvent(eventId, uint64(END + 24 hours + 1));
    }
}
