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

/// @notice The four attacks the round-1 security review demonstrated against the first deployment
///         (0x9516fd26…161d6e). Each test runs the same steps and asserts where the contract now stops them.
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
}
