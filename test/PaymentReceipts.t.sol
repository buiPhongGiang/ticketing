// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {PaymentReceipts} from "../src/PaymentReceipts.sol";

contract PaymentReceiptsTest is Test {
    PaymentReceipts receipts;
    address relayer = address(0xBEEF);
    address stranger = address(0xCAFE);
    bytes32 salt = keccak256("salt");

    event PaymentRecorded(
        uint256 indexed tokenId, PaymentReceipts.Kind kind, bytes32 indexed receiptHash, address indexed recorder
    );

    function setUp() public {
        address[] memory r = new address[](1);
        r[0] = relayer;
        receipts = new PaymentReceipts(r);
    }

    function _ids(uint256 a, uint256 b) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
    }

    function test_hashMatchesTheFormulaTheAppUses() public view {
        bytes32 h = receipts.hashOf("VG7K2M9QXA", 780_000, salt);
        assertEq(h, keccak256(abi.encodePacked("VG7K2M9QXA", uint256(780_000), salt)));
        assertTrue(h != receipts.hashOf("VG7K2M9QXA", 780_001, salt), "amount is part of the hash");
        assertTrue(h != receipts.hashOf("VG7K2M9QXB", 780_000, salt), "bank code is part of the hash");
        assertTrue(h != receipts.hashOf("VG7K2M9QXA", 780_000, bytes32(uint256(1))), "salt is part of the hash");
    }

    function test_recorderTiesOnePaymentToEveryTicketOfTheOrder() public {
        bytes32 h = receipts.hashOf("VG7K2M9QXA", 780_000, salt);
        vm.warp(1_795_300_000);
        vm.expectEmit(true, true, true, true);
        emit PaymentRecorded(145, PaymentReceipts.Kind.Purchase, h, relayer);
        vm.expectEmit(true, true, true, true);
        emit PaymentRecorded(146, PaymentReceipts.Kind.Purchase, h, relayer);
        vm.prank(relayer);
        receipts.record(_ids(145, 146), PaymentReceipts.Kind.Purchase, h);

        assertTrue(receipts.recorded(h));
        assertEq(receipts.count(), 1);
        PaymentReceipts.Receipt[] memory a = receipts.receiptsOf(145);
        assertEq(a.length, 1);
        assertEq(a[0].receiptHash, h);
        assertEq(uint8(a[0].kind), uint8(PaymentReceipts.Kind.Purchase));
        assertEq(a[0].at, 1_795_300_000);
        assertEq(receipts.receiptsOf(146)[0].receiptHash, h);
        assertEq(receipts.receiptsOf(147).length, 0);
    }

    function test_onlyARecorderCanRecord() public {
        bytes32 h = receipts.hashOf("VG1", 1, salt);
        vm.prank(stranger);
        vm.expectRevert(PaymentReceipts.NotRecorder.selector);
        receipts.record(_ids(1, 2), PaymentReceipts.Kind.Purchase, h);
        assertFalse(receipts.recorded(h));
    }

    function test_aReceiptIsRecordedOnce() public {
        bytes32 h = receipts.hashOf("VG1", 390_000, salt);
        vm.startPrank(relayer);
        receipts.record(_ids(1, 2), PaymentReceipts.Kind.Purchase, h);
        vm.expectRevert(PaymentReceipts.AlreadyRecorded.selector);
        receipts.record(_ids(3, 4), PaymentReceipts.Kind.Purchase, h);
        vm.stopPrank();
        assertEq(receipts.receiptsOf(3).length, 0);
    }

    function test_aTicketCollectsOneRecordPerPayment() public {
        uint256[] memory one = new uint256[](1);
        one[0] = 7;
        vm.startPrank(relayer);
        receipts.record(one, PaymentReceipts.Kind.Purchase, receipts.hashOf("VG1", 390_000, salt));
        receipts.record(one, PaymentReceipts.Kind.Resale, receipts.hashOf("VG2", 429_000, salt));
        receipts.record(one, PaymentReceipts.Kind.RefundPayout, receipts.hashOf("HT3", 390_000, salt));
        vm.stopPrank();
        PaymentReceipts.Receipt[] memory all = receipts.receiptsOf(7);
        assertEq(all.length, 3);
        assertEq(uint8(all[1].kind), uint8(PaymentReceipts.Kind.Resale));
        assertEq(uint8(all[2].kind), uint8(PaymentReceipts.Kind.RefundPayout));
        assertEq(receipts.count(), 3);
    }

    function test_refusesEmptyInput() public {
        uint256[] memory none = new uint256[](0);
        vm.startPrank(relayer);
        vm.expectRevert(PaymentReceipts.NoTickets.selector);
        receipts.record(none, PaymentReceipts.Kind.Purchase, bytes32(uint256(1)));
        vm.expectRevert(PaymentReceipts.EmptyHash.selector);
        receipts.record(_ids(1, 2), PaymentReceipts.Kind.Purchase, bytes32(0));
        uint256[] memory many = new uint256[](21);
        vm.expectRevert(PaymentReceipts.TooMany.selector);
        receipts.record(many, PaymentReceipts.Kind.Purchase, bytes32(uint256(2)));
        vm.stopPrank();
    }

    function testFuzz_differentInputsGiveDifferentHashes(string calldata code, uint256 amount, bytes32 s) public view {
        vm.assume(amount < type(uint256).max);
        assertTrue(receipts.hashOf(code, amount, s) != receipts.hashOf(code, amount + 1, s));
    }
}
