import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, http } from 'viem';
import type { Address } from 'viem';
import { bsc } from 'viem/chains';
import { getConfig, getSessionKeyConfig } from '../src/config.js';
import {
  DEFAULT_TWAP_WINDOW_SECONDS,
  PricingError,
  getSqrtPriceAtTick,
  priceE8FromSqrtPriceX96,
  resolvePoolDirection,
  twapPriceInUsdt,
} from '../src/pricing.js';

/**
 * 交叉驗證：連真的 anvil fork（chainId 56 的 BSC fork），把這裡算出來的價格與**已部署的**
 * PancakeV3TwapOracle 對照。這是這支檔案存在的唯一理由——單元測試只能證明「算得穩定」，
 * 證明不了「算得跟鏈上一致」。
 *
 * 三個驗證：
 * 1. WBNB/USDT：我們的 TWAP 價格 vs oracle `previewSwap(WBNB, USDT, 1e18).quoted`。
 *    比的是**同一個數量級**：`quoted` 是 1e18 raw WBNB 換到的 raw USDT（兩顆都 18 decimals），
 *    而我們的 `quotedRaw` 定義就是「1 顆 token 的 raw 輸出」，所以兩者逐位可比。
 *    `minimum` **不拿來比**：它是 max(TWAP 地板, 近 5 分鐘地板) 再打 99% 的滑價折扣，跟 TWAP 報價是兩件事。
 * 2. NVDAB/USDT（fee 2500，沒有第二個 oracle）：算得出價格，且落在 pool `slot0` 現價 ±5% 內。
 * 3. 不存在的 pool / 不是 V3 pool / token 不在 pool 裡：錯誤必須可診斷，不能靜默回 0。
 *
 * fork 掛掉（例如上游 archive 視窗過期、`cast` 回 `HTTP error 403 Archive requests`）時整組**明確 skip**
 * 並印出原因，不讓 suite 變紅：鏈不在不是這支程式的錯，靜默 pass 才是。
 */

const RPC_URL = process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545';
const EXPECTED_CHAIN_ID = 56;

/**
 * oracle 位址**不寫死**：每次重建環境（重新部署 ATP）位址都會變，寫死會讓這組測試在部署一換就紅。
 * 它要驗的是「我們的 TWAP 計算與已部署 oracle 逐位相同」，不是某個特定位址。
 * 反查路徑：EXECUTOR_ADDRESS → executor.oracle() → router.oracleOf(WBNB)。
 */
let ORACLE = '0x0000000000000000000000000000000000000000' as Address;

async function resolveOracle(): Promise<Address | null> {
  try {
    // 自建 client：這個函式在**模組頂層**被呼叫，那時檔案下方的 `client` 還在 TDZ 裡，
    // 直接用它會丟 ReferenceError，然後被下面的 catch 吞掉 → ORACLE 永遠是零地址。
    const probe = createPublicClient({ chain: bsc, transport: http(getConfig().rpcUrl ?? 'http://127.0.0.1:8545') });
    // 走設定模組而不是 process.env：`.env` 由 src/config.ts 載入，測試進程的 process.env 未必有值。
    const executor = (getSessionKeyConfig().executorAddress ?? '') as Address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(executor)) return null;
    const router = (await probe.readContract({
      address: executor,
      abi: [{ type: 'function', name: 'oracle', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }],
      functionName: 'oracle',
    })) as Address;
    const pair = (await probe.readContract({
      address: router,
      abi: [
        {
          type: 'function',
          name: 'oracleOf',
          stateMutability: 'view',
          inputs: [{ name: '', type: 'address' }],
          outputs: [{ type: 'address' }],
        },
      ],
      functionName: 'oracleOf',
      args: ['0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'],
    })) as Address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(pair) || pair === '0x0000000000000000000000000000000000000000') return null;
    return pair;
  } catch {
    return null;
  }
}

