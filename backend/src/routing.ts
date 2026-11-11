import { encodePacked, getAddress, isAddress } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';

import { V2_FACTORY_ADDRESS } from './addresses.js';

/**
 * 挑一條「實際成交最好」的 V3 路徑。
 *
 * ## 為什麼需要它
 *
 * 我們的地板價（oracle）綁在**一個**池子上 —— 那是刻意的：地板必須能約束實際成交，
 * 兩者指向同一個池子時「`amountOutMin >= floor`」才有意義。
 *
 * 但「用地板那個池子成交」與「用最好的路徑成交」是兩件事。實測（0.5 USDT 買 DOGE）：
 *
 *   DOGE/USDT fee=10000（oracle 釘住的池）   → 7.0711 DOGE
 *   USDT→WBNB(500)→DOGE(2500)               → 7.1492 DOGE
 *   USDT→WBNB(100)→DOGE(2500)               → 7.1514 DOGE   ← 最佳
 *
 * 差 1.1%。而 `Universal Router` 的 `V3_SWAP_EXACT_IN` 本來就吃任意長度的 V3 path，
 * `AtpExecutor._checkCommands` 只驗指令類型、不驗 path 內容 —— 所以**換路徑不需要改合約**。
 *
 * ## 安全性不變
 *
 * 地板仍然來自原本那個池子的 TWAP（乘上 `maxSlippageBps` 折扣）。最佳路徑的成交**只會更多**，
 * 所以 `amountOutMin >= floor` 依然成立，而合約的 pre-check（執行期重算地板）也照舊。
 * 換句話說：規劃時保守、執行時更好，兩者不衝突。
 *
 * ## 為什麼只做「直連」與「經 WBNB 兩跳」
 *
 * 三跳以上的邊際收益遠小於路徑數量爆炸帶來的 RPC 成本，而 BSC 上的主流池子（USDT/WBNB 與
 * 各代幣/WBNB）已經覆蓋絕大多數情況。多跳的組合數 = fee^2，再加一跳就是 fee^3。
 */
export type RouteCandidate =
  | {
      kind: 'v3';
      /** `tokenIn + fee + tokenOut` 的 V3 path（多跳就是多組 fee + 中間幣）。 */
      path: Hex;
      /** quoter 回報的預期輸出。 */
      amountOut: bigint;
      /** 幾個 hop（1 = 直連）。 */
      hops: number;
    }
  | {
      kind: 'v2';
      /** V2 的 `address[]` 路徑（Universal Router 的 V2_SWAP_EXACT_IN 吃這個）。 */
      tokens: Address[];
      amountOut: bigint;
      hops: number;
    };

/** PancakeSwap V3 QuoterV2（主網）。`quoteExactInput` 走真實的池子數學，不帶狀態。 */
export const V3_QUOTER: Address = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997';

/** 候選 fee tier。10000 也要試：DOGE/USDT 唯一有深度的那個池就是 1%。 */
const FEE_TIERS = [100, 500, 2500, 10000] as const;

/**
 * 候選上限。每個 leg 最多打這麼多支 quoter。
 *
 * 為什麼要上限：一個投組有 N 個非 hub 資產，每輪就是 N × 候選數的 `eth_call`。
 * 免費 RPC 的速率限制是實際會撞到的牆（publicnode 實測），所以寧可少試幾條也不要整輪失敗。
 */
const MAX_CANDIDATES = 10;

const QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInput',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'path', type: 'bytes' },
      { name: 'amountIn', type: 'uint256' },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96AfterList', type: 'uint160[]' },
    ],
  },
] as const;

const FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const;

const ZERO = '0x0000000000000000000000000000000000000000';

function v3Path(tokens: readonly Address[], fees: readonly number[]): Hex {
  if (tokens.length !== fees.length + 1) throw new Error('v3Path: tokens 必須比 fees 多一個');
  let path = tokens[0]!.toLowerCase();
  for (let i = 0; i < fees.length; i += 1) {
    path += fees[i]!.toString(16).padStart(6, '0') + tokens[i + 1]!.toLowerCase().slice(2);
  }
  return path as Hex;
}

/**
 * 挑最佳路徑。找不到任何可用路徑（所有候選都報不出價）時回 `null`，
 * 呼叫端應該退回「oracle 釘住的那個池」而不是跳過這一步。
 */
