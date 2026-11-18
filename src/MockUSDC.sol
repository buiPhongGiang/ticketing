// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title MockUSDC: a testnet stand-in for USDC (6 decimals, EIP-2612 permit).
/// @notice TEST TOKEN ONLY. Anyone can take 1,000 from the faucet once every hour. The float vault may mint
///         mock yield. On mainnet the ticket contract would take Circle's native USDC on the C-Chain instead.
contract MockUSDC is ERC20, ERC20Permit {
    uint256 public constant FAUCET_AMOUNT = 1_000e6;
    uint256 public constant FAUCET_COOLDOWN = 1 hours;

    address public immutable deployer;
    address public minter;
    mapping(address => uint256) public lastFaucet;

    error FaucetCooldown(uint256 availableAt);
    error NotMinter();
    error MinterAlreadySet();

    constructor() ERC20("Mock USDC", "USDC") ERC20Permit("Mock USDC") {
        deployer = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet() external {
        uint256 next = lastFaucet[msg.sender] + FAUCET_COOLDOWN;
        if (lastFaucet[msg.sender] != 0 && block.timestamp < next) revert FaucetCooldown(next);
        lastFaucet[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice One-time wiring: the float vault mints the mock yield it reports.
    function setMinter(address minter_) external {
        if (msg.sender != deployer) revert NotMinter();
        if (minter != address(0)) revert MinterAlreadySet();
        minter = minter_;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        _mint(to, amount);
    }
}