const resolvedOracle = await resolveOracle();
if (resolvedOracle !== null) ORACLE = resolvedOracle;
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' as Address;
const USDT = '0x55d398326f99059fF775485246999027B3197955' as Address;
/** PancakeSwap V3 WBNB/USDT，fee 500。 */
const WBNB_USDT_POOL = '0x36696169C63e42cd08ce11f5deeBbCeBae652050' as Address;
const NVDAB = '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436' as Address;
/** PancakeSwap V3 NVDAB/USDT，fee 2500（bStock 的池只存在 2500 / 10000）。 */
const NVDAB_USDT_POOL = '0x8FB4243b553aC29BA088aCf00B9B7dA24bD6690C' as Address;
const NO_CODE_ADDRESS = '0x000000000000000000000000000000000000dEaD' as Address;

const ERC20_DECIMALS_ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

const V3_POOL_SLOT0_ABI = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint32' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
] as const;

const V3_POOL_OBSERVE_ABI = [
  {
    type: 'function',
    name: 'observe',
    stateMutability: 'view',
    inputs: [{ name: 'secondsAgos', type: 'uint32[]' }],
    outputs: [
      { name: 'tickCumulatives', type: 'int56[]' },
      { name: 'secondsPerLiquidityCumulativeX128s', type: 'uint160[]' },
    ],
  },
] as const;

const ORACLE_ABI = [
  {
    type: 'function',
    name: 'previewSwap',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
    ],
    outputs: [
      { name: 'quoted', type: 'uint256' },
      { name: 'minimum', type: 'uint256' },
    ],
  },
  { type: 'function', name: 'pool', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'twapWindow', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint32' }] },
  {
    type: 'function',
    name: 'maxSlippageBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint16' }],
  },
] as const;

const client = createPublicClient({
  chain: bsc,
  transport: http(RPC_URL, { timeout: 20_000, retryCount: 1 }),
});

/** 探測某個塊讀不讀得到：403 archive 是預期中的失敗，不要讓 viem 重試三次拖慢整組。 */
const publicClientForProbe = createPublicClient({
  chain: bsc,
  transport: http(RPC_URL, { timeout: 20_000, retryCount: 0 }),
});

/** `a` 與 `b` 的相對差，單位 ppm（1 ppm = 0.0001%）。整數運算，不引入浮點誤差。 */
function relativePpm(a: bigint, b: bigint): bigint {
  const diff = a > b ? a - b : b - a;
  return b === 0n ? 0n : (diff * 1_000_000n) / b;
}

/** 1e8 定點 ↔ 人類單位，只為了把數字印成人看得懂的樣子。 */
function formatE8(value: bigint): string {
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, '0');
  return `${whole}.${fraction}`;
}

/** fork 可用性：只要 chainId 或塊高讀不到，就把整組 crosscheck 標成 skip 並帶著原因。 */
async function probeFork(): Promise<string | null> {
  try {
    const chainId = await client.getChainId();
    if (chainId !== EXPECTED_CHAIN_ID) {
      return `anvil fork ${RPC_URL} 的 chainId 是 ${chainId}，不是 ${EXPECTED_CHAIN_ID}：這不是 BSC fork`;
    }
    const blockNumber = await client.getBlockNumber();
    return blockNumber > 0n ? null : `anvil fork ${RPC_URL} 的塊高是 0：fork 沒有真的接上上游`;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return `anvil fork ${RPC_URL} 不可用（${message}）：crosscheck 需要真的 fork，403 Archive requests 就是上游視窗過期`;
  }
}

/**
 * 找出一個「窗長有餘數」的塊：只有在那種塊上，mean tick 的挪格才會真的改變報價。
 *
 * 為什麼需要這一步：anvil 自己挖出來的塊時間戳一跳就是 1 秒，而分叉之後池子狀態是凍結的，
 * 所以 `observe([1800, 0])` 的 delta 剛好是 `tick × 1800`——餘數 0，挪格那段是 no-op。
 * 在這種塊上，**任何**門檻都分辨不出「少挪一格」（改 EXACT 之前的分叉實測是 99 ppm，改之後是 0 ppm，
 * 兩者都是 0 誤差）。分叉點之後每多挖一個塊，餘數就多 1，挪格才會被行使。
 *
 * 樣本塊必須同時滿足兩件事，而且**兩件都在這個函式裡驗**，不靠呼叫端假設：
 * 1. oracle 在該塊真的有 code。fresh fork 上 fork 塊之前的塊沒有 state（`eth_getCode` 回 `0x`、
 *    `eth_call` 回 `0x`），在那裡探測等於把「環境沒部署」誤讀成「實作錯了」——這條探針曾經靠人工
 *    `anvil_mine 3` 才走得通，`refresh-anvil.sh` 之後就變成沒人記得的隱形前置條件。
 * 2. 該塊的 `observe([window, 0])` 讀得到，且 delta 對窗長有餘數。
 *
 * 兩者不成立就往下一個塊走；範圍（≤3 塊）用完就回 null + 逐塊原因，由呼叫端印出並**明確 skip**
 * 次要斷言，而不是靜默消失、也不是讓它紅在跟被測邏輯無關的地方。
 */
