// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {FloatVault} from "../src/FloatVault.sol";
import {VeGoc} from "../src/VeGoc.sol";
import {GateLog} from "../src/icm/GateLog.sol";
import {VenueCheckIns} from "../src/icm/VenueCheckIns.sol";
import {ITeleporterMessenger, ITeleporterReceiver, TeleporterMessageInput} from "../src/icm/ITeleporter.sol";

/// Stands in for TeleporterMessenger on the venue L1 and the C-Chain: delivers at once, as the relayer would, and
/// passes the receiver's revert up so a test sees it.
contract InstantTeleporter is ITeleporterMessenger {
    bytes32 public immutable sourceID;
    uint256 public sent;
    bytes32 public lastDestination;
    uint256 public lastGas;

    constructor(bytes32 sourceID_) {
        sourceID = sourceID_;
    }

    function sendCrossChainMessage(TeleporterMessageInput calldata m) external returns (bytes32 id) {
        sent++;
        lastDestination = m.destinationBlockchainID;
        lastGas = m.requiredGasLimit;
        id = keccak256(abi.encode(sent, msg.sender));
        ITeleporterReceiver(m.destinationAddress).receiveTeleporterMessage{gas: m.requiredGasLimit}(
            sourceID, msg.sender, m.message
        );
    }
}

