// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Token} from "../src/Token.sol";
import {RestrictedShare} from "../src/RestrictedShare.sol";
import {Escrow} from "../src/Escrow.sol";
import {DvPSettlement} from "../src/DvPSettlement.sol";

interface Vm {
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function expectRevert() external;
    function expectRevert(bytes calldata revertData) external;
    function warp(uint256 timestamp) external;
}

/// @notice G01 settlement slice tests. Foundry cheatcodes are used through a minimal Vm
/// interface so the contracts project has no external Solidity dependencies.
contract SettlementSliceTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    Token private cash;
    Token private spot;
    RestrictedShare private fund;
    Escrow private escrow;
    DvPSettlement private settlement;

    address private investor = address(0xA11CE);
    address private dealer = address(0xDEA1E2);
    address private feeRecipient = address(0xFEE);
    address private issuerTreasury = address(0x1550E);

    uint256 private constant CASH_UNIT = 1e6; // dEUR: 6 decimals
    uint256 private constant SPOT_UNIT = 1e18; // tWETH: 18 decimals
    uint256 private constant FUND_UNIT = 1e6; // eFUND: 6 decimals

    function setUp() public {
        cash = new Token("Demo euro cash", "dEUR", 6);
        spot = new Token("Test wrapped ETH", "tWETH", 18);
        fund = new RestrictedShare("Fictional euro fund unit", "eFUND", 6, address(this));
        escrow = new Escrow(cash);
        settlement = new DvPSettlement(cash, spot, fund, escrow, feeRecipient, issuerTreasury);
        escrow.setOperator(address(settlement));
        fund.setMinter(address(settlement), true);
        fund.setAllowlisted(investor, true);
        fund.setAllowlisted(dealer, true);
        fund.setAllowlisted(issuerTreasury, true);

        cash.mint(investor, 1_000 * CASH_UNIT);
        cash.mint(issuerTreasury, 500 * CASH_UNIT);
        spot.mint(dealer, 1 * SPOT_UNIT);

        vm.prank(investor);
        cash.approve(address(settlement), type(uint256).max);
        vm.prank(investor);
        cash.approve(address(escrow), type(uint256).max);
        vm.prank(dealer);
        spot.approve(address(settlement), type(uint256).max);
        vm.prank(issuerTreasury);
        cash.approve(address(settlement), type(uint256).max);
    }

    function testG01SpotFill() public {
        bytes32 orderId = keccak256("G01-SPOT-01");
        settlement.executeSpot(orderId, investor, dealer, 200 * CASH_UNIT, 50_000, 100_000_000_000_000_000, block.timestamp + 300);
        assert(cash.balanceOf(investor) == 799_950_000);
        assert(spot.balanceOf(investor) == 100_000_000_000_000_000);
        assert(cash.balanceOf(dealer) == 200 * CASH_UNIT);
        assert(cash.balanceOf(feeRecipient) == 50_000);
    }

    function testG01Allocation() public {
        settlement.reserveFund(keccak256("G01-FUND-01"), investor, 300 * CASH_UNIT);
        assert(cash.balanceOf(investor) == 700 * CASH_UNIT);
        assert(escrow.reserved(keccak256("G01-FUND-01")) == 300 * CASH_UNIT);
        settlement.allocateFund(keccak256("G01-FUND-01"), investor, 3_125_000, 300 * CASH_UNIT);
        assert(cash.balanceOf(investor) == 700 * CASH_UNIT);
        assert(cash.balanceOf(issuerTreasury) == 800 * CASH_UNIT);
        assert(escrow.reserved(keccak256("G01-FUND-01")) == 0);
        assert(fund.balanceOf(investor) == 3_125_000);
        assert(fund.totalSupply() == 3_125_000);
    }

    function testG01FullLifecycle() public {
        settlement.executeSpot(keccak256("G01-SPOT-01"), investor, dealer, 200 * CASH_UNIT, 50_000, 100_000_000_000_000_000, block.timestamp + 300);
        settlement.reserveFund(keccak256("G01-FUND-01"), investor, 300 * CASH_UNIT);
        settlement.allocateFund(keccak256("G01-FUND-01"), investor, 3_125_000, 300 * CASH_UNIT);
        settlement.redeemFund(keccak256("G01-RED-01"), investor, 1_000_000, 98 * CASH_UNIT);
        assert(cash.balanceOf(investor) == 597_950_000);
        assert(fund.balanceOf(investor) == 2_125_000);
        assert(fund.totalSupply() == 2_125_000);
    }

    /// S16 moved the restriction from this local allowlist to the onchain eligibility
    /// registry (see EligibilityGate.t.sol); without a registry configured the instrument
    /// remains freely transferable for the S15 unit tests.
    function testTransfersWorkWithoutRegistryConfigured() public {
        fund.mint(investor, 1_000_000);
        vm.prank(investor);
        fund.transfer(dealer, 1_000);
        assert(fund.balanceOf(dealer) == 1_000);
    }

    function testEscrowOnlyOperator() public {
        vm.prank(investor);
        vm.expectRevert();
        escrow.reserve(keccak256("X"), investor, 1);
    }

    function testExpiredQuoteReverts() public {
        vm.expectRevert();
        settlement.executeSpot(keccak256("EXPIRED"), investor, dealer, 200 * CASH_UNIT, 50_000, 100_000_000_000_000_000, block.timestamp - 1);
    }

    function testAtomicFailureLeavesNoPartialState() public {
        uint256 dealerCashBefore = cash.balanceOf(dealer);
        uint256 investorCashBefore = cash.balanceOf(investor);
        // Dealer has no tWETH allowance for this amount in a fresh actor.
        address poorDealer = address(0xB0B);
        spot.mint(poorDealer, 0);
        vm.expectRevert();
        settlement.executeSpot(keccak256("FAIL-SPOT"), investor, poorDealer, 200 * CASH_UNIT, 50_000, 100_000_000_000_000_000, block.timestamp + 300);
        assert(cash.balanceOf(dealer) == dealerCashBefore);
        assert(cash.balanceOf(investor) == investorCashBefore);
    }
}
