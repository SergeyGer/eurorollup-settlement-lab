// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {IEligibilityRegistry} from "./IEligibilityRegistry.sol";

interface IEligibilityVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

/// @title Issuer eligibility registry with onchain UltraHonk proof verification.
/// @notice The issuer publishes versioned Merkle roots per epoch. A holder presents a
/// wallet-bound membership proof for one policy gate; the proof is verified onchain and
/// cached with its policy version, root, epoch, class and expiry. Every movement that
/// needs eligibility calls `requireEligible`, so requests made under an older root stop
/// working after rotation, and the caller decides how the reserved funds are recovered.
contract EligibilityRegistry is IEligibilityRegistry {
    struct Policy {
        bytes32 root;
        uint32 epoch;
        uint32 policyVersion;
        uint64 publishedAt;
    }

    struct Approval {
        bytes32 root;
        uint32 epoch;
        uint32 policyVersion;
        uint64 expiry;
        uint32 classCode;
        bool exists;
    }

    uint256 public constant PUBLIC_INPUT_COUNT = 7;

    address public owner;
    address public issuer;
    IEligibilityVerifier public verifier;
    uint256 public immutable chainId;

    Policy public policy;
    mapping(address => bool) public authorizedIssuers;
    mapping(address => mapping(uint256 => Approval)) private approvals;
    mapping(uint256 => uint32) public requiredClassByGate;

    event IssuerChanged(address indexed issuer);
    event IssuerAuthorized(address indexed account, bool authorized);
    event RootPublished(bytes32 indexed root, uint32 indexed epoch, uint32 indexed policyVersion);
    event ApprovalCached(
        address indexed holder,
        uint256 indexed gate,
        uint32 policyVersion,
        uint32 epoch,
        uint64 expiry,
        uint32 classCode
    );
    event RequiredClassChanged(uint256 indexed gate, uint32 requiredClass);

    error UnauthorizedIssuer(address account);
    error UnauthorizedOwner(address account);
    error InvalidPolicyUpdate(uint32 currentVersion, uint32 nextVersion);
    error InvalidRoot();
    error InvalidPublicInputs(uint256 count);
    error ChainMismatch(uint256 expected, uint256 observed);
    error GateMismatch(uint256 expected, uint256 observed);
    error WalletMismatch(address holder, address provenWallet);
    error UnknownRoot(bytes32 expected, bytes32 observed);
    error UnknownEpoch(uint32 expected, uint32 observed);
    error ProofInvalid();
    error EligibilityMissing(address holder);
    error EligibilityStale(address holder, uint32 approvedPolicyVersion, uint32 currentPolicyVersion);
    error EligibilityRootChanged(address holder, bytes32 approvedRoot, bytes32 currentRoot);
    error EligibilityEpochChanged(address holder, uint32 approvedEpoch, uint32 currentEpoch);
    error EligibilityExpired(address holder, uint64 expiry, uint64 nowTimestamp);
    error EligibilityClassTooLow(address holder, uint32 holderClass, uint32 requiredClass);

    modifier onlyOwner() {
        if (msg.sender != owner) revert UnauthorizedOwner(msg.sender);
        _;
    }

    modifier onlyAuthorizedIssuer() {
        if (!authorizedIssuers[msg.sender]) revert UnauthorizedIssuer(msg.sender);
        _;
    }

    constructor(address registryOwner, IEligibilityVerifier eligibilityVerifier, uint256 settlementChainId) {
        owner = registryOwner;
        verifier = eligibilityVerifier;
        chainId = settlementChainId;
        issuer = registryOwner;
        authorizedIssuers[registryOwner] = true;
    }

    function setIssuer(address nextIssuer) external onlyOwner {
        issuer = nextIssuer;
        authorizedIssuers[nextIssuer] = true;
        emit IssuerChanged(nextIssuer);
    }

    function setIssuerAuthorized(address account, bool authorized) external onlyOwner {
        authorizedIssuers[account] = authorized;
        emit IssuerAuthorized(account, authorized);
    }

    function setRequiredClass(uint256 gate, uint32 requiredClass) external onlyOwner {
        requiredClassByGate[gate] = requiredClass;
        emit RequiredClassChanged(gate, requiredClass);
    }

    function publishRoot(bytes32 nextRoot, uint32 nextEpoch, uint32 nextPolicyVersion) external onlyAuthorizedIssuer {
        if (nextPolicyVersion <= policy.policyVersion) revert InvalidPolicyUpdate(policy.policyVersion, nextPolicyVersion);
        if (nextRoot == bytes32(0)) revert InvalidRoot();
        policy = Policy({
            root: nextRoot,
            epoch: nextEpoch,
            policyVersion: nextPolicyVersion,
            publishedAt: uint64(block.timestamp)
        });
        emit RootPublished(nextRoot, nextEpoch, nextPolicyVersion);
    }

    /// @notice Verify the wallet-bound membership proof for one gate and cache the approval.
    /// Public inputs order: wallet, root, chain_id, gate, class, epoch, expiry.
    function verifyAndCache(address holder, uint256 gate, bytes calldata proof, bytes32[] calldata publicInputs)
        external
    {
        if (publicInputs.length != PUBLIC_INPUT_COUNT) revert InvalidPublicInputs(publicInputs.length);
        uint256 wallet = uint256(publicInputs[0]);
        if (holder == address(0) || address(uint160(wallet)) != holder) revert WalletMismatch(holder, address(uint160(wallet)));
        if (uint256(publicInputs[1]) != uint256(policy.root)) revert UnknownRoot(policy.root, publicInputs[1]);
        if (uint256(publicInputs[2]) != chainId) revert ChainMismatch(chainId, uint256(publicInputs[2]));
        if (uint256(publicInputs[3]) != gate) revert GateMismatch(gate, uint256(publicInputs[3]));
        if (uint256(publicInputs[5]) != policy.epoch) revert UnknownEpoch(policy.epoch, uint32(uint256(publicInputs[5])));
        uint64 expiry = uint64(uint256(publicInputs[6]));
        if (expiry <= block.timestamp) revert EligibilityExpired(holder, expiry, uint64(block.timestamp));
        uint32 classCode = uint32(uint256(publicInputs[4]));
        if (classCode < requiredClassByGate[gate]) revert EligibilityClassTooLow(holder, classCode, requiredClassByGate[gate]);
        if (!verifier.verify(proof, publicInputs)) revert ProofInvalid();
        approvals[holder][gate] = Approval({
            root: policy.root,
            epoch: policy.epoch,
            policyVersion: policy.policyVersion,
            expiry: expiry,
            classCode: classCode,
            exists: true
        });
        emit ApprovalCached(holder, gate, policy.policyVersion, policy.epoch, expiry, classCode);
    }

    /// @notice Reason-carrying eligibility check used by the share and settlement contracts.
    function requireEligible(address holder, uint256 gate) external view {
        Approval memory approval = approvals[holder][gate];
        if (!approval.exists) revert EligibilityMissing(holder);
        if (approval.policyVersion != policy.policyVersion) {
            revert EligibilityStale(holder, approval.policyVersion, policy.policyVersion);
        }
        if (approval.root != policy.root) revert EligibilityRootChanged(holder, approval.root, policy.root);
        if (approval.epoch != policy.epoch) revert EligibilityEpochChanged(holder, approval.epoch, policy.epoch);
        if (approval.expiry <= block.timestamp) revert EligibilityExpired(holder, approval.expiry, uint64(block.timestamp));
        if (approval.classCode < requiredClassByGate[gate]) {
            revert EligibilityClassTooLow(holder, approval.classCode, requiredClassByGate[gate]);
        }
    }

    function isEligible(address holder, uint256 gate) external view returns (bool) {
        Approval memory approval = approvals[holder][gate];
        return approval.exists && approval.policyVersion == policy.policyVersion && approval.root == policy.root
            && approval.epoch == policy.epoch && approval.expiry > block.timestamp
            && approval.classCode >= requiredClassByGate[gate];
    }

    function approvalOf(address holder, uint256 gate) external view returns (Approval memory) {
        return approvals[holder][gate];
    }

    function policyView() external view returns (Policy memory) {
        return policy;
    }
}
