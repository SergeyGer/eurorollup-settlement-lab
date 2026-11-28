// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Token} from "./Token.sol";
import {RestrictedShare} from "./RestrictedShare.sol";
import {Escrow} from "./Escrow.sol";

/// @title Atomic delivery-versus-payment settlement for the synthetic G01 slice.
/// @notice The operator executes one business step per call; each call is atomic, so a
/// failed leg leaves no partial balances. Expected amounts come from the deterministic
/// dealing engine (integer base units).
contract DvPSettlement {
    Token public immutable cash;
    Token public immutable spot;
    RestrictedShare public immutable fund;
    Escrow public immutable escrow;
    address public operator;
    address public feeRecipient;
    address public issuerTreasury;

    event SpotSettled(
        bytes32 indexed orderId,
        address indexed investor,
        address indexed dealer,
        uint256 cashToDealer,
        uint256 investorFee,
        uint256 assetToInvestor
    );
    event FundAllocated(bytes32 indexed orderId, address indexed investor, uint256 units, uint256 cashFromEscrow);
    event FundRedeemed(bytes32 indexed orderId, address indexed investor, uint256 units, uint256 cashToInvestor);
    event OperatorChanged(address indexed operator);

    modifier onlyOperator() {
        require(msg.sender == operator, "DvP: not operator");
        _;
    }

    constructor(
        Token cashToken,
        Token spotToken,
        RestrictedShare fundToken,
        Escrow cashEscrow,
        address settlementFeeRecipient,
        address settlementIssuerTreasury
    ) {
        cash = cashToken;
        spot = spotToken;
        fund = fundToken;
        escrow = cashEscrow;
        feeRecipient = settlementFeeRecipient;
        issuerTreasury = settlementIssuerTreasury;
        operator = msg.sender;
    }

    function setOperator(address nextOperator) external {
        require(msg.sender == operator, "DvP: not operator");
        operator = nextOperator;
        emit OperatorChanged(nextOperator);
    }

    /// @notice Spot BUY: investor pays cash plus the fixed fee, dealer delivers the asset.
    function executeSpot(
        bytes32 orderId,
        address investor,
        address dealer,
        uint256 cashAmount,
        uint256 feeAmount,
        uint256 assetAmount,
        uint256 expiresAt
    ) external onlyOperator {
        require(block.timestamp <= expiresAt, "DvP: quote expired");
        require(cash.transferFrom(investor, dealer, cashAmount), "DvP: cash leg failed");
        if (feeAmount > 0) {
            require(cash.transferFrom(investor, feeRecipient, feeAmount), "DvP: fee leg failed");
        }
        require(spot.transferFrom(dealer, investor, assetAmount), "DvP: asset leg failed");
        emit SpotSettled(orderId, investor, dealer, cashAmount, feeAmount, assetAmount);
    }

    /// @notice Reserve investor cash in escrow for a pending fund subscription.
    function reserveFund(bytes32 orderId, address investor, uint256 amount) external onlyOperator {
        escrow.reserve(orderId, investor, amount);
    }

    /// @notice Fund allocation: reserved cash moves to the issuer, restricted units are minted.
    function allocateFund(bytes32 orderId, address investor, uint256 units, uint256 cashAmount) external onlyOperator {
        require(units > 0, "DvP: zero units");
        escrow.release(orderId, issuerTreasury, cashAmount);
        fund.mint(investor, units);
        emit FundAllocated(orderId, investor, units, cashAmount);
    }

    /// @notice Redemption: restricted units are burned and the issuer pays cash to the investor.
    function redeemFund(bytes32 orderId, address investor, uint256 units, uint256 cashAmount) external onlyOperator {
        require(units > 0, "DvP: zero units");
        fund.burn(investor, units);
        require(cash.transferFrom(issuerTreasury, investor, cashAmount), "DvP: cash leg failed");
        emit FundRedeemed(orderId, investor, units, cashAmount);
    }
}
