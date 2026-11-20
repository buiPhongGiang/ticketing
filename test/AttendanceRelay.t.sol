// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {FloatVault} from "../src/FloatVault.sol";
import {VeGoc} from "../src/VeGoc.sol";
import {AttendanceRelay} from "../src/icm/AttendanceRelay.sol";
import {AttendanceMirror} from "../src/icm/AttendanceMirror.sol";
import {ITeleporterMessenger, ITeleporterReceiver, TeleporterMessageInput} from "../src/icm/ITeleporter.sol";

/// Stands in for TeleporterMessenger on both chains: delivers each message at once, the way the relayer would.
contract MockTeleporter is ITeleporterMessenger {
    bytes32 public immutable sourceID;
    uint256 public sent;
    TeleporterMessageInput public last;

    constructor(bytes32 sourceID_) {
        sourceID = sourceID_;
    }

    function sendCrossChainMessage(TeleporterMessageInput calldata m) external returns (bytes32 id) {
        sent++;
        last = m;
        id = keccak256(abi.encode(sent, msg.sender));
        ITeleporterReceiver(m.destinationAddress).receiveTeleporterMessage{gas: m.requiredGasLimit}(
            sourceID, msg.sender, m.message
        );
    }
}

contract AttendanceRelayTest is Test {
    bytes32 constant C_CHAIN = keccak256("fuji c-chain");
    bytes32 constant DISPATCH = keccak256("dispatch");
    uint256 constant T0 = 1_800_000_000;

    MockUSDC usdc;
    VeGoc box;
    MockTeleporter teleporter;
    AttendanceRelay relay;
    AttendanceMirror mirror;
    address organizer = makeAddr("organizer");
    address scanner = makeAddr("scanner");
    address[4] guests;
    uint256[4] keys;

    function setUp() public {
        vm.warp(T0);
        usdc = new MockUSDC();
        FloatVault vault = new FloatVault(usdc);
        box = new VeGoc(usdc, vault, makeAddr("treasury"), 300);
        vault.setBox(address(box));
        teleporter = new MockTeleporter(C_CHAIN);
        // The relay and the mirror point at each other: compute the relay's address before deploying the mirror.
        address relayAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        mirror = new AttendanceMirror(address(teleporter), C_CHAIN, relayAt);
        relay = new AttendanceRelay(box, teleporter, DISPATCH, address(mirror));
        assertEq(address(relay), relayAt);
        for (uint256 i = 0; i < 4; i++) {
            (guests[i], keys[i]) = makeAddrAndKey(string.concat("guest", vm.toString(i)));
            vm.startPrank(guests[i]);
            usdc.faucet();
            usdc.approve(address(box), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _event() internal returns (uint256 id) {
        string[] memory n = new string[](1);
        n[0] = "GA";
        uint128[] memory p = new uint128[](1);
        p[0] = 25e6;
        uint32[] memory q = new uint32[](1);
        q[0] = 10;
        vm.prank(organizer);
        id = box.createEvent("Show", "Hall", uint64(T0 + 1 days), uint64(T0 + 2 days), 4, n, p, q);
        vm.prank(organizer);
        box.setScanner(id, scanner, true);
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(guests[i]);
            box.buy(id, 0, 1);
        }
    }

    function _checkIn(uint256 guest, uint256 tokenId) internal {
        uint256 deadline = vm.getBlockTimestamp() + 180;
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("VeGoc"),
                keccak256("1"),
                block.chainid,
                address(box)
            )
        );
        bytes32 h = keccak256(abi.encode(keccak256("CheckIn(uint256 tokenId,uint256 deadline)"), tokenId, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[guest], keccak256(abi.encodePacked("\x19\x01", domain, h)));
        vm.prank(scanner);
        box.checkIn(tokenId, deadline, abi.encodePacked(r, s, v));
    }

    function test_runningEvent_cannotBeRelayed() public {
        uint256 id = _event();
        vm.expectRevert(AttendanceRelay.NotFinal.selector);
        relay.relay(id);
    }

    function test_showThatHappened_arrivesAsHappened() public {
        uint256 id = _event(); // tokens 0..3
        vm.warp(T0 + 1 days + 1 hours);
        _checkIn(0, 0);
        _checkIn(1, 1); // 2 of 4 = the half quorum
        vm.warp(T0 + 2 days);
        relay.relay(id);
        (address org, uint8 outcome, uint32 sold, uint32 scanned) = mirror.records(id);
        assertEq(org, organizer);
        assertEq(outcome, uint8(AttendanceRelay.Outcome.Happened));
        assertEq(sold, 4);
        assertEq(scanned, 2);
        assertTrue(mirror.happened(id));
        (bytes32 dest, address to,,,) = teleporter.last();
        assertEq(dest, DISPATCH);
        assertEq(to, address(mirror));
    }

    function test_noShow_andCancel_arriveAsSuch() public {
        uint256 a = _event();
        uint256 b = _event();
        vm.prank(organizer);
        box.cancelEvent(b);
        relay.relay(b); // a cancel is final at once
        vm.warp(T0 + 1 days + 1 hours);
        _checkIn(0, 0); // 1 of 4
        vm.warp(T0 + 2 days);
        relay.relay(a);
        (, uint8 oa,,) = mirror.records(a);
        (, uint8 ob,,) = mirror.records(b);
        assertEq(oa, uint8(AttendanceRelay.Outcome.NoShow));
        assertEq(ob, uint8(AttendanceRelay.Outcome.Cancelled));
        assertFalse(mirror.happened(a));
    }

    function test_eachEventIsSentOnce() public {
        uint256 id = _event();
        vm.warp(T0 + 2 days);
        relay.relay(id);
        vm.expectRevert(AttendanceRelay.AlreadyRelayed.selector);
        relay.relay(id);
    }

    function test_mirror_refusesAnyoneButTeleporterFromTheRelay() public {
        bytes memory forged = abi.encode(uint256(7), organizer, uint8(1), uint256(10), uint256(10));
        vm.expectRevert(AttendanceMirror.NotTeleporter.selector);
        mirror.receiveTeleporterMessage(C_CHAIN, address(relay), forged);
        vm.startPrank(address(teleporter));
        vm.expectRevert(AttendanceMirror.WrongSource.selector);
        mirror.receiveTeleporterMessage(C_CHAIN, address(this), forged); // another sender on the C-Chain
        vm.expectRevert(AttendanceMirror.WrongSource.selector);
        mirror.receiveTeleporterMessage(DISPATCH, address(relay), forged); // the same address on another chain
        vm.stopPrank();
    }
}
