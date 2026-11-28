// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {DvPSettlement} from "./DvPSettlement.sol";

/// @title Order entry gateway used by the sponsored account.
/// @notice The account calls this gateway through ERC-4337; the gateway is the settlement
/// operator and pulls the account's approved cash. Order IDs are single-use, so a retried
/// request after a lost response observes the previous settlement instead of executing it
/// twice.
contract RetailOrderEntry {
    DvPSettlement public immutable settlement;
    mapping(bytes32 => bool) public settledOrders;

    event OrderSettled(bytes32 indexed orderId, address indexed investor, bytes32 kind, uint256 cashAmount, uint256 assetAmount);

    error OrderAlreadySettled(bytes32 orderId);
    error OrderExpired(uint256 expiresAt, uint256 nowTimestamp);

    constructor(DvPSettlement dvpSettlement) {
        settlement = dvpSettlement;
    }

    function submitSpotOrder(
        bytes32 orderId,
        address dealer,
        uint256 cashAmount,
        uint256 feeAmount,
        uint256 assetAmount,
        uint256 expiresAt
    ) external {
        if (settledOrders[orderId]) revert OrderAlreadySettled(orderId);
        if (block.timestamp > expiresAt) revert OrderExpired(expiresAt, block.timestamp);
        settledOrders[orderId] = true;
        settlement.executeSpot(orderId, msg.sender, dealer, cashAmount, feeAmount, assetAmount, expiresAt);
        emit OrderSettled(orderId, msg.sender, "SPOT_BUY", cashAmount, assetAmount);
    }

    function reserveFundOrder(bytes32 orderId, uint256 cashAmount) external {
        if (settledOrders[orderId]) revert OrderAlreadySettled(orderId);
        settledOrders[orderId] = true;
        settlement.reserveFund(orderId, msg.sender, cashAmount);
        emit OrderSettled(orderId, msg.sender, "FUND_RESERVE", cashAmount, 0);
    }
}
