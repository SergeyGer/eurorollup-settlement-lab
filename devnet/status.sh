#!/usr/bin/env bash
# Shows the devnet enclave services and their host ports.
set -euo pipefail
if ! kurtosis enclave inspect eurorollup >/dev/null 2>&1; then
  echo "The eurorollup enclave is not running. Start it with: pnpm devnet:up"
  exit 1
fi
kurtosis enclave inspect eurorollup
