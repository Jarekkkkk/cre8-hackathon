/**
 * 排程器迴圈（S3）：讓前幾刀做好的零件自己動起來。
 *
 * 這個檔案只做「誰現在該跑 → 該不該動 → 要不要送」的**決策與認領**，把三個既有零件串起來：
 *   `planPortfolio`（snapshot.ts）     持倉 + 定價 + 漂移 + blocked
 *   `planRebalance`（rebalance-plan.ts）漂移 → SwapStep[]（永不回空 steps）
 *   既有的 session key 簽名機制          execute-rebalance.ts 走過的那條路（實測成功換幣）
 *
 * ## 四條會決定「會不會重複動錢」的規則
 *
 * ① **認領與推進在同一個 transaction 裡**（`claimDuePortfolios`）。
 *    `SELECT … FOR UPDATE SKIP LOCKED` 選出到期的列，並在**離開 transaction 之前**把
 *    `next_run_at` 寫成 `now + intervalSeconds`。若等執行完才推進，一次 crash／逾時／`kill -9`
 *    就讓同一個 portfolio 在下一輪仍然「到期」→ 被重複認領 → 重複送一筆再平衡。
 *    漏跑一次只是延後（下一輪會補），重複跑是不可逆的。所以推進放在**執行之前**。
 *    ⚠ 只有 **live** 才推進：dry-run 用 `claimDuePortfolios(…, { advance: false })`，見下一段。
 *
 * ①-bis **dry-run 只讀不寫：連 `next_run_at` 都不推進。**
 *    用 dry-run 當監控是很自然的用法，但推進一次就把真正的再平衡往後推一整個 interval
 *    （本專案 86400 秒 = 一次 dry-run 就等於「今天不做」）。所以 `advance` 只給 live。
 *    代價是：連續跑兩次 dry-run 會看到**同樣的** portfolio。那是正確且可預期的 ——
 *    **觀察不該改變被觀察的系統**。live 的語意完全不變：認領與推進仍然是同一個 transaction
 *    （上面那條規則才是防重複執行的關鍵，不能因為這個修改而鬆動）。
 *
 * ② **`dryRun` 預設 true，而且 true 時執行路徑一次都不會被呼叫。**
 *    `runSchedulerOnce({})` 就是 dry run：算得出參數、印得出來，但不會有任何交易。
 *    要送交易只有一條路：明確傳 `dryRun: false`（CLI 上是 `--live`）。有測試釘住呼叫次數 = 0。
 *
 * ③ **live 的前置檢查缺一不可**（§4）：帳戶型別是 `KERNEL`、session key 在鏈上已安裝、
 *    **seed 派生得出 DB 記的那把 key**、allowance 足夠、餘額足夠。任一不滿足就 blocked 並跳過
 *    —— 不送一筆注定 revert 的交易。第一項**不看 DB 的 `session_keys.status`**：DB 說 active
 *    不代表鏈上裝好了（docs/pitfalls §8.11），而 `permissionConfig(pid).signer` 是 validator
 *    合約位址、不是 EOA（§8.10）。
 *
 * ## 為什麼「設定錯誤」必須擋在 `blocked`，不能記成 `failed`
 *
 * `failed` 的意思是「試過了但失敗」（`operations` 有一列、`attempts` +1）。而 seed 打錯、換了
 * KMS、複製貼上少一個字元，真相是「**根本沒試**」。把它記成 failed 會有兩個後果：連續 `--loop`
 * 每輪燒一次 attempt；而且監控上「失敗」與「設定錯誤」再也分不出來。所以派生對帳（純本機運算，
 * 不碰鏈）與帳戶型別檢查都放在**寫 `operations` 之前**，不符就 blocked 並帶明確的 code。
 *
 * 帳戶型別同理，而且**dry-run 也走這一條**：一個 `account_type != 'KERNEL'` 的帳戶（例如 EOA
 * ——帳戶就是 owner 本人）永遠不可能用 session key 簽 UserOp，讓它在監控輸出裡顯示 `ready`
 * 會讓「看 ready 的數量判斷健康度」得到錯的結論。
 *
 * ③-bis **③的整組前置檢查在 dry-run 也跑**（`ready` 的定義是「如果現在 `--live`，這一個會成功
 *    嗎？」）。只把帳戶型別搬過來而把 a／a2／b／c 留在 live-only，就只是把「永遠不可能成功卻顯示
 *    `ready`」從 EOA 換成另一類（KERNEL 但 active `session_keys` = 0、或 allowance 早就被用掉）。
 *    代價只有兩種讀取：每把候選 key 一次 `permissionConfig`（裝好即停）、每個 step 各一次
 *    allowance／balance —— 與 `planPortfolio` 已經在做的持倉事件掃描與定價是同一個數量級，
 *    而且只有真的走到 `ready`（有漂移、規劃得出 steps）的 portfolio 才付。dry-run 仍然
 *    **不寫 `operations`、不推進 `next_run_at`、不送交易**（①-bis 與②不變）。
 *
 * ④ **`operations` 是防重複的第二道鎖**：`idempotency_key = rebalance:{portfolioId}:{planHash}`，
 *    `planHash` 涵蓋 `tokenIn/tokenOut/amountIn/amountOutMin/deadline`。`confirmed` 永不再送、
 *    `pending`/`submitted` 視為在途不重送、`failed`/`reverted` 才允許同一個 key 重試（attempts +1）。
 *
 * ⑤ **地板的規劃值不是送出值：簽名前一定重問一次**（`deps.refreshFloors`）。
 *    `planRebalance` 的 `minimum` 是 `plan.snapshot.block` 那一塊問到的，而 `AtpExecutor._checkStep`
 *    在**執行**那一塊會自己再問一次 oracle 並 `require(step.amountOutMin >= minGross)`
 *    —— 而 `PancakeV3TwapOracle` 的 `minimum` 含近 5 分鐘均值，會追著池價跑。所以凍結的規劃值在
 *    plan → sign 之間（幾十秒、好幾塊）就可能低於當下的地板 → `BelowFloor` 或 router 的
 *    `Too little received`。重問用**新鮮值**覆寫（不是 `max`，見 `refreshFloors` 的檔頭），
 *    而且呼叫點在 `planHashFor` **之前**：`planHash` 就是 `operations.payload_hash`，
 *    它必須描述真的會上鏈的那組參數。問不到地板 → 這一輪不送（`blocked`，不寫 operations）。
 *
 * ## 為什麼 dry-run 不寫 `operations`
 *
 * §5 說「每次進入執行流程就寫一列」，而 dry-run 確實進了執行流程。但 dry-run 寫一列 `pending`
 * 會讓**真正的執行永遠被自己的預演擋住**：idempotency_key 是 `rebalance:{pid}:{planHash}`，
 * 同一個 plan 的 key 必然相同，於是 live 那一次會讀到 pending → 視為在途 → 跳過。
 * 一個預演把真交易鎖死，比「少一列稽核紀錄」嚴重得多。所以 dry-run 只把
 * `planHash`／`idempotencyKey` 印在結果裡（看得見它將會用哪個 key），一列都不寫。
 */

import { HDKey } from '@scure/bip32';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { toECDSASigner } from '@zerodev/permissions/signers';
import { addressToEmptyAccount, createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import type { GetKernelVersion } from '@zerodev/sdk/types';
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  hexToBytes,
  http,
  isAddressEqual,
  keccak256,
  toBytes,
} from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { hdKeyToAccount } from 'viem/accounts';
import { activeChain } from './chain-object.js';
import { KERNEL_V3_3_ADDRESSES } from './addresses.js';
import { detectAlerts, formatAlert, recordAlerts, resolveAlerts } from './alerts.js';
import { getConfig, getSessionKeyConfig, requireSessionKeyConfig } from './config.js';
import { errorMessage, query as dbQuery, withTransaction } from './db.js';
import { buildSessionPermissions } from './permissions.js';
import { DEFAULT_DEADLINE_SECONDS as PLAN_DEFAULT_DEADLINE_SECONDS, planRebalance, refreshFloors } from './rebalance-plan.js';
import { writeSnapshot as writeSnapshotImpl } from './snapshot.js';
import type { PlanPartial, PlannedStep, RebalancePlan, RefreshFloorsResult } from './rebalance-plan.js';
import { DEFAULT_THRESHOLD_BPS, planPortfolio } from './snapshot.js';
import type { PortfolioPlan } from './snapshot.js';
import { MIN_INTERVAL_SECONDS } from './strategies.js';

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

/** 一輪最多認領幾個 portfolio。刻意不大：一輪的長度要短於最短的 interval（60 秒）。 */
export const DEFAULT_ROUND_LIMIT = 20;

/**
 * 非 interval 排程（`cron`、缺排程、形狀不對）的後推秒數。
 *
 * 這些 portfolio **仍然會被認領**（要留下 blocked 的紀錄，不能靜默跳過），但認領一定要推進
 * `next_run_at`：留著 NULL 的話它們每一輪都排在最前面（`nulls first`），會把 limit 吃光、
 * 讓真正能跑的 portfolio 永遠輪不到。後推一小時 = 「一小時後再提醒一次」，不是「假裝支援 cron」。
 */
export const UNSUPPORTED_SCHEDULE_BACKOFF_SECONDS = 3_600;

/**
 * deadline = `max(塊時間, 牆鐘)` + 這個秒數。
 *
 * **這裡刻意不再自己寫一個數字。** 先前排程器有一個獨立的 300 秒，而它是以
 * `planRebalance({ deadlineSeconds })` **顯式**傳進去的 —— 顯式參數優先於規劃器的預設，所以
 * 修好規劃器也修不到排程器。稀疏挖礦那筆 `DeadlineExpired`（塊時間落後牆鐘 14 分鐘，
 * `塊時間 + 300` 在簽的時候就已經過期）走的就是這條路：修規劃器的預設值時如果漏掉這裡，
 * 排程器仍然會用 300 秒繼續 revert。
 *
 * 現在只有一個來源：`rebalance-plan.ts` 的 `DEFAULT_DEADLINE_SECONDS`（1800 秒）。
 */
export const DEFAULT_DEADLINE_SECONDS = PLAN_DEFAULT_DEADLINE_SECONDS;

/** CallPolicy 白名單裡唯一的 selector（= session key 唯一被允許呼叫的函式）。 */
export const EXECUTE_REBALANCE_SELECTOR: Hex = '0x1b977850';

/** EntryPoint v0.7：`toPermissionValidator` 只接受 0.7，其他版本會直接 throw。 */
const ENTRY_POINT = { address: KERNEL_V3_3_ADDRESSES.entryPointV07, version: '0.7' } as const;

/** 交易送出後等 receipt 的上限（毫秒）。超過就當這一輪失敗，下一輪重新規劃。 */
const USER_OP_RECEIPT_TIMEOUT_MS = 180_000;

/** 三層 policy 都裝好的證據：`policyData` 的長度（call + gas + timestamp）。 */
const EXPECTED_POLICY_COUNT = 3;

/**
 * `permissionConfig(bytes4)` 的回傳：Kernel v3.3 的 `ValidationManager.PermissionConfig`。
 *
 * 自己寫一份（而不是從 `@zerodev/sdk` 拿 `KernelV3_3AccountAbi`）是為了讓「讀一欄」不必把整個
 * SDK 拉進這條路徑。欄位形狀照 SDK 的 ABI 逐字抄，`bytes22[]` 不是筆誤——PolicyData 是 packed 的。
 */
const KERNEL_PERMISSION_ABI = [
  {
    type: 'function',
    name: 'permissionConfig',
    stateMutability: 'view',
    inputs: [{ name: 'pId', type: 'bytes4' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'permissionFlag', type: 'bytes2' },
          { name: 'signer', type: 'address' },
          { name: 'policyData', type: 'bytes22[]' },
        ],
      },
    ],
  },
] as const;

const ERC20_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const EXECUTOR_ABI = [
  {
    type: 'function',
    name: 'oracle',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'executeRebalance',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'account', type: 'address' },
      {
        name: 'steps',
        type: 'tuple[]',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'commands', type: 'bytes' },
          { name: 'inputs', type: 'bytes[]' },
        ],
      },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

// ---------------------------------------------------------------------------
// 送出去的 gas 預算，與收到 receipt 之後的三層判定（docs/pitfalls §8.16）
// ---------------------------------------------------------------------------

