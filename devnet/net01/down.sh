#!/usr/bin/env bash
# Stops the NET-01 consensus lane enclave.
set -euo pipefail
ENCLAVE="${NET01_ENCLAVE:-net01}"
command -v kurtosis >/dev/null || { echo "kurtosis is required" >&2; exit 1; }
kurtosis enclave rm -f "$ENCLAVE" >/dev/null 2>&1 || true
echo "removed enclave ${ENCLAVE}"
