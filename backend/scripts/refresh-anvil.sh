#!/usr/bin/env bash
#
# refresh-anvil.sh — 刷新 8545 的 anvil fork（重啟 + 重新載入 state）
#
# 為什麼需要這支腳本？
#   anvil 用「自己啟動當下釘住的塊號」向上游要資料（不是 latest tag）。
#   bsc-rpc.publicnode.com 的歷史狀態窗口只有約 75–80 分鐘
#   （約 10000 塊 × 0.45 秒/塊）。超過窗口後，凡是需要回上游補資料的查詢
#   ——也就是本地 dump 裡沒有的「冷位址」——就會收到 HTTP 403：
#     "Archive requests require a personal token."
#   本地已 dump 的 9 個合約不受影響，所以症狀是「合約都在、但查新地址就爆」。
#
#   解法是定期把 anvil 重啟到「當下最新的上游頭塊」，再把 state 灌回去。
#   重啟本身只要十幾秒，但**必須先 dump 再 kill**，否則重啟前部署的合約會全消失。
#
# 這個腳本就是那套流程的自動化：dump -> kill -> 起新 anvil -> loadState -> 驗證。
#
# 用法：
#   bash backend/scripts/refresh-anvil.sh
#   ANVIL_PORT=8546 bash backend/scripts/refresh-anvil.sh
#
# 可設定的環境變數：
#   ANVIL_PORT     預設 8545           anvil 監聽的 port
#   BSC_RPC_URL    預設 publicnode     上游 fork RPC
#   FOUNDRY_BIN    預設 ~/.foundry/bin anvil 執行檔所在目錄
#
# ⚠ 重要：不要給 --fork-block-number。
#   給舊塊號會立刻 403（連開機抓 dev account 都可能失敗）。
#   不給的話頭塊會停在啟動當下的上游 latest，這正是我們要的。
#
# ⚠ 不要改用「無 fork」版：永遠不會 403，但 PancakeSwap Router 等真實 BSC 合約
#   會讀成 0x，產生**靜默的錯誤資料**，比大聲的 403 難查得多。
#
# ⚠ 不要改用 bnbchain：它的歷史窗口只有約 43–58 秒，開機沒多久就廢。
#
set -euo pipefail

# ---------------------------------------------------------------- 設定
ANVIL_PORT="${ANVIL_PORT:-8545}"
BSC_RPC_URL="${BSC_RPC_URL:-https://bsc-rpc.publicnode.com}"
FOUNDRY_BIN="${FOUNDRY_BIN:-$HOME/.foundry/bin}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ANVIL_DIR="$REPO_ROOT/spike/anvil"
BASELINE="$ANVIL_DIR/baseline.json"
LOG_FILE="$ANVIL_DIR/${ANVIL_PORT}.log"
RPC="http://127.0.0.1:${ANVIL_PORT}"

CHAIN_ID=56
ANVIL_BIN="$FOUNDRY_BIN/anvil"

# 冷位址探針：本地 dump 裡沒有它，所以每次查詢都必須回上游。
# 它回 "0x" 代表上游窗口還開著；回 403 代表窗口已經關了，就該跑這支腳本。
COLD_ADDRESS="${COLD_ADDRESS:-0xd5F217852f16ab098BB66457A2A714D2CAfc3eb2}"
# owner() 的 4-byte selector（keccak256("owner()")[:4]）
OWNER_SELECTOR="0x8da5cb5b"
EXPECTED_OWNER="0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"

TMP_BODY="$(mktemp -t anvil-load.XXXXXX)"

# 安全網：只要腳本非 0 結束，而且新 anvil 已經起來但 state 還沒載入成功，
# 就把那個 anvil 關掉。否則會留下一個「活著但 9 個合約全部變成 0x」的 fork，
# 它不會報錯，只會讓後面所有查詢靜默地拿到錯資料 —— 這比當掉難查得多。
NEW_PID=""
STATE_LOADED=0
on_exit() {
  local rc=$?
  rm -f "$TMP_BODY"
  if [ "$rc" -ne 0 ] && [ -n "$NEW_PID" ] && [ "$STATE_LOADED" -ne 1 ]; then
    kill "$NEW_PID" 2>/dev/null || true
    printf '\n[FAIL] 腳本中止（rc=%s），已關閉新 anvil，避免留下空 state 的 fork。\n' "$rc" >&2
  fi
}
trap on_exit EXIT

# ---------------------------------------------------------------- 小工具
log()  { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }
die()  { printf '\n[FAIL] %s\n' "$*" >&2; exit 1; }
rpc()  { curl -s --max-time 30 -X POST -H 'Content-Type: application/json' --data "$1" "$RPC"; }
# 十六進位 -> 十進位（不依賴 cast，BSD/GNU 都可用）
hex2dec() { printf '%d' "$1" 2>/dev/null || echo "$1"; }

