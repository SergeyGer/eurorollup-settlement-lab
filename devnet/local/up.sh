#!/usr/bin/env bash
# Brings up the controlled local OP Stack devnet:
#
#   L1: anvil execution chain with a synthetic two-second block clock
#   L2: op-reth (execution) + op-node (sequencer) + op-batcher (calldata DA)
#       + op-proposer (output roots into the respected dispute game)
#
# The L1 contract stack is deployed with op-deployer from a `custom` intent. All
# images are pinned and the deployment configuration is written to
# .devnet-local/ so the evidence capture can consume it.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_tools
write_work_dir
DEPLOY_DIR="${WORK_DIR}/deploy"
RUN_DIR="${WORK_DIR}/run"

log "stopping any previous local devnet"
stop_container "$OP_RETH_CONTAINER"
stop_container "$OP_NODE_CONTAINER"
stop_container "$OP_BATCHER_CONTAINER"
stop_container "$OP_PROPOSER_CONTAINER"
if [ -f "${WORK_DIR}/clock.pid" ]; then
  kill "$(cat "${WORK_DIR}/clock.pid")" 2>/dev/null || true
  rm -f "${WORK_DIR}/clock.pid"
fi
stop_anvil

log "starting anvil L1 on ${L1_RPC} (chain id ${L1_CHAIN_ID})"
(anvil --host 127.0.0.1 --port "${L1_PORT}" --chain-id "${L1_CHAIN_ID}" \
  --hardfork cancun --gas-limit 100000000 --silent \
  > "${WORK_DIR}/anvil.log" 2>&1 & echo $! > "${WORK_DIR}/anvil.pid")
wait_for_rpc "$L1_RPC" "L1" 60

# op-deployer deploys through the canonical Arachnid CREATE2 deployer. A fresh
# anvil chain does not have it, so install the known runtime bytecode.
log "installing the Arachnid CREATE2 deployer"
cast rpc anvil_setCode 0x4e59b44847b379578588920cA78FbF26c0B4956C \
  0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3 \
  --rpc-url "$L1_RPC" >/dev/null

log "funding development role accounts"
FUND_WEI="0x56bc75e2d63100000" # 100 ETH
for addr in "$DEPLOYER_ADDR" "$ADMIN_ADDR" "$BASE_FEE_ADDR" "$L1_FEE_ADDR" "$SEQ_FEE_ADDR" \
            "$SYS_CONFIG_ADDR" "$SEQUENCER_ADDR" "$BATCHER_ADDR" "$PROPOSER_ADDR" "$CHALLENGER_ADDR"; do
  cast rpc anvil_setBalance "$addr" "$FUND_WEI" --rpc-url "$L1_RPC" >/dev/null
done

OPD="$(op_deployer_bin)"
log "initializing op-deployer intent"
rm -rf "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"
"$OPD" init --l1-chain-id "$L1_CHAIN_ID" --l2-chain-ids "$L2_CHAIN_ID" \
  --workdir "$DEPLOY_DIR" --intent-type custom >/dev/null

cat > "${WORK_DIR}/addresses.json" <<JSON
{
  "admin": "${ADMIN_ADDR}",
  "baseFee": "${BASE_FEE_ADDR}",
  "l1Fee": "${L1_FEE_ADDR}",
  "sequencerFee": "${SEQ_FEE_ADDR}",
  "systemConfig": "${SYS_CONFIG_ADDR}",
  "sequencer": "${SEQUENCER_ADDR}",
  "batcher": "${BATCHER_ADDR}",
  "proposer": "${PROPOSER_ADDR}",
  "challenger": "${CHALLENGER_ADDR}"
}
JSON
python3 "${LOCAL_DIR}/patch-intent.py" "${DEPLOY_DIR}/intent.toml" "${WORK_DIR}/addresses.json"

log "deploying the OP Stack L1 contracts (this takes a few minutes)"
"$OPD" apply --l1-rpc-url "$L1_RPC" --private-key "$DEPLOYER_KEY" \
  --workdir "$DEPLOY_DIR" > "${WORK_DIR}/deploy.log" 2>&1 || {
    tail -40 "${WORK_DIR}/deploy.log" >&2
    fail "op-deployer apply failed"
  }

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR"
"$OPD" inspect genesis --workdir "$DEPLOY_DIR" "$L2_CHAIN_ID" > "${RUN_DIR}/genesis.json"
"$OPD" inspect rollup --workdir "$DEPLOY_DIR" "$L2_CHAIN_ID" > "${RUN_DIR}/rollup.json"
cp "${DEPLOY_DIR}/state.json" "${RUN_DIR}/state.json"
openssl rand -hex 32 > "${RUN_DIR}/jwt.txt"

