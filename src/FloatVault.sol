// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @title FloatVault: holds ticket money per event until the event ends or is cancelled.
/// @notice MOCK YIELD. Yield accrues at a fixed APR on each event's principal and is minted in mock USDC when the
///         organizer withdraws. On mainnet this would be an ERC-4626 vault over USDC lent on Aave v3 (Avalanche
///         C-Chain), where yield is paid by borrowers. Principal never leaves the vault except through TicketBox.
contract FloatVault {
    using SafeERC20 for IERC20;

    uint256 public constant APR_BPS = 500; // 5.00 % a year, mock
    IERC20 public immutable usdc;
    address public immutable deployer;
    address public box;

    struct Account {
        uint128 principal;
        uint128 accrued;
        uint64 last;
    }

    mapping(uint256 => Account) public accounts;
    uint256 public totalPrincipal;

    error NotBox();
    error AlreadyWired();
    error Insufficient();

    event Deposited(uint256 indexed eventId, uint256 amount);
    event Withdrawn(uint256 indexed eventId, address indexed to, uint256 amount);
    event YieldPaid(uint256 indexed eventId, address indexed to, uint256 amount);

    constructor(IERC20 usdc_) {
        usdc = usdc_;
        deployer = msg.sender;
    }

    modifier onlyBox() {
        if (msg.sender != box) revert NotBox();
        _;
    }

    function setBox(address box_) external {
        if (msg.sender != deployer || box != address(0)) revert AlreadyWired();
        box = box_;
    }

    /// @notice Records money TicketBox already moved into this vault.
    function deposit(uint256 eventId, uint256 amount) external onlyBox {
        Account storage a = _accrue(eventId);
        a.principal += uint128(amount);
        totalPrincipal += amount;
        emit Deposited(eventId, amount);
    }

    function withdraw(uint256 eventId, uint256 amount, address to) external onlyBox {
        Account storage a = _accrue(eventId);
        if (amount > a.principal) revert Insufficient();
        a.principal -= uint128(amount);
        totalPrincipal -= amount;
        usdc.safeTransfer(to, amount);
        emit Withdrawn(eventId, to, amount);
    }

    function withdrawYield(uint256 eventId, address to) external onlyBox returns (uint256 amount) {
        Account storage a = _accrue(eventId);
        amount = a.accrued;
        a.accrued = 0;
        if (amount > 0) IMintable(address(usdc)).mint(to, amount);
        emit YieldPaid(eventId, to, amount);
    }

    function principalOf(uint256 eventId) external view returns (uint256) {
        return accounts[eventId].principal;
    }

    function yieldOf(uint256 eventId) public view returns (uint256) {
        Account memory a = accounts[eventId];
        return a.accrued + _pending(a);
    }

    function _pending(Account memory a) private view returns (uint256) {
        if (a.last == 0) return 0;
        return (uint256(a.principal) * APR_BPS * (block.timestamp - a.last)) / (10_000 * 365 days);
    }

    function _accrue(uint256 eventId) private returns (Account storage a) {
        a = accounts[eventId];
        a.accrued += uint128(_pending(a));
        a.last = uint64(block.timestamp);
    }
}