/**
 * `callGasLimit` 的下限：600,000。
 *
 * 實測（fork，portfolio 305 的 3 資產 → 2 筆 swap）：alto 的 `eth_estimateUserOperationGas` 只給
 * 367,885，而 `executeRebalance` 走完 UniversalRouter 的 V3 swap 實際要 450–500k。gas 不夠時
 * EntryPoint **不會**讓整筆交易 revert —— 它 emit `UserOperationEvent(success = false)` 就繼續，
 * 所以 `tx.status` 還是 1、gas 照扣、幣一個都沒換（§8.16）。
 *
 * `callGasLimit` 是**上限**：沒用完的部分不會變成手續費（帳戶付的是實際用量），偏高只是把
 * EntryPoint 要求的 prefund 墊高一點。所以「估不準就給保守值」在這裡是安全的，低估才是不安全的。
 */
export const REBALANCE_CALL_GAS_FLOOR = 600_000n;

/** 估算值的放大倍率（3/2 = 1.5×）：alto 對整條 DeFi 路徑低估 20~35%，留 50% 餘裕。 */
const CALL_GAS_HEADROOM_NUMERATOR = 3n;
const CALL_GAS_HEADROOM_DENOMINATOR = 2n;

/**
 * 真正簽進 userOp 的 `callGasLimit` = `max(alto 估計 × 1.5, 600_000)`。
 *
 * 為什麼不直接寫死 600,000：steps 的數量隨資產數成長（3 資產 = 2 筆 swap ≈ 450–500k，資產再多就會
 * 超過 600k）。固定值會變成一個**靜默的能力上限** —— 有一天它不夠了，就又回到「花錢買 success=false」。
 * `max` 讓它跟著估算一起長大，下限則蓋住 alto 系統性低估的那一段。
 *
 * 兩個都失準的情況（估得太低、且真實需求又剛好超過這裡算出來的值）由送出前的 `eth_call` 兜住：
 * 模擬用的 gas **正是這裡算出來的值**，所以「簽名前的 gas 不夠」會在那裡變成明確的失敗，而不是
 * 一筆花了錢卻什麼都沒換的交易。
 */
export function rebalanceCallGasLimit(estimatedCallGasLimit: bigint): bigint {
  const scaled = (estimatedCallGasLimit * CALL_GAS_HEADROOM_NUMERATOR) / CALL_GAS_HEADROOM_DENOMINATOR;
  return scaled > REBALANCE_CALL_GAS_FLOOR ? scaled : REBALANCE_CALL_GAS_FLOOR;
}

/** `AtpExecutor.SwapExecuted(address,address,address,uint256,uint256,uint256,uint256,uint256)` 的 topic0。 */
const SWAP_EXECUTED_TOPIC = keccak256(
  toBytes('SwapExecuted(address,address,address,uint256,uint256,uint256,uint256,uint256)'),
);

/**
 * 算一份 receipt 裡**這個 executor** 發出的 `SwapExecuted` 筆數。
 *
 * 只認 emitter 是 executor 的 log：別的合約（例如 router 自己）的主題相同也不算「幣換了」。
 * 空 `steps` 的 `executeRebalance` 是「正常返回、什麼都不做、不 emit 任何 SwapExecuted」（§8.1），
 * 所以這一層（第 3 層）是唯一能證明「真的換了東西」的證據。
 */
export function countSwapExecuted(
  logs: readonly { address: Address; topics: readonly Hex[] }[],
  executor: Address,
): number {
  const emitter = executor.toLowerCase();
  return logs.filter(
    (log) => log.topics[0]?.toLowerCase() === SWAP_EXECUTED_TOPIC && log.address.toLowerCase() === emitter,
  ).length;
}

/** 三層判定需要的證據。全部來自同一份 receipt，所以不會有「三層看到不同世界」的問題。 */
export type RebalanceEvidence = {
  /** 第 1 層：交易本身。（`receipt.status`） */
  txStatus: 'success' | 'reverted';
  /** 第 2 層：`UserOperationEvent.success`。`null` = receipt 裡找不到那個事件。 */
  userOpSuccess: boolean | null;
  /** 第 3 層：這一筆 receipt 裡 executor 發出的 `SwapExecuted` 筆數。 */
  swapExecuted: number;
  /** 這一輪規劃了幾個 step（＝應該有幾筆 SwapExecuted）。 */
  expectedSwaps: number;
  txHash: Hex | null;
  userOpHash: Hex | null;
  gasUsed: string | null;
};

/**
 * 收到 receipt 之後判定這次送出的結果。**三層缺一不可**（§8.16）：
 *
 *   ① `receipt.status == success`
 *   ② `UserOperationEvent.success == true`
 *   ③ `SwapExecuted` 筆數 == steps 筆數
 *
 * 只驗第 1 層就是 §8.1 的假成功（空 steps 也會 status = 1）；只驗 1+2 仍然可能是「op 成功但什麼都沒換」。
 * 任何一層不成立 → `reverted`（**上鏈了、gas 花了、但沒有成功**），絕不是 `success` ——
 * 因為 `success` 會被 `operations` 記成 `confirmed`，而 `confirmed` 的意思是「這組參數永不再送」。
 */
export function judgeRebalanceOutcome(evidence: RebalanceEvidence): ExecutionOutcome {
  const base = { userOpHash: evidence.userOpHash, txHash: evidence.txHash, gasUsed: evidence.gasUsed };
  const failures: string[] = [];
  if (evidence.txStatus !== 'success') failures.push('tx status 不是 success');
  if (evidence.userOpSuccess !== true) {
    failures.push(
      evidence.userOpSuccess === null
        ? 'receipt 裡找不到 UserOperationEvent（無法證明 op 成功）'
        : 'UserOperationEvent.success = false（EntryPoint 吞掉了執行失敗）',
    );
  }
  if (evidence.swapExecuted !== evidence.expectedSwaps) {
    failures.push(`SwapExecuted ${evidence.swapExecuted}/${evidence.expectedSwaps} 筆（沒有全部換成）`);
  }
  if (failures.length === 0) return { status: 'success', ...base, error: null };

  // 可診斷的 last_error：說清楚「上鏈了、錢花了、哪一層沒過」。下一輪照這個訊息決定要不要重試。
  const spent = evidence.gasUsed === null ? '' : `，gas ${evidence.gasUsed} 已經花掉`;
  return { status: 'reverted', ...base, error: `上鏈但 op 沒有成功（${failures.join('；')}）${spent}` };
}

/** `AtpRegistry.effectiveFeeBps(strategyId)`：`minGross` 的放大倍率（＝平台抽成的 bps）。 */
const REGISTRY_ABI = [
  {
    type: 'function',
    name: 'effectiveFeeBps',
    stateMutability: 'view',
    inputs: [{ name: 'strategyId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint16' }],
  },
] as const;

/** `planHash` 的編碼：只涵蓋會改變鏈上結果的四個數字 + deadline。 */
const PLAN_HASH_ABI = [
  {
    type: 'tuple[]',
    components: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
    ],
  },
  { name: 'deadline', type: 'uint256' },
] as const;

// ---------------------------------------------------------------------------
// 型別
// ---------------------------------------------------------------------------