log "starting op-reth L2 execution client"
docker run -d --name "$OP_RETH_CONTAINER" --network host \
  -v "${RUN_DIR}:/workspace" "$OP_RETH_IMAGE" \
  node --chain=/workspace/genesis.json --datadir=/workspace/op-reth-data \
  --http --http.addr=0.0.0.0 --http.port="${L2_HTTP_PORT}" --http.corsdomain='*' \
  --http.api=admin,debug,eth,net,txpool,web3 \
  --ws --ws.addr=0.0.0.0 --ws.port="${L2_WS_PORT}" --ws.origins='*' \
  --ws.api=admin,debug,eth,net,txpool,web3 \
  --authrpc.addr=0.0.0.0 --authrpc.port="${L2_AUTH_PORT}" --authrpc.jwtsecret=/workspace/jwt.txt \
  --rpc.eth-proof-window=100000 \
  --rollup.disable-tx-pool-gossip --builder.deadline=2 --builder.interval=100ms \
  > /dev/null
wait_for_rpc "$L2_RPC" "L2 op-reth" 120

log "starting op-node sequencer"
docker run -d --name "$OP_NODE_CONTAINER" --network host \
  -v "${RUN_DIR}:/workspace" "$OP_NODE_IMAGE" \
  op-node --l1="$L1_RPC" --l1.beacon=http://127.0.0.1:5052 --l1.beacon.ignore --l1.trustrpc \
  --l2="http://127.0.0.1:${L2_AUTH_PORT}" --l2.jwt-secret=/workspace/jwt.txt --l2.enginekind=reth \
  --rollup.config=/workspace/rollup.json --sequencer.enabled=true --sequencer.stopped=false \
  --verifier.l1-confs=1 --p2p.listen.ip=0.0.0.0 --p2p.listen.tcp=9222 --p2p.listen.udp=9222 \
  --p2p.advertise.ip=127.0.0.1 --p2p.advertise.tcp=9222 --p2p.advertise.udp=9222 \
  --p2p.sequencer.key="$SEQUENCER_KEY" --rpc.addr=0.0.0.0 --rpc.port="${NODE_RPC_PORT}" \
  --rpc.enable-admin --log.level=info > /dev/null
wait_for_node_rpc "$NODE_RPC" 120
wait_for_number "$L2_RPC" "eth_blockNumber" 1 "L2 block production" 120 2

log "starting the L1 block clock (${L1_BLOCK_SECONDS}s per block)"
(
  while true; do
    jsonrpc "$L1_RPC" anvil_mine '["0x1"]' >/dev/null 2>&1 || true
    sleep "$L1_BLOCK_SECONDS"
  done
) > "${WORK_DIR}/clock.log" 2>&1 &
echo $! > "${WORK_DIR}/clock.pid"

log "starting op-batcher (calldata DA development mode)"
docker run -d --name "$OP_BATCHER_CONTAINER" --network host \
  -v "${RUN_DIR}:/workspace" "$OP_BATCHER_IMAGE" \
  op-batcher --l1-eth-rpc="$L1_RPC" --l2-eth-rpc="$L2_RPC" --rollup-rpc="$NODE_RPC" \
  --private-key="$BATCHER_KEY" --max-channel-duration=1 --poll-interval=1s \
  --sub-safety-margin=2 --num-confirmations=1 --resubmission-timeout=20s \
  --data-availability-type=calldata --throttle.unsafe-da-bytes-lower-threshold=0 \
  --rpc.addr=0.0.0.0 --rpc.port="${BATCHER_RPC_PORT}" --rpc.enable-admin --log.level=info \
  > /dev/null

PORTAL="$(python3 -c "import json;d=json.load(open('${RUN_DIR}/state.json'))['opChainDeployments'][0];print(d['OptimismPortalProxy'])")"
FACTORY="$(python3 -c "import json;d=json.load(open('${RUN_DIR}/state.json'))['opChainDeployments'][0];print(d['DisputeGameFactoryProxy'])")"
GAME_TYPE="$(cast call "$PORTAL" 'respectedGameType()(uint32)' --rpc-url "$L1_RPC" | awk '{print $1}')"

