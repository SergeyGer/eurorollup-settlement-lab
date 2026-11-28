// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Token} from "../src/Token.sol";
import {Escrow} from "../src/Escrow.sol";
import {DvPSettlement} from "../src/DvPSettlement.sol";
import {RestrictedShare} from "../src/RestrictedShare.sol";
import {ScopedSponsorshipPaymaster, PackedUserOperation} from "../src/ScopedSponsorshipPaymaster.sol";
import {RetailOrderEntry} from "../src/RetailOrderEntry.sol";

interface Vm {
    function prank(address sender) external;
    function expectRevert() external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external returns (address);
    function warp(uint256 timestamp) external;
}

contract SponsorshipTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant ENTRY_POINT = address(0xE11);
    uint256 private constant SPONSOR_PK = 0xA11CE;
    address private sponsor;

    ScopedSponsorshipPaymaster private paymaster;
    address private target;
    bytes4 private constant ORDER_SELECTOR = bytes4(keccak256("submitSpotOrder(bytes32,address,uint256,uint256,uint256,uint256)"));

    function setUp() public {
        sponsor = vm.addr(SPONSOR_PK);
        paymaster = new ScopedSponsorshipPaymaster(ENTRY_POINT, sponsor);
        target = address(new Token("Order entry target", "TGT", 6));
    }

    function _permit(uint64 validUntil, uint256 maxCost) private view returns (ScopedSponsorshipPaymaster.Permit memory) {
        return ScopedSponsorshipPaymaster.Permit({
            account: address(this),
            target: target,
            selector: ORDER_SELECTOR,
            chainId: block.chainid,
            permitNonce: 1,
            validUntil: validUntil,
            maxCost: maxCost
        });
    }

    function _signature(ScopedSponsorshipPaymaster.Permit memory permit) private returns (bytes memory) {
        bytes32 digest = paymaster.permitDigest(permit);
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SPONSOR_PK, ethSigned);
        return abi.encodePacked(r, s, v);
    }

    function _userOp(ScopedSponsorshipPaymaster.Permit memory permit, bytes memory signature, bytes memory callData)
        private
        view
        returns (PackedUserOperation memory)
    {
        bytes memory paymasterAndData = abi.encodePacked(
            address(paymaster),
            bytes16(uint128(200_000)),
            bytes16(uint128(80_000)),
            abi.encode(permit, signature)
        );
        return PackedUserOperation({
            sender: permit.account,
            nonce: 0,
            initCode: "",
            callData: callData,
            accountGasLimits: bytes32(0),
            preVerificationGas: 80_000,
            gasFees: bytes32(0),
            paymasterAndData: paymasterAndData,
            signature: ""
        });
    }

    function _executeCall(address targetContract, bytes memory innerData) private pure returns (bytes memory) {
        return abi.encodeWithSignature("execute(address,uint256,bytes)", targetContract, 0, innerData);
    }

    function testValidPermitAcceptedAndConsumed() public {
        ScopedSponsorshipPaymaster.Permit memory permit = _permit(uint64(block.timestamp + 1 hours), 1 ether);
        PackedUserOperation memory op = _userOp(permit, _signature(permit), _executeCall(target, abi.encodeWithSelector(ORDER_SELECTOR)));
        vm.prank(ENTRY_POINT);
        (bytes memory context, uint256 validationData) = paymaster.validatePaymasterUserOp(op, bytes32(0), 1 ether);
        assert(context.length > 0);
        assert(validationData != 0);
        assert(paymaster.permitUsed(paymaster.permitDigest(permit)));
    }

    function testPermitCannotBeReplayed() public {
        ScopedSponsorshipPaymaster.Permit memory permit = _permit(uint64(block.timestamp + 1 hours), 1 ether);
        PackedUserOperation memory op = _userOp(permit, _signature(permit), _executeCall(target, abi.encodeWithSelector(ORDER_SELECTOR)));
        vm.prank(ENTRY_POINT);
        paymaster.validatePaymasterUserOp(op, bytes32(0), 1 ether);
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        paymaster.validatePaymasterUserOp(op, bytes32(0), 1 ether);
    }

    function testExpiredPermitRejected() public {
        ScopedSponsorshipPaymaster.Permit memory permit = _permit(uint64(block.timestamp - 1), 1 ether);
        PackedUserOperation memory op = _userOp(permit, _signature(permit), _executeCall(target, abi.encodeWithSelector(ORDER_SELECTOR)));
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        paymaster.validatePaymasterUserOp(op, bytes32(0), 1 ether);
    }

    function testCostAboveCapRejected() public {
        ScopedSponsorshipPaymaster.Permit memory permit = _permit(uint64(block.timestamp + 1 hours), 1 ether);
        PackedUserOperation memory op = _userOp(permit, _signature(permit), _executeCall(target, abi.encodeWithSelector(ORDER_SELECTOR)));
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        paymaster.validatePaymasterUserOp(op, bytes32(0), 2 ether);
    }

    function testWrongTargetRejected() public {
        ScopedSponsorshipPaymaster.Permit memory permit = _permit(uint64(block.timestamp + 1 hours), 1 ether);
        PackedUserOperation memory op = _userOp(permit, _signature(permit), _executeCall(address(0xBAD), abi.encodeWithSelector(ORDER_SELECTOR)));
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        paymaster.validatePaymasterUserOp(op, bytes32(0), 1 ether);
    }

    function testWrongSelectorRejected() public {
        ScopedSponsorshipPaymaster.Permit memory permit = _permit(uint64(block.timestamp + 1 hours), 1 ether);
        PackedUserOperation memory op = _userOp(permit, _signature(permit), _executeCall(target, abi.encodeWithSelector(bytes4(0xdeadbeef))));
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        paymaster.validatePaymasterUserOp(op, bytes32(0), 1 ether);
    }

    function testWrongSignerRejected() public {
        ScopedSponsorshipPaymaster.Permit memory permit = _permit(uint64(block.timestamp + 1 hours), 1 ether);
        bytes32 digest = paymaster.permitDigest(permit);
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, ethSigned);
        PackedUserOperation memory op = _userOp(permit, abi.encodePacked(r, s, v), _executeCall(target, abi.encodeWithSelector(ORDER_SELECTOR)));
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        paymaster.validatePaymasterUserOp(op, bytes32(0), 1 ether);
    }

    function testOnlyEntryPointCanValidate() public {
        ScopedSponsorshipPaymaster.Permit memory permit = _permit(uint64(block.timestamp + 1 hours), 1 ether);
        PackedUserOperation memory op = _userOp(permit, _signature(permit), _executeCall(target, abi.encodeWithSelector(ORDER_SELECTOR)));
        vm.expectRevert();
        paymaster.validatePaymasterUserOp(op, bytes32(0), 1 ether);
    }

    function testGatewaySettlesSpotOrderOnce() public {
        Token cash = new Token("dEUR", "dEUR", 6);
        Token spot = new Token("tWETH", "tWETH", 18);
        RestrictedShare fund = new RestrictedShare("eFUND", "eFUND", 6, address(this));
        Escrow escrow = new Escrow(cash);
        DvPSettlement settlement = new DvPSettlement(cash, spot, fund, escrow, address(0xFEE), address(this));
        escrow.setOperator(address(settlement));
        RetailOrderEntry entry = new RetailOrderEntry(settlement);
        settlement.setOperator(address(entry));
        address dealer = address(0xD3A1E2);
        cash.mint(address(this), 1_000e6);
        spot.mint(dealer, 1e18);
        cash.approve(address(settlement), type(uint256).max);
        vm.prank(dealer);
        spot.approve(address(settlement), type(uint256).max);
        bytes32 orderId = keccak256("G01-SPOT-01");
        entry.submitSpotOrder(orderId, dealer, 200e6, 50_000, 1e17, block.timestamp + 1 hours);
        assert(cash.balanceOf(address(this)) == 799_950_000);
        assert(spot.balanceOf(address(this)) == 1e17);
        vm.expectRevert();
        entry.submitSpotOrder(orderId, dealer, 200e6, 50_000, 1e17, block.timestamp + 1 hours);
    }

    function testGatewayRejectsExpiredOrder() public {
        Token cash = new Token("dEUR", "dEUR", 6);
        Token spot = new Token("tWETH", "tWETH", 18);
        RestrictedShare fund = new RestrictedShare("eFUND", "eFUND", 6, address(this));
        Escrow escrow = new Escrow(cash);
        DvPSettlement settlement = new DvPSettlement(cash, spot, fund, escrow, address(this), address(this));
        escrow.setOperator(address(settlement));
        RetailOrderEntry entry = new RetailOrderEntry(settlement);
        settlement.setOperator(address(entry));
        vm.expectRevert();
        entry.submitSpotOrder(keccak256("EXPIRED"), address(0xD3A1E2), 1, 0, 1, block.timestamp - 1);
    }
}