const NUDGE_PROBE_BLOCKS = 3n;

/** 逐塊的探測結果：skip 訊息要說得出「哪一塊為什麼不能用」，不能只說「找不到」。 */
type NudgeProbeOutcome = 'usable' | 'no-code' | 'no-remainder' | 'unreadable';

interface NudgeProbe {
  /** 可用的樣本塊。null = 範圍內沒有可用樣本，呼叫端必須印出 probes 並 skip 次要斷言。 */
  block: bigint | null;
  /** 這次探測的起點（預設 head，可被 CROSSCHECK_NUDGE_START_BLOCK 注入）。 */
  start: bigint;
  probes: { block: bigint; outcome: NudgeProbeOutcome }[];
}

const NUDGE_OUTCOME_LABEL: Record<NudgeProbeOutcome, string> = {
  usable: '可用',
  'no-code': 'oracle 沒有 code',
  'no-remainder': `有 code 但 delta % ${DEFAULT_TWAP_WINDOW_SECONDS} == 0（挪格是 no-op）`,
  unreadable: 'observe 讀不到（403 archive / 塊不存在）',
};

/**
 * 探測起點：預設 head。`CROSSCHECK_NUDGE_START_BLOCK` 只有一個用途——**不動鏈**地重現 fresh fork
 * （fresh fork 的起點就等於 fork 塊）。把它設成 fork 塊再跑一次，就能實跑驗證 skip 路徑，
 * 不必 mine、不必重啟 anvil、也不會弄髒別人的鏈上狀態。
 */
function nudgeProbeStart(head: bigint): bigint {
  const raw = process.env.CROSSCHECK_NUDGE_START_BLOCK?.trim();
  if (raw === undefined || raw === '') return head;
  const start = BigInt(raw); // 填錯就讓它拋：注入錯了不該靜默退回 head
  return start < head ? start : head;
}

/** oracle 在該塊有沒有 code。讀不到（403 / 塊不存在）與「沒有 code」在這裡是同一個結論：這塊不能用。 */
async function oracleHasCodeAt(block: bigint): Promise<boolean> {
  try {
    const code = await publicClientForProbe.getCode({ address: ORACLE, blockNumber: block });
    return code !== undefined && code.length > 2;
  } catch {
    return false;
  }
}

async function findNudgeBlock(start: bigint, windowSeconds: number): Promise<NudgeProbe> {
  const probes: NudgeProbe['probes'] = [];
  for (let back = 0n; back <= NUDGE_PROBE_BLOCKS; back += 1n) {
    const block = start - back;
    if (block <= 0n) break;
    if (!(await oracleHasCodeAt(block))) {
      probes.push({ block, outcome: 'no-code' });
      continue;
    }
    try {
      const observed = await publicClientForProbe.readContract({
        address: WBNB_USDT_POOL,
        abi: V3_POOL_OBSERVE_ABI,
        functionName: 'observe',
        args: [[windowSeconds, 0]],
        blockNumber: block,
      });
      const [ago, now] = observed[0];
      if (ago === undefined || now === undefined) {
        probes.push({ block, outcome: 'unreadable' });
        continue;
      }
      const delta = BigInt(now) - BigInt(ago);
      if (delta % BigInt(windowSeconds) === 0n) {
        probes.push({ block, outcome: 'no-remainder' });
        continue;
      }
      probes.push({ block, outcome: 'usable' });
      return { block, start, probes };
    } catch {
      // 403 archive / OLD：這個塊讀不到，換下一個。不是價格算錯。
      probes.push({ block, outcome: 'unreadable' });
    }
  }
  return { block: null, start, probes };
}