log "starting op-proposer (dispute game type ${GAME_TYPE})"
docker run -d --name "$OP_PROPOSER_CONTAINER" --network host \
  -v "${RUN_DIR}:/workspace" "$OP_PROPOSER_IMAGE" \
  op-proposer --l1-eth-rpc="$L1_RPC" --rollup-rpc="$NODE_RPC" \
  --private-key="$PROPOSER_KEY" --game-factory-address="$FACTORY" --game-type="$GAME_TYPE" \
  --proposal-interval=15s --allow-non-finalized=true --wait-node-sync=true \
  --rpc.port="${PROPOSER_RPC_PORT}" --log.level=info > /dev/null

log "waiting for derivation (safe L2 head)"
for _ in $(seq 1 120); do
  SAFE="$(jsonrpc "$NODE_RPC" optimism_syncStatus '[]' | python3 -c 'import json,sys; d=json.load(sys.stdin).get("result") or {}; print(int(d.get("safe_l2",{}).get("number",0),16))' 2>/dev/null || echo 0)"
  if [ "${SAFE:-0}" -ge 10 ]; then break; fi
  sleep 2
done

python3 - "$RUN_DIR" "$L1_RPC" "$L2_RPC" "$NODE_RPC" "$PORTAL" "$FACTORY" "$GAME_TYPE" \
  "$DEPLOYER_KEY" "$BATCHER_KEY" "$PROPOSER_KEY" "$SEQUENCER_KEY" "$CHALLENGER_KEY" \
  "$DEPLOYER_ADDR" "$ADMIN_ADDR" "$BATCHER_ADDR" "$PROPOSER_ADDR" "$SEQUENCER_ADDR" "$CHALLENGER_ADDR" \
  "$BASE_FEE_ADDR" "$L1_FEE_ADDR" "$SEQ_FEE_ADDR" "$SYS_CONFIG_ADDR" <<'PY'
import json, sys
(run_dir, l1, l2, node, portal, factory, game_type, deployer_key, batcher_key,
 proposer_key, sequencer_key, challenger_key, deployer_addr, admin_addr,
 batcher_addr, proposer_addr, sequencer_addr, challenger_addr, base_fee_addr,
 l1_fee_addr, sequencer_fee_addr, system_config_addr) = sys.argv[1:23]
state = json.load(open(f"{run_dir}/state.json"))
deployment = state["opChainDeployments"][0]
env = {
    "workDir": run_dir,
    "l1Rpc": l1,
    "l2Rpc": l2,
    "nodeRpc": node,
    "portal": portal,
    "disputeGameFactory": factory,
    "gameType": int(game_type),
    "contracts": {
        key: deployment[key]
        for key in (
            "OptimismPortalProxy", "SystemConfigProxy", "L1StandardBridgeProxy",
            "L1CrossDomainMessengerProxy", "DisputeGameFactoryProxy",
            "AnchorStateRegistryProxy", "PermissionedDisputeGameImpl",
            "FaultDisputeGameImpl",
        ) if key in deployment
    },
    "keys": {
        "deployer": deployer_key,
        "batcher": batcher_key,
        "proposer": proposer_key,
        "sequencer": sequencer_key,
        "challenger": challenger_key,
    },
    "addresses": {
        "deployer": deployer_addr,
        "admin": admin_addr,
        "batcher": batcher_addr,
        "proposer": proposer_addr,
        "sequencer": sequencer_addr,
        "challenger": challenger_addr,
        "withdrawalRecipient": l1_fee_addr,
        "l2Account": deployer_addr,
        "baseFee": base_fee_addr,
        "l1Fee": l1_fee_addr,
        "sequencerFee": sequencer_fee_addr,
        "systemConfig": system_config_addr,
    },
}
json.dump(env, open(f"{run_dir}/env.json", "w"), indent=2)
print("wrote", f"{run_dir}/env.json")
PY

log "local devnet is up: L1 ${L1_RPC} · L2 ${L2_RPC} · op-node ${NODE_RPC}"
log "portal ${PORTAL} · dispute game factory ${FACTORY} · game type ${GAME_TYPE}"
