// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

/// @notice Minimal interface the share and settlement contracts use to enforce eligibility.
interface IEligibilityRegistry {
    function isEligible(address holder, uint256 gate) external view returns (bool);
    function requireEligible(address holder, uint256 gate) external view;
}