/** fork 塊（anvil_nodeInfo）。只為了在 skip 訊息裡說清楚「head 是不是就等於 fork 塊」= fresh fork。 */
async function probeForkBlock(): Promise<bigint | null> {
  try {
    const request = publicClientForProbe.request as unknown as (args: { method: string }) => Promise<unknown>;
    const info = (await request({ method: 'anvil_nodeInfo' })) as {
      forkConfig?: { forkBlockNumber?: number | string | null };
    } | null;
    const raw = info?.forkConfig?.forkBlockNumber;
    return raw === undefined || raw === null ? null : BigInt(raw);
  } catch {
    return null;
  }
}

const skipReason = await probeFork();
const crosscheck = skipReason === null ? {} : { skip: skipReason };
if (skipReason !== null) {
  // runner 的 summary 只印 "(skip) <名稱>"，所以原因在這裡先印一次，讓 log 自己說得清楚。
  console.warn(`[crosscheck] 整組 skip：${skipReason}`);
}

test('crosscheck 1: WBNB/USDT 的 TWAP 價格與已部署 oracle 的 previewSwap quoted 逐位相同（EXACT）', crosscheck, async () => {
  const amountIn = 10n ** 18n; // 1 顆 WBNB
  // 兩邊都釘在同一個塊上。沒有塊號，「差 0 ppm」只是「讀取期間沒有人上鏈」的巧合：oracle 的 quoted 與
  // 我們的 quotedRaw 是兩次獨立的 eth_call，同一個塊同一份 observe 才算同一份觀測。
  const block = await client.getBlockNumber();
  const [oracleQuote, oraclePool, oracleToken0, oracleToken1, oracleWindow, oracleSlippageBps] = await Promise.all([
    client.readContract({
      address: ORACLE,
      abi: ORACLE_ABI,
      functionName: 'previewSwap',
      args: [WBNB, USDT, amountIn],
      blockNumber: block,
    }),
    client.readContract({ address: ORACLE, abi: ORACLE_ABI, functionName: 'pool', blockNumber: block }),
    client.readContract({ address: ORACLE, abi: ORACLE_ABI, functionName: 'token0', blockNumber: block }),
    client.readContract({ address: ORACLE, abi: ORACLE_ABI, functionName: 'token1', blockNumber: block }),
    client.readContract({ address: ORACLE, abi: ORACLE_ABI, functionName: 'twapWindow', blockNumber: block }),
    client.readContract({ address: ORACLE, abi: ORACLE_ABI, functionName: 'maxSlippageBps', blockNumber: block }),
  ]);
  const [quoted, minimum] = oracleQuote;

  // 先確認我們比的是「同一顆 oracle、同一個池、同一組 token、同一個窗長」：這些一旦漂移，
  // 後面的價格比對就變成拿兩個不同的東西互相比，寧可現在就紅。
  assert.equal(oraclePool.toLowerCase(), WBNB_USDT_POOL.toLowerCase());
  assert.equal(oracleToken0.toLowerCase(), USDT.toLowerCase());
  assert.equal(oracleToken1.toLowerCase(), WBNB.toLowerCase());
  assert.equal(oracleWindow, DEFAULT_TWAP_WINDOW_SECONDS);

  const ours = await twapPriceInUsdt(client, {
    token: WBNB,
    usdtPool: WBNB_USDT_POOL,
    expectedQuoteToken: USDT,
    blockNumber: block,
  });
  assert.equal(ours.decimals, 18);

  const ppm = relativePpm(ours.quotedRaw, quoted);
  console.log(
    `[crosscheck 1] block            = ${block}\n` +
      `[crosscheck 1] 我們的 quotedRaw = ${ours.quotedRaw}\n` +
      `[crosscheck 1] oracle quoted    = ${quoted}\n` +
      `[crosscheck 1] 相對差 = ${ppm} ppm，門檻 EXACT（0 ppm）\n` +
      `[crosscheck 1] 我們的 priceE8 = ${ours.priceE8} = ${formatE8(ours.priceE8)} USDT / WBNB\n` +
      `[crosscheck 1] oracle minimum = ${minimum}（= max(TWAP 地板, 近 5 分鐘地板) × ` +
      `${10_000n - BigInt(oracleSlippageBps)}BPS，不是 TWAP 報價，不拿來比）`,
  );

  // 門檻是 EXACT（0 ppm，一個 wei 都不差）。兩邊讀的是同一個塊的同一份 observe，而且 quoted 兩邊都是
  // 同一條 ceil 算式，所以正確的實作必然逐位相同——不需要任何容差。
  //
  // 為什麼不給 ppm 容差：實測把 mean tick 的「挪格」整段移除（模擬 1 tick 誤差）之後，
  // quotedRaw 會從 696712390769630497444 變成 696642726496980799364，相對差 99 ppm。
  // 100 ppm 的門檻守不住這個錯（照樣 pass），EXACT 守得住。容差不是安全邊界，只是把紅燈關掉。
  assert.equal(
    ours.quotedRaw,
    quoted,
    `我們的 quotedRaw ${ours.quotedRaw} 與 oracle quoted ${quoted} 不相等（差 ${ppm} ppm）：` +
      '同一個塊、同一份 observe、同一條 ceil 算式，兩邊必須逐位相同',
  );

  // 第二層（次要斷言）：換到一個「窗長有餘數」的塊再比一次。這是唯一能證明 EXACT 抓得到 1 tick 誤差的地方——
  // head 那個塊的餘數可能是 0，挪格是 no-op，少挪一格也一樣 EXACT（實測：0 ppm），分辨不出來。
  //
  // ⚠ 這一層能不能行使，取決於**環境**（fork 塊之後挖了幾個塊、oracle 在那個塊有沒有 code），
  // 不取決於受測實作。所以環境不允許時它 skip 並印出原因；但上面的主斷言（head 上的 EXACT 比對）
  // 不受這裡影響，任何情況都必須執行——那是這支測試存在的理由。
  const nudge = await findNudgeBlock(nudgeProbeStart(block), DEFAULT_TWAP_WINDOW_SECONDS);
  const nudgeBlock = nudge.block;
  if (nudgeBlock === null) {
    const forkBlock = await probeForkBlock();
    const noCodeBlocks = nudge.probes.filter((probe) => probe.outcome === 'no-code').map((probe) => probe.block);
    const why =
      noCodeBlocks.length > 0
        ? `範圍內 ${noCodeBlocks.join('、')} 的 oracle 都沒有 code（本機部署的 oracle 只存在於 fork 塊之後，fresh fork 的常態）`
        : '範圍內沒有讀得到、且 delta 對窗長有餘數的塊';
    console.warn(
      `[crosscheck 1] 樣本塊探測：head ${block}、fork 塊 ${forkBlock ?? '未知（anvil_nodeInfo 讀不到）'}、` +
        `起點 ${nudge.start}、往前的塊數上限 ${NUDGE_PROBE_BLOCKS}\n` +
        `[crosscheck 1] 樣本塊探測：${why}；逐塊結果 ` +
        nudge.probes.map((probe) => `${probe.block}=${NUDGE_OUTCOME_LABEL[probe.outcome]}`).join('｜') +
        '\n' +
        `[crosscheck 1] 樣本塊探測：→ skip 挪格樣本斷言（這一輪沒有行使 mean tick 的挪格，` +
        `1 tick 誤差只有單元測試守得住）；主斷言（head ${block} 上的 EXACT 比對）仍然執行`,
    );
  } else {
    const [nudgeQuote] = await client.readContract({
      address: ORACLE,
      abi: ORACLE_ABI,
      functionName: 'previewSwap',
      args: [WBNB, USDT, amountIn],
      blockNumber: nudgeBlock,
    });
    const oursAtNudge = await twapPriceInUsdt(client, {
      token: WBNB,
      usdtPool: WBNB_USDT_POOL,
      expectedQuoteToken: USDT,
      blockNumber: nudgeBlock,
    });
    console.log(
      `[crosscheck 1] 挪格樣本 block = ${nudgeBlock}：我們的 quotedRaw = ${oursAtNudge.quotedRaw}、` +
        `oracle quoted = ${nudgeQuote}（${oursAtNudge.quotedRaw === nudgeQuote ? 'EXACT' : '不一致'}）`,
    );
    assert.equal(
      oursAtNudge.quotedRaw,
      nudgeQuote,
      `挪格樣本 block ${nudgeBlock}：我們的 quotedRaw ${oursAtNudge.quotedRaw} 與 oracle quoted ${nudgeQuote} 不相等。` +
        '這個塊的窗長有餘數，兩邊都必須挪同一格——少挪一格在報價上是 99 ppm，EXACT 會把它擋在這裡',
    );
  }

  // 同一個 block 重跑一次：價格必須逐位相同（E3 的 blockNumber 透傳若漏了任何一支，這裡就會漂）。
  const rerun = await twapPriceInUsdt(client, {
    token: WBNB,
    usdtPool: WBNB_USDT_POOL,
    expectedQuoteToken: USDT,
    blockNumber: block,
  });
  assert.equal(rerun.quotedRaw, ours.quotedRaw, `同一個 block（${block}）重跑兩次 quotedRaw 不同：價格沒有被釘在塊上`);
  assert.equal(rerun.priceE8, ours.priceE8);
  console.log(`[crosscheck 1] 同一個 block 重跑：quotedRaw 相同（${rerun.quotedRaw}）、priceE8 相同（${rerun.priceE8}）`);

  // priceE8 不能自己漂：它必須就是 quotedRaw 去掉小數再放大 1e8 的結果。
  assert.equal(ours.priceE8, (ours.quotedRaw * 100_000_000n) / 10n ** 18n);
  assert.ok(ours.priceE8 > 0n);
});

