// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Token} from "./Token.sol";

/// @title Restricted fund-share instrument (eFUND).
/// @notice Transfers are only allowed between eligible holders. Minting and burning are
/// reserved for the issuer and explicitly authorised settlement minters; S16 adds the
/// onchain Noir eligibility proof to this gate.
contract RestrictedShare is Token {
    address public issuer;
    mapping(address => bool) public eligible;
    mapping(address => bool) public minters;

    event EligibilityChanged(address indexed account, bool allowed);
    event MinterChanged(address indexed account, bool allowed);

    modifier onlyIssuer() {
        require(msg.sender == issuer, "Share: not issuer");
        _;
    }

    constructor(string memory tokenName, string memory tokenSymbol, uint8 tokenDecimals, address shareIssuer)
        Token(tokenName, tokenSymbol, tokenDecimals)
    {
        issuer = shareIssuer;
    }

    function setEligible(address account, bool allowed) external onlyIssuer {
        eligible[account] = allowed;
        emit EligibilityChanged(account, allowed);
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
        require(eligible[from], "Share: sender not eligible");
        require(eligible[to], "Share: recipient not eligible");
        super._transfer(from, to, amount);
    }
}
