#!/usr/bin/env bash
# Tears down the controlled local OP Stack devnet.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

log "removing OP Stack containers"
stop_container "$OP_RETH_CONTAINER"
stop_container "$OP_NODE_CONTAINER"
stop_container "$OP_BATCHER_CONTAINER"
stop_container "$OP_PROPOSER_CONTAINER"

if [ -f "${WORK_DIR}/clock.pid" ]; then
  kill "$(cat "${WORK_DIR}/clock.pid")" 2>/dev/null || true
  rm -f "${WORK_DIR}/clock.pid"
fi

log "stopping the anvil L1"
stop_anvil

log "local devnet stopped (state kept under ${WORK_DIR})"
