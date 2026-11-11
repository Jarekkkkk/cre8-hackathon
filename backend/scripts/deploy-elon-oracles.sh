#!/usr/bin/env bash
# 為 Elon Universe 的五個成分資產部署 PancakeV3TwapOracle，並在 router 上註冊。
#
# ⚠ 必須在 `refresh-anvil.sh` 之後**立刻**跑：寫入需要年輕的 fork（上游 archive 窗口 ~75 分鐘），
#    過期後連 cast send 都會 Fork Error 403。
#
# 用法：bash backend/scripts/deploy-elon-oracles.sh
set -uo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

cd "$(dirname "$0")/../.."   # 之後的路徑（spike/、cre8-contracts/）都以 repo 根為基準
RPC="${RPC:-http://127.0.0.1:8545}"
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ROUTER="${ROUTER:-0x132cDfCe34d385f783dAB7F011B2E66E78A2f87f}"
FACTORY=0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865
USDT=0x55d398326f99059fF775485246999027B3197955
TWAP_WINDOW=1800   # 30 分鐘（與既有 WBNB/NVDAB oracle 一致）
MAX_SLIPPAGE="${MAX_SLIPPAGE:-100}"   # 由 env 覆寫；實測薄池需要更大緩衝
MAX_AGE=3600

# 資產 → 顯示符號（真實 BSC 代幣；TSLAB/SPCXB 是 Tesla/SpaceX 的 bStock）
ASSETS=(
  "0x5b1910eaad6450e50f816082aa078c41f10c292f:TSLAB"
  "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1:SPCXB"
  "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c:BTCB"
  "0xbA2aE424d960c26247Dd6c32edC70B295c744C43:DOGE"
  "0x2170Ed0880ac9A755fd29B2688956BD959F933F8:ETH"
)

CODE="$(cd "$(dirname "$0")/../../cre8-contracts" && forge inspect src/atp/PancakeV3TwapOracle.sol:PancakeV3TwapOracle bytecode 2>/dev/null)"
[ -n "$CODE" ] || { echo "找不到 oracle bytecode（先 forge build）"; exit 1; }

for entry in "${ASSETS[@]}"; do
  asset="${entry%%:*}"
  sym="${entry##*:}"
  # 池子從 factory 查，不寫死：寫死的話一改 fee 層就會部署到「不是這個 pair」的池子上。
  # ⚠ 選**流動性最大**的池子，不是第一個存在的。
  # 實測踩到：DOGE 的 fee=500 池存在但 `liquidity()` 是 0、`slot0` 停在 MAX_TICK，
  # 用它的 oracle 會回天文數字的報價（1.6e57），而合約的下限檢查會讓整批 rebalance revert。
  # 「池子存在」與「池子有市場」是兩件事。
  #
  # 流動性可達 1e18+（超過 bash 的 64 位整數），所以比較交給 python，不用 `[ -gt ]`（實測會溢位）。
  candidates=""
  for fee in 100 500 2500 10000; do
    candidate="$(cast call "$FACTORY" "getPool(address,address,uint24)(address)" "$asset" "$USDT" "$fee" --rpc-url "$RPC" 2>/dev/null)"
    if [ -z "$candidate" ] || [ "$candidate" = "0x0000000000000000000000000000000000000000" ]; then continue; fi
    liq="$(cast call "$candidate" "liquidity()(uint128)" --rpc-url "$RPC" 2>/dev/null | perl -pe 's/ \[.*//' | tr -dc '0-9')"
    [ -z "$liq" ] && liq=0
    candidates="${candidates}${liq} ${candidate}"$'\n'
  done
  read -r pool best_liq <<<"$(printf '%s' "$candidates" | python3 -c "
import sys
rows = [line.split() for line in sys.stdin if line.strip()]
if not rows: print('- 0'); raise SystemExit
liq, addr = max(rows, key=lambda r: int(r[0]))
print(addr, liq)
")"
  if [ "$pool" = "-" ] || [ "${best_liq:-0}" = "0" ]; then
    echo "  ✗ ${sym}：找不到有流動性的 USDT 池，跳過"; continue
  fi

  args="$(cast abi-encode "constructor(address,address,address,uint32,uint16,uint32)" \
    "$pool" "$asset" "$USDT" "$TWAP_WINDOW" "$MAX_SLIPPAGE" "$MAX_AGE")"
  out="$(cast send --rpc-url "$RPC" --private-key "$KEY" --json --create "${CODE}${args#0x}" 2>&1)"
  oracle="$(echo "$out" | python3 -c "import sys,json;print(json.load(sys.stdin).get('contractAddress') or '')" 2>/dev/null)"
  if [ -z "$oracle" ]; then
    echo "  ✗ ${sym}：部署失敗 → $(echo "$out" | head -c 160)"; continue
  fi

  # router 的 setOracle 對已註冊的資產會 revert OracleAlreadySet：先 clearOracle 再設新的。
  cast send --rpc-url "$RPC" --private-key "$KEY" --json "$ROUTER" "clearOracle(address)" "$asset" >/dev/null 2>&1
  reg="$(cast send --rpc-url "$RPC" --private-key "$KEY" --json "$ROUTER" "setOracle(address,address)" "$asset" "$oracle" 2>&1)"
  status="$(echo "$reg" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('status','?'))" 2>/dev/null)"
  echo "  ✓ $sym  pool=$pool  oracle=$oracle  setOracle status=$status"
done
