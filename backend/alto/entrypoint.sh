#!/bin/sh
# 把 Railway 的環境變數轉成 alto 的 CLI 參數。
#
# 為什麼不掛 config 檔：Railway 的 image 部署沒有地方放檔案，而 alto v1.2.5 的
# `--config` 需要一個實際路徑。改用 CLI flags（v1.2.5 全部支援），機密留在 Railway Variables。
#
# 為什麼 pin v1.2.5：v1.2.8 的 SafeValidator 對 EntryPoint v0.7 是壞的
# （用零 error 條目的 ABI 做 decodeErrorResult → 任何 UserOp 都失敗）。
# 詳見 spike/alto/V125-VERDICT.md。
set -eu

: "${RPC_URL:?RPC_URL is required}"
: "${EXECUTOR_PRIVATE_KEY:?EXECUTOR_PRIVATE_KEY is required}"

# 安全預設：safe-mode 必須開（關掉等於不強制 ERC-4337 驗證規則，護欄失效）。
SAFE_MODE="${SAFE_MODE:-true}"
# BSC 上 1 BNB 的 refill 門檻太高；預設 0.05，讓 utility wallet 只在真的見底時補。
MIN_EXECUTOR_BALANCE="${MIN_EXECUTOR_BALANCE:-50000000000000000}"

set -- \
  --rpc-url "$RPC_URL" \
  --entrypoints "${ENTRYPOINTS:-0x0000000071727De22E5E9d8BAf0edAc6f37da032}" \
  --executor-private-keys "$EXECUTOR_PRIVATE_KEY" \
  --utility-private-key "${UTILITY_PRIVATE_KEY:-$EXECUTOR_PRIVATE_KEY}" \
  --port "${PORT:-3001}" \
  --deploy-simulations-contract \
  --min-entity-stake 1 \
  --min-entity-unstake-delay 1 \
  --min-executor-balance "$MIN_EXECUTOR_BALANCE"

if [ "$SAFE_MODE" = "true" ]; then
  set -- "$@" --safe-mode
else
  set -- "$@" --no-safe-mode
fi

echo "[alto] starting: rpc=${RPC_URL} port=${PORT:-3001} safeMode=${SAFE_MODE} entrypoints=${ENTRYPOINTS:-default}"
# 不要把整串參數印出來 —— 裡面有私鑰。
echo "[alto] executor=$(printf '%s' "$EXECUTOR_PRIVATE_KEY" | head -c 6)…"

exec node src/lib/cli/alto.js "$@"