# port 上是否有 listener
port_busy() { lsof -nP -iTCP:"$ANVIL_PORT" -sTCP:LISTEN >/dev/null 2>&1; }

# 找出該 port 的 anvil pid（沙箱裡 ps 不可用，靠 pgrep -f）
anvil_pids() { pgrep -f -- "anvil.*--port ${ANVIL_PORT}( |\$)" 2>/dev/null || true; }

# 等 anvil 能回 RPC
wait_rpc() {
  local i
  for i in $(seq 1 40); do
    if rpc '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' 2>/dev/null \
        | grep -q '"result"'; then return 0; fi
    sleep 0.5
  done
  return 1
}

# 只清理由本腳本產生的 dump（10 位 unix timestamp），保留最新 3 份。
# 不碰 state-dump-8545.json / state-dump-pre-cutover.json 這類人工產物。
prune_dumps() {
  local files=() f total i
  while IFS= read -r f; do files+=("$f"); done < <(
    ls -1t "$ANVIL_DIR"/state-dump-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].json 2>/dev/null || true
  )
  total=${#files[@]}
  if [ "$total" -gt 3 ]; then
    for ((i = 3; i < total; i++)); do
      rm -f "${files[$i]}"
      log "  已刪除舊 dump：$(basename "${files[$i]}")"
    done
  fi
}

# ---------------------------------------------------------------- 前置檢查
[ -x "$ANVIL_BIN" ] || die "找不到 anvil：${ANVIL_BIN}（請確認 FOUNDRY_BIN）"
command -v lsof >/dev/null || die "找不到 lsof"
command -v jq   >/dev/null || die "找不到 jq"
command -v curl >/dev/null || die "找不到 curl"
mkdir -p "$ANVIL_DIR"

log "=== refresh-anvil：port=$ANVIL_PORT upstream=$BSC_RPC_URL ==="

# ---------------------------------------------------------------- 1) 先 dump
# 這一步必須在 kill 之前完成，否則重啟前部署的合約會全部消失。
DUMP_FILE=""
if port_busy && [ -n "$(anvil_pids)" ]; then
  log "[1/5] dump 目前狀態（保留新部署的合約）…"
  RAW_DUMP="$(rpc '{"jsonrpc":"2.0","id":1,"method":"anvil_dumpState","params":[]}')" \
    || die "anvil_dumpState 呼叫失敗（rpc=${RPC}）"
  echo "$RAW_DUMP" | jq -e '.result' >/dev/null 2>&1 \
    || die "anvil_dumpState 沒有回傳 result：$(echo "$RAW_DUMP" | head -c 300)"

  TS="$(date +%s)"
  DUMP_FILE="$ANVIL_DIR/state-dump-${TS}.json"
  # 同一秒內重跑時避免覆蓋既有檔
  N=1
  while [ -e "$DUMP_FILE" ]; do DUMP_FILE="$ANVIL_DIR/state-dump-$((TS + N)).json"; N=$((N + 1)); done

  CUR_BLOCK="$(rpc '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | jq -r '.result')"
  echo "$RAW_DUMP" | jq --arg blk "$CUR_BLOCK" --argjson ts "$TS" \
    '{_meta:{method:"anvil_dumpState",source_rpc:("http://127.0.0.1:'"$ANVIL_PORT"'"),captured_at_unix:$ts,encoding:"gzip (magic 1f8b)",hex_chars:(.result|length),block_number_hex:$blk,chain_id:"0x38"},id,jsonrpc,result}' \
    > "$DUMP_FILE"
  log "      dump -> $(basename "$DUMP_FILE")（hex_chars=$(jq -r '.result|length' "$DUMP_FILE")，block=$(hex2dec "$CUR_BLOCK")）"
else
  # 沒有在跑的 anvil：沿用最新一份 dump，讓腳本可以重複執行。
  log "[1/5] port $ANVIL_PORT 沒有 anvil，改用既有的最新 dump"
  DUMP_FILE="$(ls -1t "$ANVIL_DIR"/state-dump-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].json 2>/dev/null | head -1 || true)"
  [ -n "$DUMP_FILE" ] && [ -e "$DUMP_FILE" ] \
    || die "找不到任何可用的 state dump，無法在無 anvil 的情況下啟動（請先跑一次有 anvil 的刷新）"
  log "      使用 $(basename "$DUMP_FILE")"
fi

# 預先組好 loadState 參數（很大，寫檔不印到 stdout）
jq -r .result "$DUMP_FILE" | tr -d '\n' \
  | jq -Rs '{jsonrpc:"2.0",id:1,method:"anvil_loadState",params:[.]}' > "$TMP_BODY" \
  || die "無法組出 anvil_loadState 參數（dump 檔格式不對？）"
