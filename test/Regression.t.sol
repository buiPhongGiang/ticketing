// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {FloatVault} from "../src/FloatVault.sol";
import {VeGoc} from "../src/VeGoc.sol";

/// A ticket-holding wrapper whose controller can be handed over for any price (from the round-1 security review).
contract ScalperWrapper is IERC1271 {
    address public controller;

    constructor() {
        controller = msg.sender;
    }

    function buy(VeGoc box, IERC20 usdc, uint256 eventId, uint256 tier) external {
        require(msg.sender == controller);
        usdc.approve(address(box), type(uint256).max);
        box.buy(eventId, tier, 1);
    }

    /// Off-market sale: pay `price` USDC to the old controller, become the controller. No cap anywhere.
    function sell(IERC20 usdc, address to, uint256 price) external {
        require(msg.sender == controller);
        usdc.transferFrom(to, controller, price);
        controller = to;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        (bytes32 r, bytes32 s) = abi.decode(sig[:64], (bytes32, bytes32));
        return ecrecover(hash, uint8(sig[64]), r, s) == controller ? IERC1271.isValidSignature.selector : bytes4(0);
    }
}

/// Premium escrow from the round-2 review: pays the scalper once the named buyer holds the ticket. It only reads
/// `ownerOf`, so the contract cannot see it.
contract PremiumEscrow {
    function settle(VeGoc box, IERC20 usdc, uint256 tokenId, address buyer, address scalper, uint256 premium) external {
        require(box.ownerOf(tokenId) == buyer, "buyer does not hold it");
        usdc.transferFrom(buyer, scalper, premium);
    }
}