test('crosscheck 2: NVDAB/USDT（fee 2500）算得出價格，且在 slot0 現價 ±5% 內', crosscheck, async () => {
  const direction = await resolvePoolDirection(client, { pool: NVDAB_USDT_POOL, token: NVDAB, expectedQuoteToken: USDT });
  // NVDAB 的地址比 USDT 大，所以在 pool 裡是 token1 之外的那一邊：實測是 token0。
  assert.equal(direction.token0.toLowerCase(), NVDAB.toLowerCase());
  assert.equal(direction.token1.toLowerCase(), USDT.toLowerCase());
  assert.equal(direction.isToken0, true);

  const [ours, slot0, nvdaDecimals, usdtDecimals] = await Promise.all([
    twapPriceInUsdt(client, { token: NVDAB, usdtPool: NVDAB_USDT_POOL, expectedQuoteToken: USDT }),
    client.readContract({ address: NVDAB_USDT_POOL, abi: V3_POOL_SLOT0_ABI, functionName: 'slot0' }),
    client.readContract({ address: NVDAB, abi: ERC20_DECIMALS_ABI, functionName: 'decimals' }),
    client.readContract({ address: USDT, abi: ERC20_DECIMALS_ABI, functionName: 'decimals' }),
  ]);
  const [spotSqrtPriceX96, spotTick] = slot0;
  assert.equal(nvdaDecimals, 18, 'bStock 的 symbol 慣例 <TICKER>B，全部 18 decimals');

  // 現價用同一條純函式從 slot0 的 sqrtPriceX96 反推，所以比對的是「TWAP vs spot」而不是「兩套算術」。
  const spotPriceE8 = priceE8FromSqrtPriceX96({
    sqrtPriceX96: spotSqrtPriceX96,
    inIsToken0: direction.isToken0,
    inDecimals: nvdaDecimals,
    outDecimals: usdtDecimals,
  });
  const deviationPpm = relativePpm(ours.priceE8, spotPriceE8);

  console.log(
    `[crosscheck 2] NVDAB TWAP priceE8 = ${ours.priceE8} = ${formatE8(ours.priceE8)} USDT / NVDAB\n` +
      `[crosscheck 2] NVDAB spot priceE8 = ${spotPriceE8} = ${formatE8(spotPriceE8)} USDT / NVDAB（slot0 tick ${spotTick}）\n` +
      `[crosscheck 2] 相對差 = ${deviationPpm} ppm = ${Number(deviationPpm) / 10_000}%，門檻 50000 ppm = 5%`,
  );

  assert.ok(ours.priceE8 > 0n);
  // ±5% 的理由：現價與 1800 秒平均的差距就是「這段時間的行情」。同一顆股票代幣在 30 分鐘內
  // 動超過 5% 不是常態，真的動了就是這個斷言該紅的時候（那時也不代表算錯，而是該看盤）。
  assert.ok(
    deviationPpm <= 50_000n,
    `NVDAB 的 TWAP ${ours.priceE8} 與 spot ${spotPriceE8} 差 ${deviationPpm} ppm，超過 5%：先確認 tick math 與方向，不要放寬門檻`,
  );
});

