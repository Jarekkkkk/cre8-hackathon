#!/usr/bin/env bash
# 一次把 fork 環境拉起來：開機 → 載入 dump → 部署 5 顆 oracle + setOracle。
#
# 為什麼必須「一次做完」：dataseed 的歷史狀態窗口只有約 1 分鐘。過了之後任何**沒被本地碰過**的
# 合約讀寫都會 `missing trie node`；publicnode 則是反過來（讀得到、寫不進去，要走 archive token）。
# 所以流程是「開機後立刻把要用的合約都碰過一次」，之後它們就在本地狀態裡。
#
# 用法：bash backend/scripts/bootstrap-fork.sh
set -uo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/../.."

RPC=http://127.0.0.1:8545
# 與 backend/.env 的 CHAIN_ID 一致。1337 是刻意的：MetaMask 不認識這個 id，
# 才會用我們的 RPC 讀代幣餘額與做模擬（chainId 56 會走它自家後端 → 主網 → 永遠 0）。
CHAIN_ID="${CHAIN_ID:-1337}"
# 上游用 **NodeReal 的公開 demo key**：實測（2026-11）它是唯一同時滿足
#   * archive（舊區塊的 eth_getStorageAt / eth_getBalance / eth_code 都讀得到）
#   * eth_getLogs（單次 ≤500 塊；我們的掃描器正好用 500）
#   * 免註冊
# 的免費端點。其他實測結果：
#   publicnode      讀得到但寫入一律 403（要 archive token）
#   bnbchain dataseed 寫入可用，但歷史只有約 1 分鐘（missing trie node）
#   blastapi public  archive ✓ 但 getLogs 會限流
#   blockpi / bscrpc / zan.top  需要註冊或 API key
# ⚠ 預設用 bnbchain dataseed：**寫入可用**（歷史只有約 1 分鐘，靠上面的預熱把要用的狀態先抓下來）。
# 真正的解法是 `BSC_RPC_URL=<你自己的 archive RPC>`（免費註冊即可，見 docs/dev-setup 的說明）：
#   NodeReal MegaNode 免費層 / Chainstack 免費層 —— 兩者都支援 BSC archive 且給個人 key。
# 實測過的公開端點（2026-11）：
#   publicnode      讀得到（~75 分鐘），寫入一律 403
#   bnbchain dataseed 寫入 ✓，歷史 ~1 分鐘  ← 目前預設
#   blastapi public   archive ✓，getLogs 限流
#   nodereal 公開 key  archive ✓，但 anvil 重放會把共用 key 打到 429
#   blockpi / bscrpc / zan.top  要註冊或 key
# 有 backend/.env.fork 就用它（該檔被 .gitignore 忽略，用來放自己的 RPC key，不入版控）。
[ -f backend/.env.fork ] && set -a && . backend/.env.fork && set +a
UPSTREAM="${BSC_RPC_URL:-https://bsc-dataseed.bnbchain.org}"
DUMP="$(ls -t spike/anvil/state-dump-*.json | head -1)"

echo "  [1/4] 停掉舊 anvil…"
pkill -f "anvil --fork-url" 2>/dev/null || true
sleep 2

echo "  [2/4] 起新 anvil（$UPSTREAM, --hardfork cancun）"
# `--hardfork cancun` 是必要的，實測三次才定下來：
#   * 預設（BSC 的 Bpo1）→ 每塊觸發 blockhash 系統合約呼叫，fork 上取不到歷史 storage →
#     registerStrategy 這類寫入直接 revert。
#   * `shanghai` → **Kernel v3.3 的帳戶合約跑不起來**：`getSenderAddress` 回零地址
#     （算不出 counterfactual 地址）、既有帳戶 `validateUserOp` revert。原因是 Kernel 的 bytecode
#     需要 Cancun 之後的 opcode，shanghai 沒有。
#   * `cancun` + **loadState** → 載入的區塊缺 `excessBlobGas` → 所有 eth_call 失敗
#     （`error code -32602: Excess blob gas not set`）。
#
# 所以正確組合是：**cancun + 不載入舊 dump**。要恢復狀態就重新部署（`DeployAtp.s.sol`），
# 不要靠 loadState。下面 [3/4] 的 loadState 只在「dump 是這個硬分叉下產生」時才安全。
nohup anvil --fork-url "$UPSTREAM" --chain-id "$CHAIN_ID" --port 8545 --hardfork cancun > .shots/logs/anvil-boot.log 2>&1 &
sleep 9

