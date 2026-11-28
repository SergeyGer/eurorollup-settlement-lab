// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Token} from "./Token.sol";

/// @title Cash escrow for pending fund subscriptions.
/// @notice The settlement contract is the only operator: reserved dEUR can only move to
/// the issuer treasury on allocation or back to the investor on refund.
contract Escrow {
    Token public immutable cash;
    address public owner;
    address public operator;
    mapping(bytes32 => uint256) public reserved;

    event Reserved(bytes32 indexed orderId, address indexed investor, uint256 amount);
    event Released(bytes32 indexed orderId, address indexed recipient, uint256 amount);
    event OperatorChanged(address indexed operator);

    modifier onlyOperator() {
        require(msg.sender == operator, "Escrow: not operator");
        _;
    }

    constructor(Token cashToken) {
        cash = cashToken;
        owner = msg.sender;
        operator = msg.sender;
    }

    function setOperator(address nextOperator) external {
        require(msg.sender == owner, "Escrow: not owner");
        operator = nextOperator;
        emit OperatorChanged(nextOperator);
    }

    function reserve(bytes32 orderId, address investor, uint256 amount) external onlyOperator {
        require(amount > 0, "Escrow: zero amount");
        require(cash.transferFrom(investor, address(this), amount), "Escrow: funding failed");
        reserved[orderId] += amount;
        emit Reserved(orderId, investor, amount);
    }

    function release(bytes32 orderId, address recipient, uint256 amount) external onlyOperator {
        uint256 available = reserved[orderId];
        require(available >= amount, "Escrow: insufficient reservation");
        reserved[orderId] = available - amount;
        require(cash.transfer(recipient, amount), "Escrow: release failed");
        emit Released(orderId, recipient, amount);
    }
}
