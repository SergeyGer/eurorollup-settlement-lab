#!/usr/bin/env bash
# Shared configuration and helpers for the controlled local OP Stack devnet.
#
# Everything here is development-only material: the private keys are the public
# well-known anvil/Hardhat development keys, not secrets.
set -euo pipefail

LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${LOCAL_DIR}/../.." && pwd)"
WORK_DIR="${DEVNET_LOCAL_WORK:-${REPO_ROOT}/.devnet-local}"

# Network layout (host networking, fixed ports).
L1_PORT="${L1_PORT:-8545}"
L2_HTTP_PORT=9545
L2_WS_PORT=9546
L2_AUTH_PORT=9551
NODE_RPC_PORT=9547
BATCHER_RPC_PORT=9548
PROPOSER_RPC_PORT=9560
L1_CHAIN_ID=11155111
L2_CHAIN_ID=16584
L1_BLOCK_SECONDS=2
L2_BLOCK_SECONDS=2

# Pinned component versions. The evidence capture records the resolved image
# digests next to these tags.
OP_RETH_IMAGE="us-docker.pkg.dev/oplabs-tools-artifacts/images/op-reth:v2.4.0"
OP_NODE_IMAGE="us-docker.pkg.dev/oplabs-tools-artifacts/images/op-node:v1.19.3"
OP_BATCHER_IMAGE="us-docker.pkg.dev/oplabs-tools-artifacts/images/op-batcher:v1.16.11"
OP_PROPOSER_IMAGE="us-docker.pkg.dev/oplabs-tools-artifacts/images/op-proposer:v1.16.3"
OP_DEPLOYER_VERSION="0.6.0"
OP_DEPLOYER_URL="https://github.com/ethereum-optimism/optimism/releases/download/op-deployer/v${OP_DEPLOYER_VERSION}/op-deployer-${OP_DEPLOYER_VERSION}-linux-amd64.tar.gz"
OP_DEPLOYER_SHA256="93d668675971b57ebcef25d5bd3ae421e191b3b958bcc9cbceb68fe6b65ffb3f"

OP_RETH_CONTAINER="${OP_RETH_CONTAINER:-op-reth-local}"
OP_NODE_CONTAINER="${OP_NODE_CONTAINER:-op-node-local}"
OP_BATCHER_CONTAINER="${OP_BATCHER_CONTAINER:-op-batcher-local}"
OP_PROPOSER_CONTAINER="${OP_PROPOSER_CONTAINER:-op-proposer-local}"

# Deterministic development accounts derived from the public anvil mnemonic
# "test test test test test test test test test test test junk".
ROLE_KEYS=(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356"
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97"
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6"
)
ROLE_ADDRS=(
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906"
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"
  "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"
  "0x976EA74026E726554dB657fA54763abd0C3a0aa9"
  "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955"
  "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f"
  "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720"
)
DEPLOYER_KEY="${ROLE_KEYS[0]}"
DEPLOYER_ADDR="${ROLE_ADDRS[0]}"
ADMIN_KEY="${ROLE_KEYS[1]}"
ADMIN_ADDR="${ROLE_ADDRS[1]}"
BASE_FEE_ADDR="${ROLE_ADDRS[2]}"
L1_FEE_ADDR="${ROLE_ADDRS[3]}"
SEQ_FEE_ADDR="${ROLE_ADDRS[4]}"
SYS_CONFIG_ADDR="${ROLE_ADDRS[5]}"
SEQUENCER_KEY="${ROLE_KEYS[6]}"
SEQUENCER_ADDR="${ROLE_ADDRS[6]}"
BATCHER_KEY="${ROLE_KEYS[7]}"
BATCHER_ADDR="${ROLE_ADDRS[7]}"
PROPOSER_KEY="${ROLE_KEYS[8]}"
PROPOSER_ADDR="${ROLE_ADDRS[8]}"
CHALLENGER_KEY="${ROLE_KEYS[9]}"
CHALLENGER_ADDR="${ROLE_ADDRS[9]}"

L1_RPC="http://127.0.0.1:${L1_PORT}"
L2_RPC="http://127.0.0.1:${L2_HTTP_PORT}"
NODE_RPC="http://127.0.0.1:${NODE_RPC_PORT}"

log()  { printf '\033[1;34m[local-devnet]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[local-devnet:error]\033[0m %s\n' "$*" >&2; exit 1; }

require_tools() {
  command -v anvil >/dev/null || fail "anvil (Foundry) is required"
  command -v cast >/dev/null || fail "cast (Foundry) is required"
  command -v docker >/dev/null || fail "docker is required"
  command -v curl >/dev/null || fail "curl is required"
  command -v python3 >/dev/null || fail "python3 is required"
  command -v openssl >/dev/null || fail "openssl is required"
}

jsonrpc() {
  # jsonrpc <url> <method> <params-json>
  curl -s -X POST -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":$3}" "$1"
}

rpc_number() {
  jsonrpc "$1" "$2" '[]' | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d.get("result"); print(int(r,16) if isinstance(r,str) else 0)'
}

wait_for_rpc() {
  local url="$1" name="$2" attempts="${3:-120}"
  for _ in $(seq 1 "$attempts"); do
    if cast chain-id --rpc-url "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "${name} RPC at ${url} did not become ready"
}

wait_for_node_rpc() {
  local url="$1" attempts="${2:-120}"
  for _ in $(seq 1 "$attempts"); do
    if jsonrpc "$url" optimism_syncStatus '[]' 2>/dev/null | grep -q '"result"'; then return 0; fi
    sleep 1
  done
  fail "op-node RPC at ${url} did not become ready"
}

wait_for_number() {
  # wait_for_number <url> <method> <target> <name> [attempts] [sleep]
  local url="$1" method="$2" target="$3" name="$4" attempts="${5:-180}" pause="${6:-2}"
  for _ in $(seq 1 "$attempts"); do
    local current
    current="$(rpc_number "$url" "$method")"
    if [ "$current" -ge "$target" ]; then return 0; fi
    sleep "$pause"
  done
  fail "timed out waiting for ${name} (target ${target})"
}

write_work_dir() {
  mkdir -p "${WORK_DIR}"/{deployer,run,bin,data}
}

op_deployer_bin() {
  local bin="${WORK_DIR}/bin/op-deployer"
  if [ ! -x "$bin" ]; then
    log "downloading op-deployer v${OP_DEPLOYER_VERSION}"
    local archive="${WORK_DIR}/bin/op-deployer.tar.gz"
    curl -fsSL "${OP_DEPLOYER_URL}" -o "$archive"
    echo "${OP_DEPLOYER_SHA256}  ${archive}" | sha256sum -c - >/dev/null || fail "op-deployer archive checksum mismatch"
    tar xzf "$archive" -C "${WORK_DIR}/bin"
    cp "${WORK_DIR}/bin/op-deployer-${OP_DEPLOYER_VERSION}-linux-amd64/op-deployer" "$bin"
    chmod +x "$bin"
  fi
  printf '%s\n' "$bin"
}

container_name_in_use() {
  docker ps -a --format '{{.Names}}' | grep -qx "$1"
}

stop_container() {
  if container_name_in_use "$1"; then docker rm -f "$1" >/dev/null 2>&1 || true; fi
}

stop_anvil() {
  local pidfile="${WORK_DIR}/anvil.pid"
  if [ -f "$pidfile" ]; then
    local pid; pid="$(cat "$pidfile")"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi
    rm -f "$pidfile"
  fi
  if command -v fuser >/dev/null 2>&1; then fuser -k "${L1_PORT}/tcp" >/dev/null 2>&1 || true; fi
  sleep 1
}