test('crosscheck 3: 不存在的 pool / 不是 V3 pool / token 不在 pool 裡，錯誤都可診斷', crosscheck, async () => {
  // (a) 地址沒有 code：POOL_NO_CODE，而不是 viem 的解碼錯誤。
  await assert.rejects(
    twapPriceInUsdt(client, { token: WBNB, usdtPool: NO_CODE_ADDRESS, expectedQuoteToken: USDT }),
    (error: unknown) =>
      error instanceof PricingError && error.code === 'POOL_NO_CODE' && error.message.includes('沒有 code'),
  );

  // (b) 有 code 但不是 PancakeSwap V3 pool（USDT 本身）：POOL_TOKEN_READ_FAILED。
  await assert.rejects(
    twapPriceInUsdt(client, { token: WBNB, usdtPool: USDT, expectedQuoteToken: USDT }),
    (error: unknown) => error instanceof PricingError && error.code === 'POOL_TOKEN_READ_FAILED',
  );

  // (c) pool 存在但 token 不是它的成員（拿 NVDAB/USDT 的池子問 WBNB）：TOKEN_NOT_IN_POOL。
  await assert.rejects(
    twapPriceInUsdt(client, { token: WBNB, usdtPool: NVDAB_USDT_POOL, expectedQuoteToken: USDT }),
    (error: unknown) =>
      error instanceof PricingError && error.code === 'TOKEN_NOT_IN_POOL' && error.message.includes('token0='),
  );

  console.log('[crosscheck 3] 三個錯誤路徑都帶 PricingError.code，且訊息指名是哪一個 pool / token');
});