[ -s "$TMP_BODY" ] || die "loadState 參數是空的"
log "      loadState body = $(wc -c < "$TMP_BODY" | tr -d ' ') bytes"

# ---------------------------------------------------------------- 2) kill 舊 anvil
log "[2/5] 停止舊 anvil…"
PIDS="$(anvil_pids)"
if [ -n "$PIDS" ]; then
  # shellcheck disable=SC2086
  kill $PIDS 2>/dev/null || true
  for _ in $(seq 1 20); do
    port_busy || break
    sleep 0.5
  done
  if port_busy; then
    PIDS="$(anvil_pids)"
    [ -n "$PIDS" ] && kill -9 $PIDS 2>/dev/null || true
    sleep 1
  fi
fi
port_busy && die "port $ANVIL_PORT 仍被佔用，無法啟動新 anvil"
log "      port 已釋放"

# ---------------------------------------------------------------- 3) 起新 anvil
# 設定 A：帶 --fork-url 但**不給** --fork-block-number。
log "[3/5] 啟動新 anvil（fork 在當下最新塊）…"
: > "$LOG_FILE"
nohup "$ANVIL_BIN" --fork-url "$BSC_RPC_URL" --chain-id "$CHAIN_ID" --port "$ANVIL_PORT" \
  >> "$LOG_FILE" 2>&1 &
NEW_PID=$!

if ! wait_rpc; then
  tail -20 "$LOG_FILE" >&2 || true
  kill "$NEW_PID" 2>/dev/null || true
  die "新 anvil 起不來（看 ${LOG_FILE}）。已終止該程序，避免留下半殘的 fork。"
fi

NEW_BLOCK_HEX="$(rpc '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | jq -r '.result')"
FORK_BLOCK="$(rpc '{"jsonrpc":"2.0","id":1,"method":"anvil_nodeInfo","params":[]}' | jq -r '.result.forkConfig.forkBlockNumber')"
log "      新 anvil pid=${NEW_PID}，啟動頭塊=$(hex2dec "${NEW_BLOCK_HEX:-0x0}")，forkBlockNumber=$FORK_BLOCK"
[ "$FORK_BLOCK" != "null" ] && [ -n "$FORK_BLOCK" ] \
  || die "新 anvil 的 forkConfig 沒有 forkBlockNumber —— 可能沒吃到 --fork-url（看 ${LOG_FILE}）"

# ---------------------------------------------------------------- 4) loadState
log "[4/5] 載入 state…"
LOAD_RESP="$(curl -s --max-time 120 -X POST -H 'Content-Type: application/json' \
  --data-binary @"$TMP_BODY" "$RPC")" || LOAD_RESP=""
if ! echo "$LOAD_RESP" | jq -e '.result == true' >/dev/null 2>&1; then
  # loadState 失敗時 anvil 還活著但 state 是空的 —— 這是「靜默的錯」，必須關掉。
  kill "$NEW_PID" 2>/dev/null || true
  die "anvil_loadState 失敗：$(echo "$LOAD_RESP" | head -c 400)
已終止新 anvil，避免留下「合約全空卻看似正常」的 fork。可再用同一份 dump 重試一次：
  $DUMP_FILE"
fi
log "      loadState result=true"

# ---------------------------------------------------------------- 5) 驗證 3 項
log "[5/5] 驗證…"

# (a) 頭塊有回應
HEAD_HEX="$(rpc '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | jq -r '.result // empty')"
[ -n "$HEAD_HEX" ] || die "驗證失敗：eth_blockNumber 沒有回應"
HEAD_DEC="$(hex2dec "$HEAD_HEX")"
log "  [1/3] eth_blockNumber = $HEAD_DEC  OK"

# (b) Registry owner() 正確 —— 這一項同時證明「state 有真的載進來」
REGISTRY="${REGISTRY_ADDRESS:-}"
if [ -z "$REGISTRY" ] && [ -f "$BASELINE" ]; then
  REGISTRY="$(jq -r '.contracts.AtpRegistry.address // empty' "$BASELINE" 2>/dev/null || true)"
fi
[ -n "$REGISTRY" ] || die "驗證失敗：找不到 AtpRegistry 地址（baseline.json 缺少 .contracts.AtpRegistry.address）"

OWNER_RAW="$(rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"$REGISTRY\",\"data\":\"$OWNER_SELECTOR\"},\"latest\"]}" | jq -r '.result // empty')"
[ -n "$OWNER_RAW" ] || die "驗證失敗：AtpRegistry.owner() 沒有回應（state 可能沒載入）"
# 取回傳值最後 40 個 hex 字元當地址比對
OWNER_ADDR="0x${OWNER_RAW: -40}"
# macOS 內建 bash 是 3.2，不支援 ${var,,}，用 tr 轉小寫
OWNER_LC="$(printf '%s' "$OWNER_ADDR" | tr '[:upper:]' '[:lower:]')"
EXPECTED_LC="$(printf '%s' "$EXPECTED_OWNER" | tr '[:upper:]' '[:lower:]')"
if [ "$OWNER_LC" != "$EXPECTED_LC" ]; then
  die "驗證失敗：AtpRegistry.owner() = ${OWNER_ADDR}，預期 ${EXPECTED_OWNER}（state 沒有正確載入）
