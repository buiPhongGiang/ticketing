// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title FloatVault: holds ticket money per event until the event ends or is cancelled.
/// @notice MOCK YIELD. Each event's principal accrues a fixed APR, paid out of a reserve that somebody funded
///         beforehand with the same token (`fundReserve`). Nothing is minted, so the vault works with any ERC-20,
///         including Circle's USDC. If the reserve is short, the unpaid yield stays owed; principal is never used
///         to pay yield. On mainnet this would be an ERC-4626 vault over USDC lent on Aave v3 (Avalanche C-Chain),
///         where yield is interest paid by borrowers. Principal never leaves the vault except through the ticket
///         contract.
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
        bool frozen;
    }

    mapping(uint256 => Account) public accounts;
    uint256 public totalPrincipal;
    /// @notice Tokens set aside to pay mock yield. `balance >= totalPrincipal + reserve` always holds.
    uint256 public reserve;

    error NotBox();
    error AlreadyWired();
    error Insufficient();

    event Deposited(uint256 indexed eventId, uint256 amount);
    event Withdrawn(uint256 indexed eventId, address indexed to, uint256 amount);
    event YieldPaid(uint256 indexed eventId, address indexed to, uint256 amount);
    event YieldFrozen(uint256 indexed eventId, uint256 accrued);
    event ReserveFunded(address indexed from, uint256 amount);

    constructor(IERC20 usdc_) {
        usdc = usdc_;
        deployer = msg.sender;
    }

    modifier onlyBox() {
        if (msg.sender != box) revert NotBox();
        _;
    }

    /// @notice One-time wiring by the deployer. After this call nobody has any admin right over the vault.
    function setBox(address box_) external {
        if (msg.sender != deployer || box != address(0) || box_ == address(0)) revert AlreadyWired();
        box = box_;
    }

    /// @notice Anyone may top up the pot that mock yield is paid from. It cannot be taken back.
    function fundReserve(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        reserve += amount;
        emit ReserveFunded(msg.sender, amount);
    }

    /// @notice Records money the ticket contract already moved into this vault.
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

    /// @notice Stops accrual for good. Called when an event is cancelled, so waiting with refunds earns nothing.
    function freeze(uint256 eventId) external onlyBox {
        Account storage a = _accrue(eventId);
        a.frozen = true;
        emit YieldFrozen(eventId, a.accrued);
    }

    /// @notice Pays the accrued yield out of the reserve, as far as the reserve goes.
    function withdrawYield(uint256 eventId, address to) external onlyBox returns (uint256 amount) {
        Account storage a = _accrue(eventId);
        amount = a.accrued < reserve ? a.accrued : reserve;
        a.accrued -= uint128(amount);
        reserve -= amount;
        if (amount > 0) usdc.safeTransfer(to, amount);
        emit YieldPaid(eventId, to, amount);
    }

    function principalOf(uint256 eventId) external view returns (uint256) {
        return accounts[eventId].principal;
    }

    /// @notice accrued + principal × 5 % × seconds since the last change / 365 days.
    function yieldOf(uint256 eventId) public view returns (uint256) {
        Account memory a = accounts[eventId];
        return a.accrued + _pending(a);
    }

    function _pending(Account memory a) private view returns (uint256) {
        if (a.last == 0 || a.frozen) return 0;
        return (uint256(a.principal) * APR_BPS * (block.timestamp - a.last)) / (10_000 * 365 days);
    }

    function _accrue(uint256 eventId) private returns (Account storage a) {
        a = accounts[eventId];
        a.accrued += uint128(_pending(a));
        a.last = uint64(block.timestamp);
    }
}