/// @notice The attacks two security reviews demonstrated: A to D against the first deployment
///         (0x9516fd26…161d6e), E to G against the second (0xc5f9302d…b268d). Each test runs the same steps and
///         asserts where the contract now stops them, or how far the attack still gets.
contract RegressionTest is Test {
    uint128 constant GA = 25e6;
    uint256 constant T0 = 1_800_000_000; // absolute times: with via_ir a re-read of block.timestamp after vm.warp can be stale
    MockUSDC usdc;
    FloatVault vault;
    VeGoc box;
    address organizer = makeAddr("organizer");
    address sock = makeAddr("organizerSock");
    address scanner = makeAddr("scanner");
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
        box = new VeGoc(usdc, vault, makeAddr("treasury"), 300);
        vault.setBox(address(box));
        string[] memory names = new string[](1);
        names[0] = "GA";
        uint128[] memory prices = new uint128[](1);
        prices[0] = GA;
        uint32[] memory supplies = new uint32[](1);
        supplies[0] = 5;
        vm.prank(organizer);
        eventId = box.createEvent("Demo", "Stage", uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days), 1, names, prices, supplies);
        vm.prank(organizer);
        box.setScanner(eventId, scanner, true);
        for (uint256 i; i < 2; i++) {
            address w = i == 0 ? alice : bob;
            vm.startPrank(w);
            usdc.faucet();
            usdc.approve(address(box), type(uint256).max);
            vm.stopPrank();
        }
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

    /// A. Was: the organizer sells free comps on the official market, the money skips the vault, and a cancel
    ///    refunds the buyer nothing. Now: a comp cannot be listed, so nobody can pay for a ticket with no escrow.
    function test_A_compResale_isRefused() public {
        vm.prank(organizer);
        box.issue(eventId, 0, sock, 1);
        vm.prank(sock);
        vm.expectRevert(VeGoc.CompNotResellable.selector);
        box.list(0, (GA * 11) / 10);
        vm.prank(bob);
        vm.expectRevert(VeGoc.NotListed.selector);
        box.buyListing(0, (GA * 11) / 10);
        assertEq(usdc.balanceOf(sock), 0);
        assertEq(usdc.balanceOf(bob), 1_000e6);
    }

    /// B. Was: a wrapper contract holds the ticket and its controller is sold at 3x without the NFT moving.
    ///    Now: a contract cannot buy or receive a ticket, and check-in does not consult ERC-1271.
    function test_B_wrapperCannotHoldATicket() public {
        vm.startPrank(alice);
        ScalperWrapper w = new ScalperWrapper();
        usdc.transfer(address(w), GA);
        vm.expectRevert(VeGoc.HolderNotWallet.selector);
        w.buy(box, IERC20(address(usdc)), eventId, 0);
        vm.stopPrank();
        assertEq(box.balanceOf(address(w)), 0);
        assertEq(box.totalMinted(), 0);
        vm.prank(organizer);
        vm.expectRevert(VeGoc.HolderNotWallet.selector);
        box.issue(eventId, 0, address(w), 1);
    }

    /// C. Was: a holder signs a QR that never expires and sells it as a print-at-home ticket.
    ///    Now: the contract refuses any deadline more than five minutes ahead of the block time.
    function test_C_checkIn_deadlineIsBounded() public {
        vm.prank(alice);
        box.buy(eventId, 0, 1);
        bytes memory foreverQr = _sign(aliceKey, 0, type(uint256).max);
        vm.warp(T0 + 1 days + 12 hours);
        vm.prank(scanner);
        vm.expectRevert(VeGoc.DeadlineTooFar.selector);
        box.checkIn(0, type(uint256).max, foreverQr);
        uint256 oneHour = T0 + 1 days + 13 hours;
        bytes memory hourQr = _sign(aliceKey, 0, oneHour);
        vm.prank(scanner);
        vm.expectRevert(VeGoc.DeadlineTooFar.selector);
        box.checkIn(0, oneHour, hourQr);
        assertFalse(box.checkedIn(0));
    }

    /// D. Was: the show never happens, the organizer does not cancel, and after `endsAt` takes the whole float.
    ///    Now: with nobody scanned the organizer is locked out for 48 hours and the buyer takes the money back.
    function test_D_noShow_buyerRefunded_organizerLockedOut() public {
        vm.prank(alice);
        box.buy(eventId, 0, 1);
        uint256 end = T0 + 2 days;
        vm.warp(end);
        vm.prank(organizer);
        vm.expectRevert(abi.encodeWithSelector(VeGoc.DisputeWindow.selector, end + 48 hours));
        box.settle(eventId, organizer);
        vm.prank(alice);
        box.claimRefund(0);
        assertEq(usdc.balanceOf(alice), 1_000e6);
        vm.warp(end + 48 hours);
        vm.prank(organizer);
        box.settle(eventId, organizer);
        assertEq(usdc.balanceOf(organizer), 0);
        assertEq(vault.principalOf(eventId), 0);
    }

    function _fresh(string memory name) internal returns (address a, uint256 k) {
        (a, k) = makeAddrAndKey(name);
        vm.startPrank(a);
        usdc.faucet();
        usdc.approve(address(box), type(uint256).max);
        vm.stopPrank();
    }

    function _event(address org, uint128 price, uint32 supply) internal returns (uint256 id) {
        string[] memory names = new string[](1);
        names[0] = "GA";
        uint128[] memory prices = new uint128[](1);
        prices[0] = price;
        uint32[] memory supplies = new uint32[](1);
        supplies[0] = supply;
        vm.prank(org);
        id = box.createEvent("Round 2", "Stage", uint64(T0 + 1 days), uint64(T0 + 2 days), 1, names, prices, supplies);
        vm.prank(org);
        box.setScanner(id, scanner, true);
    }

    /// E. Was: with a 20 % quorum the organizer's 2 own wallets out of 10 buyers got scanned, the quorum was met and
    ///    the 8 victims could not refund. Now the quorum is half the paid tickets: the same attack leaves the event
    ///    a no-show, the victims refund and the organizer waits 48 hours for nothing.
    function test_E_twoSockWalletsOutOfTen_doNotMakeAQuorum() public {
        uint256 id = _event(organizer, GA, 100);
        address[] memory victims = new address[](8);
        for (uint256 i; i < 8; i++) {
            (victims[i],) = _fresh(string.concat("victim", vm.toString(i)));
            vm.prank(victims[i]);
            box.buy(id, 0, 1); // tickets 0..7
        }
        for (uint256 i; i < 2; i++) {
            (address sock_, uint256 k) = _fresh(string.concat("sock", vm.toString(i)));
            vm.prank(sock_);
            box.buy(id, 0, 1); // tickets 8, 9
            uint256 deadline = T0 + 60;
            bytes memory qr = _sign(k, 8 + i, deadline);
            vm.prank(scanner);
            box.checkIn(8 + i, deadline, qr);
        }
        uint256 end = T0 + 2 days;
        vm.warp(end); // nothing happened
        assertFalse(box.quorumMet(id)); // 2 of 10 scanned
        vm.prank(organizer);
        vm.expectRevert(abi.encodeWithSelector(VeGoc.DisputeWindow.selector, end + 48 hours));
        box.settle(id, organizer);
        for (uint256 i; i < 8; i++) {
            vm.prank(victims[i]);
            box.claimRefund(i);
            assertEq(usdc.balanceOf(victims[i]), 1_000e6);
        }
        vm.warp(end + 48 hours);
        vm.prank(organizer);
        box.settle(id, organizer);
        assertEq(usdc.balanceOf(organizer), (2 * uint256(GA) * 97) / 100); // only the money of the two own tickets, minus the fee
    }

    /// E'. What is left of E: an organizer whose own wallets hold half of the paid tickets still meets the quorum.
    ///     Stated in the README. The victims are then at most half the house.
    function test_E_residual_halfTheHouseInOwnWallets_stillMeetsTheQuorum() public {
        uint256 id = _event(organizer, GA, 100);
        (address victim,) = _fresh("victim");
        vm.prank(victim);
        box.buy(id, 0, 1);
        (address sock_, uint256 k) = _fresh("sock");
        vm.prank(sock_);
        box.buy(id, 0, 1);
        bytes memory qr = _sign(k, 1, T0 + 60);
        vm.prank(scanner);
        box.checkIn(1, T0 + 60, qr);
        vm.warp(T0 + 2 days);
        assertTrue(box.quorumMet(id));
        vm.prank(victim);
        vm.expectRevert(VeGoc.NotRefundable.selector);
        box.claimRefund(0);
    }

    /// F. Was: the scalper lists at the cap for a named buyer and an escrow pays him the premium once that buyer
    ///    holds the ticket. Now a listing goes to the first wallet on the waitlist: with anyone ahead of the named
    ///    buyer in line, the ticket goes there, the escrow never pays and the scalper has sold at the cap.
    function test_F_namedBuyerBehindInLine_getsNothing_escrowNeverPays() public {
        uint256 id = _event(organizer, GA, 100);
        (address scalper,) = _fresh("scalper");
        (address fan,) = _fresh("fan");
        (address stranger,) = _fresh("stranger");
        vm.prank(scalper);
        box.buy(id, 0, 1);
        PremiumEscrow esc = new PremiumEscrow();
        uint256 cap = (uint256(GA) * 11) / 10;
        uint256 premium = 3 * uint256(GA) - cap;
        vm.prank(fan);
        usdc.approve(address(esc), premium);

        vm.prank(stranger);
        box.joinWaitlist(id, 0); // somebody was already waiting for a ticket
        vm.prank(fan);
        box.joinWaitlist(id, 0); // the scalper's customer queues behind
        uint256 before = usdc.balanceOf(scalper);
        vm.prank(scalper);
        box.list(0, cap);
        assertEq(box.ownerOf(0), stranger);
        assertEq(usdc.balanceOf(scalper) - before, cap); // 27.50, not 75
        vm.expectRevert(bytes("buyer does not hold it"));
        esc.settle(box, IERC20(address(usdc)), 0, fan, scalper, premium);
        // and the customer cannot take an open listing past the line either
        vm.prank(fan);
        vm.expectRevert(VeGoc.NotListed.selector);
        box.buyListing(0, cap);
    }

    /// F'. What is left of F: when nobody else is waiting or buying, the named buyer is first by default and the
    ///     side deal goes through. Stated in the README: the cap binds the on-chain price only.
    function test_F_residual_withNoOneElseInLine_theSideDealStillWorks() public {
        uint256 id = _event(organizer, GA, 100);
        (address scalper,) = _fresh("scalper");
        (address fan,) = _fresh("fan");
        vm.prank(scalper);
        box.buy(id, 0, 1);
        PremiumEscrow esc = new PremiumEscrow();
        uint256 cap = (uint256(GA) * 11) / 10;
        uint256 premium = 3 * uint256(GA) - cap;
        vm.prank(fan);
        usdc.approve(address(esc), premium);
        uint256 before = usdc.balanceOf(scalper);
        vm.prank(scalper);
        box.list(0, cap);
        vm.prank(fan);
        box.buyListing(0, cap);
        esc.settle(box, IERC20(address(usdc)), 0, fan, scalper, premium);
        assertEq(usdc.balanceOf(scalper) - before, 3 * uint256(GA));
    }

    /// G. Was: one reserve paid every event's mock yield, so a stranger's self-dealt event collected yield the team
    ///    had funded. Now each event has its own reserve.
    function test_G_anEventOnlyEarnsFromItsOwnReserve() public {
        (address funder,) = _fresh("funder");
        vm.startPrank(funder);
        usdc.approve(address(vault), 500e6);
        vault.fundReserve(eventId, 500e6); // the team's event
        vm.stopPrank();
        address stranger = makeAddr("stranger");
        uint256 id = _event(stranger, 1000e6, 1);
        (address me, uint256 k) = _fresh("strangerBuyer");
        vm.prank(me);
        box.buy(id, 0, 1); // ticket 0
        bytes memory qr = _sign(k, 0, T0 + 60);
        vm.prank(scanner);
        box.checkIn(0, T0 + 60, qr);
        vm.warp(T0 + 2 days);
        assertGt(vault.yieldOf(id), 0);
        vm.prank(stranger);
        box.settle(id, stranger);
        assertEq(usdc.balanceOf(stranger), 970e6); // principal minus the 3 % fee, and no yield
        assertEq(vault.reserve(), 500e6);
        assertEq(vault.reserveOf(eventId), 500e6);
        assertEq(vault.reserveOf(id), 0);
    }
}
