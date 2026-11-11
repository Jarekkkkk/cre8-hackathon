#!/usr/bin/env bash
# 為 Elon Universe 的成分資產部署 TWAP oracle，**池子是明確釘住的**（不自動挑）。
#
# 為什麼不用自動挑：`deploy-elon-oracles.sh` 會按 `liquidity()` 選最大的池子，但實測它在
# 鏈狀態剛重建、RPC 讀取失敗時會退化成「全部 0 → 取第一個候選」，於是綁到**流動性 0 的死池**
# （TSLAB fee=500 的 liq 就是 0）。死池的 `slot0` 停在 MAX_TICK，報價會變天文數字，
# 而合約的下限檢查會讓整批 rebalance revert（`V3TooLittleReceived`）。
#
# 所以這裡把「哪個資產用哪個池子」寫死，並在部署前**斷言該池有流動性** ——
# 選錯就立刻報錯，不要靜默地部署一顆註定失敗的 oracle。
#
# 用法：bash backend/scripts/deploy-pinned-oracles.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$PATH"

RPC="${RPC:-http://127.0.0.1:8545}"
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ROUTER="${ROUTER:-$(grep -E '^EXECUTOR_ADDRESS=' backend/.env | cut -d= -f2)}"
USDT=0x55d398326f99059fF775485246999027B3197955
TWAP_WINDOW=1800
MAX_SLIPPAGE="${MAX_SLIPPAGE:-300}"
MAX_AGE=3600

# asset:pool:fee:symbol —— 池子與 fee 都是實測有流動性的那一層
TRIPLES=(
  "0x5b1910eaad6450e50f816082aa078c41f10c292f:0xB0f5E5400E8F0F7C242F2b7740C004f020579c41:2500:TSLAB"
  "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1:0x977DaFFC095b33872E2741c19568925015C35b4d:2500:SPCXB"
  "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c:0x46Cf1cF8c69595804ba91dFdd8d6b960c9B0a7C4:500:BTCB"
  "0x2170Ed0880ac9A755fd29B2688956BD959F933F8:0xBe141893E4c6AD9272e8C04BAB7E6a10604501a5:500:ETH"
)

CODE="$(cd cre8-contracts && forge inspect src/atp/PancakeV3TwapOracle.sol:PancakeV3TwapOracle bytecode 2>/dev/null)"
[ -n "$CODE" ] || { echo "找不到 oracle bytecode（先 forge build）"; exit 1; }

# router 的位址要從鏈上反查：executor.oracle() 才是真正的 router
ROUTER="$(cast call "$(grep -E '^EXECUTOR_ADDRESS=' backend/.env | cut -d= -f2)" "oracle()(address)" --rpc-url "$RPC" 2>/dev/null)"
[ -n "$ROUTER" ] || { echo "讀不到 router（executor.oracle()）"; exit 1; }
echo "  router = $ROUTER"

for triple in "${TRIPLES[@]}"; do
  asset="$(echo "$triple" | cut -d: -f1)"
  pool="$(echo "$triple" | cut -d: -f2)"
  fee="$(echo "$triple" | cut -d: -f3)"
  sym="$(echo "$triple" | cut -d: -f4)"

  liq="$(cast call "$pool" "liquidity()(uint128)" --rpc-url "$RPC" 2>/dev/null | perl -pe 's/ \[.*//' | tr -dc '0-9')"
  if [ -z "$liq" ] || [ "$liq" = "0" ]; then
    echo "  ✗ ${sym}: 池 $pool (fee $fee) 的 liquidity 是 0 或讀不到 —— 拒絕部署（死池會讓報價爆掉）"
    continue
  fi

  args="$(cast abi-encode "constructor(address,address,address,uint32,uint16,uint32)" \
    "$pool" "$asset" "$USDT" "$TWAP_WINDOW" "$MAX_SLIPPAGE" "$MAX_AGE")"
  out="$(cast send --rpc-url "$RPC" --private-key "$KEY" --json --create "${CODE}${args#0x}" 2>&1)"
  oracle="$(echo "$out" | python3 -c "import sys,json;print(json.load(sys.stdin).get('contractAddress') or '')" 2>/dev/null)"
  [ -n "$oracle" ] || { echo "  ✗ ${sym}: 部署失敗 → $(echo "$out" | head -c 140)"; continue; }

  cast send --rpc-url "$RPC" --private-key "$KEY" --json "$ROUTER" "clearOracle(address)" "$asset" >/dev/null 2>&1
  reg="$(cast send --rpc-url "$RPC" --private-key "$KEY" --json "$ROUTER" "setOracle(address,address)" "$asset" "$oracle" 2>&1)"
  status="$(echo "$reg" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)"
  echo "  ✓ ${sym}  pool=$pool fee=$fee  liq>0  oracle=$oracle  setOracle=$status"
done
