// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FloatVault} from "../src/FloatVault.sol";
import {VeGoc} from "../src/VeGoc.sol";

interface ICircleUsdc is IERC20 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonces(address owner) external view returns (uint256);
    function name() external view returns (string memory);
    function version() external view returns (string memory);
    function decimals() external view returns (uint8);
}

/// @notice The same contracts against Circle's real USDC on Avalanche Fuji, on a fork of the live chain.
///         Run with: FUJI_RPC_URL=https://avalanche-fuji-c-chain-rpc.publicnode.com forge test --match-contract CircleUsdcFork
///         Skipped when FUJI_RPC_URL is not set, so `forge test` stays offline.
contract CircleUsdcForkTest is Test {
    ICircleUsdc constant USDC = ICircleUsdc(0x5425890298aed601595a70AB815c96711a31Bc65);
    /// Pangolin's USDC/WAVAX pool on Fuji: a holder of real test USDC, used here only as a source of funds.
    address constant POOL = 0x8Aa1D713454bD21D10c9d25d717C59Ad75406888;
    uint128 constant PRICE = 5e6; // 5 USDC

    FloatVault vault;
    VeGoc box;
    address organizer = makeAddr("organizer");
    address treasury = makeAddr("treasury");
    address scanner = makeAddr("scanner");
    address alice;
    uint256 aliceKey;
    address bob;
    uint256 bobKey;
    uint256 eventId;
    uint256 t0;

    function setUp() public {
        string memory rpc = vm.envOr("FUJI_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 43113);
        t0 = vm.getBlockTimestamp();
        (alice, aliceKey) = makeAddrAndKey("alice");
        (bob, bobKey) = makeAddrAndKey("bob");
        vault = new FloatVault(USDC);
        box = new VeGoc(USDC, vault, treasury, 300);
        vault.setBox(address(box));
        _fund(alice, 20e6);
        _fund(bob, 20e6);
        string[] memory names = new string[](1);
        names[0] = "GA";
        uint128[] memory prices = new uint128[](1);
        prices[0] = PRICE;
        uint32[] memory supplies = new uint32[](1);
        supplies[0] = 10;
        vm.prank(organizer);
        eventId = box.createEvent("Fork Night", "Fuji", uint64(t0 + 1 hours), uint64(t0 + 2 hours), 4, names, prices, supplies);
        vm.prank(organizer);
        box.setScanner(eventId, scanner, true);
    }

    /// Real tokens moved with the token's own `transfer` when the pool holds enough; storage write otherwise.
    function _fund(address to, uint256 amount) internal {
        if (USDC.balanceOf(POOL) >= amount) {
            vm.prank(POOL);
            USDC.transfer(to, amount);
        } else {
            deal(address(USDC), to, amount);
        }
    }

    function _permit(address owner, uint256 key, uint256 value, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"), owner, address(box), value, USDC.nonces(owner), deadline)
        );
        return vm.sign(key, keccak256(abi.encodePacked("\x19\x01", USDC.DOMAIN_SEPARATOR(), structHash)));
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

    function test_fork_tokenIsCirclesUsdc() public view {
        assertEq(USDC.name(), "USD Coin");
        assertEq(USDC.version(), "2"); // the EIP-712 version the app must sign permits with
        assertEq(USDC.decimals(), 6);
    }

    function test_fork_permitPurchase_resale_checkIn_settleWithFee() public {
        // One-transaction purchase with Circle's own EIP-2612 permit.
        (uint8 v, bytes32 r, bytes32 s) = _permit(alice, aliceKey, PRICE, t0 + 600);
        vm.prank(alice);
        box.buyWithPermit(eventId, 0, 1, t0 + 600, v, r, s);
        assertEq(box.ownerOf(0), alice);
        assertEq(USDC.balanceOf(address(vault)), PRICE);
        assertEq(USDC.balanceOf(alice), 15e6);

        // Capped resale: 5.50 is the most the contract takes.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VeGoc.AboveCap.selector, 5_500_000));
        box.list(0, 5_500_001);
        vm.prank(alice);
        box.list(0, 5_500_000);
        (v, r, s) = _permit(bob, bobKey, 5_500_000, t0 + 600);
        vm.prank(bob);
        box.buyListingWithPermit(0, 5_500_000, t0 + 600, v, r, s);
        assertEq(box.ownerOf(0), bob);
        assertEq(USDC.balanceOf(alice), 15e6 + 5_500_000);
        assertEq(USDC.balanceOf(address(vault)), PRICE); // escrow untouched by the resale

        // Gate: the new holder's signature, during the show.
        vm.warp(t0 + 90 minutes);
        bytes memory qr = _qr(bobKey, 0, t0 + 90 minutes + 180);
        vm.prank(scanner);
        box.checkIn(0, t0 + 90 minutes + 180, qr);

        // Settlement: 3 % to the platform, the rest to the organizer, in real USDC.
        vm.warp(t0 + 2 hours);
        vm.prank(organizer);
        box.settle(eventId, organizer);
        assertEq(USDC.balanceOf(treasury), 150_000);
        assertEq(USDC.balanceOf(organizer), 4_850_000); // no reserve was funded, so no mock yield is paid
        assertEq(USDC.balanceOf(address(vault)), 0);
    }

    function test_fork_cancel_refundsRealUsdc_yieldFromFundedReserve() public {
        vm.startPrank(alice);
        USDC.approve(address(box), type(uint256).max);
        box.buy(eventId, 0, 2);
        USDC.approve(address(vault), 1e6);
        vault.fundReserve(eventId, 1e6); // somebody pre-funds this event's mock yield; nothing is minted
        vm.stopPrank();
        assertEq(USDC.balanceOf(address(vault)), 2 * PRICE + 1e6);
        vm.warp(t0 + 30 minutes);
        vm.prank(organizer);
        box.cancelEvent(eventId);
        uint256 yield_ = vault.yieldOf(eventId);
        assertEq(yield_, (uint256(2 * PRICE) * 500 * 30 minutes) / (10_000 * 365 days));
        uint256[] memory ids = new uint256[](2);
        ids[0] = 0;
        ids[1] = 1;
        box.refundMany(ids);
        assertEq(USDC.balanceOf(alice), 20e6 - 1e6);
        vm.prank(organizer);
        box.settle(eventId, organizer);
        assertEq(USDC.balanceOf(organizer), yield_);
        assertEq(USDC.balanceOf(address(vault)), 1e6 - yield_);
        assertEq(vault.reserve(), 1e6 - yield_);
    }
}
