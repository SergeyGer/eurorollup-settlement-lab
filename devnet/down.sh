#!/usr/bin/env bash
# Stops the devnet enclave and removes its containers and file artifacts.
set -euo pipefail
kurtosis enclave rm -f eurorollup
