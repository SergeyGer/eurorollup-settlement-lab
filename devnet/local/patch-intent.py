#!/usr/bin/env python3
"""Patch an op-deployer `custom` intent for the local devnet.

The `custom` intent type deploys the whole L1 contract stack from scratch, which
is what a fresh local anvil chain needs. The generated intent is a template with
zero addresses; this script fills the role addresses supplied by the launcher and
sets the required non-zero EIP-1559 parameters.
"""
import json
import re
import sys


def main() -> int:
    intent_path, addresses_path = sys.argv[1], sys.argv[2]
    with open(addresses_path, encoding="utf-8") as handle:
        addresses = json.load(handle)

    with open(intent_path, encoding="utf-8") as handle:
        text = handle.read()

    def set_field(name: str, value: str) -> None:
        nonlocal text
        pattern = rf'(?m)^(\s*{name} = )"0x[0-9a-fA-F]*"'
        replaced, count = re.subn(pattern, rf'\g<1>"{value}"', text)
        if count != 1:
            raise SystemExit(f"expected exactly one {name} field, patched {count}")
        text = replaced

    def set_optional_field(name: str, value: str) -> None:
        nonlocal text
        pattern = rf'(?m)^(\s*{name} = )"0x[0-9a-fA-F]*"'
        text = re.sub(pattern, rf'\g<1>"{value}"', text)

    for name in ("SuperchainProxyAdminOwner", "SuperchainGuardian"):
        set_field(name, addresses["admin"])
    # v0.6 intents additionally carry a ProtocolVersions owner.
    set_optional_field("ProtocolVersionsOwner", addresses["admin"])
    # Some intent versions carry a chain fee recipient.
    set_optional_field("chainFeesRecipient", addresses["l1Fee"])
    set_field("Challenger", addresses["challenger"])
    set_field("baseFeeVaultRecipient", addresses["baseFee"])
    set_field("l1FeeVaultRecipient", addresses["l1Fee"])
    set_field("sequencerFeeVaultRecipient", addresses["sequencerFee"])
    set_field("operatorFeeVaultRecipient", addresses["sequencerFee"])
    for role, key in (
        ("l1ProxyAdminOwner", "admin"),
        ("l2ProxyAdminOwner", "admin"),
        ("systemConfigOwner", "systemConfig"),
        ("unsafeBlockSigner", "sequencer"),
        ("batcher", "batcher"),
        ("proposer", "proposer"),
        ("challenger", "challenger"),
    ):
        set_field(role, addresses[key])

    text = text.replace("eip1559DenominatorCanyon = 0", "eip1559DenominatorCanyon = 250")
    text = text.replace("eip1559Denominator = 0", "eip1559Denominator = 50")
    text = text.replace("eip1559Elasticity = 0", "eip1559Elasticity = 6")
    text = text.replace("fundDevAccounts = false", "fundDevAccounts = true")

    with open(intent_path, "w", encoding="utf-8") as handle:
        handle.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
