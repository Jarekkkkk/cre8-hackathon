#!/usr/bin/env bash
# Deploy the three ATP contracts against an Anvil fork of BSC mainnet (chain 56) and record the
# addresses in deployments/fork.json. Rerunnable: every run starts a fresh fork.
set -euo pipefail

FORGE=/Users/jareklin/.foundry/bin/forge
ANVIL=/Users/jareklin/.foundry/bin/anvil
CAST=/Users/jareklin/.foundry/bin/cast
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

RPC="${BSC_MAINNET_RPC:-https://bsc-rpc.publicnode.com}"
PORT="${ANVIL_PORT:-8545}"
PRIVKEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

WBNB="0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"
USDT="0x55d398326f99059fF775485246999027B3197955"
FACTORY="0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865"
ROUTER="0x1A0A18AC4BECDDbd6389559687d1A73d8927E416"
PERMIT2="0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768"

cd "$ROOT"

echo "== starting anvil fork of $RPC (chain 56) =="
"$ANVIL" --fork-url "$RPC" --chain-id 56 --port "$PORT" > /tmp/cre8-anvil.log 2>&1 &
ANVIL_PID=$!
trap 'kill "$ANVIL_PID" 2>/dev/null || true' EXIT

# Wait for the RPC to serve chain 56.
for _ in $(seq 1 60); do
  if curl -s -X POST -H 'content-type: application/json' \
       --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
       "http://127.0.0.1:$PORT" 2>/dev/null | grep -q '"0x38"'; then
    echo "== anvil ready =="
    break
  fi
  sleep 1
done

echo "== deploying =="
"$FORGE" script script/DeployAtp.s.sol \
  --rpc-url "http://127.0.0.1:$PORT" \
  --broadcast \
  --private-key "$PRIVKEY" \
  --skip-simulation

# Read the CREATE addresses back from the broadcast receipt (chain 56).
BROADCAST="broadcast/DeployAtp.s.sol/56/run-latest.json"
REGISTRY="$(jq -r '.transactions[] | select(.contractName=="AtpRegistry") | .contractAddress' "$BROADCAST")"
ORACLE="$(jq -r '.transactions[] | select(.contractName=="PancakeV3TwapOracle") | .contractAddress' "$BROADCAST")"
EXECUTOR="$(jq -r '.transactions[] | select(.contractName=="AtpExecutor") | .contractAddress' "$BROADCAST")"

# Resolve the pool the oracle actually pinned (500 preferred, 2500 fallback).
POOL="$("$CAST" call "$FACTORY" 'getPool(address,address,uint24)(address)' "$WBNB" "$USDT" 500 --rpc-url "http://127.0.0.1:$PORT")"
POOL_FEE=500
if [ "$POOL" = "0x0000000000000000000000000000000000000000" ]; then
  POOL="$("$CAST" call "$FACTORY" 'getPool(address,address,uint24)(address)' "$WBNB" "$USDT" 2500 --rpc-url "http://127.0.0.1:$PORT")"
  POOL_FEE=2500
fi

mkdir -p deployments
jq -n \
  --arg registry "$REGISTRY" \
  --arg executor "$EXECUTOR" \
  --arg oracle "$ORACLE" \
  --arg pool "$POOL" \
  --arg router "$ROUTER" \
  --arg permit2 "$PERMIT2" \
  --argjson chainId 56 \
  --argjson poolFee "$POOL_FEE" \
  '{ chainId: $chainId, registry: $registry, executor: $executor, oracle: $oracle, pool: $pool, poolFee: $poolFee, router: $router, permit2: $permit2 }' \
  > deployments/fork.json

echo "== wrote deployments/fork.json =="
cat deployments/fork.json
