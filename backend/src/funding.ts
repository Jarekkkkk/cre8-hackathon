import type { Address } from 'viem';

/**
 * 「這個 smart account 現在能不能動」的純判斷，不碰鏈。
 *
 * ERC-4337 的 UserOp gas 由 `sender`（smart account 自己）預付，session key 只是有權限指揮帳戶、
 * 本身不持有資產（見 docs/pitfalls.zh-TW.md §3.10）。所以使用者要讓再平衡跑得起來，動作只有一個：
 * 把 BNB 打進自己的 smart account 地址。這裡回答兩件事 —— 打哪個地址、打夠了沒。
 *
 * 純函式是刻意的：餘額與 gas price 都是鏈上呼叫（`chain.getAccountGasBalance` /
 * `chain.getGasPriceWei`），把它們與判斷分開，這個模組就能用固定數字測到每個邊界。
 */

/** 一次 rebalance UserOp 的實測 gasUsed（約 250k）。估算用，不是帳務數字。 */
/**
 * 一次 rebalance 大約用多少 gas —— **取自實測，不是猜的**。
 *
 * 三次真實執行（含 approve 與 swap）：`actualGasUsed` 870,901 / 938,431 / 935k 左右。
 * 舊值是 250,000（只算了 handleOps 的骨架，沒算 calldata 與兩筆 swap），讓 `estimatedOps`
 * 高估 3.5 倍 —— 而那個數字會顯示給使用者（portfolio 頁的 gas 一列），所以必須是誠實的。
 *
 * 取 900,000 而不是平均值：寧可略微保守，因為低估的後果是「以為還能跑，結果付不出 gas」。
 */
export const OPS_GAS_PER_OPERATION = 900_000n;

/** `Number` 的安全上限；超過就 clamp，避免把一個巨大的 bigint 轉成看似精確的錯數字。 */
const MAX_SAFE_OPS = Number.MAX_SAFE_INTEGER;

export type GasStatus = {
  /** 打錢的目標：smart account 自己的地址。 */
  address: Address;
  /** 目前餘額，十進位字串（JSON 沒有 bigint，數字會失真）。 */
  balanceWei: string;
  /** 可執行的門檻（`MIN_SESSION_GAS_WEI`）。 */
  minimumWei: string;
  /** `balanceWei >= minimumWei`。只跟餘額有關，與 gas price 無關。 */
  ready: boolean;
  /** 還差多少 wei 才到門檻；`ready` 時是 "0"。 */
  shortfallWei: string;
  /** 用當前 gas price 估還能跑幾次 op（向下取整）。gas price 取不到時是 0，見 `gasPriceKnown`。 */
  estimatedOps: number;
  /**
   * false = gas price 拿不到（0），`estimatedOps` 因此是「未知」而不是「跑不了」。
   * 少了這個旗標，一次 gas price 查詢失敗的回應會長得跟「餘額是 0」一模一樣。
   */
  gasPriceKnown: boolean;
};

/**
 * 一次 op 的 gas 成本（wei）。gas price 未知（<= 0）時回 0，呼叫端要先看 `gasPriceKnown`。
 */
export function perOperationCostWei(gasPriceWei: bigint): bigint {
  if (gasPriceWei <= 0n) return 0n;
  return OPS_GAS_PER_OPERATION * gasPriceWei;
}

/**
 * 餘額 → 可執行狀態。三件事都有防護：除以零（gas price 0）、bigint→Number 溢位（clamp）、
 * 餘額低於門檻（shortfall 而不是負數）。
 */
export function describeGasStatus(args: {
  address: Address;
  balanceWei: bigint;
  minimumWei: bigint;
  gasPriceWei: bigint;
}): GasStatus {
  const { address, balanceWei, minimumWei, gasPriceWei } = args;
  const ready = balanceWei >= minimumWei;

  return {
    address,
    balanceWei: balanceWei.toString(),
    minimumWei: minimumWei.toString(),
    ready,
    shortfallWei: ready ? '0' : (minimumWei - balanceWei).toString(),
    estimatedOps: estimateOps(balanceWei, gasPriceWei),
    gasPriceKnown: gasPriceWei > 0n,
  };
}

/** `balance / (gasPerOp * gasPrice)`，向下取整；gas price 0 時回 0（不除以零）。 */
function estimateOps(balanceWei: bigint, gasPriceWei: bigint): number {
  const costPerOp = perOperationCostWei(gasPriceWei);
  if (costPerOp === 0n || balanceWei <= 0n) return 0;

  const ops = balanceWei / costPerOp;
  return ops > BigInt(MAX_SAFE_OPS) ? MAX_SAFE_OPS : Number(ops);
}
