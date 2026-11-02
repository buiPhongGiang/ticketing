// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {EventTicket} from "../src/EventTicket.sol";

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

contract RefusesPayment {}

contract EventTicketTest is Test {
    uint256 constant PRICE = 1 ether;
    uint256 constant SUPPLY = 3;

    EventTicket ticket;
    address organizer = makeAddr("organizer");
    address scanner = makeAddr("scanner");
    address alice;
    uint256 aliceKey;
    address bob;
    uint256 bobKey;

    function setUp() public {
        (alice, aliceKey) = makeAddrAndKey("alice");
        (bob, bobKey) = makeAddrAndKey("bob");
        ticket = new EventTicket("Show", "SHOW", SUPPLY, PRICE, organizer);
        vm.prank(organizer);
        ticket.setScanner(scanner, true);
        vm.deal(alice, 10 ether);
    }

    // Built here rather than via the contract, so a wrong EIP-712 layout in the contract fails the tests.
    function _sign(EventTicket t, uint256 key, uint256 tokenId, uint256 deadline) internal view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("EventTicket"),
                keccak256("1"),
                block.chainid,
                address(t)
            )
        );
        bytes32 structHash = keccak256(abi.encode(keccak256("CheckIn(uint256 tokenId,uint256 deadline)"), tokenId, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _mintTo(address to) internal returns (uint256 tokenId) {
        tokenId = ticket.totalMinted();
        vm.prank(organizer);
        ticket.mint(to, 1);
    }

    function _deadline() internal view returns (uint256) {
        return block.timestamp + 60;
    }

    // --- issuing ---

    function test_mint_issuesSequentialTicketsToRecipient() public {
        vm.prank(organizer);
        ticket.mint(alice, 2);
        assertEq(ticket.ownerOf(0), alice);
        assertEq(ticket.ownerOf(1), alice);
        assertEq(ticket.totalMinted(), 2);
    }

    function test_mint_rejectsNonOrganizer() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        ticket.mint(alice, 1);
    }

    function test_mint_rejectsAboveMaxSupply() public {
        vm.prank(organizer);
        vm.expectRevert(EventTicket.SoldOut.selector);
        ticket.mint(alice, 4);
    }

    // --- primary sale ---

    function test_buy_issuesTicketsForExactPayment() public {
        vm.prank(alice);
        ticket.buy{value: 2 ether}(2);
        assertEq(ticket.ownerOf(0), alice);
        assertEq(ticket.ownerOf(1), alice);
        assertEq(address(ticket).balance, 2 ether);
    }

    function test_buy_rejectsUnderpayment() public {
        vm.prank(alice);
        vm.expectRevert(EventTicket.WrongPayment.selector);
        ticket.buy{value: 1 ether}(2);
    }

    function test_buy_rejectsOverpayment() public {
        vm.prank(alice);
        vm.expectRevert(EventTicket.WrongPayment.selector);
        ticket.buy{value: 3 ether}(2);
    }

    function test_buy_rejectsAboveMaxSupply() public {
        vm.prank(alice);
        vm.expectRevert(EventTicket.SoldOut.selector);
        ticket.buy{value: 4 ether}(4);
    }

    function test_buy_isClosedWhenPriceIsZero() public {
        EventTicket free = new EventTicket("Free", "FREE", SUPPLY, 0, organizer);
        vm.prank(alice);
        vm.expectRevert(EventTicket.SaleClosed.selector);
        free.buy(1);
    }

    // --- the core promise: only the last holder gets in ---

    function test_checkIn_acceptsCurrentHolder() public {
        uint256 id = _mintTo(alice);
        uint256 deadline = _deadline();
        bytes memory sig = _sign(ticket, aliceKey, id, deadline);

        vm.expectEmit(true, true, true, true);
        emit EventTicket.CheckedIn(id, alice, scanner);
        vm.prank(scanner);
        ticket.checkIn(id, deadline, sig);

        assertTrue(ticket.checkedIn(id));
    }

    function test_checkIn_rejectsSignatureMadeBeforeTheTicketWasSold() public {
        uint256 id = _mintTo(alice);
        uint256 deadline = _deadline();
        bytes memory oldQr = _sign(ticket, aliceKey, id, deadline);

        vm.prank(alice);
        ticket.transferFrom(alice, bob, id);

        vm.prank(scanner);
        vm.expectRevert(EventTicket.InvalidSignature.selector);
        ticket.checkIn(id, deadline, oldQr);
        assertFalse(ticket.checkedIn(id));
    }

    function test_checkIn_acceptsLastHolderAfterResale() public {
        uint256 id = _mintTo(alice);
        vm.prank(alice);
        ticket.transferFrom(alice, bob, id);

        uint256 deadline = _deadline();
        bytes memory sig = _sign(ticket, bobKey, id, deadline);
        vm.prank(scanner);
        ticket.checkIn(id, deadline, sig);

        assertTrue(ticket.checkedIn(id));
    }

    function test_checkIn_rejectsSecondEntry() public {
        uint256 id = _mintTo(alice);
        uint256 deadline = _deadline();
        bytes memory sig = _sign(ticket, aliceKey, id, deadline);
        vm.startPrank(scanner);
        ticket.checkIn(id, deadline, sig);
        vm.expectRevert(EventTicket.AlreadyCheckedIn.selector);
        ticket.checkIn(id, deadline, sig);
        vm.stopPrank();
    }

    function test_checkIn_rejectsExpiredSignature() public {
        uint256 id = _mintTo(alice);
        uint256 deadline = _deadline();
        bytes memory sig = _sign(ticket, aliceKey, id, deadline);
        vm.warp(deadline + 1);
        vm.prank(scanner);
        vm.expectRevert(EventTicket.SignatureExpired.selector);
        ticket.checkIn(id, deadline, sig);
    }

    function test_checkIn_acceptsSignatureAtExactDeadline() public {
        uint256 id = _mintTo(alice);
        uint256 deadline = _deadline();
        bytes memory sig = _sign(ticket, aliceKey, id, deadline);
        vm.warp(deadline);
        vm.prank(scanner);
        ticket.checkIn(id, deadline, sig);
        assertTrue(ticket.checkedIn(id));
    }

    function test_checkIn_rejectsCallerWhoIsNotScanner() public {
        uint256 id = _mintTo(alice);
        uint256 deadline = _deadline();
        bytes memory sig = _sign(ticket, aliceKey, id, deadline);
        vm.prank(alice);
        vm.expectRevert(EventTicket.NotScanner.selector);
        ticket.checkIn(id, deadline, sig);
    }

    function test_checkIn_rejectsRemovedScanner() public {
        uint256 id = _mintTo(alice);
        vm.prank(organizer);
        ticket.setScanner(scanner, false);
        uint256 deadline = _deadline();
        bytes memory sig = _sign(ticket, aliceKey, id, deadline);
        vm.prank(scanner);
        vm.expectRevert(EventTicket.NotScanner.selector);
        ticket.checkIn(id, deadline, sig);
    }

    function test_checkIn_rejectsSignatureForAnotherTicket() public {
        uint256 first = _mintTo(alice);
        uint256 second = _mintTo(alice);
        uint256 deadline = _deadline();
        bytes memory sig = _sign(ticket, aliceKey, first, deadline);
        vm.prank(scanner);
        vm.expectRevert(EventTicket.InvalidSignature.selector);
        ticket.checkIn(second, deadline, sig);
    }

    function test_checkIn_rejectsDeadlineTamperedAfterSigning() public {
        uint256 id = _mintTo(alice);
        uint256 deadline = _deadline();
        bytes memory sig = _sign(ticket, aliceKey, id, deadline);
        vm.prank(scanner);
        vm.expectRevert(EventTicket.InvalidSignature.selector);
        ticket.checkIn(id, deadline + 1 days, sig);
    }

    function test_checkIn_rejectsSignatureFromAnotherEvent() public {
        EventTicket other = new EventTicket("Other", "OTHER", SUPPLY, PRICE, organizer);
        uint256 id = _mintTo(alice);
        uint256 deadline = _deadline();
        bytes memory sig = _sign(other, aliceKey, id, deadline);
        vm.prank(scanner);
        vm.expectRevert(EventTicket.InvalidSignature.selector);
        ticket.checkIn(id, deadline, sig);
    }

    function test_checkIn_acceptsSmartContractWalletHolder() public {
        SmartWallet wallet = new SmartWallet(bob);
        uint256 id = _mintTo(address(wallet));
        uint256 deadline = _deadline();
        bytes memory sig = _sign(ticket, bobKey, id, deadline);
        vm.prank(scanner);
        ticket.checkIn(id, deadline, sig);
        assertTrue(ticket.checkedIn(id));
    }

    // --- after entry the ticket is dead ---

    function test_transfer_isBlockedAfterCheckIn() public {
        uint256 id = _mintTo(alice);
        uint256 deadline = _deadline();
        bytes memory sig = _sign(ticket, aliceKey, id, deadline);
        vm.prank(scanner);
        ticket.checkIn(id, deadline, sig);

        vm.prank(alice);
        vm.expectRevert(EventTicket.TicketUsed.selector);
        ticket.transferFrom(alice, bob, id);
        assertEq(ticket.ownerOf(id), alice);
    }

    // --- admin ---

    function test_setScanner_rejectsNonOrganizer() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        ticket.setScanner(alice, true);
    }

    function test_withdraw_sendsSaleProceedsToRecipient() public {
        vm.prank(alice);
        ticket.buy{value: 2 ether}(2);
        address payable treasury = payable(makeAddr("treasury"));
        vm.prank(organizer);
        ticket.withdraw(treasury);
        assertEq(treasury.balance, 2 ether);
        assertEq(address(ticket).balance, 0);
    }

    function test_withdraw_revertsWhenRecipientRefusesPayment() public {
        vm.prank(alice);
        ticket.buy{value: 1 ether}(1);
        address payable refuses = payable(address(new RefusesPayment()));
        vm.prank(organizer);
        vm.expectRevert(EventTicket.WithdrawFailed.selector);
        ticket.withdraw(refuses);
        assertEq(address(ticket).balance, 1 ether);
    }

    function test_withdraw_rejectsNonOrganizer() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        ticket.withdraw(payable(alice));
    }
}
