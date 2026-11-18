// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {FloatVault} from "../src/FloatVault.sol";
import {TicketBox} from "../src/TicketBox.sol";

contract SmartWallet is IERC1271 {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        (bytes32 r, bytes32 s) = abi.decode(sig[:64], (bytes32, bytes32));
        return ecrecover(hash, uint8(sig[64]), r, s) == signer ? IERC1271.isValidSignature.selector : bytes4(0);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

contract TicketBoxTest is Test {
    uint128 constant GA = 25e6; // 25 USDC
    uint128 constant VIP = 60e6;

    MockUSDC usdc;
    FloatVault vault;
    TicketBox box;
    address organizer = makeAddr("organizer");
    address scanner = makeAddr("scanner");
    address alice;
    uint256 aliceKey;
    address bob;
    uint256 bobKey;
    uint256 eventId;

    function setUp() public {
        vm.warp(1_800_000_000);
        (alice, aliceKey) = makeAddrAndKey("alice");
        (bob, bobKey) = makeAddrAndKey("bob");
        usdc = new MockUSDC();
        vault = new FloatVault(usdc);
        box = new TicketBox(usdc, vault);
        vault.setBox(address(box));
        usdc.setMinter(address(vault));
        eventId = _create(organizer, 4);
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
                keccak256("TicketBox"),
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
        TicketBox.EventView memory v = box.getEvent(eventId);
        assertEq(v.data.organizer, organizer);
        assertEq(v.tiers.length, 2);
        assertEq(v.tiers[1].price, VIP);
        assertEq(box.eventCount(), 1);
    }

    function test_createEvent_rejectsBadInput() public {
        string[] memory names = new string[](0);
        uint128[] memory prices = new uint128[](0);
        uint32[] memory supplies = new uint32[](0);
        vm.expectRevert(TicketBox.BadTier.selector);
        box.createEvent("X", "Y", uint64(block.timestamp + 1), uint64(block.timestamp + 2), 0, names, prices, supplies);
        vm.expectRevert(TicketBox.BadEvent.selector);
        box.createEvent("X", "Y", uint64(block.timestamp - 10), uint64(block.timestamp - 1), 0, names, prices, supplies);
    }

    // ------------------------------------------------------------ primary sale

    function test_buy_movesUsdcIntoVaultUnderTheEvent() public {
        _buy(alice, 0, 2);
        assertEq(box.balanceOf(alice), 2);
        assertEq(usdc.balanceOf(alice), 1_000e6 - 2 * GA);
        assertEq(usdc.balanceOf(address(vault)), 2 * GA);
        assertEq(usdc.balanceOf(address(box)), 0);
        assertEq(vault.principalOf(eventId), 2 * GA);
        assertEq(box.getEvent(eventId).data.sales, 2 * GA);
        assertEq(box.getTicket(0).paid, GA);
    }

    function test_buy_enforcesWalletLimit() public {
        _buy(alice, 0, 3);
        vm.expectRevert(TicketBox.WalletLimit.selector);
        _buy(alice, 1, 2);
        _buy(alice, 1, 1);
    }

    function test_buy_enforcesTierSupply() public {
        _buy(alice, 1, 2);
        vm.expectRevert(TicketBox.SoldOut.selector);
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
        vm.expectRevert(TicketBox.NotOrganizer.selector);
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
        vm.expectRevert(TicketBox.TransferBlocked.selector);
        box.transferFrom(alice, bob, 0);
        vm.expectRevert(TicketBox.TransferBlocked.selector);
        box.safeTransferFrom(alice, bob, 0);
        box.approve(bob, 0);
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(TicketBox.TransferBlocked.selector);
        box.transferFrom(alice, bob, 0);
    }

    // ------------------------------------------------------------ resale

    function test_list_capIsFacePlusTenPercent() public {
        _buy(alice, 0, 1);
        assertEq(box.resaleCap(0), 27_500_000);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TicketBox.AboveCap.selector, 27_500_000));
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
        if (price == 0 || price > cap) vm.expectRevert(abi.encodeWithSelector(TicketBox.AboveCap.selector, cap));
        box.list(0, price);
    }

    function test_list_onlyHolder() public {
        _buy(alice, 0, 1);
        vm.prank(bob);
        vm.expectRevert(TicketBox.NotHolder.selector);
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
        TicketBox.EventView memory v = box.getEvent(eventId);
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
        vm.expectRevert(abi.encodeWithSelector(TicketBox.PriceChanged.selector, 26e6));
        box.buyListing(0, 25e6);
    }

    function test_buyListing_rejectsUnlistedAndOwn() public {
        _buy(alice, 0, 1);
        vm.prank(bob);
        vm.expectRevert(TicketBox.NotListed.selector);
        box.buyListing(0, 30e6);
        vm.prank(alice);
        box.list(0, 25e6);
        vm.prank(alice);
        vm.expectRevert(TicketBox.OwnListing.selector);
        box.buyListing(0, 30e6);
        vm.prank(alice);
        box.unlist(0);
        vm.prank(bob);
        vm.expectRevert(TicketBox.NotListed.selector);
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
        vm.expectRevert(TicketBox.InvalidSignature.selector);
        box.checkIn(0, deadline, oldQr);

        bytes memory qr = _sign(bobKey, 0, deadline);
        vm.prank(scanner);
        box.checkIn(0, deadline, qr);
        assertTrue(box.checkedIn(0));

        vm.prank(scanner);
        vm.expectRevert(TicketBox.AlreadyCheckedIn.selector);
        box.checkIn(0, deadline, qr);

        vm.prank(bob);
        vm.expectRevert(TicketBox.TicketUsed.selector);
        box.list(0, 25e6);
    }

    function test_checkIn_rules() public {
        _buy(alice, 0, 1);
        uint256 deadline = block.timestamp + 180;
        bytes memory qr = _sign(aliceKey, 0, deadline);
        vm.expectRevert(TicketBox.NotScanner.selector);
        box.checkIn(0, deadline, qr);
        vm.warp(deadline + 1);
        vm.prank(scanner);
        vm.expectRevert(TicketBox.SignatureExpired.selector);
        box.checkIn(0, deadline, qr);
    }

    function test_checkIn_smartWalletHolder() public {
        (address owner, uint256 key) = makeAddrAndKey("wallet-owner");
        SmartWallet w = new SmartWallet(owner);
        vm.prank(organizer);
        box.issue(eventId, 0, address(w), 1);
        uint256 deadline = block.timestamp + 180;
        vm.prank(scanner);
        box.checkIn(0, deadline, _sign(key, 0, deadline));
        assertTrue(box.checkedIn(0));
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
        vm.expectRevert(TicketBox.EventCancelled.selector);
        _buy(bob, 0, 1);
        vm.prank(alice);
        vm.expectRevert(TicketBox.EventCancelled.selector);
        box.list(0, 25e6);
        uint256 deadline = block.timestamp + 180;
        bytes memory qr = _sign(aliceKey, 0, deadline);
        vm.prank(scanner);
        vm.expectRevert(TicketBox.EventCancelled.selector);
        box.checkIn(0, deadline, qr);
    }

    function test_refund_requiresCancel_andHolder() public {
        _buy(alice, 0, 1);
        vm.prank(alice);
        vm.expectRevert(TicketBox.NotCancelled.selector);
        box.claimRefund(0);
        vm.prank(organizer);
        box.cancelEvent(eventId);
        vm.prank(bob);
        vm.expectRevert(TicketBox.NotHolder.selector);
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
        vm.expectRevert(TicketBox.NotOrganizer.selector);
        box.cancelEvent(eventId);
        vm.warp(block.timestamp + 3 days);
        vm.prank(organizer);
        vm.expectRevert(TicketBox.EventEnded.selector);
        box.cancelEvent(eventId);
    }

    // ------------------------------------------------------------ float, yield, settle

    function test_settle_afterEnd_paysPrincipalPlusYield() public {
        _buy(alice, 0, 4);
        vm.prank(organizer);
        vm.expectRevert(TicketBox.EventNotEnded.selector);
        box.settle(eventId, organizer);

        vm.warp(block.timestamp + 365 days);
        uint256 expectedYield = (uint256(4 * GA) * 500) / 10_000; // 5 % of 100 USDC over a year
        assertEq(vault.yieldOf(eventId), expectedYield);
        vm.prank(organizer);
        box.settle(eventId, organizer);
        assertEq(usdc.balanceOf(organizer), 4 * GA + expectedYield);
        assertEq(vault.principalOf(eventId), 0);

        vm.prank(organizer);
        vm.expectRevert(TicketBox.AlreadySettled.selector);
        box.settle(eventId, organizer);
    }

    function test_settle_afterCancel_onlyYield_principalStaysForRefunds() public {
        _buy(alice, 0, 2);
        vm.warp(block.timestamp + 12 hours);
        vm.prank(organizer);
        box.cancelEvent(eventId);
        vm.prank(organizer);
        box.settle(eventId, organizer);
        assertGt(usdc.balanceOf(organizer), 0);
        assertEq(vault.principalOf(eventId), 2 * GA);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 0;
        ids[1] = 1;
        box.refundMany(ids);
        assertEq(usdc.balanceOf(alice), 1_000e6);
    }

    function test_settle_onlyOrganizer() public {
        vm.warp(block.timestamp + 3 days);
        vm.prank(alice);
        vm.expectRevert(TicketBox.NotOrganizer.selector);
        box.settle(eventId, alice);
    }

    function test_vault_onlyBoxMovesMoney() public {
        _buy(alice, 0, 1);
        vm.expectRevert(FloatVault.NotBox.selector);
        vault.withdraw(eventId, GA, alice);
        vm.expectRevert(FloatVault.NotBox.selector);
        vault.withdrawYield(eventId, alice);
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
        vm.expectRevert(TicketBox.NotOrganizer.selector);
        box.setScanner(other, scanner, true);
        uint256 deadline = block.timestamp + 180;
        bytes memory qr = _sign(aliceKey, 1, deadline);
        vm.prank(scanner); // a gate wallet of one event cannot scan another event's tickets
        vm.expectRevert(TicketBox.NotScanner.selector);
        box.checkIn(1, deadline, qr);
    }

    // ------------------------------------------------------------ views + faucet

    function test_views_ticketsOfAndListings() public {
        _buy(alice, 0, 2);
        _buy(bob, 1, 1);
        vm.prank(alice);
        box.list(1, 26e6);
        TicketBox.TicketView[] memory mine = box.ticketsOf(alice);
        assertEq(mine.length, 2);
        assertEq(mine[1].listPrice, 26e6);
        TicketBox.TicketView[] memory market = box.listings(eventId);
        assertEq(market.length, 1);
        assertEq(market[0].tokenId, 1);
        assertEq(box.getEvents().length, 1);
    }

    function test_faucet_cooldownAndMinterLock() public {
        vm.prank(alice);
        vm.expectRevert();
        usdc.faucet();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        usdc.faucet();
        vm.expectRevert(MockUSDC.NotMinter.selector);
        usdc.mint(alice, 1);
        vm.expectRevert(MockUSDC.MinterAlreadySet.selector);
        usdc.setMinter(alice);
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