test('crosscheck 4: 自寫 tick math 與鏈上 TickMath 一致（slot0 落在 [tick, tick+1) 區間內）', crosscheck, async () => {
  // Uniswap/Pancake V3 的 slot0.tick 是 floor(log_1.0001(sqrtPriceX96))，所以必然
  // getSqrtRatioAtTick(tick) <= sqrtPriceX96 < getSqrtRatioAtTick(tick + 1)。
  // 兩邊都成立就等於「我們的 getSqrtPriceAtTick 與鏈上 pool 用的是同一套 tick math」，
  // 而且這條檢查不依賴 oracle：bStock 的池沒有第二個 oracle 時，這是唯一的算術對照。
  for (const [label, pool] of [
    ['WBNB/USDT', WBNB_USDT_POOL],
    ['NVDAB/USDT', NVDAB_USDT_POOL],
  ] as const) {
    const [sqrtPriceX96, tick] = await client.readContract({
      address: pool,
      abi: V3_POOL_SLOT0_ABI,
      functionName: 'slot0',
    });
    const atTick = getSqrtPriceAtTick(BigInt(tick));
    const nextTick = getSqrtPriceAtTick(BigInt(tick) + 1n);
    console.log(
      `[crosscheck 4] ${label}: slot0 sqrtPriceX96 = ${sqrtPriceX96}, tick = ${tick}, ` +
        `我們的 [tick, tick+1) = [${atTick}, ${nextTick})`,
    );
    assert.ok(atTick <= sqrtPriceX96, `${label}: sqrtPriceX96 ${sqrtPriceX96} 小於 tick ${tick} 的 ${atTick}`);
    assert.ok(sqrtPriceX96 < nextTick, `${label}: sqrtPriceX96 ${sqrtPriceX96} 不小於 tick ${tick + 1} 的 ${nextTick}`);
  }
});