echo "  [3/4] 載入 dump：$(basename "$DUMP")"
python3 - "$DUMP" <<'PY'
import json, pathlib, sys
d = json.loads(pathlib.Path(sys.argv[1]).read_text())
pathlib.Path('.shots/logs/loadstate.json').write_text(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'anvil_loadState', 'params': [d['result']]}))
PY
curl -s --max-time 180 -X POST -H 'content-type: application/json' --data-binary @.shots/logs/loadstate.json "$RPC" | head -c 60
echo " ← loadState"


echo "  [3.5/5] 預熱 canonical 合約（之後它們就在本地狀態裡）"
# 為什麼要這一步：anvil 對「沒碰過的帳戶」一律回源查 BSC；而免費上游的歷史窗口只有約 1 分鐘。
# 一旦回源失敗，連 `anvil_setCode` / `anvil_setStorageAt` 都做不到（anvil 連建立本地帳戶都要先抓）。
# 實測踩到：Multicall3（0xcA11…）不在 dump 裡 → `/portfolios/:id/status` 整條路徑 503。
# 所以在窗口還開著的時候，把後端會用到的 canonical 合約全部讀一次（`cast code` 就會快取）。
CANONICAL=(
  0xcA11bde05977b3631167028862bE2a173976CA11   # Multicall3（positions 一次彙總所有 balanceOf）
  0x0000000071727De22E5E9d8BAf0edAc6f37da032   # EntryPoint v0.7
  0xd703aaE79538628d27099B8c4f621bE4CCd142d5   # Kernel MetaFactory
  0x2577507b78c2008Ff367261CB6285d44ba5eF2E9   # KernelFactory v3.3
  0xd6CEDDe84be40893d153Be9d467CD6aD37875b28   # Kernel impl v3.3
  0x845ADb2C711129d4f3966735eD98a9F09fC4cE57   # ECDSA validator
  0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768   # Permit2
  0x1A0A18AC4BECDDbd6389559687d1A73d8927E416   # Pancake Universal Router
  0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865   # Pancake V3 factory
  0x55d398326f99059fF775485246999027B3197955   # USDT
  # 代幣（oracle 建構子會讀 decimals）
  0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436   # NVDAB
  0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c   # WBNB
  0x5b1910eaad6450e50f816082aa078c41f10c292f   # TSLAB
  0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1   # SPCXB
  0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c   # BTCB
  0xbA2aE424d960c26247Dd6c32edC70B295c744C43   # DOGE
  0x2170Ed0880ac9A755fd29B2688956BD959F933F8   # ETH
  # 池子（TWAP oracle 的 previewSwap 會讀 slot0 / liquidity / observations）
  0x36696169C63e42cd08ce11f5deeBbCeBae652050   # WBNB/USDT fee 500
  0x8FB4243b553aC29BA088aCf00B9B7dA24bD6690C   # NVDAB/USDT fee 2500
  0xA75cd0Ce15325F7C578155C6f47AF05F384098fB   # TSLAB/USDT fee 500
  0x626301d37c135a6f368aDC6a12FE1462B14ef03a   # SPCXB/USDT fee 500
  0x46Cf1cF8c69595804ba91dFdd8d6b960c9B0a7C4   # BTCB/USDT fee 500
  0x8D59B8Ee3666ec265663F8811BbF16f3d7699892   # DOGE/USDT fee 500
  0xBe141893E4c6AD9272e8C04BAB7E6a10604501a5   # ETH/USDT fee 500
)
for addr in "${CANONICAL[@]}"; do
  cast code "$addr" --rpc-url "$RPC" >/dev/null 2>&1