/** DB 的最小介面：只要求 `{ rows }`，`db.query` 與測試 stub 都直接接得上（與 snapshot.ts 同形）。 */
export type SchedulerQueryFn = (text: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>;

/** 交易 runner：`db.withTransaction` 的形狀，測試用記憶體 stub 取代。 */
export type WithTransactionFn = <T>(fn: (client: { query: SchedulerQueryFn }) => Promise<T>) => Promise<T>;

/**
 * 一個被認領的 portfolio。
 *
 * `intervalSeconds` 在非 interval 排程（cron／缺排程）時是**後推用的退避秒數**，不是排程週期：
 * 那種 portfolio 一定會帶著 `unsupportedReason` 回來，不可能被執行。
 */
export type DuePortfolio = {
  portfolioId: number;
  strategyId: number;
  account: Address;
  intervalSeconds: number;
  /**
   * `smart_accounts.account_type`：只有 `KERNEL` 能用 session key 簽 UserOp。
   * 認不出來的值（欄位缺失／空字串）一律當成非 KERNEL → blocked，不是「大概是吧」。
   */
  accountType: string;
  /** 非 null = 這一輪不可能執行（cron 不支援／排程缺失或形狀不對），只會被記成 blocked。 */
  unsupportedReason: string | null;
  /**
   * 認領時算出的下一次執行時間。
   *
   * `advance: true`（live）→ 這個值**已經在認領的 transaction 內寫進 DB**。
   * `advance: false`（dry-run）→ **沒有寫入**，它只是「如果推進會寫成什麼」。
   */
  nextRunAt: Date;
};

/** `strategy_versions.schedule` 的解析結果。cron 是**明確不支援**，不是靜默跳過。 */
export type ParsedSchedule =
  | { kind: 'interval'; intervalSeconds: number }
  | { kind: 'unsupported'; reason: string };

/** 一輪裡每個 portfolio 的結果。`ready-dry-run` = 算好了但沒送（dry-run）。 */
export type PortfolioOutcome = 'noop' | 'blocked' | 'ready-dry-run' | 'executed' | 'failed';

/**
 * 「部分執行」之後要提早再跑：`next_run_at` 用 **`min(intervalSeconds, 這個值)`** 而不是完整間隔。
 *
 * 為什麼需要它：池子不夠深時一筆大額再平衡會被價格衝擊上限切成一小塊（見
 * `rebalance-plan.ts` 的 `maxImpactBps`），剩下的要靠**下一輪** —— 因為地板來自 TWAP，
 * 同一批裡再切細只會讓後面的幾份更糟。等 TWAP 吸收掉這一輪的衝擊，下一輪的地板才會跟著移動。
 *
 * ## 為什麼是 1800 秒：等於 TWAP 視窗，不是半個
 *
 * `PancakeV3TwapOracle.twapWindow` 是 30 分鐘起跳（合約限制 30–90 分鐘）。影響估算是
 * 「手續費 + **現貨相對 TWAP 的既有偏差** + 本筆衝擊」三塊一起算，所以**基準偏差會吃掉那 50 bps 的
 * 預算**：買入把池價推離 TWAP，而 TWAP 還沒追上 → 下一輪能做的增量就越來越小。
 *
 * 實測（原本 900 秒、即半個 TWAP 視窗）：09:35 那輪 NVDAB 買 18,680 USDT，09:53 那輪只買到約
 * 2,557 USDT（1/7）—— 每輪都在 TWAP 還沒追上時又推一次，收斂被自己的基準偏差拖住。
 *
 *   * 好處：每輪間隔 ≥ TWAP 視窗，基準偏差有時間衰減，每輪可做的量變大。
 *   * 代價：**失敗／部分執行的跟進變慢**（30 分鐘而不是 15 分鐘）→ 完整收斂的 wall-clock 時間
 *     不一定變短；一次「只做了一點」的輪次要等更久才會再試。
 *   * 為什麼不是更長：> TWAP 視窗之後就沒有新的衰減可得，只是把跟進拖得更慢。1800 是合約允許的
 *     TWAP 視窗下限 —— 剛好「一輪 = 一個視窗」，也剛好是能選的最短的那個合法值。
 *
 * 為什麼 `min(intervalSeconds, …)`：排程週期本來就比 30 分鐘短的策略不該被**延後**。
 */
export const PARTIAL_FOLLOW_UP_SECONDS = 1800;


/** 準備要執行的參數摘要：dry-run 與 live 都會有，差別只在有沒有 `execution`。 */
export type PlannedSummary = {
  steps: {
    tokenIn: Address;
    tokenOut: Address;
    amountIn: string;
    amountOutMin: string;
  }[];
  deadline: string;
  /** 涵蓋 steps 四個數字 + deadline 的 hash（hex）。 */
  planHash: Hex;
  /** `rebalance:{portfolioId}:{planHash}`：live 時 operations 的防重複鍵（dry-run 只印不寫）。 */
  idempotencyKey: string;
  rationale: string;
};

export type PortfolioRunResult = {
  portfolioId: number;
  strategyId: number;
  account: Address;
  outcome: PortfolioOutcome;
  /** 一句話說明為什麼是這個結果（繁中，直接進 CLI 摘要）。 */
  reason: string;
  nextRunAt: Date;
  plan: PlannedSummary | null;
  /** 真的送出時的結果。dry-run 一律 null。 */
  execution: ExecutionOutcome | null;
  /**
   * 這一輪只做了一部分：依這份計畫執行後**預估漂移仍高於門檻**（還有事要做）。非 null 且真的執行
   * 成功時，`nextRunAt` 會被拉近到 `min(intervalSeconds, PARTIAL_FOLLOW_UP_SECONDS)`。
   *
   * 判準是結果不是過程：`shrunk` 只是證據，**可以是空的**（缺口是被跳過而不是被縮小）。
   */
  partial: PlanPartial | null;
};

/** DB 的 session key（只存派生路徑，私鑰不落 DB）＋ 鏈上要用的三個欄位。 */
export type SessionKeyRef = {
  keyRef: `m/44'/60'/${string}`;
  permissionId: Hex;
  sessionKeyAddress: Address;
  /** Unix 秒（重建 permissionId 要用同一個 validUntil，否則 id 會變）。 */
  validUntil: number;
  owner: Address;
};

export type SessionKeyResolution = { ok: true; key: SessionKeyRef } | { ok: false; reason: string };

/** 鏈上 `permissionConfig(pid)` 的兩個關鍵欄位。 */
export type PermissionInstallation = { signer: Address; policyCount: number };

export type Erc20Args = { token: Address; owner: Address; spender?: Address };

export type ExecuteArgs = {
  portfolioId: number;
  account: Address;
  sessionKey: SessionKeyRef;
  /** AtpExecutor：`executeRebalance` 的 target，也是 allowance 的 spender。 */
  executor: Address;
  steps: readonly PlannedStep[];
  deadline: bigint;
  /** 送出（拿到 userOpHash）後立刻回呼，讓排程器把 operations 標成 submitted。 */
  onSubmitted: (ids: { userOpHash?: Hex; txHash?: Hex }) => Promise<void>;
};

/**
 * 一次送出的結果。三種狀態刻意分開：
 *   success   上鏈且成功 —— **三層都成立**（`receipt.status` + `UserOperationEvent.success` +
 *             `SwapExecuted` 筆數 == steps 筆數，見 `judgeRebalanceOutcome`）。只有這個狀態會被
 *             `operations` 記成 `confirmed`。
 *   reverted  上鏈了但沒有成功（有 tx_hash，花掉 gas，什麼都沒換）。包含「`tx.status == 1` 但
 *             EntryPoint 吞掉執行失敗」那個版本（§8.16）：`error` 會帶上哪一層沒過。
 *   error     根本沒送出去（bundler 拒絕、簽章錯、送出前的 `eth_call` 模擬失敗、逾時）：
 *             **沒有證據說它上鏈了**，所以要記成 failed 而不是 reverted —— 後者會讓人以為鏈上那一筆失敗了。
 */
export type ExecutionOutcome = {
  status: 'success' | 'reverted' | 'error';
  userOpHash: Hex | null;
  txHash: Hex | null;
  gasUsed: string | null;
  /** `reverted` 的診斷（哪一層沒過）與 `error` 的原因；`success` 時為 null。 */
  error: string | null;
};

/** 決策所需的輸入：portfolio 與它的 drift 計畫（`planPortfolio` 的產物）。 */
export type RebalancePlanningInput = { portfolioId: number; account: Address; plan: PortfolioPlan };

/** 送出前重問地板的輸入。`executor` 是 chain 上 `oracle()` 的讀取點，`strategyId` 是 `effectiveFeeBps` 的 key。 */
export type FloorRefreshInput = {
  steps: readonly PlannedStep[];
  /** **鏈上** strategy id（`enrollment.strategyId`），不是 DB 的 `strategies.id`。 */
  strategyId: bigint;
  executor: Address;
};

export type SchedulerDeps = {
  /**
   * 即使漂移低於門檻也照樣呼叫 `planRebalance`。
   *
   * 為什麼需要：`needsRebalance === false` 是「不需要再平衡」的判準，但**不是**「這個投組沒有事要做」。
   * `POST /portfolios/:id/redeem` 要按比例把部位賣成 numeraire —— 賣完權重不變、漂移不會變大，
   * 所以在對齊的投組上它會被門檻短路掉，變成永遠 noop（實測：drift 2 bps 時 redeem 回 noop）。
   */
  forcePlan?: boolean;
  /** 認領用的 DB 介面（測試換成記憶體 stub）。 */
  withTransaction?: WithTransactionFn;
  query?: SchedulerQueryFn;
  /** 讀鏈用的 chain id（smart account 的 chain_id 篩選）。 */
  chainId?: number;
  /**
   * AtpExecutor 位址（allowance 的 spender、`executeRebalance` 的 target）。省略 = 讀 `EXECUTOR_ADDRESS`。
   * dry-run 也需要它（前置檢查 b 的 spender，見檔頭 ③-bis），而預設的 planRebalance 本來就在讀。
   */
  executor?: Address;
  /**
   * 稽核快照的 writer。預設是 `snapshot.ts` 的 `writeSnapshot`；測試注入 stub 就不必真的寫 DB。
   * 失敗不會讓這一輪失敗（快照是觀測，不是這一輪的目的）。
   */
  writeSnapshot?: typeof writeSnapshotImpl;

  planPortfolio?: (portfolioId: number) => Promise<PortfolioPlan>;
  planRebalance?: (input: RebalancePlanningInput) => Promise<RebalancePlan>;
  /** live 前置檢查 a：鏈上的 permissionConfig（不看 DB 的 status）。 */
  readPermissionConfig?: (args: { account: Address; permissionId: Hex }) => Promise<PermissionInstallation>;
  /**
   * live 前置檢查 a2：`master seed + key_ref` 派生出的 EOA（**純本機運算，不碰鏈**）。
   * 省略 = 讀 `SESSION_KEY_MASTER_SEED` 自己派生。它與 DB 的 `sessionKeyAddress` 不符 → blocked。
   */
  deriveSessionKeyAddress?: (keyRef: SessionKeyRef['keyRef']) => Promise<Address>;
  /** live 前置檢查 b。 */
  readAllowance?: (args: Erc20Args) => Promise<bigint>;
  /** live 前置檢查 c。 */
  readBalance?: (args: Erc20Args) => Promise<bigint>;
  /** 真正送出的路徑。dry-run 時**一次都不會被呼叫**（測試釘住）。 */
  executeRebalance?: (args: ExecuteArgs) => Promise<ExecutionOutcome>;
  /**
   * **送出前重問地板**。省略 = `rebalance-plan.ts` 的 `refreshFloors`（讀 `executor.oracle()` 與
   * `registry.effectiveFeeBps(strategyId)`，再對每個 step 重問 `previewSwap`）。
   *
   * ⚠ 呼叫點在 `planHashFor` **之前**：`planHash` 涵蓋 `amountOutMin`，而 `operations.payload_hash`
   * 與 `idempotency_key` 都是那個 hash。放在 `beginOperation` 之後（送出路徑裡）就等於讓 DB 記下
   * 一組從未上鏈的參數，而 `idempotency_key` 也會指到錯的那一組。
   *
   * 回 `{ ok: false }` 時呼叫端**不送**（fail closed）：問不到地板就不能假裝知道現在的下限。
   */
  refreshFloors?: (input: FloorRefreshInput) => Promise<RefreshFloorsResult>;
  log?: (line: string) => void;
};

export type RunSchedulerArgs = {
  /** **預設 true**（省略即 dry run）。要送交易必須明確給 false。 */
  dryRun?: boolean;
  limit?: number;
  now?: Date;
  thresholdBps?: number;
};

export type SchedulerRound = {
  claimed: number;
  dryRun: boolean;
  results: PortfolioRunResult[];
};

// ---------------------------------------------------------------------------
// 純函式：排程解析 / planHash
// ---------------------------------------------------------------------------

/**
 * `strategy_versions.schedule` → 週期或「不支援」。
 *
 * `cron` 一定要回 `unsupported` 並帶上原因：目前只支援 interval，而**假裝支援** cron 會在
 * 「每一輪都不動作」與「每一輪都動作」之間選一個錯的答案，而且看不出來。靜默跳過同樣糟：
 * 一個 cron 的策略會永遠不被排程，卻沒有任何紀錄。
 */
export function parseSchedule(raw: unknown): ParsedSchedule {
  if (raw === null || raw === undefined) {
    return { kind: 'unsupported', reason: 'strategy_versions 沒有這個版本（DB 沒有鏡像到 portfolio 釘住的版本），排程週期無從取得' };
  }
  if (typeof raw !== 'object') {
    return { kind: 'unsupported', reason: `schedule 不是物件（收到 ${JSON.stringify(raw)}），排程週期無從取得` };
  }
  const schedule = raw as { kind?: unknown; intervalSeconds?: unknown; cron?: unknown };
  if (schedule.kind === 'interval') {
    const intervalSeconds = schedule.intervalSeconds;
    if (typeof intervalSeconds !== 'number' || !Number.isInteger(intervalSeconds) || intervalSeconds < MIN_INTERVAL_SECONDS) {
      return {
        kind: 'unsupported',
        reason: `schedule.intervalSeconds 必須是 >= ${MIN_INTERVAL_SECONDS} 的整數（收到 ${JSON.stringify(intervalSeconds)}）`,
      };
    }
    return { kind: 'interval', intervalSeconds };
  }
  if (schedule.kind === 'cron') {
    return {
      kind: 'unsupported',
      reason: `cron 排程尚未支援（收到 ${JSON.stringify(schedule.cron)}）：目前只實作 {kind:'interval'}，` +
        `不猜 cron 的觸發時間，也不靜默跳過`,
    };
  }
  return { kind: 'unsupported', reason: `schedule.kind 不認得：${JSON.stringify(schedule.kind)}` };
}

/**
 * `planHash`：涵蓋 `tokenIn/tokenOut/amountIn/amountOutMin/deadline`。
 *
 * 它同時是 operations 的 `payload_hash` 與 `idempotency_key` 的一部分，所以「同樣的參數」必須
 * 得到同一個 hash（keccak256 對 abi.encode 的結果，欄位順序由 `PLAN_HASH_ABI` 固定）。
 */
export function planHashFor(steps: readonly PlannedStep[], deadline: bigint): Hex {
  return keccak256(
    encodeAbiParameters(PLAN_HASH_ABI, [
      steps.map((step) => ({
        tokenIn: step.tokenIn,
        tokenOut: step.tokenOut,
        amountIn: step.amountIn,
        amountOutMin: step.amountOutMin,
      })),
      deadline,
    ]),
  );
}

/** operations 的防重複鍵：同一個 portfolio 的同一組參數只會有一列。 */
export function idempotencyKeyFor(portfolioId: number, planHash: Hex): string {
  return `rebalance:${portfolioId}:${planHash}`;
}

// ---------------------------------------------------------------------------
// 認領
// ---------------------------------------------------------------------------

/**
 * 到期判定 + 認領。
 *
 * 條件：`schedule_state = 'active'` 且（`next_run_at is null` 或 `next_run_at <= now`）。
 * `idle`／`paused` 一律不會被選到；`next_run_at` 為 NULL 的 active = 立刻到期（新 portfolio 不被漏掉）。
 *
 * `FOR UPDATE OF p SKIP LOCKED`：兩個排程器行程同時跑也不會認領到同一列——後到的那個直接跳過
 * 被鎖住的列，而不是等它。鎖在 transaction 結束時釋放，而 `next_run_at` 已經在**commit 之前**
 * 推進，所以「認領」與「已經排到下一輪」是同一個原子事件。
 */
const SQL_CLAIM_DUE = `
  select p.id as portfolio_id,
         p.strategy_id,
         sa.address,
         sa.account_type,
         sv.schedule
    from portfolios p
    join smart_accounts sa
      on sa.portfolio_id = p.id
     and sa.chain_id = $2
    left join strategy_versions sv
      on sv.strategy_id = p.strategy_id
     and sv.version = p.version
   where p.schedule_state = 'active'
     and (p.next_run_at is null or p.next_run_at <= $1)
   order by p.next_run_at asc nulls first, p.id asc
   limit $3
     for update of p skip locked
`;

/** 認領列的下一次執行時間：單一 statement 寫回，避免 N 次往返（仍在同一個 transaction 內）。 */
const SQL_ADVANCE_CLAIMED = `
  update portfolios p
     set next_run_at = claimed.next_run_at
    from (select * from unnest($1::bigint[], $2::timestamptz[]) as t(id, next_run_at)) as claimed
   where p.id = claimed.id
`;

function assertLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`limit 必須是正整數（收到 ${JSON.stringify(limit)}）`);
  }
  return limit;
}

