// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Token} from "../src/Token.sol";
import {RestrictedShare} from "../src/RestrictedShare.sol";
import {Escrow} from "../src/Escrow.sol";
import {DvPSettlement} from "../src/DvPSettlement.sol";
import {EligibilityRegistry, IEligibilityVerifier} from "../src/EligibilityRegistry.sol";
import {IEligibilityRegistry} from "../src/IEligibilityRegistry.sol";

interface Vm {
    function prank(address sender) external;
    function expectRevert() external;
    function warp(uint256 timestamp) external;
}

contract StubVerifier {
    bool public result = true;

    function setResult(bool nextResult) external {
        result = nextResult;
    }

    function verify(bytes calldata, bytes32[] calldata) external view returns (bool) {
        return result;
    }
}

contract StubRegistry is IEligibilityRegistry {
    mapping(address => uint256) public blockedClass;
    bool public allowAll = true;

    function setAllowAll(bool nextValue) external {
        allowAll = nextValue;
    }

    function setClass(address holder, uint256 classCode) external {
        blockedClass[holder] = classCode;
    }

    function isEligible(address holder, uint256) external view returns (bool) {
        return allowAll || blockedClass[holder] > 0;
    }

    function requireEligible(address holder, uint256) external view {
        require(allowAll || blockedClass[holder] > 0, "StubRegistry: not eligible");
    }
}

/// @notice S16 tests: registry policy checks and the share/settlement enforcement points.
contract EligibilityGateTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    StubVerifier private stubVerifier;
    EligibilityRegistry private registry;
    RestrictedShare private fund;
    StubRegistry private stubRegistry;

    address private holder = address(0xA11CE);
    address private other = address(0xB0B);
    address private stranger = address(0xBAD);

    uint256 private constant SUBSCRIPTION_GATE = uint256(uint160(0x2000000000000000000000000000000000000002));
    uint256 private constant REDEMPTION_GATE = uint256(uint160(0x2000000000000000000000000000000000000003));
    uint256 private constant TRANSFER_GATE = uint256(uint160(0x2000000000000000000000000000000000000004));

    bytes32[] private inputs;
    bytes32 private root1;

    function setUp() public {
        stubVerifier = new StubVerifier();
        registry = new EligibilityRegistry(address(this), IEligibilityVerifier(address(stubVerifier)), 16584);
        registry.setRequiredClass(SUBSCRIPTION_GATE, 3);
        registry.setRequiredClass(TRANSFER_GATE, 3);
        registry.setRequiredClass(REDEMPTION_GATE, 2);
        fund = new RestrictedShare("Fictional euro fund unit", "eFUND", 6, address(this));
        stubRegistry = new StubRegistry();
        fund.configureEligibility(address(stubRegistry), TRANSFER_GATE, SUBSCRIPTION_GATE, REDEMPTION_GATE);
        root1 = keccak256("root-1");
        registry.publishRoot(root1, 1, 1);
        inputs = [
            bytes32(uint256(uint160(holder))),
            root1,
            bytes32(uint256(16584)),
            bytes32(SUBSCRIPTION_GATE),
            bytes32(uint256(3)),
            bytes32(uint256(1)),
            bytes32(block.timestamp + 1 days)
        ];
    }

    function testRegistryVerifiesAndCachesProof() public {
        registry.verifyAndCache(holder, SUBSCRIPTION_GATE, hex"deadbeef", inputs);
        EligibilityRegistry.Approval memory approval = registry.approvalOf(holder, SUBSCRIPTION_GATE);
        assert(approval.exists);
        assert(approval.policyVersion == 1);
        assert(approval.classCode == 3);
        assert(registry.isEligible(holder, SUBSCRIPTION_GATE));
    }

    function testRegistryRejectsWrongWallet() public {
        vm.expectRevert();
        registry.verifyAndCache(other, SUBSCRIPTION_GATE, hex"deadbeef", inputs);
    }

    function testRegistryRejectsWrongGate() public {
        vm.expectRevert();
        registry.verifyAndCache(holder, REDEMPTION_GATE, hex"deadbeef", inputs);
    }

    function testRegistryRejectsFailingVerifier() public {
        stubVerifier.setResult(false);
        vm.expectRevert();
        registry.verifyAndCache(holder, SUBSCRIPTION_GATE, hex"deadbeef", inputs);
    }

    function testRegistryRejectsExpiredProof() public {
        inputs[6] = bytes32(uint256(block.timestamp - 1));
        vm.expectRevert();
        registry.verifyAndCache(holder, SUBSCRIPTION_GATE, hex"deadbeef", inputs);
    }

    function testRegistryRejectsLowClass() public {
        inputs[4] = bytes32(uint256(2));
        vm.expectRevert();
        registry.verifyAndCache(holder, SUBSCRIPTION_GATE, hex"deadbeef", inputs);
    }

    function testRegistryRejectsUnauthorizedIssuer() public {
        vm.prank(stranger);
        vm.expectRevert();
        registry.publishRoot(keccak256("root-x"), 2, 2);
    }

    function testApprovalGoesStaleAfterRootRotation() public {
        registry.verifyAndCache(holder, SUBSCRIPTION_GATE, hex"deadbeef", inputs);
        registry.publishRoot(keccak256("root-2"), 2, 2);
        assert(!registry.isEligible(holder, SUBSCRIPTION_GATE));
        vm.expectRevert();
        registry.requireEligible(holder, SUBSCRIPTION_GATE);
    }

    function testShareEnforcesEligibilityOnMintTransferAndBurn() public {
        fund.mint(holder, 1_000_000);
        // The stub blocks the stranger, so a transfer to it fails.
        stubRegistry.setClass(stranger, 0);
        stubRegistry.setClass(address(this), 3);
        stubRegistry.setAllowAll(false);
        stubRegistry.setClass(holder, 3);
        fund.mint(holder, 1_000_000);
        vm.prank(holder);
        fund.transfer(address(this), 1);
        vm.prank(holder);
        vm.expectRevert();
        fund.transfer(stranger, 1);
        fund.setMinter(address(this), true);
        fund.burn(holder, 100);
    }

    function testAllocationRecheckFailsClosedAndPreservesEscrow() public {
        Token cash = new Token("dEUR", "dEUR", 6);
        Token spot = new Token("tWETH", "tWETH", 18);
        Escrow escrow = new Escrow(cash);
        DvPSettlement settlement = new DvPSettlement(cash, spot, fund, escrow, other, other);
        escrow.setOperator(address(settlement));
        fund.setMinter(address(settlement), true);
        cash.mint(holder, 300);
        vm.prank(holder);
        cash.approve(address(escrow), type(uint256).max);
        settlement.reserveFund(keccak256("order"), holder, 300);
        // Eligibility becomes stale: the mint must revert and the escrow must stay intact.
        stubRegistry.setAllowAll(false);
        stubRegistry.setClass(holder, 0);
        vm.expectRevert();
        settlement.allocateFund(keccak256("order"), holder, 1_000_000, 300);
        assert(cash.balanceOf(address(escrow)) == 300);
        assert(fund.balanceOf(holder) == 0);
        // Recovery: eligibility is restored and the same reservation can be settled once.
        stubRegistry.setClass(holder, 3);
        settlement.allocateFund(keccak256("order"), holder, 1_000_000, 300);
        assert(fund.balanceOf(holder) == 1_000_000);
        assert(cash.balanceOf(address(escrow)) == 0);
    }
}
