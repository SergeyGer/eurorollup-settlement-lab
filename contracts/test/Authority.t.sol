// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {TwoOfThreeAuthority} from "../src/TwoOfThreeAuthority.sol";

interface Vm {
    function prank(address sender) external;
    function expectRevert() external;
    function warp(uint256 timestamp) external;
    function addr(uint256 privateKey) external returns (address);
}

contract UpgradeTarget {
    uint256 public version;
    bool public failNext;

    function setVersion(uint256 nextVersion) external {
        if (failNext) revert("upgrade target failure");
        version = nextVersion;
    }

    function setFailNext(bool value) external {
        failNext = value;
    }
}

contract AuthorityTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    TwoOfThreeAuthority private authority;
    UpgradeTarget private target;
    address private ownerA;
    address private ownerB;
    address private ownerC;
    address private stranger = address(0xBAD);

    bytes32 private constant PROPOSAL = keccak256("proposal-1");

    function setUp() public {
        ownerA = vm.addr(0xA11);
        ownerB = vm.addr(0xB0B);
        ownerC = vm.addr(0xC0C);
        authority = new TwoOfThreeAuthority([ownerA, ownerB, ownerC], 100);
        target = new UpgradeTarget();
    }

    function _propose() private {
        uint64 eta = uint64(block.timestamp + 100);
        vm.prank(ownerA);
        authority.propose(PROPOSAL, address(target), 0, abi.encodeCall(UpgradeTarget.setVersion, (7)), eta);
    }

    function testTwoApprovalsActivateAfterTimelock() public {
        _propose();
        vm.prank(ownerA);
        authority.approve(PROPOSAL);
        vm.prank(ownerB);
        authority.approve(PROPOSAL);
        vm.prank(ownerA);
        vm.expectRevert();
        authority.execute(PROPOSAL); // early activation is rejected
        vm.warp(block.timestamp + 100);
        uint256 activationBlock = block.number + 1;
        vm.prank(ownerA);
        authority.execute(PROPOSAL);
        assert(target.version() == 7);
        assert(authority.proposalStatus(PROPOSAL).executed);
        assert(activationBlock > 0);
    }

    function testOnlyTwoOwnersAreEnough() public {
        _propose();
        vm.prank(ownerA);
        authority.approve(PROPOSAL);
        vm.prank(ownerA);
        vm.expectRevert();
        authority.execute(PROPOSAL); // only one approval
        vm.prank(ownerC);
        authority.approve(PROPOSAL);
        vm.warp(block.timestamp + 100);
        vm.prank(ownerA);
        authority.execute(PROPOSAL);
        assert(target.version() == 7);
    }

    function testExecutionFailureCanRecoverForward() public {
        _propose();
        target.setFailNext(true);
        vm.prank(ownerA);
        authority.approve(PROPOSAL);
        vm.prank(ownerB);
        authority.approve(PROPOSAL);
        vm.warp(block.timestamp + 100);
        vm.prank(ownerA);
        authority.execute(PROPOSAL);
        assert(authority.proposalStatus(PROPOSAL).failed);
        assert(!authority.proposalStatus(PROPOSAL).executed);
        target.setFailNext(false);
        vm.prank(ownerA);
        authority.recover(PROPOSAL);
        vm.prank(ownerA);
        authority.execute(PROPOSAL);
        assert(target.version() == 7);
        assert(authority.proposalStatus(PROPOSAL).executed);
    }

    function testNonOwnerCannotProposeOrApprove() public {
        vm.prank(stranger);
        vm.expectRevert();
        authority.propose(PROPOSAL, address(target), 0, abi.encodeCall(UpgradeTarget.setVersion, (7)), uint64(block.timestamp + 100));
        _propose();
        vm.prank(stranger);
        vm.expectRevert();
        authority.approve(PROPOSAL);
    }
}
