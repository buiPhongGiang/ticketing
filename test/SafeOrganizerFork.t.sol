// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {FloatVault} from "../src/FloatVault.sol";
import {VeGoc} from "../src/VeGoc.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce) external returns (address proxy);
}

interface ISafe {
    function setup(address[] calldata owners, uint256 threshold, address to, bytes calldata data, address fallbackHandler, address paymentToken, uint256 payment, address payable paymentReceiver) external;
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
    function nonce() external view returns (uint256);
    function approveHash(bytes32 hashToApprove) external;
    function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce_) external view returns (bytes32);
    function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) external payable returns (bool);
}

/// @notice Rule L3: pooled money behind a multisig. A real Safe v1.4.1 (the canonical contracts deployed on Fuji)
///         with 2 of 3 owners organizes an event and receives the platform fee; one owner alone can do nothing.
///         Run with FUJI_RPC_URL set; skipped otherwise.
contract SafeOrganizerForkTest is Test {
    ISafeProxyFactory constant FACTORY = ISafeProxyFactory(0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67);
    address constant SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address constant FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    uint128 constant GA = 25e6;

    MockUSDC usdc;
    FloatVault vault;
    VeGoc box;
    ISafe safe;
    address[] owners;
    address scanner = makeAddr("scanner");
    address alice;
    uint256 aliceKey;
    uint256 t0;

    function setUp() public {
        string memory rpc = vm.envOr("FUJI_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        t0 = vm.getBlockTimestamp();
        (alice, aliceKey) = makeAddrAndKey("alice");
        owners.push(makeAddr("owner-1"));
        owners.push(makeAddr("owner-2"));
        owners.push(makeAddr("owner-3"));
        bytes memory init = abi.encodeCall(ISafe.setup, (owners, 2, address(0), "", FALLBACK_HANDLER, address(0), 0, payable(address(0))));
        safe = ISafe(FACTORY.createProxyWithNonce(SAFE_L2_SINGLETON, init, uint256(keccak256("vegoc-test"))));
        assertEq(safe.getThreshold(), 2);
        assertEq(safe.getOwners().length, 3);

        usdc = new MockUSDC();
        vault = new FloatVault(usdc);
        box = new VeGoc(usdc, vault, address(safe), 300);
        vault.setBox(address(box));
        vm.startPrank(alice);
        usdc.faucet();
        usdc.approve(address(box), type(uint256).max);
        vm.stopPrank();
    }

    /// Owner `a` approves the Safe transaction hash on chain, owner `b` executes it.
    function _exec(address a, address b, bytes memory data) internal returns (bool ok) {
        bytes32 h = safe.getTransactionHash(address(box), 0, data, 0, 0, 0, 0, address(0), address(0), safe.nonce());
        vm.prank(a);
        safe.approveHash(h);
        (address lo, address hi) = a < b ? (a, b) : (b, a);
        bytes memory sigs = abi.encodePacked(bytes32(uint256(uint160(lo))), bytes32(0), uint8(1), bytes32(uint256(uint160(hi))), bytes32(0), uint8(1));
        vm.prank(b);
        return safe.execTransaction(address(box), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs);
    }

    function _qr(uint256 key, uint256 tokenId, uint256 deadline) internal view returns (bytes memory) {
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

    function test_fork_safeOrganizesAnEvent_oneOwnerAloneCannotMoveTheFloat() public {
        string[] memory names = new string[](1);
        names[0] = "GA";
        uint128[] memory prices = new uint128[](1);
        prices[0] = GA;
        uint32[] memory supplies = new uint32[](1);
        supplies[0] = 10;
        bytes memory create = abi.encodeCall(VeGoc.createEvent, ("Safe Night", "Fuji", uint64(t0 + 1 hours), uint64(t0 + 2 hours), 4, names, prices, supplies));
        assertTrue(_exec(owners[0], owners[1], create));
        assertEq(box.getEvent(0).data.organizer, address(safe));
        assertTrue(_exec(owners[1], owners[2], abi.encodeCall(VeGoc.setScanner, (0, scanner, true))));

        vm.prank(alice);
        box.buy(0, 0, 2);
        vm.warp(t0 + 90 minutes);
        bytes memory qr = _qr(aliceKey, 0, t0 + 90 minutes + 180);
        vm.prank(scanner);
        box.checkIn(0, t0 + 90 minutes + 180, qr);
        vm.warp(t0 + 2 hours);

        // One owner, even a legitimate one, cannot settle: neither directly nor through the Safe alone.
        bytes memory settle = abi.encodeCall(VeGoc.settle, (0, owners[0]));
        vm.prank(owners[0]);
        vm.expectRevert(VeGoc.NotOrganizer.selector);
        box.settle(0, owners[0]);
        bytes memory oneSig = abi.encodePacked(bytes32(uint256(uint160(owners[0]))), bytes32(0), uint8(1));
        vm.prank(owners[0]);
        vm.expectRevert(bytes("GS020")); // signatures data too short for the threshold
        safe.execTransaction(address(box), 0, settle, 0, 0, 0, 0, address(0), payable(address(0)), oneSig);

        // Two owners settle to the Safe: 97 % as proceeds, 3 % as the platform fee, both land in the multisig.
        assertTrue(_exec(owners[0], owners[2], abi.encodeCall(VeGoc.settle, (0, address(safe)))));
        assertEq(usdc.balanceOf(address(safe)), 2 * GA);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertTrue(box.getEvent(0).data.settled);
    }
}
