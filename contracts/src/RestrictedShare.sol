// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Token} from "./Token.sol";
import {IEligibilityRegistry} from "./IEligibilityRegistry.sol";

/// @title Restricted fund-share instrument (eFUND).
/// @notice Transfers are only allowed between eligible holders. Minting and burning are
/// reserved for the issuer and explicitly authorised settlement minters; S16 adds the
/// onchain Noir eligibility proof to this gate.
contract RestrictedShare is Token {
    address public issuer;
    mapping(address => bool) public allowlisted;
    mapping(address => bool) public minters;
    IEligibilityRegistry public eligibilityRegistry;
    uint256 public transferGate;
    uint256 public subscriptionGate;
    uint256 public redemptionGate;

    event AllowlistChanged(address indexed account, bool allowed);
    event MinterChanged(address indexed account, bool allowed);
    event EligibilityRegistryChanged(address indexed registry, uint256 transferGateId, uint256 subscriptionGateId, uint256 redemptionGateId);

    modifier onlyIssuer() {
        require(msg.sender == issuer, "Share: not issuer");
        _;
    }

    constructor(string memory tokenName, string memory tokenSymbol, uint8 tokenDecimals, address shareIssuer)
        Token(tokenName, tokenSymbol, tokenDecimals)
    {
        issuer = shareIssuer;
    }

    function setAllowlisted(address account, bool allowed) external onlyIssuer {
        allowlisted[account] = allowed;
        emit AllowlistChanged(account, allowed);
    }

    /// @notice Wire the issuer eligibility registry and the per-movement policy gates.
    /// A zero registry keeps the S15 allowlist-only behaviour for local unit tests.
    function configureEligibility(address registry, uint256 transferGateId, uint256 subscriptionGateId, uint256 redemptionGateId)
        external
        onlyIssuer
    {
        eligibilityRegistry = IEligibilityRegistry(registry);
        transferGate = transferGateId;
        subscriptionGate = subscriptionGateId;
        redemptionGate = redemptionGateId;
        emit EligibilityRegistryChanged(registry, transferGateId, subscriptionGateId, redemptionGateId);
    }

    function setMinter(address account, bool allowed) external onlyIssuer {
        minters[account] = allowed;
        emit MinterChanged(account, allowed);
    }

    function mint(address to, uint256 amount) public override {
        require(msg.sender == owner || minters[msg.sender], "Share: not minter");
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) public override {
        require(msg.sender == owner || minters[msg.sender], "Share: not minter");
        _burn(from, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        _requireEligible(from, transferGate);
        _requireEligible(to, transferGate);
        super._transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal override {
        _requireEligible(to, subscriptionGate);
        super._mint(to, amount);
    }

    function _burn(address from, uint256 amount) internal override {
        _requireEligible(from, redemptionGate);
        super._burn(from, amount);
    }

    function _requireEligible(address holder, uint256 gate) private view {
        if (address(eligibilityRegistry) != address(0) && gate != 0) {
            eligibilityRegistry.requireEligible(holder, gate);
        }
    }
}
