// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

/// @title Two-of-three upgrade authority with a timelock and forward recovery.
/// @notice Three owners approve a proposal; execution requires two approvals, the
/// timelock to elapse and the proposal to be unused. A rejected early activation is a
/// hard revert. A failed execution is recorded and can be recovered forward (retry after
/// the target is fixed) without losing the approvals or the audit trail.
contract TwoOfThreeAuthority {
    struct Proposal {
        address target;
        uint256 value;
        bytes data;
        uint64 eta;
        uint8 approvals;
        bool executed;
        bool failed;
    }

    address[3] public owners;
    uint64 public immutable timelockDelay;
    mapping(bytes32 => Proposal) private proposals;
    mapping(bytes32 => mapping(address => bool)) private approvalsByOwner;

    event Proposed(bytes32 indexed proposalId, address indexed target, uint64 eta);
    event Approved(bytes32 indexed proposalId, address indexed owner, uint8 approvals);
    event Activated(bytes32 indexed proposalId, uint256 activationBlock);
    event ExecutionFailed(bytes32 indexed proposalId, bytes reason);
    event Recovered(bytes32 indexed proposalId);

    error NotOwner(address caller);
    error TimelockNotElapsed(uint64 eta, uint64 nowTimestamp);
    error InsufficientApprovals(uint8 approvals);
    error AlreadyUsed(bytes32 proposalId);
    error ProposalNotFound(bytes32 proposalId);
    error NotFailed(bytes32 proposalId);

    modifier onlyOwner() {
        bool isOwner = false;
        for (uint256 index = 0; index < 3; index++) {
            if (owners[index] == msg.sender) isOwner = true;
        }
        if (!isOwner) revert NotOwner(msg.sender);
        _;
    }

    constructor(address[3] memory initialOwners, uint64 delay) {
        owners = initialOwners;
        timelockDelay = delay;
    }

    function propose(bytes32 proposalId, address target, uint256 value, bytes calldata data, uint64 eta) external onlyOwner {
        Proposal storage proposal = proposals[proposalId];
        if (proposal.eta != 0) revert AlreadyUsed(proposalId);
        uint64 minimumEta = uint64(block.timestamp) + timelockDelay;
        if (eta < minimumEta) revert TimelockNotElapsed(eta, minimumEta);
        Proposal storage created = proposals[proposalId];
        created.target = target;
        created.value = value;
        created.data = data;
        created.eta = eta;
        emit Proposed(proposalId, target, eta);
    }

    function approve(bytes32 proposalId) external onlyOwner {
        Proposal storage proposal = proposals[proposalId];
        if (proposal.eta == 0) revert ProposalNotFound(proposalId);
        if (!approvalsByOwner[proposalId][msg.sender]) {
            approvalsByOwner[proposalId][msg.sender] = true;
            proposal.approvals += 1;
        }
        emit Approved(proposalId, msg.sender, proposal.approvals);
    }

    function execute(bytes32 proposalId) external onlyOwner {
        Proposal storage proposal = proposals[proposalId];
        if (proposal.eta == 0) revert ProposalNotFound(proposalId);
        if (proposal.executed) revert AlreadyUsed(proposalId);
        if (proposal.approvals < 2) revert InsufficientApprovals(proposal.approvals);
        if (block.timestamp < proposal.eta) revert TimelockNotElapsed(proposal.eta, uint64(block.timestamp));
        if (proposal.failed) proposal.failed = false;
        (bool success, bytes memory reason) = proposal.target.call{value: proposal.value}(proposal.data);
        if (!success) {
            proposal.failed = true;
            emit ExecutionFailed(proposalId, reason);
            return;
        }
        proposal.executed = true;
        emit Activated(proposalId, block.number);
    }

    /// @notice Forward recovery retry after a failed execution (target fixed off-chain).
    function recover(bytes32 proposalId) external onlyOwner {
        Proposal storage proposal = proposals[proposalId];
        if (proposal.eta == 0) revert ProposalNotFound(proposalId);
        if (!proposal.failed) revert NotFailed(proposalId);
        proposal.failed = false;
        emit Recovered(proposalId);
    }

    function proposalStatus(bytes32 proposalId) external view returns (Proposal memory) {
        return proposals[proposalId];
    }
}