可重試：以同一份 dump 再跑一次 loadState（${DUMP_FILE}）"
fi
# 到這裡才算「state 真的載進去了」。在此之前任何失敗，安全網都會關掉新 anvil。
STATE_LOADED=1
log "  [2/3] AtpRegistry.owner() = $OWNER_ADDR  OK"

# (c) 冷位址查詢不再 403 —— 這正是刷新要解決的問題
COLD_RESP="$(rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getCode\",\"params\":[\"$COLD_ADDRESS\",\"latest\"]}")" || COLD_RESP=""
if echo "$COLD_RESP" | jq -e '.error' >/dev/null 2>&1; then
  die "驗證失敗：冷位址 $COLD_ADDRESS 查詢出錯（上游窗口可能沒開）：
$(echo "$COLD_RESP" | jq -r '.error.message' | head -c 300)"
fi
COLD_CODE="$(echo "$COLD_RESP" | jq -r '.result // empty')"
[ "$COLD_CODE" = "0x" ] || die "驗證失敗：冷位址 $COLD_ADDRESS 回 '$COLD_CODE'，預期 '0x'"
log "  [3/3] 冷位址 $COLD_ADDRESS -> \"0x\"（不再 403）  OK"

# ---------------------------------------------------------------- 9 合約摘要（僅供參考）
log ""
log "--- 9 合約驗證摘要（對照 baseline.json）---"
MATCH=0; TOTAL=0
if [ -f "$BASELINE" ]; then
  for name in $(jq -r '.contracts | keys[]' "$BASELINE"); do
    addr="$(jq -r ".contracts.$name.address" "$BASELINE")"
    want="$(jq -r ".contracts.$name.sha256" "$BASELINE")"
    code="$(rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getCode\",\"params\":[\"$addr\",\"latest\"]}" | jq -r '.result // ""')"
    TOTAL=$((TOTAL + 1))
    if [ -z "$code" ] || [ "$code" = "0x" ]; then
      printf '  %-20s %s  MISSING\n' "$name" "$addr"
    else
      got="$(printf '%s' "$code" | shasum -a 256 | cut -d' ' -f1)"
      if [ "$got" = "$want" ]; then
        MATCH=$((MATCH + 1)); printf '  %-20s %s  MATCH\n' "$name" "$addr"
      else
        # 合約改動（例如重新部署）不算刷新失敗，但必須讓人看見。
        printf '  %-20s %s  MISMATCH (baseline 已過期？)\n' "$name" "$addr"
      fi
    fi
  done
  log "  合計：$MATCH/$TOTAL 與 baseline 一致"
  [ "$MATCH" -eq "$TOTAL" ] || log "  ⚠ 有合約與 baseline 不同；若你有重新部署，請一併更新 baseline.json"
else
  log "  （找不到 ${BASELINE}，跳過）"
fi

# ---------------------------------------------------------------- 收尾
prune_dumps

# 下次建議刷新時間 = 現在 + 55 分鐘（上游窗口約 75 分鐘，留 20 分鐘餘裕）
if date -v+55M '+%Y-%m-%d %H:%M:%S' >/dev/null 2>&1; then
  NEXT_REFRESH="$(date -v+55M '+%Y-%m-%d %H:%M:%S')"          # macOS / BSD
elif date -d '+55 minutes' '+%Y-%m-%d %H:%M:%S' >/dev/null 2>&1; then
  NEXT_REFRESH="$(date -d '+55 minutes' '+%Y-%m-%d %H:%M:%S')"  # GNU
else
  NEXT_REFRESH="(約 55 分鐘後)"
fi

log ""
log "=== 刷新完成 ==="
log "  新頭塊        : $HEAD_DEC ($HEAD_HEX)"
log "  fork 來源     : ${BSC_RPC_URL}（forkBlockNumber=${FORK_BLOCK}）"
log "  載入的 dump   : $(basename "$DUMP_FILE")"
log "  合約驗證      : $MATCH/$TOTAL 與 baseline 一致"
log "  冷位址查詢    : OK（不再 403）"
log "  下次建議刷新  : $NEXT_REFRESH"
log ""
log "  ⚠ 上游歷史窗口約 75 分鐘。到 $NEXT_REFRESH 左右請重跑："
log "      bash backend/scripts/refresh-anvil.sh"
exit 0