function toInteger(value: unknown, what: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw new Error(`${what} 不是整數（收到 ${JSON.stringify(value)}）`);
  return parsed;
}

function asAddress(value: unknown, what: string): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${what} 不是 0x + 40 hex 的地址（收到 ${JSON.stringify(value)}）`);
  }
  return value.toLowerCase() as Address;
}

/**
 * `smart_accounts.account_type` 的形狀檢查。
 *
 * 認不出來時回 `(missing)` 而不是拋錯：欄位缺失的意思是「不知道它是不是 KERNEL」，而下游把它
 * 當成**非 KERNEL** → blocked。寧可擋下一個型別不明的帳戶，也不要對它送一筆注定失敗的 op，
 * 更不要讓一整輪因為一列壞資料而停擺。
 */
function asAccountType(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '(missing)';
}

/** `claimDuePortfolios` 的選項。 */
export type ClaimOptions = {
  withTransaction?: WithTransactionFn;
  chainId?: number;
  /**
   * 認領時要不要把 `next_run_at` 推進到 `now + intervalSeconds`（**預設 true**）。
   *
   * `false` = 只讀不寫，只有 dry-run 用。live 一定要 `true`：推進與認領在同一個 transaction 內
   * 才是「不會重複執行」的全部證據（見檔頭 ①）。
   */
  advance?: boolean;
};

/**
 * 認領到期的 portfolio，並在**同一個 transaction 內**把 `next_run_at` 推進。
 *
 * 回傳的每一列都帶著「下一次執行時間」（`nextRunAt`），所以「這一輪跑完之後它什麼時候再跑」
 * 不必再查一次 DB，而且推進與認領是同一個 commit。
 *
 * ## 為什麼 dry-run 不推進（`advance: false`）
 *
 * 推進 = 把這個 portfolio 的下一次到期時間往後推一整個 interval。live 這樣做是為了防重複執行
 * （認領即推進，見檔頭 ①），但 dry-run 是在**觀察**：用 dry-run 當監控時，推進一次就等於
 * 「今天不做」（本專案 86400 秒）。所以 dry-run 連那一條 `UPDATE` 都不發，`next_run_at` 一位都不動。
 *
 * 權衡（刻意接受）：dry-run 不推進，所以連續跑兩次 dry-run 會看到**同樣的** portfolio。那是
 * 正確且可預期的 —— 觀察不該改變被觀察的系統；「這一輪該跑誰」這個問題的答案本來就不該被
 * 「我剛看過」改變。live 的語意則完全不變：認領與推進仍然一起 commit。
 */
export async function claimDuePortfolios(
  limit: number,
  now: Date = new Date(),
  deps: ClaimOptions = {},
): Promise<DuePortfolio[]> {
  assertLimit(limit);
  const run = deps.withTransaction ?? defaultWithTransaction;
  const chainId = deps.chainId ?? getConfig().chainId;
  const advance = deps.advance ?? true;

  return run(async (client) => {
    const claimed: DuePortfolio[] = [];
    const rows = (await client.query(SQL_CLAIM_DUE, [now, chainId, limit])).rows;

    for (const row of rows) {
      const typed = row as {
        portfolio_id?: unknown;
        strategy_id?: unknown;
        address?: unknown;
        account_type?: unknown;
        schedule?: unknown;
      };
      const portfolioId = toInteger(typed.portfolio_id, 'portfolios.id');
      const strategyId = toInteger(typed.strategy_id, 'portfolios.strategy_id');
      const account = asAddress(typed.address, 'smart_accounts.address');
      const accountType = asAccountType(typed.account_type);
      const schedule = parseSchedule(typed.schedule);
      const intervalSeconds =
        schedule.kind === 'interval' ? schedule.intervalSeconds : UNSUPPORTED_SCHEDULE_BACKOFF_SECONDS;

      claimed.push({
        portfolioId,
        strategyId,
        account,
        accountType,
        intervalSeconds,
        unsupportedReason: schedule.kind === 'unsupported' ? schedule.reason : null,
        // 與 SQL_ADVANCE_CLAIMED 寫下去的值逐位相同：回傳值不是另外算的，是同一份資料。
        // advance = false（dry-run）時這個值**不會**被寫入：DB 的 next_run_at 一位都不動。
        nextRunAt: new Date(now.getTime() + intervalSeconds * 1_000),
      });
    }

    if (advance && claimed.length > 0) {
      // ⚠ 這一行發生在 transaction **結束之前**：認領與推進一起 commit，中途 crash 就兩者都沒發生。
      // advance = false（dry-run）時整條 UPDATE 都不發：dry-run 只讀不寫，連「碰一下」都不做。
      await client.query(SQL_ADVANCE_CLAIMED, [
        claimed.map((due) => due.portfolioId),
        claimed.map((due) => due.nextRunAt.toISOString()),
      ]);
    }

    return claimed;
  });
}

// ---------------------------------------------------------------------------
// 每輪結果的落地（last_checked_at / last_rebalance_at）
// ---------------------------------------------------------------------------

const SQL_MARK_CHECKED = `
  update portfolios
     set last_checked_at = $2,
         last_rebalance_at = case when $3 then $2 else last_rebalance_at end
   where id = $1
`;

// ---------------------------------------------------------------------------
// operations 的生命週期（§5）
// ---------------------------------------------------------------------------

const SQL_INSERT_OPERATION = `
  insert into operations (portfolio_id, type, state, idempotency_key, payload_hash, attempts, updated_at)
  values ($1, 'rebalance', 'pending', $2, $3, 1, now())
  on conflict (idempotency_key) do nothing
  returning attempts
`;

const SQL_GET_OPERATION = 'select state, attempts from operations where idempotency_key = $1';

/**
 * 重試的 compare-and-swap：只有 `failed`/`reverted` 會被改成 `pending` 並把 attempts +1。
 * 兩個行程同時想重試同一個 key，只有一個會拿到 row（另一個的 where 已經不成立）。
 */
const SQL_RETRY_OPERATION = `
  update operations
     set state = 'pending',
         attempts = attempts + 1,
         last_error = null,
         tx_hash = null,
         user_op_hash = null,
         updated_at = now()
   where idempotency_key = $1
     and state in ('failed', 'reverted')
  returning attempts
`;

const SQL_MARK_SUBMITTED = `
  update operations
     set state = 'submitted',
         user_op_hash = coalesce($2, user_op_hash),
         tx_hash = coalesce($3, tx_hash),
         updated_at = now()
   where idempotency_key = $1
`;

const SQL_SETTLE_OPERATION = `
  update operations
     set state = $2,
         tx_hash = coalesce($3, tx_hash),
         user_op_hash = coalesce($4, user_op_hash),
         last_error = $5,
         updated_at = now()
   where idempotency_key = $1
`;

/**
 * 送出前的閘門：可以送（含 attempts）或不可以送（附原因與該記成哪一種結果）。
 *
 * 「不可以送」有兩種，混在一起會讓 CLI 摘要說謊：
 *   * `confirmed`（這一組參數早就成功了）→ **noop**：真的不需要動。
 *   * `pending`/`submitted`（結果未知）或狀態被別人改掉 → **blocked**：需要人看一眼，
 *     不是「不需要動」。
 */
type OperationGate =
  | { proceed: true; attempts: number }
  | { proceed: false; outcome: 'noop' | 'blocked'; reason: string };

/**
 * 決定這個 idempotency_key 現在能不能送。
 *
 *   * insert 成功 → 新的一列（attempts = 1），可以送。
 *   * `confirmed` → 同一個 plan 已經上鏈成功，**永不再送**。
 *   * `pending`/`submitted` → 在途或結果未知，**不重送**：結果未知時重送的代價是重複動錢。
 *   * `failed`/`reverted` → 上一次沒有成交，允許重試（CAS +1 attempts）。
 */
async function beginOperation(
  query: SchedulerQueryFn,
  args: { portfolioId: number; idempotencyKey: string; payloadHash: Hex },
): Promise<OperationGate> {
  const inserted = await query(SQL_INSERT_OPERATION, [args.portfolioId, args.idempotencyKey, args.payloadHash]);
  if (inserted.rows.length > 0) {
    return { proceed: true, attempts: toInteger((inserted.rows[0] as { attempts?: unknown }).attempts, 'operations.attempts') };
  }

  const existing = (await query(SQL_GET_OPERATION, [args.idempotencyKey])).rows[0] as
    | { state?: unknown; attempts?: unknown }
    | undefined;
  if (existing === undefined) {
    return {
      proceed: false,
      outcome: 'blocked',
      reason: `operations(${args.idempotencyKey}) 插入被略過、又查不到那一列：拒絕在狀態不明的情況下送交易`,
    };
  }
  const state = String(existing.state);
  if (state === 'confirmed') {
    return {
      proceed: false,
      outcome: 'noop',
      reason: `這組參數已經 confirmed 過（idempotency_key ${args.idempotencyKey}），不重複執行`,
    };
  }
  if (state === 'pending' || state === 'submitted') {
    return {
      proceed: false,
      outcome: 'blocked',
      reason: `這組參數的 operations 還在 ${state}（結果未知，重送等於重複動錢），這一輪不送；需要人確認那一筆的結果`,
    };
  }

  const retried = (await query(SQL_RETRY_OPERATION, [args.idempotencyKey])).rows[0] as { attempts?: unknown } | undefined;
  if (retried === undefined) {
    return {
      proceed: false,
      outcome: 'blocked',
      reason: `operations 的狀態在這一段時間內被改掉了（${state} → 不是 failed/reverted），這一輪不送`,
    };
  }
  return { proceed: true, attempts: toInteger(retried.attempts, 'operations.attempts') };
}

// ---------------------------------------------------------------------------
// live 前置檢查（§4）
// ---------------------------------------------------------------------------

/** 一項前置檢查的失敗。`code` 進結果，`detail` 給人看。 */
type PrecheckFailure = {
  code:
    | 'SESSION_KEY_NOT_INSTALLED'
    | 'SESSION_KEY_DERIVATION_MISMATCH'
    | 'SESSION_KEY_DERIVATION_FAILED'
    | 'ALLOWANCE_TOO_LOW'
    | 'INSUFFICIENT_BALANCE';
  detail: string;
};

const SQL_ACTIVE_SESSION_KEYS = `
  select k.key_ref, k.permissions, sa.owner
    from session_keys k
    join smart_accounts sa
      on sa.portfolio_id = k.portfolio_id
     and sa.chain_id = $2
   where k.portfolio_id = $1
     and k.status = 'active'
     and k.expires_at > now()
   order by (split_part(k.key_ref, '/', 6))::bigint desc