export async function chooseBestPath(
  client: PublicClient,
  params: {
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    blockNumber?: bigint;
    /** 中間幣（BSC = WBNB）。null = 只試直連。 */
    via: Address | null;
    factory: Address;
    /** 已知的直連 fee（oracle 釘住的那個池）。它一定在候選裡，作為保底。 */
    pinnedFee: number | null;
    /** V2 factory。null = 不比 V2 候選（測試或舊鏈）。 */
    v2Factory?: Address | null;
    quoter?: Address;
  },
): Promise<RouteCandidate | null> {
  if (params.amountIn <= 0n) return null;
  const quoter = params.quoter ?? V3_QUOTER;
  const blockNumber = params.blockNumber;

  /** 池子存在性快取：同一個 (a,b,fee) 在一輪裡會被問很多次。 */
  const poolCache = new Map<string, boolean>();
  const hasPool = async (a: Address, b: Address, fee: number): Promise<boolean> => {
    const key = `${a.toLowerCase()}-${b.toLowerCase()}-${fee}`;
    const cached = poolCache.get(key);
    if (cached !== undefined) return cached;
    const pool = await client
      .readContract({ address: params.factory, abi: FACTORY_ABI, functionName: 'getPool', args: [a, b, fee], ...(blockNumber === undefined ? {} : { blockNumber }) })
      .catch(() => null);
    const exists = typeof pool === 'string' && isAddress(pool) && getAddress(pool) !== ZERO;
    poolCache.set(key, exists);
    return exists;
  };

  const candidates: ({ kind: 'v3'; path: Hex; hops: number } | { kind: 'v2'; tokens: Address[]; hops: number })[] = [];

  // ① 直連：只試真的存在的池子（getPool 回零＝沒這個 fee tier，不必打 quoter）。
  for (const fee of FEE_TIERS) {
    if (!(await hasPool(params.tokenIn, params.tokenOut, fee))) continue;
    candidates.push({ kind: 'v3', path: v3Path([params.tokenIn, params.tokenOut], [fee]), hops: 1 });
    if (candidates.length >= MAX_CANDIDATES) break;
  }

  // ② 經中間幣兩跳：兩段池子都存在才試。
  if (params.via !== null && candidates.length < MAX_CANDIDATES) {
    const first = [] as number[];
    for (const fee of FEE_TIERS) {
      if (await hasPool(params.tokenIn, params.via, fee)) first.push(fee);
    }
    const second = [] as number[];
    for (const fee of FEE_TIERS) {
      if (await hasPool(params.via, params.tokenOut, fee)) second.push(fee);
    }
    for (const f1 of first) {
      for (const f2 of second) {
        candidates.push({ kind: 'v3', path: v3Path([params.tokenIn, params.via, params.tokenOut], [f1, f2]), hops: 2 });
        if (candidates.length >= MAX_CANDIDATES) break;
      }
      if (candidates.length >= MAX_CANDIDATES) break;
    }
  }

  // 保底：oracle 釘住的那個 fee，即使 getPool 讀不到也試一次 —— 它是地板價的來源，
  // 沒有它就只能猜。放在最後，只在沒有其他候選時才用到。
  if (candidates.length === 0 && params.pinnedFee !== null) {
    candidates.push({ kind: 'v3', path: v3Path([params.tokenIn, params.tokenOut], [params.pinnedFee]), hops: 1 });
  }

  let best: RouteCandidate | null = null;
  const consider = (candidate: RouteCandidate): void => {
    if (candidate.amountOut <= 0n) return;
    if (best === null || candidate.amountOut > best.amountOut) best = candidate;
  };

  for (const candidate of candidates) {
    if (candidate.kind !== 'v3') continue;
    const quoted = await client
      .readContract({
        address: quoter,
        abi: QUOTER_ABI,
        functionName: 'quoteExactInput',
        args: [candidate.path, params.amountIn],
        ...(blockNumber === undefined ? {} : { blockNumber }),
      })
      // 池子沒流動性、path 不合法 → quoter revert。那是「這條路不可用」，不是錯誤。
      .catch(() => null);
    const amountOut = Array.isArray(quoted) ? (quoted[0] as bigint) : null;
    if (amountOut === null) continue;
    consider({ kind: 'v3', path: candidate.path, amountOut, hops: candidate.hops });
  }

  // ③ V2：同一組候選（直連／經中間幣兩跳），用 pair 儲備算輸出。
  //    V2 池的深度常常勝過 V3 的某個 fee tier，而且 Universal Router 的 V2_SWAP_EXACT_IN
  //    已經在 executor 的 allowlist 裡 —— 不需要動合約。
  if (params.v2Factory !== undefined && params.v2Factory !== null) {
    const v2Candidates: Address[][] = [[params.tokenIn, params.tokenOut]];
    if (params.via !== null) v2Candidates.push([params.tokenIn, params.via, params.tokenOut]);
    for (const tokens of v2Candidates) {
      const amountOut = await quoteV2(client, {
        factory: params.v2Factory,
        tokens,
        amountIn: params.amountIn,
        ...(blockNumber === undefined ? {} : { blockNumber }),
      });
      if (amountOut === null) continue;
      consider({ kind: 'v2', tokens, amountOut, hops: tokens.length - 1 });
    }
  }

  return best;
}

const V2_FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPair',
    stateMutability: 'view',
    inputs: [
      { name: '', type: 'address' },
      { name: '', type: 'address' },
    ],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

