#!/usr/bin/env bash
# Starts the pinned two-layer devnet in the `eurorollup` Kurtosis enclave.
#
# The devnet uses the upstream ethpandaops/optimism-package at a pinned commit
# with one committed patch: a single-beacon Fulu/PeerDAS devnet must request the
# lighthouse supernode data-column subscription, otherwise the beacon node
# rejects locally produced blocks. The patch is applied locally and never
# modifies the upstream repository.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# The upstream ethereum-package launcher still passes the legacy
# --allow-insecure-unlock flag, removed in geth 1.17. Pin the last compatible
# stable release and expose it under the tag the launcher expects.
PINNED_GETH_IMAGE="ethereum/client-go:v1.16.9"
docker pull -q "${PINNED_GETH_IMAGE}"
docker tag "${PINNED_GETH_IMAGE}" ethereum/client-go:latest

if ! kurtosis engine status >/dev/null 2>&1; then
  kurtosis engine start
fi

# Pinned upstream package commit (recorded with the A05 evidence). The devnet
# config supplies the L1 network parameters explicitly so the package keeps the
# supernode participant instead of injecting its own default participant list.
PACKAGE_COMMIT="7bef190d7c0b9f619438ed08b17bd5e5f51e72ff"

kurtosis enclave rm -f eurorollup >/dev/null 2>&1 || true
kurtosis run "github.com/ethpandaops/optimism-package@${PACKAGE_COMMIT}" \
  --args-file "${REPO_ROOT}/devnet/network_params.yaml" \
  --enclave eurorollup