done
# 池子的 storage 也要碰：oracle 的 previewSwap 讀 slot0 / liquidity / observe([…])，
# 只快取 code 不夠（實測：計畫階段會以 missing trie node 失敗）。
for pool in 0x36696169C63e42cd08ce11f5deeBbCeBae652050 0x8FB4243b553aC29BA088aCf00B9B7dA24bD6690C \
            0xA75cd0Ce15325F7C578155C6f47AF05F384098fB 0x626301d37c135a6f368aDC6a12FE1462B14ef03a \
            0x46Cf1cF8c69595804ba91dFdd8d6b960c9B0a7C4 0x8D59B8Ee3666ec265663F8811BbF16f3d7699892 \
            0xBe141893E4c6AD9272e8C04BAB7E6a10604501a5; do
  cast call "$pool" "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" --rpc-url "$RPC" >/dev/null 2>&1
  cast call "$pool" "liquidity()(uint128)" --rpc-url "$RPC" >/dev/null 2>&1
  cast call "$pool" "fee()(uint24)" --rpc-url "$RPC" >/dev/null 2>&1
  cast call "$pool" "token0()(address)" --rpc-url "$RPC" >/dev/null 2>&1
  cast call "$pool" "token1()(address)" --rpc-url "$RPC" >/dev/null 2>&1
  cast call "$pool" "observations(uint256)(uint32,int56,uint160,bool)" 0 --rpc-url "$RPC" >/dev/null 2>&1
done
echo "      預熱 ${#CANONICAL[@]} 個地址"

echo "  [4/5] 部署 oracle 並註冊"
bash backend/scripts/deploy-elon-oracles.sh

echo "  [4.5/5] 補幣給測試錢包（重啟後 dump 會把他們的餘額蓋回去，所以在這裡重新補）"
# 為什麼要固定補：`loadState` 載入的是舊 dump，之後才入金/發幣的餘額都會消失。
# 症狀是 MetaMask 顯示「BNB 不足」，而鏈上其實是 `BEP20: transfer amount exceeds balance`
# —— 錢包把 ERC-20 revert 誤報成 gas 問題，非常容易誤導。
FUND_ADDRESSES=(
  0x90F79bf6EB2c4f870365E785982E1f101E93b906   # anvil #3（使用者匯入 MetaMask 的那把）
  0x8e91fa86b79377b51c774237d0ef262421602c5e   # 使用者的另一個登入位址
  0xa2d0553d393b9c672c3d45516aaa07feb3f8bc21
)
FUND_ARGS=()
for addr in "${FUND_ADDRESSES[@]}"; do FUND_ARGS+=(--address "$addr"); done
RPC_URL="$RPC" bun run backend/scripts/fund-eoa.ts "${FUND_ARGS[@]}" --bnb 10 --usdt 1000 2>&1 | sed 's/^/      /'

echo "  [5/5] 把當前狀態存成新 dump（下一次開機就不用再搶那 1 分鐘窗口）"
python3 - <<'PYEOF'
import json, pathlib, subprocess, time
rpc = 'http://127.0.0.1:8545'
body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'anvil_dumpState', 'params': []})
out = subprocess.run(['curl', '-s', '--max-time', '120', '-X', 'POST', '-H', 'content-type: application/json', '-d', body, rpc], capture_output=True, text=True).stdout
res = json.loads(out)['result']
ts = int(time.time())
path = pathlib.Path(f'spike/anvil/state-dump-{ts}.json')
path.write_text(json.dumps({'_meta': {'method': 'anvil_dumpState', 'source_rpc': rpc, 'captured_at_unix': ts, 'encoding': 'gzip (magic 1f8b)', 'hex_chars': len(res), 'note': 'bootstrap-fork：含預熱的 canonical 合約與 oracle 註冊'}, 'id': 1, 'jsonrpc': '2.0', 'result': res}))
print('      dump →', path.name, len(res), 'chars')
PYEOF