`;

/**
 * 前置檢查 a：挑一把**鏈上真的裝好了**的 session key。
 *
 * ⚠ `permissionConfig` 要讀的是 **smart account**（`planPortfolio` 的 `account`），不是 `owner`
 * ——owner 是控制帳戶的 EOA，它身上沒有這個函式。`owner` 只有在簽章時（sudo 的空帳號）才用得到。
 *
 * 一定要讀鏈：DB 的 `status='active'` 不代表鏈上裝好了（docs/pitfalls §8.11），而且本專案實測過
 * 「最新那把沒安裝、舊的那把可用」（§8.11 的 ⚠）。所以由新到舊逐把驗 `permissionConfig(pid).signer`，
 * 第一個通過的才用；全部不通過就 blocked。
 *
 * ⚠ `signer` 是 **validator 合約位址**，不是 session key 的 EOA（§8.10）：這裡只證明「這組 policy
 * 已安裝」，不證明「綁的是這把 key」。後者只有真的送一筆 op 才會知道——而那正是接下來的事。
 */
async function resolveSessionKey(
  args: { portfolioId: number; account: Address; chainId: number },
  deps: { query: SchedulerQueryFn; readPermissionConfig: NonNullable<SchedulerDeps['readPermissionConfig']> },
): Promise<SessionKeyResolution> {
  const rows = (await deps.query(SQL_ACTIVE_SESSION_KEYS, [args.portfolioId, args.chainId])).rows;
  if (rows.length === 0) {
    return { ok: false, reason: 'DB 沒有未過期的 active session key（沒有列，不是「沒安裝」）' };
  }

  const tried: string[] = [];
  const typedRows = rows as { key_ref?: unknown; permissions?: unknown; owner?: unknown }[];
  for (const row of typedRows) {
    const keyRef = typeof row.key_ref === 'string' ? row.key_ref : '';
    if (!/^m\/44'\/60'\/0'\/0\/\d+$/.test(keyRef)) {
      tried.push(`${keyRef || '(空 key_ref)'}：派生路徑格式不對`);
      continue;
    }
    const permissions = row.permissions as
      | { permissionId?: unknown; sessionKeyAddress?: unknown; timestamp?: { validUntil?: unknown } }
      | null
      | undefined;
    const permissionId = permissions?.permissionId;
    const sessionKeyAddress = permissions?.sessionKeyAddress;
    const validUntilRaw = permissions?.timestamp?.validUntil;
    if (typeof permissionId !== 'string' || !/^0x[0-9a-fA-F]{8}$/.test(permissionId)) {
      tried.push(`${keyRef}：permissions.permissionId 不是 4 bytes hex`);
      continue;
    }
    if (typeof sessionKeyAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(sessionKeyAddress)) {
      tried.push(`${keyRef}：permissions.sessionKeyAddress 不是地址`);
      continue;
    }
    const validUntil = Number(validUntilRaw);
    if (!Number.isInteger(validUntil)) {
      tried.push(`${keyRef}：permissions.timestamp.validUntil 不是整數`);
      continue;
    }

    const owner = asAddress(row.owner, 'smart_accounts.owner');
    const installed = await deps.readPermissionConfig({
      account: args.account,
      permissionId: permissionId as Hex,
    });
    const zeroSigner = installed.signer === '0x0000000000000000000000000000000000000000';
    if (zeroSigner || installed.policyCount !== EXPECTED_POLICY_COUNT) {
      tried.push(`${keyRef}(${permissionId})：signer=${installed.signer} policies=${installed.policyCount}（要 ${EXPECTED_POLICY_COUNT}）`);
      continue;
    }

    return {
      ok: true,
      key: {
        keyRef: keyRef as `m/44'/60'/${string}`,
        permissionId: permissionId as Hex,
        sessionKeyAddress: sessionKeyAddress.toLowerCase() as Address,
        validUntil,
        owner,
      },
    };
  }

  return {
    ok: false,
    reason: `DB 有 ${rows.length} 把 active session key，但鏈上沒有一把安裝完整：${tried.join('；')}`,
  };
}

/**
 * 前置檢查 a2：DB 記的 `sessionKeyAddress` 必須等於 `master seed + key_ref` 派生出的 EOA。
 *
 * 為什麼要搬到這裡（而不是留給送出時的三方對帳）：送出時的對帳發生在 `beginOperation` **之後**，
 * 所以一個打錯的 seed 會被記成 `operations(state=failed, attempts=1)` —— 語意是「試過了但失敗」，
 * 而真相是「**根本沒試**」。連續 `--loop` 就會每輪燒一次 attempt，而且監控上再也分不出「設定錯誤」
 * 與「這一筆失敗」。派生是純本機運算，所以在 blocked 階段驗得到，一列 `operations` 都不必寫。
 *
 * ⚠ 只對**已經選定的那把**驗（呼叫端在 `resolveSessionKey` 成功之後才呼叫）。對每一把都派生會把
 * 真正可用的那把也擋掉：由新到舊逐把驗的是「這一組 policy 在鏈上裝好了沒」，而 seed 只會派生得出
 * 其中一把，其他把本來就不會相符。
 */
async function checkSessionKeyDerivation(
  key: SessionKeyRef,
  derive: NonNullable<SchedulerDeps['deriveSessionKeyAddress']>,
): Promise<PrecheckFailure | null> {
  let derived: Address;
  try {
    derived = await derive(key.keyRef);
  } catch (error) {
    return {
      code: 'SESSION_KEY_DERIVATION_FAILED',
      detail:
        `用 SESSION_KEY_MASTER_SEED 派生 ${key.keyRef} 失敗（seed 沒設／不是 0x + 64 hex）：${oneLine(error)}` +
        `——這是設定問題，不是「這一輪試過了」`,
    };
  }
  if (!isAddressEqual(derived, key.sessionKeyAddress)) {
    return {
      code: 'SESSION_KEY_DERIVATION_MISMATCH',
      detail:
        `seed + ${key.keyRef} 派生得 ${derived}，DB 記的 session key 是 ${key.sessionKeyAddress}` +
        `（seed 打錯／換了 KMS／複製貼上少一個字元）：簽章一定不過，這一輪不送`,
    };
  }
  return null;
}

/**
 * 前置檢查 a + a2 + b + c：對**每一個 step** 檢查 allowance 與餘額（amountIn 是原幣單位）。
 *
 * ⚠ 呼叫端有**兩個**（live 與 dry-run），而且順序在 `beginOperation` 之前就固定了（檔頭 ③-bis）：
 * dry-run 的 `ready` 只有在這四條全過之後才會出現。要搬動這個呼叫，先讀檔頭 ③-bis。
 */
async function runPrechecks(
  args: {
    portfolioId: number;
    account: Address;
    executor: Address;
    steps: readonly PlannedStep[];
    chainId: number;
  },
  deps: {
    query: SchedulerQueryFn;
    readPermissionConfig: NonNullable<SchedulerDeps['readPermissionConfig']>;
    deriveSessionKeyAddress: NonNullable<SchedulerDeps['deriveSessionKeyAddress']>;
    readAllowance: NonNullable<SchedulerDeps['readAllowance']>;
    readBalance: NonNullable<SchedulerDeps['readBalance']>;
  },
): Promise<{ failures: PrecheckFailure[]; sessionKey: SessionKeyRef | null }> {
  const resolution = await resolveSessionKey(
    { portfolioId: args.portfolioId, account: args.account, chainId: args.chainId },
    { query: deps.query, readPermissionConfig: deps.readPermissionConfig },
  );
  if (!resolution.ok) {
    return { failures: [{ code: 'SESSION_KEY_NOT_INSTALLED', detail: resolution.reason }], sessionKey: null };
  }

  // 前置檢查 a2：seed 派生不出 DB 記的那把 → blocked（**不是** failed），operations 一列都不寫。
  const derivationFailure = await checkSessionKeyDerivation(resolution.key, deps.deriveSessionKeyAddress);
  if (derivationFailure !== null) return { failures: [derivationFailure], sessionKey: null };

  const failures: PrecheckFailure[] = [];
  for (const [index, step] of args.steps.entries()) {
    const allowance = await deps.readAllowance({ token: step.tokenIn, owner: args.account, spender: args.executor });
    if (allowance < step.amountIn) {
      failures.push({
        code: 'ALLOWANCE_TOO_LOW',
        detail:
          `step#${index} allowance(${args.account} → executor ${args.executor}, token ${step.tokenIn}) = ${allowance} ` +
          `< amountIn ${step.amountIn}：執行器的 safeTransferFrom 一定 revert`,
      });
    }
    const balance = await deps.readBalance({ token: step.tokenIn, owner: args.account });
    if (balance < step.amountIn) {
      failures.push({
        code: 'INSUFFICIENT_BALANCE',
        detail: `step#${index} balanceOf(${step.tokenIn}, ${args.account}) = ${balance} < amountIn ${step.amountIn}`,
      });
    }
  }
  return { failures, sessionKey: resolution.key };
}

// ---------------------------------------------------------------------------
// live 送出（預設實作；本工單不實際執行）
// ---------------------------------------------------------------------------

/**
 * 用 session key 簽一筆 `executeRebalance` 並送 alto。
 *
 * 這一段是 `backend/scripts/execute-rebalance.ts`（已實測成功換幣）的同一條路，搬進 src 是為了
 * 讓排程器的 live 路徑**也被 typecheck 覆蓋**。三個步驟與那支腳本逐項相同：
 *   ① 由 DB 的 `key_ref` 用 master seed 派生金鑰，三方對帳（派生器 / 腳本 / DB）一致才用；
 *   ② 用同一組 `validUntil` 重建權限，permissionId 必須與 DB 相同（不同就是 policy 參數變了）；
 *   ③ 帳戶的 sudo 只給 owner 的**空帳號**（本行程沒有 owner 的私鑰），真正簽章的是 regular
 *      （permission validator）——那正是「keeper 用 session key 執行」的意思。
 *
 * 送出前後各有一道防線，兩道都對應 `docs/pitfalls` §8.16 的實測：
 *   * **送出前**：`callGasLimit` 明確覆寫成 `max(估算 × 1.5, 600,000)`，再用 `eth_call`
 *     以 `gas = 那個值` 模擬一次執行。不通過就不簽名 —— 不花錢買 `success = false`。
 *   * **送出後**：`judgeRebalanceOutcome` 三層判定。`tx.status == 1` 單獨不足以叫成功。
 */
async function sendRebalanceWithSessionKey(args: ExecuteArgs): Promise<ExecutionOutcome> {
  const { masterSeed } = requireSessionKeyConfig();
  const publicClient = defaultPublicClient();
  // 簽 UserOp 用的鏈物件必須與 RPC 的 chainId 一致（userOpHash 含 chainId）。
  const network = activeChain();

  const keyAccount = hdKeyToAccount(HDKey.fromMasterSeed(hexToBytes(masterSeed)), { path: args.sessionKey.keyRef });
  if (!isAddressEqual(keyAccount.address, args.sessionKey.sessionKeyAddress)) {
    throw new Error(
      `派生不一致：seed + ${args.sessionKey.keyRef} 得到 ${keyAccount.address}，` +
        `DB 記的 session key 是 ${args.sessionKey.sessionKeyAddress}`,
    );
  }

  const permissions = await buildSessionPermissions({
    publicClient,
    sessionKeyAddress: keyAccount.address,
    executorAddress: args.executor,
    validUntil: args.sessionKey.validUntil,
    signer: await toECDSASigner({ signer: keyAccount }),
  });
  if (permissions.permissionId.toLowerCase() !== args.sessionKey.permissionId.toLowerCase()) {
    throw new Error(
      `permissionId 不符：重建 ${permissions.permissionId} != DB ${args.sessionKey.permissionId}` +
        `（validUntil 或 policy 參數變了）`,
    );
  }

  const kernelVersion: GetKernelVersion<'0.7'> = KERNEL_V3_3;
  const account = await createKernelAccount(publicClient, {
    address: args.account,
    plugins: {
      sudo: await signerToEcdsaValidator(publicClient, {
        signer: addressToEmptyAccount(args.sessionKey.owner),
        entryPoint: ENTRY_POINT,
        kernelVersion,
      }),
      regular: permissions.permissionValidator,
    },
    entryPoint: ENTRY_POINT,
    kernelVersion,
    useMetaFactory: true,
  });
  if (!isAddressEqual(account.address, args.account)) {
    throw new Error(`帳戶地址不符：算出 ${account.address} != 已部署 ${args.account}`);
  }

  const data = encodeFunctionData({
    abi: EXECUTOR_ABI,
    functionName: 'executeRebalance',
    args: [
      args.account,
      args.steps.map((step) => ({
        tokenIn: step.tokenIn,
        tokenOut: step.tokenOut,
        amountIn: step.amountIn,
        amountOutMin: step.amountOutMin,
        commands: step.commands,
        inputs: step.inputs,
      })),
      args.deadline,
    ],
  });
  if (data.slice(0, 10) !== EXECUTE_REBALANCE_SELECTOR) {
    throw new Error(`selector 不符：${data.slice(0, 10)} != ${EXECUTE_REBALANCE_SELECTOR}（CallPolicy 會擋下）`);
  }

  const client = createKernelAccountClient({
    account,
    chain: network,
    client: publicClient,
    bundlerTransport: http(bundlerUrl()),
    // alto 不提供 ZeroDev 的 zd_getUserOperationGasPrice，用節點 gas price。
    userOperation: {
      estimateFeesPerGas: async () => {
        const gasPrice = await publicClient.getGasPrice();
        return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice };
      },
    },
  });

  const calls = [{ to: args.executor, data, value: 0n }] as const;

  // ---- ① gas：`callGasLimit` 明確覆寫，不讓 alto 的估算單獨決定 ---------------------------------
  // alto 對「一筆 op 跑完整條 DeFi 路徑」系統性低估（§8.16 實測 367,885 vs 需要 450–500k），
  // 而 gas 不足的後果不是 revert，是「success = false 但 tx.status = 1」—— 錢扣了、幣沒換。
  const estimate = await client.estimateUserOperationGas({ calls });
  const callGasLimit = rebalanceCallGasLimit(estimate.callGasLimit);

  // ---- ② 簽名前用 eth_call 模擬整格執行 ---------------------------------------------------------
  // `executeRebalance` 的第一個檢查是 `msg.sender != account → NotAccount`，所以 `from = 帳戶` 的
  // `eth_call` 走的是**真正的那條路**（帳戶本身就是 UserOp 執行時的呼叫者），不需要 state override，
  // 也不需要先 simulateValidation。gas 給的**正是等一下要簽的 callGasLimit**，所以它能抓到的就是
  // 「這個值不夠」本身，而不是一個寬鬆的「有沒有 revert」。
  //
  // 抓到什麼：執行必定失敗的原因（地板、註冊狀態、allowance、UniversalRouter 的命令/參數）＋ 粗的
  // gas 不足（需求 > callGasLimit）。抓不到什麼：比 63/64 內層保留額更小的邊緣 gas 不足，以及
  // **驗證階段**的問題（session key 的權限、nonce、prefund）—— 那些發生在 EntryPoint 那一層，
  // 這裡的 `eth_call` 沒有經過 EntryPoint，alto 的 simulation 才會擋。兩者是互補的檢查。
  try {
    await publicClient.call({ account: args.account, to: args.executor, data, gas: callGasLimit });
  } catch (error) {
    throw new Error(
      `送出前的 eth_call 模擬失敗（from ${args.account}、gas ${callGasLimit}）：這一筆不送，` +
        `不花錢買一個 success=false 的 op。原因：${errorMessage(error)}`,
    );
  }

  // 只覆寫 `callGasLimit`：其餘欄位（verificationGasLimit / preVerificationGas）仍由 alto 估算，
  // 它們與「執行路徑有多長」無關。
  const userOpHash = await client.sendUserOperation({ calls, callGasLimit });
  // alto 有 simulation：被拒的 op **不會**回 userOpHash。所以拿到 hash = 這一筆被接受了。
  await args.onSubmitted({ userOpHash });

  const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash, timeout: USER_OP_RECEIPT_TIMEOUT_MS });

  // ---- ③ 三層判定（§8.16）：只驗 receipt.status 就是把「上鏈但什麼都沒換」記成成功 -----------------
  return judgeRebalanceOutcome({
    txStatus: receipt.receipt.status,
    userOpSuccess: typeof receipt.success === 'boolean' ? receipt.success : null,
    swapExecuted: countSwapExecuted(receipt.receipt.logs, args.executor),
    expectedSwaps: args.steps.length,
    txHash: receipt.receipt.transactionHash,
    userOpHash,
    gasUsed: (receipt.actualGasUsed ?? receipt.receipt.gasUsed).toString(),
  });
}

