// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

/// @notice Minimal ERC-4337 v0.7 packed user-operation layout used by the paymaster.
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

interface IEntryPointV07 {
    function depositTo(address account) external payable;
    function balanceOf(address account) external view returns (uint256);
    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external;
}

/// @title Paymaster for one target- and method-scoped, expiring sponsorship permit.
/// @notice The sponsor signs a permit binding the account, the exact target contract and
/// method selector, the chain id, a single-use permit nonce, the expiry and the maximum
/// cost in wei. The paymaster only validates operations whose inner account call matches
/// the permit, marks the permit used, and lets the pinned EntryPoint charge the sponsor
/// deposit. The user account never pays gas.
contract ScopedSponsorshipPaymaster {
    uint256 public constant PAYMASTER_DATA_OFFSET = 52; // address + 2 * uint128 gas limits

    IEntryPointV07 public immutable entryPoint;
    address public immutable sponsor;
    address public immutable owner;
    mapping(bytes32 => bool) public permitUsed;

    struct Permit {
        address account;
        address target;
        bytes4 selector;
        uint256 chainId;
        uint256 permitNonce;
        uint64 validUntil;
        uint256 maxCost;
    }

    event PermitConsumed(bytes32 indexed permitHash, address indexed account, address indexed target, bytes4 selector, uint256 permitNonce);
    event Deposited(address indexed sponsor, uint256 amount);

    error NotEntryPoint(address caller);
    error EmptyContext();
    error WrongChain(uint256 expected, uint256 observed);
    error PermitExpired(uint64 validUntil, uint64 nowTimestamp);
    error PermitAlreadyUsed(bytes32 permitHash);
    error PermitAccountMismatch(address expected, address observed);
    error PermitTargetMismatch(address expected, address observed);
    error PermitSelectorMismatch(bytes4 expected, bytes4 observed);
    error PermitValueNotZero(uint256 value);
    error CostAboveCap(uint256 cost, uint256 maxCost);
    error InvalidSponsorSignature(address recovered, address expected);
    error MalformedPermitData();

    constructor(address entryPointAddress, address permitSponsor) {
        entryPoint = IEntryPointV07(entryPointAddress);
        sponsor = permitSponsor;
        owner = msg.sender;
    }

    modifier onlyEntryPoint() {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint(msg.sender);
        _;
    }

    function deposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(address payable to, uint256 amount) external {
        require(msg.sender == owner, "Paymaster: not owner");
        entryPoint.withdrawTo(to, amount);
    }

    function getEntryPoint() external view returns (address) {
        return address(entryPoint);
    }

    /// @notice Digest the sponsor signs; also binds the paymaster and EntryPoint addresses.
    function permitDigest(Permit memory permit) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                block.chainid,
                address(this),
                address(entryPoint),
                permit.account,
                permit.target,
                permit.selector,
                permit.permitNonce,
                permit.validUntil,
                permit.maxCost
            )
        );
    }

    /// @notice EntryPoint validation hook. Returns the permit hash as context and packs
    /// the permit expiry into the validation data.
    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256 maxCost)
        external
        onlyEntryPoint
        returns (bytes memory context, uint256 validationData)
    {
        if (userOp.paymasterAndData.length <= PAYMASTER_DATA_OFFSET) revert MalformedPermitData();
        bytes calldata data = userOp.paymasterAndData[PAYMASTER_DATA_OFFSET:];
        (Permit memory permit, bytes memory signature) = abi.decode(data, (Permit, bytes));
        if (permit.account != userOp.sender) revert PermitAccountMismatch(userOp.sender, permit.account);
        if (permit.chainId != block.chainid) revert WrongChain(block.chainid, permit.chainId);
        if (block.timestamp > permit.validUntil) revert PermitExpired(permit.validUntil, uint64(block.timestamp));
        if (maxCost > permit.maxCost) revert CostAboveCap(maxCost, permit.maxCost);
        bytes32 digest = permitDigest(permit);
        if (permitUsed[digest]) revert PermitAlreadyUsed(digest);
        address recovered = _recoverSigner(digest, signature);
        if (recovered != sponsor) revert InvalidSponsorSignature(recovered, sponsor);
        _checkInnerCall(userOp.callData, permit.target, permit.selector);
        permitUsed[digest] = true;
        emit PermitConsumed(digest, permit.account, permit.target, permit.selector, permit.permitNonce);
        return (abi.encode(digest), _packValidationData(uint48(permit.validUntil)));
    }

    /// @notice ERC-4337 v0.7 postOp hook (mode, context, actualGasCost, actualFeePerGas).
    function postOp(uint8, bytes calldata context, uint256, uint256) external onlyEntryPoint {
        if (context.length == 0) revert EmptyContext();
    }

    function _checkInnerCall(bytes calldata callData, address expectedTarget, bytes4 expectedSelector) private pure {
        if (callData.length < 4) revert MalformedPermitData();
        // The account must call execute(target, value, innerData); the permit scopes the
        // inner target contract and the inner method selector of the actual order.
        (address innerTarget, uint256 value, bytes memory innerData) = abi.decode(callData[4:], (address, uint256, bytes));
        if (innerTarget != expectedTarget) revert PermitTargetMismatch(expectedTarget, innerTarget);
        if (value != 0) revert PermitValueNotZero(value);
        if (innerData.length < 4) revert MalformedPermitData();
        bytes4 selector = bytes4(innerData);
        if (selector != expectedSelector) revert PermitSelectorMismatch(expectedSelector, selector);
    }

    function _recoverSigner(bytes32 digest, bytes memory signature) private pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (v < 27) v += 27;
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        return ecrecover(ethSigned, v, r, s);
    }

    function _packValidationData(uint48 validUntil) private pure returns (uint256) {
        return uint256(validUntil) << 160; // validAfter = 0, validUntil in bits 160..208
    }
}