contract VenueL1Test is Test {
    bytes32 constant C_CHAIN = keccak256("fuji c-chain");
    bytes32 constant VEGOC = keccak256("vegoc");
    uint256 constant T0 = 1_800_000_000;

    MockUSDC usdc;
    VeGoc box;
    InstantTeleporter teleporter; // on vegoc, delivering to the C-Chain
    GateLog gate;
    VenueCheckIns fuji;
    address venue = makeAddr("venue");
    address device = makeAddr("gate device");
    address organizer = makeAddr("organizer");
    address[6] guests;
    uint256[6] keys;
    uint256 show;

    function setUp() public {
        vm.warp(T0);
        usdc = new MockUSDC();
        FloatVault vault = new FloatVault(usdc);
        box = new VeGoc(usdc, vault, makeAddr("treasury"), 300);
        vault.setBox(address(box));
        teleporter = new InstantTeleporter(VEGOC);
        // GateLog and VenueCheckIns name each other: compute the receiver's address first.
        address fujiAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        gate = new GateLog(venue, teleporter, C_CHAIN, fujiAt, block.chainid, address(box));
        fuji = new VenueCheckIns(address(teleporter), VEGOC, address(gate), box);
        assertEq(address(fuji), fujiAt);
        vm.prank(venue);
        gate.setGate(device, true);
        for (uint256 i = 0; i < guests.length; i++) {
            (guests[i], keys[i]) = makeAddrAndKey(string.concat("guest", vm.toString(i)));
            vm.startPrank(guests[i]);
            usdc.faucet();
            usdc.approve(address(box), type(uint256).max);
            vm.stopPrank();
        }
        show = _event(4); // tokens 0..3, one per guest 0..3
    }

    function _event(uint256 buyers) internal returns (uint256 id) {
        string[] memory n = new string[](1);
        n[0] = "GA";
        uint128[] memory p = new uint128[](1);
        p[0] = 25e6;
        uint32[] memory q = new uint32[](1);
        q[0] = 50;
        vm.prank(organizer);
        id = box.createEvent("Show", "Hall", uint64(T0 + 1 days), uint64(T0 + 2 days), 4, n, p, q);
        for (uint256 i = 0; i < buyers; i++) {
            vm.prank(guests[i]);
            box.buy(id, 0, 1);
        }
    }

    /// The QR the app shows: the holder signs CheckIn(tokenId, deadline) under VeGoc's EIP-712 domain.
    function _qr(uint256 key, uint256 tokenId) internal view returns (uint256 deadline, bytes memory sig) {
        deadline = block.timestamp + 120;
        bytes32 h = keccak256(abi.encode(keccak256("CheckIn(uint256 tokenId,uint256 deadline)"), tokenId, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", gate.ticketDomain(), h)));
        sig = abi.encodePacked(r, s, v);
    }

    function _scan(uint256 eventId, uint256 guest, uint256 tokenId) internal {
        (uint256 d, bytes memory sig) = _qr(keys[guest], tokenId);
        vm.prank(device);
        gate.checkIn(eventId, tokenId, d, sig);
    }

    function test_ticketDomain_isVeGocsOwn() public view {
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = box.eip712Domain();
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifying
            )
        );
        assertEq(gate.ticketDomain(), expected);
    }

    function test_doorScans_reachTheCChain_andMeetTheQuorum() public {
        vm.warp(T0 + 1 days + 1 hours);
        _scan(show, 0, 0);
        _scan(show, 1, 1);
        assertEq(gate.scanCount(show), 2);
        vm.prank(device);
        gate.attest(show);
        (uint32 accepted, uint32 paid, uint32 rejected, uint32 batches) = fuji.tallies(show);
        assertEq(accepted, 2);
        assertEq(paid, 2);
        assertEq(rejected, 0);
        assertEq(batches, 1);
        assertTrue(fuji.counted(0) && fuji.counted(1));
        (uint256 venuePaid, uint256 sold, uint256 onVeGoc, bool met) = fuji.venueQuorum(show);
        assertEq(venuePaid, 2);
        assertEq(sold, 4);
        assertEq(onVeGoc, 0); // VeGoc itself is unchanged
        assertTrue(met);
        assertEq(teleporter.lastDestination(), C_CHAIN);
        assertEq(teleporter.lastGas(), gate.RECEIVE_GAS());
        assertEq(gate.sentUpTo(show), 2);
    }

    function test_qrSignedByAnotherWallet_isRejectedOnTheCChain() public {
        _scan(show, 1, 0); // guest 1 signs for token 0, which guest 0 holds
        vm.prank(device);
        gate.attest(show);
        (uint32 accepted,, uint32 rejected,) = fuji.tallies(show);
        assertEq(accepted, 0);
        assertEq(rejected, 1);
        assertFalse(fuji.counted(0));
    }

    function test_wrongEvent_unknownTicket_afterEnd_cancelled_areRejected() public {
        uint256 other = _event(0);
        uint256 off = _event(4); // tokens 4..7
        _scan(other, 0, 0); // token 0 belongs to `show`
        _scan(show, 0, 99); // no such token
        vm.prank(device);
        gate.attest(other);
        vm.prank(device);
        gate.attest(show);
        (,, uint32 rOther,) = fuji.tallies(other);
        (,, uint32 rShow,) = fuji.tallies(show);
        assertEq(rOther, 1);
        assertEq(rShow, 1);

        vm.prank(organizer);
        box.cancelEvent(off);
        _scan(off, 0, 4);
        vm.prank(device);
        gate.attest(off);
        (uint32 a,, uint32 r,) = fuji.tallies(off);
        assertEq(a, 0);
        assertEq(r, 1);

        vm.warp(T0 + 2 days); // the end
        _scan(show, 2, 2);
        vm.prank(device);
        gate.attest(show);
        (uint32 accepted,, uint32 rejected,) = fuji.tallies(show);
        assertEq(accepted, 0);
        assertEq(rejected, 2);
    }

    function test_compTicket_countsButNotTowardsThePaidQuorum() public {
        vm.prank(organizer);
        box.issue(show, 0, guests[5], 1); // token 4, free
        _scan(show, 5, 4);
        vm.prank(device);
        gate.attest(show);
        (uint32 accepted, uint32 paid,,) = fuji.tallies(show);
        assertEq(accepted, 1);
        assertEq(paid, 0);
        (,,, bool met) = fuji.venueQuorum(show);
        assertFalse(met);
    }

    function test_gate_refusesStrangersStaleQrsAndRepeats() public {
        (uint256 d, bytes memory sig) = _qr(keys[0], 0);
        vm.expectRevert(GateLog.NotGate.selector);
        gate.checkIn(show, 0, d, sig);
        vm.expectRevert(GateLog.NotVenue.selector);
        gate.setGate(address(this), true);

        vm.startPrank(device);
        vm.warp(block.timestamp + 121);
        vm.expectRevert(GateLog.SignatureExpired.selector);
        gate.checkIn(show, 0, d, sig);
        (d, sig) = _qr(keys[0], 0);
        vm.expectRevert(GateLog.DeadlineTooFar.selector);
        gate.checkIn(show, 0, block.timestamp + 6 minutes, sig);
        vm.expectRevert(GateLog.InvalidSignature.selector);
        gate.checkIn(show, 0, d, hex"1234");
        gate.checkIn(show, 0, d, sig);
        vm.expectRevert(GateLog.AlreadyScanned.selector);
        gate.checkIn(show, 0, d, sig);
        vm.stopPrank();

        vm.expectRevert(GateLog.NotGate.selector);
        gate.attest(show);
        vm.prank(venue); // the venue may send too
        gate.attest(show);
        vm.prank(device);
        vm.expectRevert(GateLog.NothingToSend.selector);
        gate.attest(show);

        vm.prank(venue);
        gate.setGate(device, false);
        (d, sig) = _qr(keys[1], 1);
        vm.prank(device);
        vm.expectRevert(GateLog.NotGate.selector);
        gate.checkIn(show, 1, d, sig);
    }

    function test_manyScans_goInBatchesOfTwenty() public {
        uint256 big = _event(0);
        uint256 first = box.totalMinted();
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(guests[i]);
            box.buy(big, 0, 4); // wallet limit 4
        }
        vm.prank(guests[5]);
        box.buy(big, 0, 1);
        uint256 n = 20 + 1;
        uint256[] memory ids = new uint256[](n);
        uint256[] memory ds = new uint256[](n);
        bytes[] memory sigs = new bytes[](n);
        for (uint256 i = 0; i < n; i++) {
            ids[i] = first + i;
            (ds[i], sigs[i]) = _qr(keys[i / 4], ids[i]);
        }
        vm.prank(device);
        gate.checkInMany(big, ids, ds, sigs);
        vm.startPrank(device);
        gate.attest(big);
        assertEq(gate.sentUpTo(big), 20);
        gate.attest(big);
        vm.stopPrank();
        (uint32 accepted,, uint32 rejected, uint32 batches) = fuji.tallies(big);
        assertEq(accepted, 21);
        assertEq(rejected, 0);
        assertEq(batches, 2);
        assertEq(gate.batches(big), 2);
    }

    function test_checkInMany_lengthsMustMatch() public {
        vm.prank(device);
        vm.expectRevert(GateLog.LengthMismatch.selector);
        gate.checkInMany(show, new uint256[](2), new uint256[](1), new bytes[](2));
    }

    function test_aTicketCountsOnce_evenIfSentAgain() public {
        GateLog.Scan[] memory s = new GateLog.Scan[](2);
        s[0] = GateLog.Scan(0, guests[0], uint64(block.timestamp));
        s[1] = GateLog.Scan(0, guests[0], uint64(block.timestamp));
        vm.prank(address(teleporter));
        fuji.receiveTeleporterMessage(VEGOC, address(gate), abi.encode(show, uint256(1), s));
        (uint32 accepted,, uint32 rejected,) = fuji.tallies(show);
        assertEq(accepted, 1);
        assertEq(rejected, 0); // a repeat is logged, not held against the venue
    }

    function test_receiver_refusesAnyoneButTeleporterFromTheGateLog() public {
        GateLog.Scan[] memory s = new GateLog.Scan[](1);
        s[0] = GateLog.Scan(0, guests[0], uint64(block.timestamp));
        bytes memory forged = abi.encode(show, uint256(1), s);
        vm.expectRevert(VenueCheckIns.NotTeleporter.selector);
        fuji.receiveTeleporterMessage(VEGOC, address(gate), forged);
        vm.startPrank(address(teleporter));
        vm.expectRevert(VenueCheckIns.WrongSource.selector);
        fuji.receiveTeleporterMessage(VEGOC, address(this), forged); // another sender on vegoc
        vm.expectRevert(VenueCheckIns.WrongSource.selector);
        fuji.receiveTeleporterMessage(C_CHAIN, address(gate), forged); // the same address on another chain
        vm.stopPrank();
        (uint32 accepted,,,) = fuji.tallies(show);
        assertEq(accepted, 0);
    }
}