// ---------------------------------------------------------------------------
// 一輪的執行
// ---------------------------------------------------------------------------

let cachedPublicClient: PublicClient | null = null;

function defaultPublicClient(): PublicClient {
  if (cachedPublicClient !== null) return cachedPublicClient;
  const { rpcUrl } = getConfig();
  // config.ts 已經把空字串（`RPC_URL=""`）收成 null：空字串不是「沒設」，`http('')` 會靜默打到別的
  // 節點（docs/pitfalls §8.12）。所以這裡 null 就是真的沒設，直接帶著變數名失敗。
  if (rpcUrl === null) {
    throw new Error('chain 未設定：排程器要讀鏈（RPC_URL 是空的——空字串等於沒設，見 docs/pitfalls §8.12）');
  }
  cachedPublicClient = createPublicClient({ chain: activeChain(), transport: http(rpcUrl) });
  return cachedPublicClient;
}

function executorAddress(): Address {
  const { executorAddress: executor } = getSessionKeyConfig();
  if (executor === null) {
    throw new Error(
      '未設定 EXECUTOR_ADDRESS：它是 AtpExecutor 的地址（planRebalance 的 recipient、allowance 的 spender），' +
        '排程器沒有它就算不出要送什麼',
    );
  }
  return executor;
}

function registryAddress(): Address {
  const { registryAddress: registry } = getConfig();
  if (registry === null) throw new Error('chain 未設定：REGISTRY_ADDRESS 是排程器讀 enrollment 的必要條件');
  return registry as Address;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function bundlerUrl(): string {
  return firstNonEmpty(process.env.BUNDLER_URL) ?? 'http://127.0.0.1:3001';
}

const defaultWithTransaction: WithTransactionFn = (fn) =>
  withTransaction((client) => fn({ query: (text, params) => client.query(text, params === undefined ? [] : [...params]) }));

function defaultQuery(): SchedulerQueryFn {
  return (text, params) => dbQuery(text, params ?? []);
}

function oneLine(error: unknown): string {
  return errorMessage(error).split('\n')[0]!.slice(0, 400);
}

/** 把 run 的參數與外部注入的 deps 合成一組完整可用的依賴（缺的就補預設實作）。 */
function resolveDeps(args: { thresholdBps: number }, provided: SchedulerDeps) {
  const query = provided.query ?? defaultQuery();
  const chainId = provided.chainId ?? getConfig().chainId;
  const deadlineSeconds = DEFAULT_DEADLINE_SECONDS;

  return {
    query,
    chainId,
    /**
     * null = 還沒解析；`decideAndMaybeExecute` 在**兩條路**上都會 `?? executorAddress()`
     * （dry-run 的前置檢查 b 也要 spender，見檔頭 ③-bis）。
     */
    executor: provided.executor ?? null,
    withTransaction: provided.withTransaction ?? defaultWithTransaction,
    log: provided.log ?? ((line: string) => console.log(line)),
    /** 稽核快照的writer。可注入，所以排程器測試不必真的寫 DB。 */
    writeSnapshot: provided.writeSnapshot ?? writeSnapshotImpl,
    planPortfolio:
      provided.planPortfolio ??
      ((portfolioId: number) =>
        planPortfolio(portfolioId, {
          publicClient: defaultPublicClient(),
          registryAddress: registryAddress(),
          thresholdBps: args.thresholdBps,
        })),
    planRebalance:
      provided.planRebalance ??
      (async ({ account, plan }: RebalancePlanningInput) => {
        const publicClient = defaultPublicClient();
        const executor = executorAddress();
        const oracle = await publicClient.readContract({
          address: executor,
          abi: EXECUTOR_ABI,
          functionName: 'oracle',
        });
        if (plan.report === null) {
          // 呼叫端已經擋掉這一種；留著是為了不讓一個 null report 靜默變成「不需要再平衡」。
          throw new Error('planPortfolio 沒有漂移報告（blocked）：不該進到規劃器');
        }
        return planRebalance({
          publicClient,
          account,
          executor,
          oracle,
          registry: registryAddress(),
          strategyId: BigInt(plan.pinnedVersion.onchainStrategyId),
          holdings: plan.snapshot.holdings,
          targets: plan.targets,
          drift: plan.report,
          thresholdBps: plan.thresholdBps,
          blockNumber: plan.snapshot.block,
          deadlineSeconds,
        });
      }),
    readPermissionConfig:
      provided.readPermissionConfig ??
      (async ({ account, permissionId }: { account: Address; permissionId: Hex }) => {
        const config = await defaultPublicClient().readContract({
          address: account,
          abi: KERNEL_PERMISSION_ABI,
          functionName: 'permissionConfig',
          args: [permissionId],
        });
        return { signer: config.signer, policyCount: config.policyData.length };
      }),
    /**
     * 前置檢查 a2 的預設實作：本機派生（一次鏈上讀取都沒有）。與 `sendRebalanceWithSessionKey`
     * 用的是同一條 `HDKey.fromMasterSeed → hdKeyToAccount`，所以「這裡通過了、送出時卻不符」不可能
     * 發生在 seed 上。seed 沒設時 `requireSessionKeyConfig()` 會拋錯，由 `runPrechecks` 收成
     * `SESSION_KEY_DERIVATION_FAILED`（blocked），而不是等到送出才變成 failed。
     */
    deriveSessionKeyAddress:
      provided.deriveSessionKeyAddress ??
      (async (keyRef: SessionKeyRef['keyRef']) => {
        const { masterSeed } = requireSessionKeyConfig();
        return hdKeyToAccount(HDKey.fromMasterSeed(hexToBytes(masterSeed)), { path: keyRef }).address;
      }),
    /**
     * 送出前重問地板的預設實作：`executor.oracle()` 給報價來源、`registry.effectiveFeeBps` 給
     * `minGross` 的倍率（與 `AtpExecutor._checkStep` 用的是同一個值），再交給 `refreshFloors`。
     *
     * 任何一步讀不到就回 `{ ok: false }` 而不是拋錯：呼叫端要把這件事記成「這一輪不送」，不是讓整輪炸掉。
     * 注意這裡用的是 `registryAddress()`（不是 enrollment 的 strategyId 以外的東西）：合約在執行時
     * 問的就是這個 registry。
     */
    refreshFloors:
      provided.refreshFloors ??
      (async ({ steps, strategyId, executor }: FloorRefreshInput) => {
        try {
          const publicClient = defaultPublicClient();
          const [oracle, feeBpsRaw] = await Promise.all([
            publicClient.readContract({ address: executor, abi: EXECUTOR_ABI, functionName: 'oracle' }),
            publicClient.readContract({
              address: registryAddress(),
              abi: REGISTRY_ABI,
              functionName: 'effectiveFeeBps',
              args: [strategyId],
            }),
          ]);
          return await refreshFloors({ publicClient, oracle, steps, feeBps: Number(feeBpsRaw) });
        } catch (error) {
          return {
            ok: false,
            kind: 'quote-failed',
            reason:
              `送出前重問地板的前提讀取失敗（executor.oracle() / registry.effectiveFeeBps(${strategyId})）：` +
              `${oneLine(error)}——沒有新鮮的地板就不送`,
          };
        }
      }),
    readAllowance:
      provided.readAllowance ??
      (async ({ token, owner, spender }: Erc20Args) => {
        if (spender === undefined) throw new Error('readAllowance 需要 spender（executor）');
        return defaultPublicClient().readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [owner, spender],
        });
      }),
    readBalance:
      provided.readBalance ??
      (({ token, owner }: Erc20Args) =>
        defaultPublicClient().readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] })),
    executeRebalance: provided.executeRebalance ?? sendRebalanceWithSessionKey,
  };
}

/**
 * 跑一輪排程器。
 *
 * 順序（每個被認領的 portfolio）：
 *   ① 排程不支援（cron／缺排程）→ blocked，不讀鏈。
 *   ①-bis 帳戶型別不是 `KERNEL`（例如 EOA）→ blocked，不讀鏈（**dry-run 也擋**：它永遠不可能成功）。
 *   ② `planPortfolio` → blocked 非空／沒有報告／鏈上 enrollment paused → blocked，不執行。
 *   ③ `needsRebalance === false` → noop。
 *   ④ `planRebalance` → noop / blocked / ready（ready 但 steps 空的視為 blocked：空 steps 在鏈上會
 *      「成功」而什麼都沒換，docs/pitfalls §8.1）。
 *   ⑤ ready：前置檢查（型別／安裝／派生／allowance／餘額，§4）→ `dryRun` 只記錄
 *      （`ready-dry-run`：不寫 operations、不推進 `next_run_at`、不呼叫執行路徑）；
 *      `dryRun: false` → operations 閘門 → 送出。前置檢查**兩條路都跑**（檔頭 ③-bis），
 *      所以 `ready-dry-run` 的語意是「live 時不會被前置檢查擋下」，不是「算得出參數」。
 *   ⑥ 不論結果，更新 `last_checked_at`；只有真的成功才更新 `last_rebalance_at`。
 *
 * `dryRun` 也決定**認領要不要推進 `next_run_at`**：dry-run 只讀不寫（見 `claimDuePortfolios`）。
 */
