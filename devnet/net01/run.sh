#!/usr/bin/env bash
# Brings up the NET-01 consensus-backed lane with the pinned Kurtosis packages.
#
# Requires docker and kurtosis. The upstream optimism-package clone is pinned to the
# revision this repository was tested against; the local checkout is reset so a stale
# "supernode" patch cannot change the blob block validation path.
set -euo pipefail

LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="${OPTIMISM_PACKAGE_DIR:-/tmp/optimism-package}"
PACKAGE_REPO="${OPTIMISM_PACKAGE_REPO:-https://github.com/ethpandaops/optimism-package}"
PACKAGE_COMMIT="${OPTIMISM_PACKAGE_COMMIT:-7bef190d7c0b9f619438ed08b17bd5e5f51e72ff}"
ENCLAVE="${NET01_ENCLAVE:-net01}"

command -v kurtosis >/dev/null || { echo "kurtosis is required" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

if [ ! -d "$PACKAGE_DIR/.git" ]; then
  git clone "$PACKAGE_REPO" "$PACKAGE_DIR"
fi
git -C "$PACKAGE_DIR" fetch --quiet origin "$PACKAGE_COMMIT"
git -C "$PACKAGE_DIR" checkout --quiet "$PACKAGE_COMMIT"
git -C "$PACKAGE_DIR" checkout --quiet -- main.star

kurtosis enclave rm -f "$ENCLAVE" >/dev/null 2>&1 || true
kurtosis run "$PACKAGE_DIR" --args-file "$LOCAL_DIR/network-params.yaml" --enclave "$ENCLAVE"