const V2_PAIR_ABI = [
  { type: 'function', name: 'getReserves', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint112' }, { type: 'uint112' }, { type: 'uint32' }] },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

/** V2 手續費 0.25%：輸出的乘數是 9975/10000。 */
const V2_FEE_NUM = 9975n;
const V2_FEE_DEN = 10000n;

/**
 * 用 V2 pair 的儲備算「這條路徑能拿到多少」，多跳逐段套用。
 *
 * 任何一段 pair 不存在或儲備為 0 → `null`（這條路不可用，不是錯誤）。
 */
async function quoteV2(
  client: PublicClient,
  params: { factory: Address; tokens: Address[]; amountIn: bigint; blockNumber?: bigint },
): Promise<bigint | null> {
  let amount = params.amountIn;
  for (let i = 0; i < params.tokens.length - 1; i += 1) {
    const a = params.tokens[i]!;
    const b = params.tokens[i + 1]!;
    const pair = await client
      .readContract({
        address: params.factory,
        abi: V2_FACTORY_ABI,
        functionName: 'getPair',
        args: [a, b],
        ...(params.blockNumber === undefined ? {} : { blockNumber: params.blockNumber }),
      })
      .catch(() => null);
    if (typeof pair !== 'string' || !isAddress(pair) || getAddress(pair) === ZERO) return null;

    const [reserves, token0] = await Promise.all([
      client
        .readContract({ address: getAddress(pair), abi: V2_PAIR_ABI, functionName: 'getReserves', ...(params.blockNumber === undefined ? {} : { blockNumber: params.blockNumber }) })
        .catch(() => null),
      client
        .readContract({ address: getAddress(pair), abi: V2_PAIR_ABI, functionName: 'token0', ...(params.blockNumber === undefined ? {} : { blockNumber: params.blockNumber }) })
        .catch(() => null),
    ]);
    if (!Array.isArray(reserves) || typeof token0 !== 'string') return null;

    const [r0, r1] = [reserves[0] as bigint, reserves[1] as bigint];
    const aIsToken0 = getAddress(token0).toLowerCase() === a.toLowerCase();
    const [reserveIn, reserveOut] = aIsToken0 ? [r0, r1] : [r1, r0];
    if (reserveIn <= 0n || reserveOut <= 0n) return null;

    // Uniswap V2 的定額輸出公式（含 0.25% 手續費）。
    const amountInWithFee = amount * V2_FEE_NUM;
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * V2_FEE_DEN + amountInWithFee;
    amount = numerator / denominator;
    if (amount <= 0n) return null;
  }
  return amount;
}

/** `tokenIn + fee + tokenOut` 的單跳 path（既有行為，給沒有路由資訊的地方用）。 */
export function singleHopPath(tokenIn: Address, fee: number, tokenOut: Address): Hex {
  return encodePacked(['address', 'uint24', 'address'], [tokenIn, fee, tokenOut]);
}

/**
 * 用「實際要走的路徑」估算這筆交易的衝擊（bps）。
 *
 * ## 為什麼不能用釘住池子的數字
 *
 * `capLegByImpact` 讀的是 oracle 釘住那個池子的 `slot0`/`liquidity`。對 DOGE 來說那是
 * fee=10000（1%）的池子 —— 於是「衝擊」永遠是 99 bps，不管我們實際走哪條路。
 * 但成交可以走 `USDT→WBNB→DOGE`（0.01% + 0.25% 手續費），真實成本只有 ~30 bps。
 * 用釘住池子的數字去擋，等於**用錯的尺量**，結果是永遠買不到。
 *
 * ## 定義
 *
 * 以「同一條路徑的小額成交」為邊際價，比較大額成交的單位價格掉了多少：
 *
 *     impact = 1 − (out(amountIn) / amountIn) / (out(dust) / dust)
 *
 * 這個數字同時包含手續費與價格衝擊，也就是使用者真正付出的成本。
 * 交叉相乘避免定點除法（bigint 除法會截斷，小額時誤差很大）。
 */
export async function routeImpactBps(
  client: PublicClient,
  params: {
    path: Hex;
    amountIn: bigint;
    blockNumber?: bigint;
    quoter?: Address;
  },
): Promise<number | null> {
  if (params.amountIn <= 0n) return null;
  const quoter = params.quoter ?? V3_QUOTER;
  const dust = params.amountIn / 1000n > 0n ? params.amountIn / 1000n : 1n;

  const quote = async (amount: bigint): Promise<bigint | null> => {
    const out = await client
      .readContract({
        address: quoter,
        abi: QUOTER_ABI,
        functionName: 'quoteExactInput',
        args: [params.path, amount],
        ...(params.blockNumber === undefined ? {} : { blockNumber: params.blockNumber }),
      })
      .catch(() => null);
    return Array.isArray(out) ? (out[0] as bigint) : null;
  };

  const [outFull, outDust] = await Promise.all([quote(params.amountIn), quote(dust)]);
  if (outFull === null || outDust === null || outDust <= 0n || outFull <= 0n) return null;

  // 邊際單位價 vs 大額單位價，交叉相乘：outFull/dust 與 outDust/amountIn 比大小。
  const bigScaled = outFull * dust;
  const dustScaled = outDust * params.amountIn;
  if (dustScaled === 0n) return null;
  if (bigScaled >= dustScaled) return 0; // 大額反而更划算（極少見）→ 0 bps
  const bps = ((dustScaled - bigScaled) * 10_000n) / dustScaled;
  return Number(bps);
}