export async function runSchedulerOnce(
  args: RunSchedulerArgs,
  deps: SchedulerDeps = {},
): Promise<SchedulerRound> {
  // 預設 dry run：省略 dryRun 就是「只算不做」。要送交易只有明確傳 false 這一條路。
  const dryRun = args.dryRun ?? true;
  const now = args.now ?? new Date();
  const limit = assertLimit(args.limit ?? DEFAULT_ROUND_LIMIT);
  const thresholdBps = args.thresholdBps ?? DEFAULT_THRESHOLD_BPS;
  const resolved = resolveDeps({ thresholdBps }, deps);

  const claimed = await claimDuePortfolios(limit, now, {
    withTransaction: resolved.withTransaction,
    chainId: resolved.chainId,
    // live 一定要推進（認領即推進 = 防重複執行的關鍵）；dry-run 只讀不寫，連 UPDATE 都不發。
    advance: !dryRun,
  });

  const results: PortfolioRunResult[] = [];
  for (const due of claimed) {
    // `forcePlan` 要一路傳到 runOne：它決定「漂移低於門檻時要不要照樣規劃」（redeem 用）。
    const result = await runOne(due, { dryRun, now, thresholdBps, deps: resolved, forcePlan: deps.forcePlan === true });
    results.push(result);
    resolved.log(formatResult(result, dryRun));
  }

  // ---- 一輪的尾端：告警（偵測 → 寫入 → 解除 → 一行 stdout）----
  // 只加在這裡：認領、前置檢查、間隔推進的邏輯一個字都沒動。
  await announceAlerts({ query: resolved.query, log: resolved.log, now });

  return { claimed: claimed.length, dryRun, results };
}

/**
 * 尾端的告警：`detectAlerts` → `recordAlerts` → `resolveAlerts` → 每個警示印一行。
 *
 * ⚠ 整段包在 try/catch：**告警是輔助，不是主要流程**。偵測失敗（migration 沒跑、SQL 打錯、DB 抖
 * 一下）只印一行 `[ALERT] 偵測失敗：…` 就繼續。這一輪的再平衡**已經執行完了**，讓整輪因為一個觀測
 * 用的查詢而失敗，看起來會像「交易沒成」—— 那比沒有告警更糟。
 *
 * dry-run 也跑：它不送交易、不推進 `next_run_at`、不寫 `operations`，而告警只寫 `scheduler_alerts`
 * 這一張「只關於觀測」的表。反過來說，若 dry-run 不寫，`--once`（預設 dry-run）就永遠看不到問題
 * 累積，而「無人值守」正是靠這個累積被看見。
 */
export async function announceAlerts(args: {
  query: SchedulerQueryFn;
  log: (line: string) => void;
  now: Date;
}): Promise<void> {
  try {
    const findings = await detectAlerts(args.query, { now: args.now });
    await recordAlerts(args.query, findings, args.now);
    const resolved = await resolveAlerts(args.query, findings, args.now);

    if (findings.length === 0) {
      args.log(`[ALERT] 沒有警示${resolved > 0 ? `（已解除 ${resolved} 筆）` : ''}`);
      return;
    }
    for (const finding of findings) args.log(formatAlert(finding));
    if (resolved > 0) args.log(`[ALERT] 已解除 ${resolved} 筆（條件消失）`);
  } catch (error) {
    args.log(`[ALERT] 偵測失敗：${oneLine(error)}`);
  }
}

type ResolvedDeps = ReturnType<typeof resolveDeps>;

async function runOne(
  due: DuePortfolio,
  ctx: { dryRun: boolean; now: Date; thresholdBps: number; deps: ResolvedDeps; forcePlan?: boolean },
): Promise<PortfolioRunResult> {
  const base = {
    portfolioId: due.portfolioId,
    strategyId: due.strategyId,
    account: due.account,
    nextRunAt: due.nextRunAt,
    plan: null,
    execution: null,
    partial: null,
  };

  let result: PortfolioRunResult;
  try {
    result = await decideAndMaybeExecute(due, ctx, base);
  } catch (error) {
    // 一個 portfolio 的例外不該讓整輪停擺（RPC 抖動、某個帳戶的資料不一致）。它會被記成 blocked
    // 並在下一輪重試；next_run_at 已經推進過了，所以不會變成熱迴圈。
    result = { ...base, outcome: 'blocked', reason: `處理時拋錯，這一輪不執行：${oneLine(error)}` };
  }

  // ---- 部分執行 → 把 next_run_at 拉近（只拉近，不延後；只在真的做了一部分之後）----
  // 認領時已經在**同一個 transaction 內**寫入完整間隔（那個語意不動，crash 時留在完整間隔＝
  // 不會變成熱迴圈）。這裡是在結果已知之後把它**提前**，屬於同一條推進路上的第二段。
  //
  // ⚠ 只有**算得出**執行後漂移時才提前。`remainingDriftBps === null` 代表「算不出來」（這一輪買進
  // 帳戶沒持有的資產，到手量沒有價格可估）—— 拿一個算不出來的缺口去排一輪 1800s 後的執行，
  // 等於用猜的調度。實際發生過：6600 → 6 bps 收斂的一輪，卻被排成「還在 6600，30 分鐘後再來」。
  if (!ctx.dryRun && result.outcome === 'executed' && result.partial !== null) {
    if (result.partial.remainingDriftBps === null) {
      result = {
        ...result,
        reason:
          `${result.reason}；Partial execution: the drift after this round cannot be estimated yet ` +
          '(it buys assets the portfolio did not hold, so the received amount has no price to value it). ' +
          'Kept the full interval; the next round will measure it.',
      };
    } else {
    const followUpSeconds = Math.min(due.intervalSeconds, PARTIAL_FOLLOW_UP_SECONDS);
    const followUpAt = new Date(ctx.now.getTime() + followUpSeconds * 1_000);
    if (followUpAt.getTime() < result.nextRunAt.getTime()) {
      const note =
        `Partial execution: estimated drift is still ${result.partial.remainingDriftBps} bps after this round` +
        ` (${result.partial.shrunk.length === 0 ? 'the gap was skipped rather than shrunk' : `${result.partial.shrunk.length} step(s) were shrunk by the impact budget`});` +
        ` next_run_at moved up to ${followUpAt.toISOString()} (${followUpSeconds}s, full interval is ${due.intervalSeconds}s)`;
      try {
        await ctx.deps.query(SQL_ADVANCE_CLAIMED, [[due.portfolioId], [followUpAt.toISOString()]]);
        result = { ...result, nextRunAt: followUpAt, reason: `${result.reason}；${note}` };
      } catch (error) {
        // 寫不進去不代表這一輪白做：留在完整間隔，下一輪照排程跑，只是收斂慢一點。
        result = { ...result, reason: `${result.reason}；${note}（但寫回失敗：${oneLine(error)}）` };
      }
    }
    }
  }

  try {
    await ctx.deps.query(SQL_MARK_CHECKED, [due.portfolioId, ctx.now.toISOString(), result.outcome === 'executed']);
  } catch (error) {
    ctx.deps.log(`[scheduler] portfolio ${due.portfolioId} 的 last_checked_at 寫不進去：${oneLine(error)}`);
  }
  return result;
}

async function decideAndMaybeExecute(
  due: DuePortfolio,
  ctx: { dryRun: boolean; now: Date; thresholdBps: number; deps: ResolvedDeps; forcePlan?: boolean },
  base: Omit<PortfolioRunResult, 'outcome' | 'reason'>,
): Promise<PortfolioRunResult> {
  if (due.unsupportedReason !== null) {
    return { ...base, outcome: 'blocked', reason: `排程不支援，不執行：${due.unsupportedReason}` };
  }

  // 帳戶型別：只有 KERNEL 能被 session key 簽 UserOp。EOA（帳戶就是 owner 本人）身上沒有
  // permission validator、`session_keys` 也不會有它的列，所以它**永遠不可能**成功 —— 這種
  // portfolio 在 dry-run 顯示 `ready` 會讓「看 ready 的數量判斷健康度」得到錯的結論，所以
  // dry-run **也**走這一條（而且擋在 planPortfolio 之前：不浪費一次讀鏈）。
  if (due.accountType !== 'KERNEL') {
    return {
      ...base,
      outcome: 'blocked',
      reason:
        `[ACCOUNT_NOT_KERNEL] smart_accounts.account_type = ${due.accountType}，只有 KERNEL 可以：` +
        `EOA 帳戶本身就是 owner，沒有 session key 的 permission validator，無法用 session key 簽 UserOp`,
    };
  }

  const plan = await ctx.deps.planPortfolio(due.portfolioId);

  // 把「鏈上釘住的版本」同步回 DB。
  //
  // 為什麼需要：`portfolios.version` 是 enrollment 當下寫的，但 owner 可以在鏈上
  // 重新 `registry.enroll` 換版本（我們就手動把 portfolio 1 從 v1 換到 v2 過）。
  // 那時 DB 不會知道，於是 operator 頁顯示 `v1`、鏈上其實是 `v2` —— 實測就發生過。
  //
  // 規劃器讀的是**鏈上**版本（`snapshot.ts` 的 `enrollment[1]`），所以行為一直正確，
  // 錯的只是標籤。這裡把它們對齊，讓「畫面上寫的」與「實際在跑的」一致。
  //
  // 失敗不影響這一輪：版本標籤不是交易的前置條件。
  try {
    await ctx.deps.query('update portfolios set version = $1 where id = $2 and version <> $1', [
      plan.pinnedVersion.version,
      due.portfolioId,
    ]);
  } catch (error) {
    ctx.deps.log(`[scheduler] portfolio ${due.portfolioId} 的 version 同步失敗：${oneLine(error)}`);
  }

  if (plan.blocked.length > 0) {
    return {
      ...base,
      outcome: 'blocked',
      reason: `planPortfolio 擋下（不執行）：${plan.blocked.map((block) => `[${block.code}] ${block.detail}`).join('；')}`,
    };
  }
  if (plan.pinnedVersion.paused) {
    // 鏈上 enrollment 是 paused：executor 會 revert `Paused()`，這一筆一定失敗。
    return { ...base, outcome: 'blocked', reason: '鏈上 enrollment 是 paused：executor 會 revert，這一輪不送' };
  }
  if (plan.report === null) {
    return { ...base, outcome: 'blocked', reason: 'planPortfolio 沒有漂移報告，也沒有 blocked 原因：拒絕在不明狀態下執行' };
  }
  // `forcePlan`：呼叫端要用**同一條送出管線**做別的事（例如 redeem 按比例賣成 numeraire）。
  // 那種動作不會讓漂移變大，所以「不需要再平衡」不代表「什麼都不用做」。
  if (!plan.report.needsRebalance && ctx.forcePlan !== true) {
    return {
      ...base,
      outcome: 'noop',
      reason:
        `Drift ${plan.report.grossDriftBps} bps is below the ${plan.report.thresholdBps} bps threshold ` +
        `(largest single delta ${plan.report.maxAbsDeltaBps} bps); nothing to rebalance`,
    };
  }

  const rebalance = await ctx.deps.planRebalance({ portfolioId: due.portfolioId, account: due.account, plan });
  if (rebalance.kind === 'noop') {
    return { ...base, outcome: 'noop', reason: `Planner returned noop: ${rebalance.reason}` };
  }
  if (rebalance.kind === 'blocked') {
    return { ...base, outcome: 'blocked', reason: `規劃器擋下（不執行）：${rebalance.reason}` };
  }
  if (rebalance.steps.length === 0) {
    // planRebalance 的型別結構保證非空；這一條是給「未來有人改了那份保證」的防線。
    // 空 steps 的 executeRebalance 在鏈上**正常返回、什麼都不換**（docs/pitfalls §8.1），所以它必須 blocked。
    return {
      ...base,
      outcome: 'blocked',
      reason:
        'Planner returned ready but the steps are empty: empty steps "succeed" on-chain while swapping nothing, so nothing is sent',
    };
  }

  // ---- ⑤ 送出前重問地板：`rebalance.steps` 的 `amountOutMin` 是**規劃當時**的地板 --------------
  // `planRebalance` 在 `plan.snapshot.block` 那一塊問到 `minimum`，然後我們簽名送出；合約在**執行**
  // 那一塊會自己再問一次（`AtpExecutor._checkStep`），而 oracle 的 `minimum` 含近 5 分鐘均值 ——
  // 它會追著池價跑。所以凍結的規劃值在 plan → sign 的幾十秒裡就可能低於當下的地板 → `BelowFloor`。
  // 這裡用**新鮮值**覆寫（不是 `max(規劃, 新鮮)`：理由見 `refreshFloors` 的檔頭）。
  //
  // 呼叫點放在 `planHashFor` **之前**是刻意的：`planHash`（＝ `operations.payload_hash`，
  // 也是 `idempotency_key` 的一部分）涵蓋 `amountOutMin`，所以它必須描述**真的會上鏈**的那組參數。
  const executor = ctx.deps.executor ?? executorAddress();
  const refresh = await ctx.deps.refreshFloors({
    steps: rebalance.steps,
    strategyId: BigInt(plan.pinnedVersion.onchainStrategyId),
    executor,
  });
  if (!refresh.ok) {
    ctx.deps.log(`[scheduler] portfolio ${due.portfolioId} 送出前重問地板失敗（${refresh.kind}）：${refresh.reason}`);
    return {
      ...base,
      // 問不到地板＝不知道現在的下限 → `blocked`（一筆都沒送，不是「試過了失敗」）；
      // 地板崩掉＝市場狀態，不是設定錯 → `noop`（下一輪用新價格重新規劃）。
      outcome: refresh.kind === 'floor-collapsed' ? 'noop' : 'blocked',
      reason: refresh.reason,
    };
  }
  const steps = refresh.steps;
  ctx.deps.log(`[scheduler] portfolio ${due.portfolioId} 送出前重問地板：${refresh.note}`);

  const planHash = planHashFor(steps, rebalance.deadline);
  const idempotencyKey = idempotencyKeyFor(due.portfolioId, planHash);
  const summary: PlannedSummary = {
    steps: steps.map((step) => ({
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      amountIn: step.amountIn.toString(),
      amountOutMin: step.amountOutMin.toString(),
    })),
    deadline: rebalance.deadline.toString(),
    planHash,
    idempotencyKey,
    rationale: rebalance.rationale,
  };
  const withPlan = { ...base, plan: summary, partial: rebalance.partial ?? null };

  // 前置檢查（§4）一定在 `beginOperation` 之前：擋下來的 portfolio 一列 `operations` 都不該寫
  // （寫了語意就是「試過了但失敗」，而真相是「根本沒試」）。
  //
  // ⚠ 這裡是 dry-run 與 live 的**共同**路段（檔頭 ③-bis）：把 dry-run 的 return 擺在這一段之前，
  // 就是「KERNEL 但 active session_keys = 0」「allowance 早就被用掉」那一整類 portfolio 在監控
  // 輸出裡仍然顯示 `ready` 的原因。`ready` 要回答「現在 `--live` 會成功嗎」，所以兩條路都驗。
  //
  // 位置選在 planRebalance 之後而不是 planPortfolio 之前，是因為 b/c 需要 `steps`；而 a/a2 擺在
  // 這裡也剛好不多讀一次鏈——一個 `noop`（漂移未達門檻）的 portfolio 根本不需要 session key。
  // （`executor` 在上面「重問地板」那一段就解析好了：地板要靠 `executor.oracle()` 才問得到。）
  const prechecks = await runPrechecks(
    {
      portfolioId: due.portfolioId,
      account: due.account,
      executor,
      steps,
      chainId: ctx.deps.chainId,
    },
    {
      query: ctx.deps.query,
      readPermissionConfig: ctx.deps.readPermissionConfig,
      deriveSessionKeyAddress: ctx.deps.deriveSessionKeyAddress,
      readAllowance: ctx.deps.readAllowance,
      readBalance: ctx.deps.readBalance,
    },
  );
  if (prechecks.failures.length > 0) {
    return {
      ...withPlan,
      outcome: 'blocked',
      reason:
        (ctx.dryRun
          ? 'Pre-checks failed (dry-run blocks it too: `--live` would not send either, so this is not reported as ready)'
          : 'Pre-checks failed (not sending a transaction that is certain to fail)') +
        '：' +
        prechecks.failures.map((failure) => `[${failure.code}] ${failure.detail}`).join('；'),
    };
  }
  const sessionKey = prechecks.sessionKey;
  if (sessionKey === null) {
    // 不可能：failures 非空就是上面那一條。留著只是為了收窄型別。
    return { ...withPlan, outcome: 'blocked', reason: '前置檢查沒有回傳 session key' };
  }

  if (ctx.dryRun) {
    // dry-run 到此為止：前置檢查都過了（這是 `ready` 的全部意義），但仍然不寫 operations
    // （見檔頭「為什麼 dry-run 不寫 operations」）、不推進 `next_run_at`、不呼叫執行路徑。
    return {
      ...withPlan,
      outcome: 'ready-dry-run',
      reason:
        `Would execute ${steps.length} step(s) (dry-run: nothing is sent; see the plan for the parameters; ` +
        `when live the idempotency_key would be ${idempotencyKey}). Pre-checks a/a2/b/c all pass — ` +
        `session key ${sessionKey.keyRef}(${sessionKey.permissionId}) is installed on-chain, derives from the seed, ` +
        `and allowance plus balance are sufficient`,
    };
  }

  const gate = await beginOperation(ctx.deps.query, { portfolioId: due.portfolioId, idempotencyKey, payloadHash: planHash });
  if (!gate.proceed) {
    return { ...withPlan, outcome: gate.outcome, reason: `operations 閘門擋下：${gate.reason}` };
  }

  // 稽核軌跡：送出前先記一張（用剛剛算好的觀測，不額外讀鏈）。
  await recordAuditSnapshot({
    deps: ctx.deps,
    portfolioId: due.portfolioId,
    phase: 'before',
    plan,
    idempotencyKey,
    thresholdBps: ctx.thresholdBps,
  });

  const execution = await executeAndSettle(ctx.deps, {
    portfolioId: due.portfolioId,
    account: due.account,
    sessionKey,
    executor,
    steps,
    deadline: rebalance.deadline,
    idempotencyKey,
  });

  // 落地後再記一張 —— **重新讀鏈**，不沿用送出前的觀測：這一張的全部意義就是「交易真的改變了什麼」。
  // 只有真的上鏈（success / reverted）才有 after；送出失敗（error）時鏈上沒變，寫一張相同的只是噪音。
  if (execution.status === 'success' || execution.status === 'reverted') {
    try {
      const afterPlan = await ctx.deps.planPortfolio(due.portfolioId);
      await recordAuditSnapshot({
        deps: ctx.deps,
        portfolioId: due.portfolioId,
        phase: 'after',
        plan: afterPlan,
        idempotencyKey,
        thresholdBps: ctx.thresholdBps,
      });
    } catch (error) {
      ctx.deps.log(`[scheduler] portfolio ${due.portfolioId} 的 after 快照讀鏈失敗：${oneLine(error)}（這一輪照常）`);
    }
  }
  if (execution.status === 'success') {
    return {
      ...withPlan,
      outcome: 'executed',
      reason: `Landed on-chain: tx ${execution.txHash ?? '(unknown)'} (attempt ${gate.attempts})`,
      execution,
    };
  }
  if (execution.status === 'reverted') {
    return {
      ...withPlan,
      outcome: 'failed',
      reason:
        `上鏈但沒有成功：tx ${execution.txHash ?? '(unknown)'}` +
        `（第 ${gate.attempts} 次嘗試，operations 記為 reverted 可重試）｜${execution.error ?? '(沒有診斷訊息)'}`,
      execution,
    };
  }
  return {
    ...withPlan,
    outcome: 'failed',
    reason:
      `Send failed (nothing landed): ${execution.error ?? '(no error message)'}` +
      `（第 ${gate.attempts} 次嘗試，operations 記為 failed）`,
    execution,
  };
}


/**
 * 寫一張稽核快照（`before` 或 `after`），並連回這一輪的 `operations` 列。
 *
 * 為什麼在排程器寫而不是在 `writeSnapshot` 自己找 operation：快照不該知道 `idempotency_key` 這種
 * 排程器的概念。這裡用 key 查出 id 再傳進去，兩層的責任就分開了。
 *
 * **失敗不往外拋**：快照是觀測，不是這一輪的目的。寫不進去時留一行 log，這一輪的再平衡照常 ——
 * 反過來（為了一張快照讓一筆已經規劃好的再平衡失敗）才是真正不可接受的。
 */
async function recordAuditSnapshot(args: {
  deps: ResolvedDeps;
  portfolioId: number;
  phase: 'before' | 'after';
  plan: PortfolioPlan;
  idempotencyKey: string;
  thresholdBps: number;
}): Promise<void> {
  try {
    const { rows } = await args.deps.query(
      'select id::text as id from operations where idempotency_key = $1',
      [args.idempotencyKey],
    );
    const first = rows[0] as { id?: unknown } | undefined;
    const rawId = typeof first?.id === 'string' ? first.id : undefined;
    await args.deps.writeSnapshot(args.plan.snapshot, args.plan.report, {
      query: args.deps.query as never,
      phase: args.phase,
      operationId: rawId === undefined ? null : BigInt(rawId),
      // `PortfolioPlan.pinnedVersion` 是物件（version + 鏈上 id + paused），表頭只要 version。
      pinnedVersion: args.plan.pinnedVersion.version,
      thresholdBps: args.thresholdBps,
    });
    args.deps.log(
      `[scheduler] portfolio ${args.portfolioId} 的 ${args.phase} 快照已寫入（block ${args.plan.snapshot.block.toString()}）`,
    );
  } catch (error) {
    args.deps.log(
      `[scheduler] portfolio ${args.portfolioId} 的 ${args.phase} 快照沒寫成：${oneLine(error)}（這一輪照常）`,
    );
  }
}

/** 送出 → 標 submitted → 等 receipt → 標 confirmed / reverted / failed。 */
async function executeAndSettle(
  deps: ResolvedDeps,
  args: {
    portfolioId: number;
    account: Address;
    sessionKey: SessionKeyRef;
    executor: Address;
    steps: readonly PlannedStep[];
    deadline: bigint;
    idempotencyKey: string;
  },
): Promise<ExecutionOutcome> {
  const settle = (state: 'confirmed' | 'reverted' | 'failed', outcome: ExecutionOutcome, error: string | null) =>
    deps.query(SQL_SETTLE_OPERATION, [args.idempotencyKey, state, outcome.txHash, outcome.userOpHash, error]);

  try {
    const outcome = await deps.executeRebalance({
      portfolioId: args.portfolioId,
      account: args.account,
      sessionKey: args.sessionKey,
      executor: args.executor,
      steps: args.steps,
      deadline: args.deadline,
      onSubmitted: async (ids) => {
        await deps.query(SQL_MARK_SUBMITTED, [args.idempotencyKey, ids.userOpHash ?? null, ids.txHash ?? null]);
      },
    });
    if (outcome.status === 'success') {
      await settle('confirmed', outcome, null);
      return outcome;
    }
    // `reverted` 的訊息用**判定時寫好的那一段**（哪一層沒過、gas 花了多少），不是一句「status = reverted」：
    // 「上鏈但 op 失敗」與「上鏈後真的 revert」在維運上要看到不同的字（§8.16）。
    const diagnosis =
      outcome.error ?? `上鏈但沒有成功（tx ${outcome.txHash ?? '(unknown)'}，沒有帶回診斷訊息）`;
    await settle('reverted', outcome, diagnosis);
    return outcome;
  } catch (error) {
    // 送出這一段拋錯 = 沒有證據說它上鏈了。記 failed（不是 reverted）並保留錯誤訊息：
    // 下一次同一個 planHash 會走「failed → 允許重試」那條路，而不是被誤判成 confirmed。
    // 這裡**不往外拋**：一筆送不出去是這一輪的結果（failed），不是整輪的例外。
    const message = oneLine(error);
    const outcome: ExecutionOutcome = { status: 'error', userOpHash: null, txHash: null, gasUsed: null, error: message };
    try {
      await settle('failed', outcome, message);
    } catch (dbError) {
      deps.log(`[scheduler] operations 的 failed 寫不進去（${oneLine(dbError)}）：原始錯誤是 ${message}`);
    }
    return outcome;
  }
}

/** 一行摘要（CLI 與 log 都用它）。 */
export function formatResult(result: PortfolioRunResult, dryRun: boolean): string {
  const label: Record<PortfolioOutcome, string> = {
    noop: 'noop',
    blocked: 'blocked',
    'ready-dry-run': 'ready(dry-run)',
    executed: 'executed',
    failed: 'failed',
  };
  const suffix = result.execution?.txHash === undefined || result.execution?.txHash === null ? '' : ` tx=${result.execution.txHash}`;
  // dry-run 不推進 next_run_at（只讀不寫），所以那一行不能長得跟 live 一樣：DB 裡的值沒被改過。
  const nextRun = dryRun
    ? `next_run_at 未推進（dry-run 只讀不寫；若推進會是 ${result.nextRunAt.toISOString()}）`
    : `next_run_at ${result.nextRunAt.toISOString()}`;
  return (
    `[scheduler] portfolio ${result.portfolioId} → ${label[result.outcome]}${suffix}｜${nextRun}` +
    `${dryRun ? '｜dry-run（沒有送出任何交易）' : ''}\n           ${result.reason}`
  );
}
