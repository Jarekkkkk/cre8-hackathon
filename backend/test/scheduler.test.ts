import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { decodeAbiParameters, encodeAbiParameters, encodePacked, keccak256, toBytes } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { closePool, query } from '../src/db.js';
import { TWAP_PRICE_SOURCE } from '../src/positions.js';
import { DEFAULT_DEADLINE_SECONDS as PLANNER_DEFAULT_DEADLINE_SECONDS, MAX_FLOOR_WORSENING_BPS, refreshFloors, amountOutMinWithBuffer,
} from '../src/rebalance-plan.js';
import type { PlannedStep, RebalancePlan, RefreshFloorsResult } from '../src/rebalance-plan.js';
import {
  DEFAULT_DEADLINE_SECONDS,
  PARTIAL_FOLLOW_UP_SECONDS,
  REBALANCE_CALL_GAS_FLOOR,
  claimDuePortfolios,
  countSwapExecuted,
  idempotencyKeyFor,
  judgeRebalanceOutcome,
  parseSchedule,
  planHashFor,
  rebalanceCallGasLimit,
  runSchedulerOnce,
} from '../src/scheduler.js';
import type {
  Erc20Args,
  ExecutionOutcome,
  ExecuteArgs,
  PermissionInstallation,
  PortfolioRunResult,
  RebalancePlanningInput,
  SchedulerDeps,
  SchedulerQueryFn,
  WithTransactionFn,
} from '../src/scheduler.js';
import type { PortfolioPlan } from '../src/snapshot.js';

/**
 * 排程器的測試。
 *
 * 這支檔案的核心不是「跑起來了」，而是**它不會做不該做的事**：
 *   * 沒到期／paused／idle 的 portfolio 一個都不能被認領（重複執行 = 重複動錢）；
 *   * `dryRun` 時執行路徑的呼叫次數必須是 0（不是「大概不會」）；
 *   * live 的三個前置檢查各自失敗時都**不送交易**（不送一筆注定 revert 的 op）；
 *   * `operations` 的 idempotency_key 重複時不重複寫、不重複送。
 *
 * 前 21 組是 stub DB + stub 依賴（不碰鏈、不碰真 DB）。最後一組對**真的 Postgres** 驗證
 * `SELECT … FOR UPDATE SKIP LOCKED` 與「認領即推進」——那一組的價值在於它證明的是 SQL，不是
 * 我對 SQL 的描述。真 DB 不可用時它會明確 skip（不是靜默 pass）。
 */

// ---------------------------------------------------------------------------
// 固定資料
// ---------------------------------------------------------------------------

const PORTFOLIO_ID = 9001;
const STRATEGY_ID = 11;
const TEST_CHAIN_ID = 999_001;
const ACCOUNT = '0x626121698b6403b1794b09c9f16bd2156eeb75bd' as Address;
const OWNER = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc' as Address;
const TOKEN_IN = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' as Address;
const TOKEN_OUT = '0x55d398326f99059ff775485246999027b3197955' as Address;
const EXECUTOR = '0x60691760815c69d32c1f68146fa11669f62a4b38' as Address;
const SESSION_KEY = '0x2b082fadf8f3d620eaa242a9e36817af8640d042' as Address;
const SIGNER_CONTRACT = '0x6a6f069e2a08c2469f3d1c9d1d1b0c0c6e0b1f0a' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const PERMISSION_ID = '0xf67556bf' as Hex;
const OLD_PERMISSION_ID = '0x4ddb1075' as Hex;
const KEY_REF = "m/44'/60'/0'/0/24806714" as const;
const OLD_KEY_REF = "m/44'/60'/0'/0/24806713" as const;
/**
 * 「seed 打錯」的世界：`0x1111…11` 這個 master seed 在 live 驗證中派生出來的 EOA（實測值）。
 * 它與 DB 記的 `SESSION_KEY` 不同 → 前置檢查 a2 必須 blocked。
 */
const WRONG_SEED_EOA = '0x17eaa8d61288a75d9a45bc3074a12aa5e800918d' as Address;
const NOW = new Date('2026-11-07T00:00:00.000Z');
const VALID_UNTIL = 1_825_513_307;

const THRESHOLD_BPS = 100;
/** 86400 秒 = 一天：與 DB 裡那幾個策略的排程相同。 */
const ONE_DAY_SECONDS = 86_400;

function step(overrides: Partial<PlannedStep> = {}): PlannedStep {
  return {
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amountIn: 250_000_000_000_000_000n,
    amountOutMin: 500_000_000_000_000_000n,
    oracleFloor: 499_000_000_000_000_000n,
    commands: '0x00',
    inputs: ['0x'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// stub DB：一個最小的 Postgres（只認排程器會發的那幾條 SQL）
// ---------------------------------------------------------------------------

type StubPortfolio = {
  id: number;
  strategyId: number;
  state: 'idle' | 'active' | 'paused';
  account: Address;
  /** `smart_accounts.account_type`：非 KERNEL（例如 EOA）不可能用 session key 簽 UserOp。 */
  accountType: string;
  /** `strategy_versions.schedule` 的內容（null = DB 沒有這個版本）。 */
  schedule: unknown;
  nextRunAt: Date | null;
  lastCheckedAt: Date | null;
  lastRebalanceAt: Date | null;
};

type StubSessionKey = {
  portfolioId: number;
  keyRef: string;
  permissionId: Hex;
  sessionKeyAddress: Address;
  validUntil: number;
  owner: Address;
  status: 'active' | 'revoked';
};

type StubOperation = {
  portfolioId: number;
  idempotencyKey: string;
  payloadHash: string;
  state: 'pending' | 'submitted' | 'confirmed' | 'failed' | 'reverted';
  attempts: number;
  txHash: string | null;
  userOpHash: string | null;
  lastError: string | null;
};

type StubDb = {
  portfolios: StubPortfolio[];
  sessionKeys: StubSessionKey[];
  operations: StubOperation[];
  /** 每一條 statement 與它執行時「transaction 是否還開著」——回滾與時序的證據。 */
  statements: { sql: string; inTransaction: boolean }[];
  /** transaction 內的暫存寫入：commit 才落到 portfolios，rollback 就消失。 */
  pendingNextRunAt: Map<number, Date>;
  inTransaction: boolean;
  /** true = 下一次 withTransaction 在 fn 之後拋錯（模擬 crash）。 */
  failTransaction: boolean;
};

function stubDb(overrides: Partial<StubDb> = {}): StubDb {
  return {
    portfolios: [],
    sessionKeys: [],
    operations: [],
    statements: [],
    pendingNextRunAt: new Map(),
    inTransaction: false,
    failTransaction: false,
    ...overrides,
  };
}

function portfolio(overrides: Partial<StubPortfolio> = {}): StubPortfolio {
  return {
    id: PORTFOLIO_ID,
    strategyId: STRATEGY_ID,
    state: 'active',
    account: ACCOUNT,
    accountType: 'KERNEL',
    schedule: { kind: 'interval', intervalSeconds: ONE_DAY_SECONDS },
    nextRunAt: null,
    lastCheckedAt: null,
    lastRebalanceAt: null,
    ...overrides,
  };
}

function sessionKey(overrides: Partial<StubSessionKey> = {}): StubSessionKey {
  return {
    portfolioId: PORTFOLIO_ID,
    keyRef: KEY_REF,
    permissionId: PERMISSION_ID,
    sessionKeyAddress: SESSION_KEY,
    validUntil: VALID_UNTIL,
    owner: OWNER,
    status: 'active',
    ...overrides,
  };
}

function keyIndex(keyRef: string): number {
  return Number(keyRef.split('/').at(-1));
}

/**
 * pg 的 `{ rows }` 介面（與 `db.query` 同形）+ 排程器會發的每一條 SQL。
 *
 * 認領的 select 這裡**照它的 WHERE 語意篩選**；那條 WHERE 本身在下面有文字斷言釘住（stub 證明不了
 * SQL 寫對了，最後那一組真 Postgres 的測試才證明得了）。
 */
function stubQuery(db: StubDb): SchedulerQueryFn {
  return async (text: string, params: readonly unknown[] = []) => {
    // 存**完整**的 SQL（斷言要看 WHERE 子句）；只有錯誤訊息才截斷。
    db.statements.push({ sql: text.replace(/\s+/g, ' ').trim(), inTransaction: db.inTransaction });

    if (text.includes('for update of p skip locked')) {
      const now = params[0] as Date;
      const limit = Number(params[2]);
      const due = db.portfolios
        .filter((row) => row.state === 'active' && (row.nextRunAt === null || row.nextRunAt.getTime() <= now.getTime()))
        .sort((left, right) => {
          const lt = left.nextRunAt?.getTime() ?? Number.NEGATIVE_INFINITY;
          const rt = right.nextRunAt?.getTime() ?? Number.NEGATIVE_INFINITY;
          return lt === rt ? left.id - right.id : lt - rt;
        })
        .slice(0, limit);
      return {
        rows: due.map((row) => ({
          // pg 對 bigint 回字串，stub 照抄那個形狀。
          portfolio_id: String(row.id),
          strategy_id: String(row.strategyId),
          address: row.account,
          account_type: row.accountType,
          schedule: row.schedule,
        })),
      };
    }

    if (text.includes('set next_run_at = claimed.next_run_at')) {
      const ids = params[0] as number[];
      const stamps = params[1] as string[];
      ids.forEach((id, index) => {
        const value = new Date(String(stamps[index]));
        if (db.inTransaction) {
          db.pendingNextRunAt.set(id, value);
        } else {
          const row = db.portfolios.find((entry) => entry.id === id);
          if (row !== undefined) row.nextRunAt = value;
        }
      });
      return { rows: [] };
    }

    if (text.includes('set last_checked_at')) {
      const id = Number(params[0]);
      const row = db.portfolios.find((entry) => entry.id === id);
      if (row !== undefined) {
        row.lastCheckedAt = new Date(String(params[1]));
        if (params[2] === true) row.lastRebalanceAt = new Date(String(params[1]));
      }
      return { rows: [] };
    }

    if (text.includes('from session_keys k')) {
      const rows = db.sessionKeys
        .filter((entry) => entry.portfolioId === Number(params[0]) && entry.status === 'active')
        .sort((left, right) => keyIndex(right.keyRef) - keyIndex(left.keyRef))
        .map((entry) => ({
          key_ref: entry.keyRef,
          permissions: {
            permissionId: entry.permissionId,
            sessionKeyAddress: entry.sessionKeyAddress,
            timestamp: { validUntil: entry.validUntil },
          },
          owner: entry.owner,
        }));
      return { rows };
    }

    if (text.includes('insert into operations')) {
      const key = String(params[1]);
      const existing = db.operations.find((entry) => entry.idempotencyKey === key);
      if (existing !== undefined) return { rows: [] };
      db.operations.push({
        portfolioId: Number(params[0]),
        idempotencyKey: key,
        payloadHash: String(params[2]),
        state: 'pending',
        attempts: 1,
        txHash: null,
        userOpHash: null,
        lastError: null,
      });
      return { rows: [{ attempts: 1 }] };
    }

    if (text.includes('select state, attempts from operations')) {
      const existing = db.operations.find((entry) => entry.idempotencyKey === String(params[0]));
      return { rows: existing === undefined ? [] : [{ state: existing.state, attempts: existing.attempts }] };
    }

    if (text.includes("set state = 'submitted'")) {
      const existing = db.operations.find((entry) => entry.idempotencyKey === String(params[0]));
      if (existing === undefined) return { rows: [] };
      existing.state = 'submitted';
      if (params[1] !== null && params[1] !== undefined) existing.userOpHash = String(params[1]);
      if (params[2] !== null && params[2] !== undefined) existing.txHash = String(params[2]);
      return { rows: [] };
    }

    if (text.includes('attempts = attempts + 1')) {
      const existing = db.operations.find((entry) => entry.idempotencyKey === String(params[0]));
      if (existing === undefined || (existing.state !== 'failed' && existing.state !== 'reverted')) return { rows: [] };
      existing.state = 'pending';
      existing.attempts += 1;
      existing.lastError = null;
      existing.txHash = null;
      existing.userOpHash = null;
      return { rows: [{ attempts: existing.attempts }] };
    }

    if (text.includes('set state = $2')) {
      const existing = db.operations.find((entry) => entry.idempotencyKey === String(params[0]));
      if (existing === undefined) return { rows: [] };
      existing.state = String(params[1]) as StubOperation['state'];
      if (params[2] !== null && params[2] !== undefined) existing.txHash = String(params[2]);
      if (params[3] !== null && params[3] !== undefined) existing.userOpHash = String(params[3]);
      existing.lastError = params[4] === null || params[4] === undefined ? null : String(params[4]);
      return { rows: [] };
    }

    throw new Error(`stub DB 沒預期這條 SQL：${text.replace(/\s+/g, ' ').slice(0, 120)}`);
  };
}

/** 記憶體交易：commit 才把 next_run_at 落下去；fn 之後拋錯（或 fn 自己拋）就整個回滾。 */
function stubWithTransaction(db: StubDb): WithTransactionFn {
  const queryFn = stubQuery(db);
  return async (fn) => {
    db.inTransaction = true;
    db.statements.push({ sql: 'begin', inTransaction: true });
    try {
      const result = await fn({ query: queryFn });
      if (db.failTransaction) throw new Error('stub：transaction 在 fn 之後失敗（模擬 crash）');
      for (const [id, value] of db.pendingNextRunAt) {
        const row = db.portfolios.find((entry) => entry.id === id);
        if (row !== undefined) row.nextRunAt = value;
      }
      db.pendingNextRunAt.clear();
      db.statements.push({ sql: 'commit', inTransaction: false });
      return result;
    } catch (error) {
      db.pendingNextRunAt.clear();
      db.statements.push({ sql: 'rollback', inTransaction: false });
      throw error;
    } finally {
      db.inTransaction = false;
    }
  };
}

// ---------------------------------------------------------------------------
// stub 依賴（鏈的部分全部在這裡）
// ---------------------------------------------------------------------------

function stubPlan(
  args: {
    needsRebalance?: boolean;
    blocked?: { code: 'UNPRICED_HOLDINGS' | 'ALLOCATION_MISMATCH'; detail: string }[];
    paused?: boolean;
    portfolioId?: number;
  } = {},
): PortfolioPlan {
  const blocked = args.blocked ?? [];
  const needsRebalance = args.needsRebalance ?? true;
  const portfolioId = args.portfolioId ?? PORTFOLIO_ID;
  return {
    portfolioId,
    strategyId: STRATEGY_ID,
    account: ACCOUNT,
    chainId: TEST_CHAIN_ID,
    snapshot: {
      portfolioId,
      block: 48_000_000n,
      nativeBalanceWei: 10n ** 17n,
      holdings: [{ asset: TOKEN_IN, amountWei: 10n ** 18n, decimals: 18, usdPriceE8: 100_000_000n, priceSource: TWAP_PRICE_SOURCE }],
      unpriced: [],
    },
    scan: {
      portfolioId,
      block: 48_000_000n,
      cursor: { portfolioId, startBlock: 1n, lastScannedBlock: 48_000_000n },
      scannedRange: null,
      candidateCount: 0,
      unknownHoldings: [],
      zeroBalanceCount: 0,
      unreadableCandidates: [],
      deployment: { block: 1n, reason: 'resolved', detail: 'stub' },
      universeComplete: true,
      incompleteReasons: [],
    },
    report:
      blocked.length > 0
        ? null
        : {
            totalUsdE8: 100_000_000_000n,
            assets: [
              { asset: TOKEN_IN, targetBps: 5_000, currentBps: 2_000, deltaBps: -3_000, usdValueE8: 20_000_000_000n },
              { asset: TOKEN_OUT, targetBps: 5_000, currentBps: 8_000, deltaBps: 3_000, usdValueE8: 80_000_000_000n },
            ],
            maxAbsDeltaBps: 3_000,
            grossDriftBps: 3_000,
            needsRebalance,
            thresholdBps: THRESHOLD_BPS,
          },
    blocked,
    targets: [
      { asset: TOKEN_IN, weightBps: 5_000, symbol: 'WBNB' },
      { asset: TOKEN_OUT, weightBps: 5_000, symbol: 'USDT' },
    ],
    pinnedVersion: { version: 1, onchainStrategyId: 1, paused: args.paused ?? false },
    allocationCheck: { consistent: blocked.length === 0, chain: [], mismatches: [] },
    thresholdBps: THRESHOLD_BPS,
  };
}

function readyPlan(steps: PlannedStep[] = [step()]): RebalancePlan {
  return { kind: 'ready', steps, deadline: 1_800_000_300n, rationale: 'stub：WBNB 超配 3000bps' };
}

/**
 * 一個「部分執行」的 ready：其中一個 step 被價格衝擊上限縮小（`partial` 有記錄）。
 * 排程器唯一需要知道的事就是「這一輪只做了一部分、還有事要做」。
 */
function partialPlan(steps: PlannedStep[] = [step()]): RebalancePlan {
  const amountIn = steps[0]?.amountIn ?? 0n;
  return {
    kind: 'ready',
    steps,
    deadline: 1_800_000_300n,
    rationale: 'stub：WBNB 超配 3000bps（⚠ 部分執行：剩餘由下一輪處理）',
    partial: {
      // 判準是結果：依這份步驟執行後預估漂移仍有 1000 bps（遠高於門檻）＝還有事要做。
      remainingDriftBps: 1_000,
      shrunk: [{ index: 0, idealAmountIn: amountIn * 4n, amountIn, idealImpactBps: 900, impactBps: 50 }],
    },
  };
}

type StubChain = {
  plan: PortfolioPlan;
  rebalance: RebalancePlan;
  /** 每一把 key 的鏈上安裝狀態（permissionId → signer / policies）。 */
  installations: Map<string, PermissionInstallation>;
  allowance: bigint;
  balance: bigint;
  /** 被呼叫的次數：dry-run 時 executeCalls 必須是 0。 */
  executeCalls: ExecuteArgs[];
  executeResult: ExecutionOutcome;
  executeError: string | null;
  planPortfolioCalls: number[];
  planRebalanceCalls: number;
  /** 送出前重問地板被呼叫的次數與輸入（釘住「真的在送出前問了」）。 */
  refreshCalls: { steps: readonly PlannedStep[]; strategyId: bigint; executor: Address }[];
  /** 重問地板的結果；預設「地板沒變」＝既有測試的行為完全不動。 */
  refresh: (input: { steps: readonly PlannedStep[] }) => Promise<RefreshFloorsResult>;
  /** 每一把 key 被讀 `permissionConfig` 的對象地址（必須是 smart account，不是 owner）。 */
  permissionReads: { account: Address; permissionId: Hex }[];
  /**
   * `master seed + key_ref` 派生出來的那個 EOA。預設等於 DB 記的 `SESSION_KEY`（= seed 正確的世界）；
   * 換成別的地址就是「seed 打錯」的世界（見缺陷 1 的測試）。
   */
  derivedAddress: Address;
  /** 非 null = 派生本身失敗（seed 沒設／格式不對）。 */
  deriveError: string | null;
  /** 對哪幾個 keyRef 做過派生（釘住「只對選定的那把派生」）。 */
  derivations: string[];
};

function stubChain(overrides: Partial<StubChain> = {}): StubChain {
  return {
    plan: stubPlan(),
    rebalance: readyPlan(),
    installations: new Map([
      [PERMISSION_ID.toLowerCase(), { signer: SIGNER_CONTRACT, policyCount: 3 }],
      [OLD_PERMISSION_ID.toLowerCase(), { signer: SIGNER_CONTRACT, policyCount: 3 }],
    ]),
    allowance: 10n ** 20n,
    balance: 10n ** 18n,
    executeCalls: [],
    executeResult: { status: 'success', userOpHash: '0xabc123', txHash: '0xdef456', gasUsed: '250000', error: null },
    executeError: null,
    planPortfolioCalls: [],
    planRebalanceCalls: 0,
    refreshCalls: [],
    refresh: async (input) => ({
      ok: true,
      steps: input.steps.map((entry) => ({ ...entry })),
      refreshes: [],
      note: 'stub：地板沒有變',
    }),
    permissionReads: [],
    derivedAddress: SESSION_KEY,
    deriveError: null,
    derivations: [],
    ...overrides,
  };
}

function deps(db: StubDb, chain: StubChain, extra: SchedulerDeps = {}): SchedulerDeps {
  return {
    withTransaction: stubWithTransaction(db),
    query: stubQuery(db),
    chainId: TEST_CHAIN_ID,
    executor: EXECUTOR,
    log: () => {},
    planPortfolio: async (portfolioId: number) => {
      chain.planPortfolioCalls.push(portfolioId);
      return chain.plan;
    },
    planRebalance: async (_input: RebalancePlanningInput) => {
      chain.planRebalanceCalls += 1;
      return chain.rebalance;
    },
    /**
     * 送出前重問地板（預設實作會讀真鏈：`executor.oracle()` / `effectiveFeeBps` / `previewSwap`，
     * 測試一律不碰鏈，所以這裡注入 stub）。預設 stub 回「地板沒變」，既有測試的斷言因此完全不受影響。
     */
    refreshFloors: async (input: { steps: readonly PlannedStep[]; strategyId: bigint; executor: Address }) => {
      chain.refreshCalls.push(input);
      return chain.refresh(input);
    },
    readPermissionConfig: async ({ account, permissionId }: { account: Address; permissionId: Hex }) => {
      chain.permissionReads.push({ account, permissionId });
      return chain.installations.get(permissionId.toLowerCase()) ?? { signer: ZERO, policyCount: 0 };
    },
    /** 前檢查 a2：真正實作是 `hdKeyToAccount(masterSeed, keyRef)`；這裡只回一個可控制的地址。 */
    deriveSessionKeyAddress: async (keyRef: `m/44'/60'/${string}`) => {
      chain.derivations.push(keyRef);
      if (chain.deriveError !== null) throw new Error(chain.deriveError);
      return chain.derivedAddress;
    },
    readAllowance: async (_args: Erc20Args) => chain.allowance,
    readBalance: async (_args: Erc20Args) => chain.balance,
    executeRebalance: async (args: ExecuteArgs) => {
      chain.executeCalls.push(args);
      if (args.onSubmitted !== undefined) await args.onSubmitted({ userOpHash: chain.executeResult.userOpHash ?? undefined });
      if (chain.executeError !== null) throw new Error(chain.executeError);
      return chain.executeResult;
    },
    ...extra,
  };
}

type Outcome = PortfolioRunResult['outcome'];

function outcomes(round: { results: PortfolioRunResult[] }): Outcome[] {
  return round.results.map((result) => result.outcome);
}

// ---------------------------------------------------------------------------
// 1. 純函式：排程解析 / planHash
// ---------------------------------------------------------------------------

test('parseSchedule：interval 取得到秒數；cron 明確回不支援；缺排程與壞掉的秒數也是不支援', () => {
  assert.deepEqual(parseSchedule({ kind: 'interval', intervalSeconds: 86_400 }), {
    kind: 'interval',
    intervalSeconds: 86_400,
  });

  const cron = parseSchedule({ kind: 'cron', cron: '0 0 * * *' });
  assert.equal(cron.kind, 'unsupported');
  assert.match(cron.kind === 'unsupported' ? cron.reason : '', /cron/, '原因要指名 cron，不能只是「不支援」');
  assert.match(cron.kind === 'unsupported' ? cron.reason : '', /0 0 \* \* \*/, '要把收到的 cron 字串記下來');

  const missing = parseSchedule(null);
  assert.equal(missing.kind, 'unsupported');

  const tooShort = parseSchedule({ kind: 'interval', intervalSeconds: 59 });
  assert.equal(tooShort.kind, 'unsupported', `intervalSeconds < 60 不接受（strategies.ts 的規則是 >= 60）`);
  const notInteger = parseSchedule({ kind: 'interval', intervalSeconds: 60.5 });
  assert.equal(notInteger.kind, 'unsupported');
  const unknown = parseSchedule({ kind: 'weekly' });
  assert.equal(unknown.kind, 'unsupported');

  console.log(`[cron] blocked 原因原文：${cron.kind === 'unsupported' ? cron.reason : ''}`);
});

test('planHashFor：同樣的參數得到同一個 hash；改 amountIn 或 deadline 就不同；idempotency_key 形狀固定', () => {
  const steps = [step()];
  const hash = planHashFor(steps, 1_800_000_300n);
  assert.match(hash, /^0x[0-9a-f]{64}$/, 'keccak256 的 hex');
  assert.equal(planHashFor([step()], 1_800_000_300n), hash, '同樣的參數 → 同樣的 hash（防重複的基礎）');

  assert.notEqual(planHashFor([step({ amountIn: 1n })], 1_800_000_300n), hash, 'amountIn 變了就是另一個 plan');
  assert.notEqual(planHashFor(steps, 1_800_000_301n), hash, 'deadline 變了就是另一個 plan（過期的 deadline 不該撞同一列）');
  assert.notEqual(planHashFor([step({ amountOutMin: 1n })], 1_800_000_300n), hash, 'amountOutMin 變了也要不同');

  assert.equal(idempotencyKeyFor(PORTFOLIO_ID, hash), `rebalance:${PORTFOLIO_ID}:${hash}`);
});

// ---------------------------------------------------------------------------
// 2. 認領
// ---------------------------------------------------------------------------

test('認領：只有 active 且（next_run_at is null 或 <= now）會被撿到——paused／idle／未到期都不會', async () => {
  const db = stubDb({
    portfolios: [
      portfolio({ id: 1, state: 'active', nextRunAt: null }),
      portfolio({ id: 2, state: 'active', nextRunAt: new Date(NOW.getTime() - 1_000) }),
      portfolio({ id: 3, state: 'paused', nextRunAt: null }),
      portfolio({ id: 4, state: 'idle', nextRunAt: null }),
      portfolio({ id: 5, state: 'active', nextRunAt: new Date(NOW.getTime() + 60_000) }),
    ],
  });

  const claimed = await claimDuePortfolios(10, NOW, { withTransaction: stubWithTransaction(db), chainId: TEST_CHAIN_ID });

  assert.deepEqual(
    claimed.map((due) => due.portfolioId),
    [1, 2],
    'paused(3)／idle(4)／未到期(5) 一個都不能被認領；null 與已到期的兩個都要',
  );

  // stub 依 SQL 的 WHERE 語意篩選，所以這裡另外把 SQL 本身釘住：改壞 WHERE 時這幾條會先紅。
  const claimSql = db.statements.find((entry) => entry.sql.includes('for update'))?.sql ?? '';
  assert.match(claimSql, /schedule_state = 'active'/, '認領只認 active');
  assert.match(claimSql, /next_run_at is null or p\.next_run_at <= \$1/, 'NULL = 立刻到期');
  assert.match(claimSql, /for update of p skip locked/, '兩個排程器行程不能認領到同一列');
  assert.match(claimSql, /order by p\.next_run_at asc nulls first/, 'NULL 排最前面，新 portfolio 不被餓死');

  console.log(`[claim] SQL: ${claimSql}`);
});

test('認領：limit 生效，而且 next_run_at 為 null 的排在前面（新 portfolio 不被餓死）', async () => {
  const db = stubDb({
    portfolios: [
      portfolio({ id: 7, nextRunAt: new Date(NOW.getTime() - 10_000) }),
      portfolio({ id: 8, nextRunAt: null }),
      portfolio({ id: 9, nextRunAt: new Date(NOW.getTime() - 5_000) }),
    ],
  });

  const claimed = await claimDuePortfolios(2, NOW, { withTransaction: stubWithTransaction(db), chainId: TEST_CHAIN_ID });
  assert.deepEqual(
    claimed.map((due) => due.portfolioId),
    [8, 7],
    'null 先、再依 next_run_at 由舊到新；limit 2 只認領兩個',
  );
});

test('認領：next_run_at 在**同一個 transaction 內**就推進（不是執行完才推進）；transaction 失敗則整個回滾', async () => {
  const db = stubDb({ portfolios: [portfolio({ id: 1, nextRunAt: null })] });

  const claimed = await claimDuePortfolios(5, NOW, { withTransaction: stubWithTransaction(db), chainId: TEST_CHAIN_ID });
  assert.equal(claimed.length, 1);
  const nextRunAt = claimed[0]?.nextRunAt;
  assert.equal(nextRunAt?.toISOString(), new Date(NOW.getTime() + ONE_DAY_SECONDS * 1_000).toISOString());
  assert.equal(
    db.portfolios[0]?.nextRunAt?.toISOString(),
    nextRunAt?.toISOString(),
    'commit 之後 DB 裡的值必須就是認領回傳的那個值（同一份資料，不是另外算的）',
  );

  // 時序：advance 那條 UPDATE 執行時，transaction 還開著；而且它在 commit 之前。
  const advance = db.statements.find((entry) => entry.sql.includes('set next_run_at = claimed.next_run_at'));
  assert.ok(advance !== undefined, '認領一定有推進 next_run_at 的那一條 UPDATE');
  assert.equal(advance.inTransaction, true, '推進必須發生在 transaction 內（這是「認領即推進」的全部證據）');
  const order = db.statements.map((entry) => (entry.sql === 'begin' || entry.sql === 'commit' ? entry.sql : entry.sql.slice(0, 20)));
  const advanceIndex = db.statements.findIndex((entry) => entry.sql.includes('set next_run_at = claimed.next_run_at'));
  const commitIndex = db.statements.findIndex((entry) => entry.sql === 'commit');
  assert.ok(advanceIndex >= 0 && commitIndex >= 0 && advanceIndex < commitIndex, `推進必須在 commit 之前：${order.join(' → ')}`);

  // crash 模擬：fn 之後拋錯 → 推進被回滾（否則「認領了但沒跑」會變成「永遠不再跑」）。
  const crashed = stubDb({ portfolios: [portfolio({ id: 2, nextRunAt: null })], failTransaction: true });
  await assert.rejects(
    claimDuePortfolios(5, NOW, { withTransaction: stubWithTransaction(crashed), chainId: TEST_CHAIN_ID }),
    /transaction 在 fn 之後失敗/,
  );
  assert.equal(crashed.portfolios[0]?.nextRunAt, null, 'transaction 失敗時 next_run_at 不能被寫進去（下一輪還會撿到它）');
});

// ---------------------------------------------------------------------------
// 3. dry-run（預設值）
// ---------------------------------------------------------------------------

test('dryRun 預設 true：ready 也只記錄、執行路徑 0 次呼叫、operations 一列都不寫', async () => {
  const db = stubDb({ portfolios: [portfolio()], sessionKeys: [sessionKey()] });
  const chain = stubChain();

  const round = await runSchedulerOnce({ now: NOW }, deps(db, chain));

  assert.equal(round.dryRun, true, '不給 dryRun 就是 dry-run');
  assert.deepEqual(outcomes(round), ['ready-dry-run']);
  assert.equal(chain.executeCalls.length, 0, '**執行路徑必須 0 次呼叫**（這是這整個工單最重要的一條）');
  assert.equal(db.operations.length, 0, 'dry-run 不寫 operations：寫了會讓真正的執行被自己的預演擋住（idempotency_key 相同）');
  assert.equal(chain.executeCalls.length, 0);

  const result = round.results[0];
  assert.ok(result?.plan !== null && result?.plan !== undefined, 'dry-run 也要看得到將要送出的參數');
  assert.equal(result?.plan.steps.length, 1);
  assert.equal(result?.plan.steps[0]?.amountIn, step().amountIn.toString());
  assert.equal(result?.plan.deadline, '1800000300');
  assert.equal(result?.plan.idempotencyKey, idempotencyKeyFor(PORTFOLIO_ID, result?.plan.planHash ?? '0x'));
  assert.match(result?.reason ?? '', /沒有送出任何交易|dry-run/);

  console.log(`[dry-run] ${result?.outcome}：${result?.reason}`);
  console.log(`[dry-run] 將要送出：stake ${result?.plan.steps[0]?.amountIn} amountOutMin ${result?.plan.steps[0]?.amountOutMin} deadline ${result?.plan.deadline}`);
});

test('dryRun: true 明示也一樣：ready 但不送出、不寫 operations', async () => {
  const db = stubDb({ portfolios: [portfolio()], sessionKeys: [sessionKey()] });
  const chain = stubChain();

  const round = await runSchedulerOnce({ dryRun: true, now: NOW }, deps(db, chain));
  assert.deepEqual(outcomes(round), ['ready-dry-run']);
  assert.equal(chain.executeCalls.length, 0);
  assert.equal(db.operations.length, 0);
});

test('缺陷 3：dry-run 不推進 next_run_at（只讀不寫）；live 仍然在認領的同一個 transaction 內推進', async () => {
  // 監控用法：一個 next_run_at = NULL（立刻到期）的 active portfolio，跑完 dry-run 之後必須還是 NULL。
  const dry = stubDb({ portfolios: [portfolio({ nextRunAt: null })], sessionKeys: [sessionKey()] });
  const dryChain = stubChain();

  const before = dry.portfolios[0]?.nextRunAt ?? null;
  const first = await runSchedulerOnce({ now: NOW }, deps(dry, dryChain));
  const after = dry.portfolios[0]?.nextRunAt ?? null;
  // 先格式化再看斷言：`assert.equal` 會把型別收窄成 null，之後就沒有 toISOString 可用了。
  const label = (value: Date | null): string => (value === null ? 'NULL' : value.toISOString());
  const dryLabels = `before=${label(before)} → after=${label(after)}`;

  assert.deepEqual(outcomes(first), ['ready-dry-run']);
  assert.equal(before, null, '前提：跑之前是 NULL');
  assert.equal(after, null, '**dry-run 不能推進 next_run_at**：推進一次就等於「今天不做」（86400 秒）');
  assert.equal(
    dry.statements.some((entry) => entry.sql.includes('set next_run_at = claimed.next_run_at')),
    false,
    'dry-run 連那一條 UPDATE 都不該發（不是「發了但值剛好一樣」）',
  );
  console.log(`[缺陷 3] dry-run：${dryLabels}`);

  // 連續兩次 dry-run 看到同一個 portfolio：正確且可預期（觀察不該改變被觀察的系統）。
  const second = await runSchedulerOnce({ now: NOW }, deps(dry, dryChain));
  assert.equal(second.claimed, 1, '觀察兩次、兩次都看到它——這正是 dry-run 不推進的可預期後果');
  assert.equal(dry.portfolios[0]?.nextRunAt ?? null, null);

  // 對照：live 一模一樣的起始狀態，但**一定要**推進，而且在認領的 transaction 內。
  const live = stubDb({ portfolios: [portfolio({ nextRunAt: null })], sessionKeys: [sessionKey()] });
  const liveRound = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(live, stubChain()));

  const expected = new Date(NOW.getTime() + ONE_DAY_SECONDS * 1_000).toISOString();
  assert.deepEqual(outcomes(liveRound), ['executed']);
  assert.equal(live.portfolios[0]?.nextRunAt?.toISOString(), expected, 'live 仍然必須推進 next_run_at（不能因為這個修改鬆動）');
  const advance = live.statements.find((entry) => entry.sql.includes('set next_run_at = claimed.next_run_at'));
  assert.ok(advance !== undefined, 'live 一定有那一條 UPDATE');
  assert.equal(advance.inTransaction, true, 'live 的推進仍然發生在認領的 transaction 內');
  console.log(`[缺陷 3] live：after=${live.portfolios[0]?.nextRunAt?.toISOString()}（UPDATE inTransaction=${advance.inTransaction}）`);
});

// ---------------------------------------------------------------------------
// 4. 不該執行的每一種情況
// ---------------------------------------------------------------------------

test('cron 排程 → blocked 且原因指名 cron，連 planPortfolio 都不呼叫', async () => {
  const db = stubDb({ portfolios: [portfolio({ schedule: { kind: 'cron', cron: '0 0 * * *' } })] });
  const chain = stubChain();

  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['blocked']);
  assert.match(round.results[0]?.reason ?? '', /cron/, 'cron 必須被明確寫出來（不能靜默跳過）');
  assert.deepEqual(chain.planPortfolioCalls, [], '不支援的排程不該去讀鏈');
  assert.equal(chain.planRebalanceCalls, 0);
  assert.equal(chain.executeCalls.length, 0);

  // 認領時仍然推進了 next_run_at（否則它每輪都排最前面，把 limit 吃光）
  assert.equal(
    db.portfolios[0]?.nextRunAt?.toISOString(),
    new Date(NOW.getTime() + 3_600 * 1_000).toISOString(),
    'cron 的後推是一小時的退避（不是假裝支援），而且一定要推進',
  );
  console.log(`[cron] ${round.results[0]?.outcome}：${round.results[0]?.reason}`);
});

test('缺陷 2：account_type != KERNEL（EOA）→ **dry-run 也** blocked，code 是 ACCOUNT_NOT_KERNEL', async () => {
  // 真實的 portfolio 1：帳戶就是 owner 本人（EOA），沒有任何 session_keys 列 → live 必定
  // SESSION_KEY_NOT_INSTALLED。它在監控輸出裡顯示 ready 會讓「看 ready 的數量判斷健康度」出錯。
  const dry = stubDb({ portfolios: [portfolio({ accountType: 'EOA' })] });
  const dryChain = stubChain();

  const dryRound = await runSchedulerOnce({ now: NOW }, deps(dry, dryChain));
  const dryReason = dryRound.results[0]?.reason ?? '';

  assert.deepEqual(outcomes(dryRound), ['blocked'], '**dry-run 也不能顯示 ready**：它永遠不可能成功');
  assert.match(dryReason, /ACCOUNT_NOT_KERNEL/);
  assert.match(dryReason, /EOA/, '訊息要說明 EOA 為什麼不行');
  assert.match(dryReason, /session key/, '訊息要指名「無法用 session key 簽 UserOp」');
  assert.deepEqual(dryChain.planPortfolioCalls, [], '型別不對就不必讀鏈（擋在 planPortfolio 之前）');
  assert.equal(dryChain.executeCalls.length, 0);
  assert.equal(dry.operations.length, 0, 'dry-run 本來就不寫 operations');
  console.log(`[缺陷 2] dry-run：${dryRound.results[0]?.outcome}｜${dryReason}`);

  // live 走同一條：也是 blocked（而且仍然不寫 operations：這裡不是「試過了」）。
  const live = stubDb({ portfolios: [portfolio({ accountType: 'EOA' })] });
  const liveChain = stubChain();
  const liveRound = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(live, liveChain));

  assert.deepEqual(outcomes(liveRound), ['blocked']);
  assert.match(liveRound.results[0]?.reason ?? '', /ACCOUNT_NOT_KERNEL/);
  assert.equal(live.operations.length, 0, '型別不對不是「嘗試失敗」：一列 operations 都不該寫');
  assert.equal(liveChain.executeCalls.length, 0);
});

test('帳戶型別認不出來（欄位缺失／空字串）→ 也是 blocked，不是「大概是 KERNEL 吧」', async () => {
  const db = stubDb({ portfolios: [portfolio({ accountType: '' })] });
  const chain = stubChain();

  const round = await runSchedulerOnce({ now: NOW }, deps(db, chain));
  assert.deepEqual(outcomes(round), ['blocked']);
  assert.match(round.results[0]?.reason ?? '', /ACCOUNT_NOT_KERNEL/);
  assert.match(round.results[0]?.reason ?? '', /\(missing\)/);
  assert.equal(chain.executeCalls.length, 0);
});

test('planPortfolio 有 blocked → blocked、不執行（也不呼叫規劃器）', async () => {
  const db = stubDb({ portfolios: [portfolio()] });
  const chain = stubChain({
    plan: stubPlan({ blocked: [{ code: 'UNPRICED_HOLDINGS', detail: '持有但沒有價格：NVDAB 沒有 USDT 池' }] }),
  });

  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['blocked']);
  assert.match(round.results[0]?.reason ?? '', /UNPRICED_HOLDINGS/);
  assert.equal(chain.planRebalanceCalls, 0, 'blocked 的 portfolio 不該進規劃器');
  assert.equal(chain.executeCalls.length, 0);
  assert.equal(db.operations.length, 0);
  console.log(`[blocked] ${round.results[0]?.reason}`);
});

test('鏈上 enrollment paused → blocked、不執行（executor 會 revert Paused()）', async () => {
  const db = stubDb({ portfolios: [portfolio()] });
  const chain = stubChain({ plan: stubPlan({ paused: true }) });

  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));
  assert.deepEqual(outcomes(round), ['blocked']);
  assert.match(round.results[0]?.reason ?? '', /paused/);
  assert.equal(chain.executeCalls.length, 0);
});

test('needsRebalance === false → noop，不呼叫規劃器', async () => {
  const db = stubDb({ portfolios: [portfolio()] });
  const chain = stubChain({ plan: stubPlan({ needsRebalance: false }) });

  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));
  assert.deepEqual(outcomes(round), ['noop']);
  assert.match(round.results[0]?.reason ?? '', /3000 bps is below the 100 bps threshold/);
  assert.equal(chain.planRebalanceCalls, 0);
  assert.equal(chain.executeCalls.length, 0);
  console.log(`[noop] ${round.results[0]?.reason}`);
});

test('planRebalance 回 noop / blocked → 對應結果，都不執行', async () => {
  const noopDb = stubDb({ portfolios: [portfolio()] });
  const noopChain = stubChain({ rebalance: { kind: 'noop', reason: '賣出量算出來是 0' } });
  const noopRound = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(noopDb, noopChain));
  assert.deepEqual(outcomes(noopRound), ['noop']);
  assert.match(noopRound.results[0]?.reason ?? '', /賣出量算出來是 0/);
  assert.equal(noopChain.executeCalls.length, 0);

  const blockedDb = stubDb({ portfolios: [portfolio()] });
  const blockedChain = stubChain({ rebalance: { kind: 'blocked', reason: 'oracle 不認這個 pair' } });
  const blockedRound = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(blockedDb, blockedChain));
  assert.deepEqual(outcomes(blockedRound), ['blocked']);
  assert.match(blockedRound.results[0]?.reason ?? '', /oracle 不認這個 pair/);
  assert.equal(blockedChain.executeCalls.length, 0);
});

test('planRebalance 回 ready 但 steps 是空的 → blocked（空 steps 在鏈上會「成功」而什麼都沒換）', async () => {
  const db = stubDb({ portfolios: [portfolio()] });
  const chain = stubChain({ rebalance: { kind: 'ready', steps: [], deadline: 1_800_000_300n, rationale: '不該發生' } });

  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));
  assert.deepEqual(outcomes(round), ['blocked']);
  assert.match(round.results[0]?.reason ?? '', /the steps are empty/);
  assert.equal(chain.executeCalls.length, 0, '空 steps 送出去會是「成功但沒換幣」（docs/pitfalls §8.1）');
  assert.equal(db.operations.length, 0);
  console.log(`[empty-steps] ${round.results[0]?.reason}`);
});

// ---------------------------------------------------------------------------
// 5. live 的前置檢查（各自獨立失敗 → 各自 blocked，且都不送交易）
//    a：鏈上裝好了沒 / a2：seed 派生得出 DB 記的那把嗎 / b：allowance / c：餘額
// ---------------------------------------------------------------------------

test('前置檢查 a：鏈上沒有任何一把 session key 裝好 → blocked，不送交易', async () => {
  const db = stubDb({ portfolios: [portfolio()], sessionKeys: [sessionKey()] });
  const chain = stubChain({
    // DB 有 active 的列，但鏈上 signer = 0：這正是 docs/pitfalls §8.11 的坑。
    installations: new Map([[PERMISSION_ID.toLowerCase(), { signer: ZERO, policyCount: 0 }]]),
  });

  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['blocked']);
  assert.match(round.results[0]?.reason ?? '', /SESSION_KEY_NOT_INSTALLED/);
  assert.match(round.results[0]?.reason ?? '', /signer=0x0000000000000000000000000000000000000000/);
  assert.equal(chain.executeCalls.length, 0, '沒裝好的 key 送出去一定失敗，不送');
  assert.equal(db.operations.length, 0, '前置檢查沒過就不該寫 operations（連 pending 都不該有）');

  // 挑 key 的 SQL 一起釘住：stub 自己也會篩選，所以把 WHERE 的每一條都寫成斷言。
  const keySql = db.statements.find((entry) => entry.sql.includes('from session_keys k'))?.sql ?? '';
  assert.match(keySql, /status = 'active'/, 'DB 只給 active 的列當候選');
  assert.match(keySql, /expires_at > now\(\)/, '過期的 key 不該被挑進來（早擋省一次必敗的 op）');
  assert.match(keySql, /order by \(split_part\(k\.key_ref/, '由新到舊逐把驗（§8.11）');
  console.log(`[precheck a] ${round.results[0]?.reason}`);
  console.log(`[precheck a] 挑 key 的 SQL: ${keySql}`);
});

test('前置檢查 a：最新那把沒安裝時改用舊的那把（§8.11 說「取最新」是危險的預設）', async () => {
  const db = stubDb({
    portfolios: [portfolio()],
    sessionKeys: [
      sessionKey({ keyRef: KEY_REF, permissionId: PERMISSION_ID }),
      sessionKey({ keyRef: OLD_KEY_REF, permissionId: OLD_PERMISSION_ID }),
    ],
  });
  const chain = stubChain({
    installations: new Map([
      [PERMISSION_ID.toLowerCase(), { signer: ZERO, policyCount: 0 }],
      [OLD_PERMISSION_ID.toLowerCase(), { signer: SIGNER_CONTRACT, policyCount: 3 }],
    ]),
  });

  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));
  assert.deepEqual(outcomes(round), ['executed']);
  assert.equal(chain.executeCalls.length, 1);
  assert.equal(chain.executeCalls[0]?.sessionKey.keyRef, OLD_KEY_REF, '要用鏈上真的裝好的那把');
  assert.equal(chain.executeCalls[0]?.sessionKey.permissionId, OLD_PERMISSION_ID);
  // 派生只對**選定的那把**做：對每一把都派生會把真正可用的那把也一起擋掉。
  assert.deepEqual(chain.derivations, [OLD_KEY_REF], '派生只該問一次，而且是選定的那把');
  console.log(`[precheck a] 跳過沒安裝的 ${KEY_REF}，改用 ${OLD_KEY_REF}；派生只問了 [${chain.derivations.join(', ')}]`);
});

test('前置檢查 a2（缺陷 1）：seed 派生不出 DB 記的那把 → blocked（不是 failed），operations 0 列', async () => {
  // live 驗證裡實際看到的形狀：seed 打成 0x1111…11 → 派生到 0x17eAA8…，而 DB 記的是 0x2b082f…。
  // 修好之前，這條路會先 beginOperation（寫一列 failed/attempts=1）才在送出時炸掉。
  const db = stubDb({ portfolios: [portfolio()], sessionKeys: [sessionKey()] });
  const chain = stubChain({ derivedAddress: WRONG_SEED_EOA });

  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));
  const reason = round.results[0]?.reason ?? '';

  assert.deepEqual(outcomes(round), ['blocked'], '設定錯誤是 blocked；failed 的語意是「試過了但失敗」');
  assert.match(reason, /SESSION_KEY_DERIVATION_MISMATCH/, 'code 要明確，不能只有一句話');
  assert.ok(reason.includes(WRONG_SEED_EOA), `訊息要含派生值 ${WRONG_SEED_EOA}`);
  assert.ok(reason.includes(SESSION_KEY), `訊息要含期望值（DB 記的 ${SESSION_KEY}）`);
  assert.equal(db.operations.length, 0, '**根本沒試 → 一列 operations 都不該寫**');
  assert.equal(
    db.statements.some((entry) => entry.sql.includes('insert into operations')),
    false,
    '連那一條 INSERT 都不該發（不是「寫了又刪」）',
  );
  assert.equal(chain.executeCalls.length, 0, '派生就不符了，不可能送出');
  assert.equal(db.portfolios[0]?.lastRebalanceAt, null);
  console.log(`[缺陷 1] ${round.results[0]?.outcome}｜${reason}`);
  console.log(`[缺陷 1] operations 列數=${db.operations.length}；有 INSERT operations 的 statement=${db.statements.some((e) => e.sql.includes('insert into operations'))}`);
});

test('前置檢查 a2：seed 根本派生不了（沒設／格式不對）→ blocked + SESSION_KEY_DERIVATION_FAILED', async () => {
  const db = stubDb({ portfolios: [portfolio()], sessionKeys: [sessionKey()] });
  const chain = stubChain({ deriveError: 'Session key 設定不完整：缺少 SESSION_KEY_MASTER_SEED' });

  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['blocked'], '也是設定錯誤，不是嘗試失敗');
  assert.match(round.results[0]?.reason ?? '', /SESSION_KEY_DERIVATION_FAILED/);
  assert.match(round.results[0]?.reason ?? '', /SESSION_KEY_MASTER_SEED/);
  assert.equal(db.operations.length, 0);
  assert.equal(chain.executeCalls.length, 0);
  console.log(`[缺陷 1] ${round.results[0]?.reason}`);
});

test('前置檢查 a2：seed 相符時行為不變（照常走到送出）', async () => {
  const db = stubDb({ portfolios: [portfolio()], sessionKeys: [sessionKey()] });
  const chain = stubChain(); // derivedAddress 預設 = DB 記的那把 = seed 正確的世界

  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['executed'], '派生對得上就照原本的路走完');
  assert.deepEqual(chain.derivations, [KEY_REF]);
  assert.equal(chain.executeCalls.length, 1);
  assert.equal(db.operations[0]?.state, 'confirmed');
});

test('前置檢查 b：allowance < amountIn → blocked，不送交易', async () => {
  const db = stubDb({ portfolios: [portfolio()], sessionKeys: [sessionKey()] });
  const chain = stubChain({ allowance: step().amountIn - 1n });

  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['blocked']);
  assert.match(round.results[0]?.reason ?? '', /ALLOWANCE_TOO_LOW/);
  assert.match(round.results[0]?.reason ?? '', /一定 revert/);
  assert.equal(chain.executeCalls.length, 0);
  assert.equal(db.operations.length, 0);
  console.log(`[precheck b] ${round.results[0]?.reason}`);
});

test('前置檢查 c：tokenIn 餘額 < amountIn → blocked，不送交易', async () => {
  const db = stubDb({ portfolios: [portfolio()], sessionKeys: [sessionKey()] });
  const chain = stubChain({ balance: step().amountIn - 1n });

  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['blocked']);
  assert.match(round.results[0]?.reason ?? '', /INSUFFICIENT_BALANCE/);
  assert.equal(chain.executeCalls.length, 0);
  assert.equal(db.operations.length, 0);
  console.log(`[precheck c] ${round.results[0]?.reason}`);
});

// ---------------------------------------------------------------------------
// 5-bis. 缺陷 4：前置檢查在 **dry-run 也跑**
//
// `ready` 的定義是「如果現在 `--live`，這一個會成功嗎？」。缺陷 2 只把帳戶型別搬到 dry-run，
// 而安裝／派生／allowance／餘額留在 live-only —— 那只是把「永遠不可能成功卻顯示 ready」的來源
// 從 EOA 換成「KERNEL 但 active session_keys = 0」（真實的 portfolio 3／4）。
// ---------------------------------------------------------------------------

test('缺陷 4：KERNEL 但 active session_keys = 0（真實的 portfolio 3／4）→ **dry-run 也** blocked', async () => {
  const db = stubDb({ portfolios: [portfolio({ nextRunAt: null })], sessionKeys: [] });
  const chain = stubChain();

  const round = await runSchedulerOnce({ now: NOW }, deps(db, chain));
  const reason = round.results[0]?.reason ?? '';

  assert.deepEqual(outcomes(round), ['blocked'], '**dry-run 不能顯示 ready**：沒有 key 就不可能簽出 UserOp');
  assert.match(reason, /SESSION_KEY_NOT_INSTALLED/, 'code 要明確，不能只有一句話');
  assert.match(reason, /active session key/, '訊息要說明「DB 沒有未過期的 active key」');
  assert.equal(chain.executeCalls.length, 0);

  // dry-run 的另外三條邊界照樣成立：不寫 operations、不推進 next_run_at、不送交易。
  assert.equal(db.operations.length, 0);
  assert.equal(db.statements.some((entry) => entry.sql.includes('insert into operations')), false);
  assert.equal(db.statements.some((entry) => entry.sql.includes('set next_run_at')), false, 'dry-run 連那一條 UPDATE 都不發');
  assert.equal(db.portfolios[0]?.nextRunAt, null);
  console.log(`[缺陷 4] dry-run：${round.results[0]?.outcome}｜${reason}`);
});

test('缺陷 4：DB 有 active 的列但鏈上 signer = 0（§8.11，portfolio 6／7 的形狀）→ **dry-run 也** blocked', async () => {
  const db = stubDb({ portfolios: [portfolio()], sessionKeys: [sessionKey()] });
  const chain = stubChain({
    // DB 說 active，鏈上沒裝：只信 DB 的檢查會放行一筆必定失敗的 op。
    installations: new Map([[PERMISSION_ID.toLowerCase(), { signer: ZERO, policyCount: 0 }]]),
  });

  const round = await runSchedulerOnce({ now: NOW }, deps(db, chain));
  const reason = round.results[0]?.reason ?? '';

  assert.deepEqual(outcomes(round), ['blocked']);
  assert.match(reason, /SESSION_KEY_NOT_INSTALLED/);
  assert.match(reason, /signer=0x0000000000000000000000000000000000000000/, '要指名鏈上讀到的值');
  assert.equal(chain.permissionReads.length, 1, '**真的去讀了鏈**（不是只看 DB 的 status）');
  assert.equal(chain.permissionReads[0]?.account, ACCOUNT, 'permissionConfig 讀 smart account，不是 owner');
  assert.equal(chain.executeCalls.length, 0);
  assert.equal(db.operations.length, 0);
  console.log(`[缺陷 4] dry-run：${round.results[0]?.outcome}｜${reason}`);
});

test('缺陷 4：seed 派生不出 DB 記的那把 → **dry-run 也** blocked（MISMATCH／FAILED），operations 0 列', async () => {
  // a2 是純本機運算（不碰鏈），所以 dry-run 驗它幾乎不花钱；但它同樣是「live 一定被擋」的一類。
  const mismatchDb = stubDb({ portfolios: [portfolio()], sessionKeys: [sessionKey()] });
  const mismatchChain = stubChain({ derivedAddress: WRONG_SEED_EOA });
  const mismatchRound = await runSchedulerOnce({ now: NOW }, deps(mismatchDb, mismatchChain));
  const mismatchReason = mismatchRound.results[0]?.reason ?? '';

  assert.deepEqual(outcomes(mismatchRound), ['blocked'], '設定錯誤是 blocked；failed 的語意是「試過了」');
  assert.match(mismatchReason, /SESSION_KEY_DERIVATION_MISMATCH/);
  assert.ok(mismatchReason.includes(WRONG_SEED_EOA), `訊息要含派生值 ${WRONG_SEED_EOA}`);
  assert.equal(mismatchDb.operations.length, 0);
  assert.equal(mismatchChain.executeCalls.length, 0);
  console.log(`[缺陷 4] dry-run：${mismatchRound.results[0]?.outcome}｜${mismatchReason}`);

  const failedDb = stubDb({ portfolios: [portfolio()], sessionKeys: [sessionKey()] });
  const failedChain = stubChain({ deriveError: 'Session key 設定不完整：缺少 SESSION_KEY_MASTER_SEED' });
  const failedRound = await runSchedulerOnce({ now: NOW }, deps(failedDb, failedChain));

  assert.deepEqual(outcomes(failedRound), ['blocked']);
  assert.match(failedRound.results[0]?.reason ?? '', /SESSION_KEY_DERIVATION_FAILED/);
  assert.equal(failedDb.operations.length, 0);
  assert.equal(failedChain.executeCalls.length, 0);
  console.log(`[缺陷 4] dry-run：${failedRound.results[0]?.outcome}｜${failedRound.results[0]?.reason}`);
});

test('缺陷 4／判斷題：allowance 與餘額在 dry-run 也算 → 不夠就 blocked（不然 ready 還是會騙人）', async () => {
  // 這兩條依賴 steps，所以只能驗在 planRebalance 之後；但它們與 a／a2 是同一件事的另一半：
  // 「live 會不會被擋」。只驗 key 而留 allowance 不驗，等於承認 ready 只代表「前半段會過」。
  const allowanceDb = stubDb({ portfolios: [portfolio()], sessionKeys: [sessionKey()] });
  const allowanceChain = stubChain({ allowance: step().amountIn - 1n });
  const allowanceRound = await runSchedulerOnce({ now: NOW }, deps(allowanceDb, allowanceChain));

  assert.deepEqual(outcomes(allowanceRound), ['blocked']);
  assert.match(allowanceRound.results[0]?.reason ?? '', /ALLOWANCE_TOO_LOW/);
  assert.equal(allowanceChain.executeCalls.length, 0);
  assert.equal(allowanceDb.operations.length, 0);
  console.log(`[缺陷 4] dry-run：${allowanceRound.results[0]?.outcome}｜${allowanceRound.results[0]?.reason}`);

  const balanceDb = stubDb({ portfolios: [portfolio()], sessionKeys: [sessionKey()] });
  const balanceChain = stubChain({ balance: step().amountIn - 1n });
  const balanceRound = await runSchedulerOnce({ now: NOW }, deps(balanceDb, balanceChain));

  assert.deepEqual(outcomes(balanceRound), ['blocked']);
  assert.match(balanceRound.results[0]?.reason ?? '', /INSUFFICIENT_BALANCE/);
  assert.equal(balanceChain.executeCalls.length, 0);
  assert.equal(balanceDb.operations.length, 0);
});

test('缺陷 4：四條都過才 ready，而且 reason 說得出驗過什麼（ready 的值來自這裡）', async () => {
  const db = stubDb({ portfolios: [portfolio()], sessionKeys: [sessionKey()] });
  const chain = stubChain();

  const round = await runSchedulerOnce({ now: NOW }, deps(db, chain));
  const result = round.results[0];
  const reason = result?.reason ?? '';

  assert.deepEqual(outcomes(round), ['ready-dry-run']);
  assert.ok(reason.includes(KEY_REF), 'reason 要指名通過的是哪一把 key');
  assert.ok(reason.includes(PERMISSION_ID), 'reason 要指名 permissionId（重建 permissionId 用的就是它）');
  assert.match(reason, /derives from the seed/);
  assert.match(reason, /allowance plus balance are sufficient/);
  // ready 仍然只是「算好了」：dry-run 的邊界一條都不能鬆。
  assert.equal(chain.executeCalls.length, 0);
  assert.equal(db.operations.length, 0);
  assert.equal(db.portfolios[0]?.nextRunAt, null, 'dry-run 不推進 next_run_at');
  console.log(`[缺陷 4] dry-run：${result?.outcome}｜${reason}`);
});

test('缺陷 4／效能：前置檢查只給「真的要送」的 portfolio 付錢（noop／擋在planRebalance之前的都不讀鏈）', async () => {
  // 沒有漂移 → noop：它根本不需要 session key，一次 permissionConfig 都不該讀。
  const noopDb = stubDb({ portfolios: [portfolio()], sessionKeys: [sessionKey()] });
  const noopChain = stubChain({ plan: stubPlan({ needsRebalance: false }) });
  const noopRound = await runSchedulerOnce({ now: NOW }, deps(noopDb, noopChain));

  assert.deepEqual(outcomes(noopRound), ['noop']);
  assert.equal(noopChain.permissionReads.length, 0, 'noop 不該為了驗 key 讀鏈');
  assert.equal(noopChain.planRebalanceCalls, 0, '擋在規劃器之前，steps 也算不出來');

  // 兩把候選 key、最新那把已安裝：由新到舊逐把驗，讀到第一把就停（不多讀）。
  const twoKeysDb = stubDb({
    portfolios: [portfolio()],
    sessionKeys: [sessionKey({ keyRef: KEY_REF, permissionId: PERMISSION_ID }), sessionKey({ keyRef: OLD_KEY_REF, permissionId: OLD_PERMISSION_ID })],
  });
  const twoKeysChain = stubChain();
  const twoKeysRound = await runSchedulerOnce({ now: NOW }, deps(twoKeysDb, twoKeysChain));

  assert.deepEqual(outcomes(twoKeysRound), ['ready-dry-run']);
  assert.deepEqual(
    twoKeysChain.permissionReads.map((read) => read.permissionId),
    [PERMISSION_ID],
    '最新那把裝好了就不再往舊的問：每個 portfolio 的 permissionConfig 讀取次數 <= 候選 key 數',
  );
  console.log(
    `[缺陷 4/效能] noop 的 permissionConfig 讀取=${noopChain.permissionReads.length}；` +
      `2 把候選的讀取=${twoKeysChain.permissionReads.length}（${twoKeysChain.permissionReads.map((r) => r.permissionId).join(', ')}）`,
  );
});

// ---------------------------------------------------------------------------
// 5.5 送出前的 gas 預算與送出後的三層判定（docs/pitfalls §8.16）
// ---------------------------------------------------------------------------

test('rebalanceCallGasLimit：max(估算 × 1.5, 600,000) —— alto 實測那個 367,885 會被下限蓋掉', () => {
  // 實測值：alto 對 2 筆 swap 的 executeRebalance 估 367,885，實際要 450–500k。
  // 367,885 × 1.5 = 551,827（尾數捨去）< 600,000 → 下限勝出。
  assert.equal(rebalanceCallGasLimit(367_885n), 600_000n, 'alto 的低估必須被下限蓋掉');
  assert.equal(rebalanceCallGasLimit(367_885n), REBALANCE_CALL_GAS_FLOOR);

  // 估算大的時候跟著長大（資產變多 → steps 變多 → 固定值會變成靜默的能力上限）。
  assert.equal(rebalanceCallGasLimit(500_000n), 750_000n, '500k × 1.5 = 750k，超過下限就不再用下限');
  assert.equal(rebalanceCallGasLimit(1_000_000n), 1_500_000n);

  // 0 或垃圾估算不能讓它掉到下限以下（下限是「不可能更好」的地板，不是「剛好」）。
  assert.equal(rebalanceCallGasLimit(0n), 600_000n);
  assert.equal(rebalanceCallGasLimit(1n), 600_000n);
  // 剛剛好越過下限的邊界：400,001 × 1.5 = 600,001 > 600,000。
  assert.equal(rebalanceCallGasLimit(399_999n), 600_000n, '399,999 × 1.5 捨去 = 599,998 → 下限');
  assert.equal(rebalanceCallGasLimit(400_001n), 600_001n);
  console.log(`[gas] alto 367,885 → 簽名用 ${rebalanceCallGasLimit(367_885n)}（放大 63%）`);
});

test('countSwapExecuted：只算 executor 自己發的 SwapExecuted，別的合約的主題相同不算', () => {
  // topic0 由 cast 獨立算出（不是從受測模組的常數抄來的，所以字串寫錯會在這裡紅）。
  const topic0 = keccak256(toBytes('SwapExecuted(address,address,address,uint256,uint256,uint256,uint256,uint256)'));
  assert.equal(topic0, '0x30be1b3fa0cdc51a3f640c5fa1785b0c9aa2ed3e2e72a2d66a6bd6a9f65a71a7');

  const accountTopic = `0x${'0'.repeat(24)}${ACCOUNT.slice(2)}` as Hex;
  const swapLog = { address: EXECUTOR, topics: [topic0, accountTopic] as Hex[] };
  // 別的合約（例如 router 自己）也 emit 同一個主題：不是「這次執行換了幣」的證據。
  const foreignLog = { address: TOKEN_OUT, topics: [topic0] as Hex[] };
  // 別的合約的別的事件。
  const irrelevantLog = { address: EXECUTOR, topics: [keccak256(toBytes('Transfer(address,address,uint256)'))] as Hex[] };

  assert.equal(countSwapExecuted([], EXECUTOR), 0);
  assert.equal(countSwapExecuted([swapLog], EXECUTOR), 1);
  assert.equal(countSwapExecuted([swapLog, swapLog], EXECUTOR), 2, '2 個 step → 2 筆');
  assert.equal(countSwapExecuted([foreignLog], EXECUTOR), 0, 'emitter 不是 executor → 不算');
  assert.equal(countSwapExecuted([irrelevantLog], EXECUTOR), 0, '主題不同 → 不算');
  assert.equal(countSwapExecuted([swapLog, foreignLog, irrelevantLog, swapLog], EXECUTOR), 2);
  // 大小寫不影響（RPC 回來的是小寫 hex，設定檔裡是 checksum 過的）。
  assert.equal(countSwapExecuted([{ address: EXECUTOR.toLowerCase() as Address, topics: [topic0.toUpperCase().replace('0X', '0x') as Hex] }], EXECUTOR), 1);
  console.log('[swap] emitter 過濾：executor 2 筆、別的合約 0 筆');
});

test('judgeRebalanceOutcome：三層缺一不可，任何一層沒過都不是 success', () => {
  const ok = { txStatus: 'success' as const, userOpSuccess: true, swapExecuted: 1, expectedSwaps: 1, txHash: '0xdef456' as Hex, userOpHash: '0xabc123' as Hex, gasUsed: '250000' };

  const success = judgeRebalanceOutcome(ok);
  assert.equal(success.status, 'success', '三層都成立才是 success');
  assert.equal(success.error, null);
  assert.equal(success.txHash, '0xdef456');
  assert.equal(success.gasUsed, '250000');

  // ---- 缺陷 B 的形狀：上鏈、status = 1、gas 花了、什麼都沒換 ----------------------------------
  const swallowed = judgeRebalanceOutcome({ ...ok, userOpSuccess: false, swapExecuted: 0 });
  assert.equal(swallowed.status, 'reverted', '「上鏈但 op 失敗」**不是** success（success → confirmed → 永不再送）');
  assert.match(swallowed.error ?? '', /UserOperationEvent\.success = false/, '診斷要指名哪一層沒過');
  assert.match(swallowed.error ?? '', /SwapExecuted 0\/1/, '要寫出「換成幾筆／該有幾筆」');
  assert.match(swallowed.error ?? '', /gas 250000 已經花掉/, '要說明錢已經花了');
  assert.equal(swallowed.txHash, '0xdef456', 'txHash 仍要保留：鏈上真的有一筆');

  // 只缺第 3 層（op 成功但 steps 是空的，§8.1）：1+2 通過也還不夠。
  const emptySteps = judgeRebalanceOutcome({ ...ok, swapExecuted: 0, expectedSwaps: 1 });
  assert.equal(emptySteps.status, 'reverted');
  assert.match(emptySteps.error ?? '', /SwapExecuted 0\/1/);
  assert.doesNotMatch(emptySteps.error ?? '', /UserOperationEvent/, 'op 本身成功，原因就只有 SwapExecuted 那一層');

  // 部分成交：2 個 step 只換了 1 筆。
  const partial = judgeRebalanceOutcome({ ...ok, swapExecuted: 1, expectedSwaps: 2 });
  assert.equal(partial.status, 'reverted');
  assert.match(partial.error ?? '', /SwapExecuted 1\/2/);

  // 交易本身 revert（EntryPoint 就擋掉了）。
  const revertedTx = judgeRebalanceOutcome({ ...ok, txStatus: 'reverted' });
  assert.equal(revertedTx.status, 'reverted');
  assert.match(revertedTx.error ?? '', /tx status/);

  // 找不到 UserOperationEvent：沒有證據說 op 成功 → 不能叫 success。
  const noEvent = judgeRebalanceOutcome({ ...ok, userOpSuccess: null });
  assert.equal(noEvent.status, 'reverted');
  assert.match(noEvent.error ?? '', /找不到 UserOperationEvent/);

  console.log(`[judge] 缺陷 B 的形狀 → ${swallowed.status}｜${swallowed.error}`);
});

// ---------------------------------------------------------------------------
// 6. live 成功與 operations 的生命週期
// ---------------------------------------------------------------------------

test('live 成功：operations 一列 confirmed（attempts=1、有 tx_hash），last_rebalance_at 被更新', async () => {
  const db = stubDb({ portfolios: [portfolio()], sessionKeys: [sessionKey()] });
  const chain = stubChain();

  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['executed']);
  assert.equal(chain.executeCalls.length, 1);

  const sent = chain.executeCalls[0];
  assert.equal(sent?.account, ACCOUNT);
  assert.equal(sent?.executor, EXECUTOR);
  assert.equal(sent?.steps.length, 1);
  assert.equal(sent?.deadline, 1_800_000_300n);

  assert.equal(db.operations.length, 1, '一次執行只寫一列');
  const op = db.operations[0];
  assert.equal(op?.state, 'confirmed');
  assert.equal(op?.attempts, 1);
  assert.equal(op?.txHash, '0xdef456');
  assert.equal(op?.userOpHash, '0xabc123');
  assert.equal(op?.lastError, null);
  assert.equal(op?.idempotencyKey, `rebalance:${PORTFOLIO_ID}:${round.results[0]?.plan?.planHash}`);
  assert.equal(op?.payloadHash, round.results[0]?.plan?.planHash, 'payload_hash = planHash（audit 可重建）');

  assert.deepEqual(
    chain.permissionReads.map((read) => read.account),
    [ACCOUNT],
    'permissionConfig 要讀 **smart account**，不是 owner（owner 身上沒有這個函式）',
  );

  assert.equal(db.portfolios[0]?.lastCheckedAt?.toISOString(), NOW.toISOString(), 'last_checked_at 一定會更新');
  assert.equal(db.portfolios[0]?.lastRebalanceAt?.toISOString(), NOW.toISOString(), '真的有執行才更新 last_rebalance_at');
  console.log(`[executed] ${round.results[0]?.reason}`);
});

test('上鏈但 op 失敗 → operations 記 reverted（帶診斷）且**不**更新 last_rebalance_at', async () => {
  const db = stubDb({ portfolios: [portfolio()], sessionKeys: [sessionKey()] });
  // 缺陷 B 的形狀：tx.status = 1、gas 花了、SwapExecuted 0 筆。判定必須是 reverted 而不是 success。
  const diagnosis = '上鏈但 op 沒有成功（UserOperationEvent.success = false（EntryPoint 吞掉了執行失敗）；SwapExecuted 0/1 筆（沒有全部換成）），gas 537605 已經花掉';
  const chain = stubChain({
    executeResult: { status: 'reverted', userOpHash: '0xabc123', txHash: '0xdef456', gasUsed: '537605', error: diagnosis },
  });

  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['failed'], '「上鏈但什麼都沒換」不是 executed');
  assert.match(round.results[0]?.reason ?? '', /上鏈但沒有成功/, 'CLI 摘要不能說「已上鏈」');
  assert.match(round.results[0]?.reason ?? '', /UserOperationEvent\.success = false/, '摘要要帶診斷');

  assert.equal(db.operations.length, 1);
  assert.equal(db.operations[0]?.state, 'reverted', 'reverted 才允許同一個 key 重試；confirmed 會永久放棄那組參數');
  assert.equal(db.operations[0]?.txHash, '0xdef456', '鏈上真的有一筆，tx_hash 要留著');
  assert.match(db.operations[0]?.lastError ?? '', /UserOperationEvent\.success = false/, 'last_error 要能診斷');
  assert.match(db.operations[0]?.lastError ?? '', /SwapExecuted 0\/1/, 'last_error 要寫出換成幾筆');
  assert.equal(
    db.portfolios[0]?.lastRebalanceAt,
    null,
    'last_rebalance_at 只在真正的 success 更新：gas 花了但什麼都沒換不算再平衡過',
  );
  assert.equal(db.portfolios[0]?.lastCheckedAt?.toISOString(), NOW.toISOString(), 'last_checked_at 仍然要更新');
  console.log(`[op-failed] ${round.results[0]?.reason}`);
});

test('idempotency_key 重複（已 confirmed）：不重複寫入、也不重複執行', async () => {
  const planHash = planHashFor([step()], 1_800_000_300n);
  const db = stubDb({
    portfolios: [portfolio()],
    sessionKeys: [sessionKey()],
    operations: [
      {
        portfolioId: PORTFOLIO_ID,
        idempotencyKey: idempotencyKeyFor(PORTFOLIO_ID, planHash),
        payloadHash: planHash,
        state: 'confirmed',
        attempts: 1,
        txHash: '0xold',
        userOpHash: '0xolduo',
        lastError: null,
      },
    ],
  });
  const chain = stubChain();

  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['noop'], '同一組參數已經上鏈成功過 → 什麼都不做（不是 blocked）');
  assert.match(round.results[0]?.reason ?? '', /confirmed/);
  assert.equal(db.operations.length, 1, '**不重複寫入**：還是一列');
  assert.equal(db.operations[0]?.attempts, 1, 'attempts 不該增加');
  assert.equal(chain.executeCalls.length, 0, '**不重複執行**：這正是 idempotency_key 存在的理由');
  console.log(`[idempotent] ${round.results[0]?.reason}`);
});

test('idempotency_key 重複（已 failed）：允許重試，attempts 累加到 2，仍然只有一列', async () => {
  const planHash = planHashFor([step()], 1_800_000_300n);
  const db = stubDb({
    portfolios: [portfolio()],
    sessionKeys: [sessionKey()],
    operations: [
      {
        portfolioId: PORTFOLIO_ID,
        idempotencyKey: idempotencyKeyFor(PORTFOLIO_ID, planHash),
        payloadHash: planHash,
        state: 'failed',
        attempts: 1,
        txHash: null,
        userOpHash: null,
        lastError: '上一次送出失敗',
      },
    ],
  });
  const chain = stubChain();

  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['executed']);
  assert.equal(db.operations.length, 1, '重試是同一列，不是第二列');
  assert.equal(db.operations[0]?.attempts, 2, '**attempts 正確累加**');
  assert.equal(db.operations[0]?.state, 'confirmed');
  assert.equal(db.operations[0]?.lastError, null, '重試成功後 last_error 要清掉');
  assert.equal(chain.executeCalls.length, 1);
  console.log(`[retry] attempts=2，state=confirmed`);
});

test('idempotency_key 重複（還在 pending）：視為在途，blocked 不重送（不是 noop——那不是「不需要動」）', async () => {
  const planHash = planHashFor([step()], 1_800_000_300n);
  const db = stubDb({
    portfolios: [portfolio()],
    sessionKeys: [sessionKey()],
    operations: [
      {
        portfolioId: PORTFOLIO_ID,
        idempotencyKey: idempotencyKeyFor(PORTFOLIO_ID, planHash),
        payloadHash: planHash,
        state: 'pending',
        attempts: 1,
        txHash: null,
        userOpHash: null,
        lastError: null,
      },
    ],
  });
  const chain = stubChain();

  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['blocked'], '結果未知的那一筆需要人看，不能記成 noop');
  assert.match(round.results[0]?.reason ?? '', /還在 pending/);
  assert.equal(chain.executeCalls.length, 0, '結果未知時重送的代價是重複動錢');
  assert.equal(db.operations.length, 1);
  assert.equal(db.operations[0]?.attempts, 1);
  console.log(`[in-flight] ${round.results[0]?.reason}`);
});

test('送出拋錯 → failed + last_error（不是 reverted：沒有證據說它上鏈了）', async () => {
  const db = stubDb({ portfolios: [portfolio()], sessionKeys: [sessionKey()] });
  const chain = stubChain({ executeError: 'alto 拒絕：AA23 invalid account signature' });

  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['failed']);
  assert.match(round.results[0]?.reason ?? '', /AA23/);
  assert.equal(db.operations.length, 1);
  assert.equal(db.operations[0]?.state, 'failed');
  assert.match(db.operations[0]?.lastError ?? '', /AA23/, '失敗原因留在 DB（log 會被輪替，DB 不會）');
  assert.equal(db.operations[0]?.txHash, null);
  assert.equal(db.portfolios[0]?.lastRebalanceAt, null, '沒有成功就不更新 last_rebalance_at');
  console.log(`[failed] ${round.results[0]?.reason}`);
});

test('一個 portfolio 拋錯不會讓整輪停擺：它自己變 blocked，其他的照跑', async () => {
  const db = stubDb({
    portfolios: [portfolio({ id: 1 }), portfolio({ id: 2 })],
    // 兩個 portfolio 各自要有一把裝好的 key，否則第 2 個會停在「沒有 session key」而看不出隔離效果。
    sessionKeys: [sessionKey({ portfolioId: 1 }), sessionKey({ portfolioId: 2 })],
  });
  const chain = stubChain();
  const withFault = deps(db, chain, {
    planPortfolio: async (portfolioId: number) => {
      chain.planPortfolioCalls.push(portfolioId);
      if (portfolioId === 1) throw new Error('RPC 502 Bad Gateway');
      return chain.plan;
    },
  });

  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, withFault);

  assert.deepEqual(outcomes(round), ['blocked', 'executed'], '第 1 個擋下來，第 2 個照跑');
  assert.match(round.results[0]?.reason ?? '', /RPC 502/);
  assert.equal(round.claimed, 2);
});

// ---------------------------------------------------------------------------
// 7. 真 Postgres：認領的 SQL 與「認領即推進」
// ---------------------------------------------------------------------------

/**
 * 這一組存在的理由：上面所有認領的測試都用 stub，而 stub 證明不了 SQL 寫對了（它自己也在篩選）。
 * 這裡對**真的 Postgres** 驗四件事：paused／idle／未到期不被認領、NULL 會被認領、
 * `next_run_at` 與認領一起 commit、transaction 失敗時一起回滾。
 *
 * 用的是獨立的 `chain_id`（999_001…），所以不會碰到真實的 portfolio（claim 會 join smart_accounts
 * 的 chain_id）。收工時把自己造的列刪掉。
 */
const REAL_CHAIN_ID = 999_001;

async function dbReason(): Promise<string | null> {
  try {
    await query('select 1 from portfolios where next_run_at is null limit 0');
    await query('select 1 from operations where attempts = 0 limit 0');
    return null;
  } catch (cause) {
    return `Postgres 或 0012 不可用（${cause instanceof Error ? cause.message : String(cause)}）`;
  }
}

const dbSkip = await dbReason();
if (dbSkip !== null) console.warn(`[scheduler] 真 DB 的認領測試 skip：${dbSkip}`);
const dbGate = dbSkip === null ? {} : { skip: dbSkip };

after(async () => {
  await query('delete from portfolios where id in (select portfolio_id from smart_accounts where chain_id = $1)', [
    REAL_CHAIN_ID,
  ]).catch(() => {
    // DB 不可用時整組本來就 skip 了；這裡的失敗不該蓋掉測試結果。
  });
  await closePool().catch(() => {
    // 同上。
  });
});

/** 造一個只屬於這支測試的 portfolio（含 smart account）。回傳它的 id 與帳戶地址。 */
async function seedPortfolio(args: {
  state: 'idle' | 'active' | 'paused';
  nextRunAt: Date | null;
  serial: number;
}): Promise<{ id: number; account: Address }> {
  // 這支測試要一個 strategy 只是為了 portfolio 的外鍵。**不要借別的測試留下的資料**：
  // 在乾淨的資料庫上（例如 CI 開一個新的）「select … limit 1」會回空，測試就變成
  // 「只有在別人的資料還在的時候才會過」—— 那不是測試，那是巧合。
  const strategy =
    (await query<{ id: string }>('select id from strategies order by id limit 1')).rows[0] ??
    (
      await query<{ id: string }>(
        `insert into strategies (provider, name) values ($1, $2) returning id`,
        ['0xscheduler-test', 'scheduler test fixture'],
      )
    ).rows[0];
  if (strategy === undefined) throw new Error('造不出測試用的 strategy（外鍵）');
  // portfolio.version = 1，而認領查詢會 join `strategy_versions` 拿 interval（DB 決定節奏）。
  // 少這一列 → join 不到 → next_run_at 的斷言會拿到 undefined。所以 fixture 要含版本。
  await query(
    `insert into strategy_versions (strategy_id, version, allocation, schedule, active_at)
     values ($1, 1, $2::jsonb, $3::jsonb, now())
     on conflict (strategy_id, version) do nothing`,
    [
      strategy.id,
      JSON.stringify({ assets: [{ address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', weightBps: 10_000 }] }),
      JSON.stringify({ kind: 'interval', intervalSeconds: 3_600 }),
    ],
  );
  // 地址必須是 unique(chain_id, address) 且符合 0x+40 hex：用 serial 造一個可預期的。
  const account = `0x${args.serial.toString(16).padStart(40, '0')}` as Address;
  const inserted = (
    await query<{ id: string }>(
      `insert into portfolios (user_id, strategy_id, version, schedule_state, next_run_at)
       values ($1, $2, 1, $3, $4) returning id`,
      [`0xscheduler-test-${args.serial}`, strategy.id, args.state, args.nextRunAt],
    )
  ).rows[0];
  if (inserted === undefined) throw new Error('insert portfolio 沒有回傳 id');
  const id = Number(inserted.id);
  await query(
    `insert into smart_accounts (portfolio_id, chain_id, address, owner, account_type)
     values ($1, $2, $3, $4, 'KERNEL')`,
    [id, REAL_CHAIN_ID, account, '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'],
  );
  return { id, account };
}

test('認領（真的 Postgres）：paused／idle／未到期不被認領，NULL 會；next_run_at 與認領一起 commit', dbGate, async () => {
  // 先清掉上一輪可能留下的殘骸（同一個 chain_id 的 smart_accounts → portfolios）。
  await query('delete from portfolios where id in (select portfolio_id from smart_accounts where chain_id = $1)', [
    REAL_CHAIN_ID,
  ]);

  const due = await seedPortfolio({ state: 'active', nextRunAt: null, serial: 1 });
  const overdue = await seedPortfolio({ state: 'active', nextRunAt: new Date(Date.now() - 60_000), serial: 2 });
  const paused = await seedPortfolio({ state: 'paused', nextRunAt: null, serial: 3 });
  const idle = await seedPortfolio({ state: 'idle', nextRunAt: null, serial: 4 });
  const future = await seedPortfolio({ state: 'active', nextRunAt: new Date(Date.now() + 3_600_000), serial: 5 });

  const now = new Date();
  const claimed = await claimDuePortfolios(50, now, { chainId: REAL_CHAIN_ID });
  const ids = claimed.map((entry) => entry.portfolioId).sort((left, right) => left - right);

  assert.deepEqual(ids, [due.id, overdue.id].sort((left, right) => left - right), '只有 due 與 overdue 會被認領');
  for (const excluded of [paused.id, idle.id, future.id]) {
    assert.ok(!ids.includes(excluded), `portfolio ${excluded}（paused／idle／未到期）不該被認領`);
  }

  // next_run_at 真的寫進去了，而且 = now + intervalSeconds（interval 由 DB 的 schedule 決定）。
  for (const entry of claimed) {
    const row = (
      await query<{ next_run_at: Date; interval_seconds: string | null }>(
        `select p.next_run_at, (sv.schedule->>'intervalSeconds') as interval_seconds
           from portfolios p
           join strategy_versions sv on sv.strategy_id = p.strategy_id and sv.version = p.version
          where p.id = $1`,
        [entry.portfolioId],
      )
    ).rows[0];
    assert.ok(row !== undefined);
    assert.equal(
      new Date(row.next_run_at).toISOString(),
      entry.nextRunAt.toISOString(),
      '回傳值必須就是寫進 DB 的那個值',
    );
    const expected = now.getTime() + Number(row.interval_seconds) * 1_000;
    assert.ok(
      Math.abs(new Date(row.next_run_at).getTime() - expected) <= 1_000,
      `next_run_at 應該是 now + intervalSeconds（差 ${Math.abs(new Date(row.next_run_at).getTime() - expected)}ms）`,
    );
  }

  // 再跑一次同一輪：已經推進過，所以一個都撿不到（這正是「不會重複認領」）。
  const second = await claimDuePortfolios(50, new Date(), { chainId: REAL_CHAIN_ID });
  assert.deepEqual(second, [], '同一輪再跑一次，一個都不該被重複認領');

  console.log(
    `[claim/真 DB] 認領 ${claimed.map((entry) => `${entry.portfolioId}(${entry.intervalSeconds}s)`).join(', ')}；` +
      `排除 paused=${paused.id} idle=${idle.id} future=${future.id}`,
  );

  await query('delete from portfolios where id in (select portfolio_id from smart_accounts where chain_id = $1)', [
    REAL_CHAIN_ID,
  ]);
});

test('缺陷 3（真的 Postgres）：advance: false 一位都不寫；預設（live）才把 next_run_at 推進', dbGate, async () => {
  await query('delete from portfolios where id in (select portfolio_id from smart_accounts where chain_id = $1)', [
    REAL_CHAIN_ID,
  ]);

  const overdueAt = new Date(Date.now() - 60_000);
  const fresh = await seedPortfolio({ state: 'active', nextRunAt: null, serial: 11 });
  const overdue = await seedPortfolio({ state: 'active', nextRunAt: overdueAt, serial: 12 });
  const ids = [fresh.id, overdue.id];

  /** 直接從 DB 讀（證明的是 SQL，不是 stub 的記憶體狀態）。 */
  const readNextRunAt = async (): Promise<Map<number, string | null>> => {
    const rows = (
      await query<{ id: string; next_run_at: Date | null }>(
        'select id, next_run_at from portfolios where id = any($1::bigint[])',
        [ids],
      )
    ).rows;
    return new Map(rows.map((row) => [Number(row.id), row.next_run_at === null ? null : new Date(row.next_run_at).toISOString()]));
  };

  const before = await readNextRunAt();
  assert.equal(before.get(fresh.id), null, '前提：fresh 的 next_run_at 是 NULL');
  assert.ok(Math.abs(new Date(before.get(overdue.id) ?? 0).getTime() - overdueAt.getTime()) <= 1_000);

  // dry-run：認領得到，但**一位都不寫**。
  const dryClaimed = await claimDuePortfolios(50, new Date(), { chainId: REAL_CHAIN_ID, advance: false });
  assert.deepEqual(dryClaimed.map((entry) => entry.portfolioId).sort((a, b) => a - b), ids.sort((a, b) => a - b));

  const afterDry = await readNextRunAt();
  assert.equal(afterDry.get(fresh.id), null, '**dry-run 之後 DB 的 next_run_at 必須還是 NULL**');
  assert.equal(
    afterDry.get(overdue.id),
    before.get(overdue.id),
    '**dry-run 之後仍然是原本那個逾期時間**（沒有被推到 24 小時後）',
  );
  console.log(`[缺陷 3/真 DB] dry-run：${fresh.id} NULL→${afterDry.get(fresh.id) ?? 'NULL'}；${overdue.id} ${before.get(overdue.id)}→${afterDry.get(overdue.id)}`);

  // 觀察不改變被觀察的系統：再跑一次 dry-run，還是同一批。
  const dryAgain = await claimDuePortfolios(50, new Date(), { chainId: REAL_CHAIN_ID, advance: false });
  assert.deepEqual(dryAgain.map((entry) => entry.portfolioId).sort((a, b) => a - b), ids, '連續兩次 dry-run 看到同樣的 portfolio（正確且可預期）');
  assert.equal((await readNextRunAt()).get(fresh.id), null);

  // live（預設 advance: true）：推進，而且 = 回傳值。
  const liveClaimed = await claimDuePortfolios(50, new Date(), { chainId: REAL_CHAIN_ID });
  assert.equal(liveClaimed.length, 2, 'live 仍然認領得到（dry-run 沒有把它們藏起來）');
  const afterLive = await readNextRunAt();
  for (const entry of liveClaimed) {
    assert.equal(
      afterLive.get(entry.portfolioId),
      entry.nextRunAt.toISOString(),
      'live：DB 的值必須就是認領回傳的那個值（認領即推進）',
    );
  }
  console.log(`[缺陷 3/真 DB] live：${liveClaimed.map((entry) => `${entry.portfolioId}→${afterLive.get(entry.portfolioId)}`).join(', ')}`);

  await query('delete from portfolios where id in (select portfolio_id from smart_accounts where chain_id = $1)', [
    REAL_CHAIN_ID,
  ]);
});

// ---------------------------------------------------------------------------
// 部分執行 → next_run_at 提前（拆單的排程那一半）
// ---------------------------------------------------------------------------

/**
 * 三種結果三種間隔：
 *   * 完全收斂（沒被縮）→ 完整 `intervalSeconds`
 *   * 部分執行（有 step 被縮）→ `min(intervalSeconds, PARTIAL_FOLLOW_UP_SECONDS)`
 *   * blocked／noop／failed → 完整 `intervalSeconds`（沒有進展就不該密集重試）
 *
 * 「認領時在同一個 transaction 內推進」那個語意**不動**：認領照樣先寫完整間隔，
 * 這一組測的是結果已知之後把它**拉近**（只拉近、不延後）。
 */
test('排程：部分執行 → next_run_at 用短間隔（不是完整的一天）', async () => {
  const db = stubDb({ portfolios: [portfolio({ nextRunAt: null })], sessionKeys: [sessionKey()] });
  const chain = stubChain({ rebalance: partialPlan() });
  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['executed']);
  const expected = new Date(NOW.getTime() + PARTIAL_FOLLOW_UP_SECONDS * 1_000);
  assert.equal(db.portfolios[0]?.nextRunAt?.toISOString(), expected.toISOString());
  assert.equal(round.results[0]?.nextRunAt.toISOString(), expected.toISOString(), '回傳值就是 DB 的值');
  assert.ok(
    expected.getTime() < NOW.getTime() + ONE_DAY_SECONDS * 1_000,
    '短間隔必須**早於**完整間隔（不然等於沒改）',
  );
  assert.match(round.results[0]?.reason ?? '', /Partial execution/);
  // 理由要說得出「執行後還剩多少」——這才是排程器提早再跑的原因（不是「有 step 被縮小」）。
  assert.match(round.results[0]?.reason ?? '', /estimated drift is still 1000 bps/);
  assert.match(round.results[0]?.reason ?? '', /moved up to/, '要說清楚為什麼下一次那麼近');

  // 認領那一條仍在 transaction 內（語意不變）；把時間拉近的是**第二條**、在 transaction 之後。
  const advance = db.statements.filter((entry) => entry.sql.includes('set next_run_at = claimed.next_run_at'));
  assert.equal(advance.length, 2, '認領一條、部分執行的修正一條');
  assert.equal(advance[0]?.inTransaction, true, '認領即推進：仍然在認領的 transaction 內');
  assert.equal(advance[1]?.inTransaction, false, '部分執行的修正發生在結果已知之後（transaction 外）');
});

// 回歸（實測踩到）：這一輪**買進帳戶沒持有的資產** → 執行後的漂移算不出來。
//
// 錯的做法：拿「執行前的漂移」當剩餘量，於是理由寫「still 6600 bps after this round」並把下一次
// 提前到 30 分鐘後 —— 而實際那一輪把 6600 收斂到 6 bps。用算不出來的缺口去調度，等於用猜的。
test('排程：執行後漂移算不出來（remainingDriftBps 是 null）→ 不提前 next_run_at，並說明算不出來', async () => {
  const db = stubDb({ portfolios: [portfolio({ nextRunAt: null })], sessionKeys: [sessionKey()] });
  // `partialPlan()` 的 partial 一定有 `remainingDriftBps: number`；這裡要的是「算不出來」那種，
  // 所以直接改欄位再組回去（`RebalancePlan` 是聯合型別，展開後 kind 會被放寬）。
  const base = partialPlan();
  const withNull: RebalancePlan = { ...base, partial: { remainingDriftBps: null, shrunk: [] } } as RebalancePlan;
  const chain = stubChain({ rebalance: withNull });
  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['executed']);
  const claimed = round.results[0]?.nextRunAt.toISOString();
  assert.equal(
    db.portfolios[0]?.nextRunAt?.toISOString(),
    claimed,
    '算不出來就不該改 next_run_at —— 維持認領時寫入的完整間隔',
  );
  const reason = round.results[0]?.reason ?? '';
  assert.match(reason, /cannot be estimated yet/, `理由要說算不出來（實際：${reason}）`);
  assert.doesNotMatch(reason, /estimated drift is still/, '不能把算不出來的缺口講成一個具體數字');
  assert.doesNotMatch(reason, /moved up to/, '沒有提前，就不該說提前');

  const advance = db.statements.filter((entry) => entry.sql.includes('set next_run_at = claimed.next_run_at'));
  assert.equal(advance.length, 1, '只有認領那一條，沒有第二條修正');
});

test('排程：完全收斂（執行後預估漂移已回到門檻下）→ 完整間隔，寫入的還是認領算好的那個值', async () => {
  const db = stubDb({ portfolios: [portfolio({ nextRunAt: null })], sessionKeys: [sessionKey()] });
  const chain = stubChain(); // readyPlan()：沒有 partial
  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['executed']);
  const expected = new Date(NOW.getTime() + ONE_DAY_SECONDS * 1_000);
  assert.equal(db.portfolios[0]?.nextRunAt?.toISOString(), expected.toISOString());
  assert.equal(round.results[0]?.nextRunAt.toISOString(), expected.toISOString());
  const advance = db.statements.filter((entry) => entry.sql.includes('set next_run_at = claimed.next_run_at'));
  assert.equal(advance.length, 1, '沒有部分執行就只有認領那一條 UPDATE');
});

test('排程：部分執行但被前置檢查擋下（blocked）→ 仍然用完整間隔（沒進展就不密集重試）', async () => {
  const db = stubDb({ portfolios: [portfolio({ nextRunAt: null })], sessionKeys: [] }); // 沒有 session key
  const chain = stubChain({ rebalance: partialPlan() });
  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['blocked']);
  assert.equal(
    db.portfolios[0]?.nextRunAt?.toISOString(),
    new Date(NOW.getTime() + ONE_DAY_SECONDS * 1_000).toISOString(),
    'blocked 用完整間隔（不是 15 分鐘的熱迴圈）',
  );
  assert.doesNotMatch(round.results[0]?.reason ?? '', /moved up to/);
});

test('排程：部分執行但送出失敗（failed）→ 完整間隔（別把 operations 的嘗試次數燒光）', async () => {
  const db = stubDb({ portfolios: [portfolio({ nextRunAt: null })], sessionKeys: [sessionKey()] });
  const chain = stubChain({
    rebalance: partialPlan(),
    executeResult: { status: 'error', userOpHash: null, txHash: null, gasUsed: null, error: 'boom' },
  });
  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['failed']);
  assert.equal(
    db.portfolios[0]?.nextRunAt?.toISOString(),
    new Date(NOW.getTime() + ONE_DAY_SECONDS * 1_000).toISOString(),
  );
});

test('排程：noop（漂移未達門檻）→ 完整間隔', async () => {
  const db = stubDb({ portfolios: [portfolio({ nextRunAt: null })], sessionKeys: [sessionKey()] });
  const chain = stubChain({ plan: stubPlan({ needsRebalance: false }) });
  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['noop']);
  assert.equal(
    db.portfolios[0]?.nextRunAt?.toISOString(),
    new Date(NOW.getTime() + ONE_DAY_SECONDS * 1_000).toISOString(),
  );
});

test('排程：dry-run 的部分執行 → next_run_at 一位都不寫（觀察不改變被觀察的系統）', async () => {
  const db = stubDb({ portfolios: [portfolio({ nextRunAt: null })], sessionKeys: [sessionKey()] });
  const chain = stubChain({ rebalance: partialPlan() });
  const round = await runSchedulerOnce({ now: NOW }, deps(db, chain)); // 預設 dryRun = true

  assert.deepEqual(outcomes(round), ['ready-dry-run']);
  assert.equal(db.portfolios[0]?.nextRunAt ?? null, null, 'dry-run 連認領那一條都不發，更不該有修正');
  assert.equal(
    db.statements.some((entry) => entry.sql.includes('set next_run_at = claimed.next_run_at')),
    false,
  );
});

test('排程器送出的 deadlineSeconds 就是規劃器的預設（1800，不是另一個 300）', () => {
  // 排程器把 deadlineSeconds **顯式**傳進 planRebalance，所以這個常數會蓋掉規劃器的預設 ——
  // 兩邊各自寫一個數字就是稀疏挖礦那筆 DeadlineExpired 沒被修到的原因。
  assert.equal(DEFAULT_DEADLINE_SECONDS, 1_800);
  assert.equal(DEFAULT_DEADLINE_SECONDS, PLANNER_DEFAULT_DEADLINE_SECONDS, '只能有一個來源');
});

test('排程：部分執行的跟進間隔是 min(intervalSeconds, 1800)——等於 TWAP 視窗，不是半個', async () => {
  assert.equal(PARTIAL_FOLLOW_UP_SECONDS, 1_800, '900（半個 TWAP 視窗）是收斂減速的來源');

  const db = stubDb({ portfolios: [portfolio({ nextRunAt: null })], sessionKeys: [sessionKey()] });
  const chain = stubChain({ rebalance: partialPlan() });
  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['executed']);
  const expected = new Date(NOW.getTime() + 1_800 * 1_000);
  assert.equal(db.portfolios[0]?.nextRunAt?.toISOString(), expected.toISOString());
  assert.equal(round.results[0]?.nextRunAt.toISOString(), expected.toISOString());
  // 一天（86400s）比 1800s 長，所以 min() 取 1800；舊值 900 會被這條擋掉。
  assert.notEqual(db.portfolios[0]?.nextRunAt?.toISOString(), new Date(NOW.getTime() + 900 * 1_000).toISOString());
  assert.ok(ONE_DAY_SECONDS > PARTIAL_FOLLOW_UP_SECONDS, '完整間隔比跟進間隔長，min() 才會生效');
  assert.match(round.results[0]?.reason ?? '', /1800s/);
});

test('排程：短間隔是 min(intervalSeconds, 1800)——本來就更短的排程不會被延後', async () => {
  const db = stubDb({
    portfolios: [portfolio({ nextRunAt: null, schedule: { kind: 'interval', intervalSeconds: 300 } })],
    sessionKeys: [sessionKey()],
  });
  const chain = stubChain({ rebalance: partialPlan() });
  const round = await runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain));

  assert.deepEqual(outcomes(round), ['executed']);
  assert.equal(
    db.portfolios[0]?.nextRunAt?.toISOString(),
    new Date(NOW.getTime() + 300 * 1_000).toISOString(),
    '300s 的排程用 300s，不是 1800s（不能把本來密的排程變鬆）',
  );
  assert.equal(round.results[0]?.nextRunAt.toISOString(), db.portfolios[0]?.nextRunAt?.toISOString());
});

// ---------------------------------------------------------------------------
// 送出前重問地板（plan → execute 之間池價會動）
// ---------------------------------------------------------------------------

/** 自己一份 V3 payload 的 ABI（不從被測檔案 import，否則編錯會一起錯）。 */
const V3_INPUT_ABI = [
  { name: 'recipient', type: 'address' },
  { name: 'amountIn', type: 'uint256' },
  { name: 'amountOutMin', type: 'uint256' },
  { name: 'path', type: 'bytes' },
  { name: 'payerIsUser', type: 'bool' },
] as const;

/**
 * 一個**真的可以解回 recipient / path** 的 step（`refreshFloors` 要靠這兩個重建 inputs）。
 * `step()` 的 `inputs: ['0x']` 只夠給不重問地板的測試用。
 */
function encodableStep(overrides: Partial<PlannedStep> = {}): PlannedStep {
  const amountIn = 250_000_000_000_000_000n;
  const amountOutMin = 500_000_000_000_000_000n;
  const poolFee = 2500;
  const path = encodePacked(['address', 'uint24', 'address'], [TOKEN_IN, poolFee, TOKEN_OUT]);
  return {
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amountIn,
    amountOutMin,
    oracleFloor: amountOutMin,
    commands: '0x00',
    inputs: [encodeAbiParameters(V3_INPUT_ABI, [EXECUTOR, amountIn, amountOutMin, path, true])],
    ...overrides,
  };
}

/** 只認 `previewSwap` 的 stub client：回 `[quoted, minimum]`，或丟出指定的錯誤。 */
function floorClient(result: { minimum: bigint; quoted?: bigint } | { error: Error }): PublicClient {
  return {
    readContract: async (args: { functionName: string }) => {
      if (args.functionName !== 'previewSwap') throw new Error(`stub 沒有 ${args.functionName}`);
      if ('error' in result) throw result.error;
      return [result.quoted ?? result.minimum, result.minimum];
    },
  } as unknown as PublicClient;
}

/** 排程器的一輪 live：portfolio 到期待跑，鏈上安裝狀態齊全。 */
function dueRound(chain: StubChain): { db: StubDb; round: Promise<{ results: PortfolioRunResult[] }> } {
  const db = stubDb({ portfolios: [portfolio({ nextRunAt: null })], sessionKeys: [sessionKey()] });
  return { db, round: runSchedulerOnce({ dryRun: false, now: NOW }, deps(db, chain)) };
}

test('稽核快照：executed 的一輪寫 before + after，兩張共用 operationId，after 是重新讀鏈的觀測', async () => {
  const chain = stubChain({ rebalance: readyPlan([encodableStep()]) });
  const db = stubDb({ portfolios: [portfolio({ nextRunAt: null })], sessionKeys: [sessionKey()] });
  const base = deps(db, chain);
  const written: { phase: string; operationId: unknown; block: bigint; pinned: unknown }[] = [];

  const round = await runSchedulerOnce(
    { dryRun: false, now: NOW },
    deps(db, chain, {
      // 排程器用 idempotency_key 反查 operations.id；stub 只認這一句，其餘交回原本的 stub。
      query: async (text, params) => {
        if (text.includes('from operations where idempotency_key')) return { rows: [{ id: '42' }] };
        if (base.query === undefined) throw new Error('base.query 不見了');
        return base.query(text, params);
      },
      writeSnapshot: async (snapshot, _report, options) => {
        written.push({
          phase: options?.phase ?? 'manual',
          operationId: options?.operationId ?? null,
          block: snapshot.block,
          pinned: options?.pinnedVersion ?? null,
        });
        return { headerInserted: true, inserted: 0, updated: 0 };
      },
    }),
  );

  assert.equal(round.results[0]?.outcome, 'executed');
  assert.deepEqual(
    written.map((row) => row.phase),
    ['before', 'after'],
    '一次成功的一輪要留下前後兩張：只有一張時「這一輪做了什麼」算不出來',
  );
  assert.equal(written[0]?.operationId, 42n, 'before 要連回 operations.id');
  assert.equal(written[1]?.operationId, 42n, 'before/after 共用同一個 operationId，才能配成前後');
  assert.equal(written[0]?.pinned, 1, '表頭要拿到 enrollment.version，不是 {version,...} 物件');
  assert.equal(
    chain.planPortfolioCalls.length,
    2,
    'after 那張必須重新讀鏈（沿用送出前的觀測等於自己抄一份給自己）',
  );
});

test('稽核快照：writeSnapshot 失敗不會讓已經上鏈的那一輪變成失敗', async () => {
  const chain = stubChain({ rebalance: readyPlan([encodableStep()]) });
  const db = stubDb({ portfolios: [portfolio({ nextRunAt: null })], sessionKeys: [sessionKey()] });

  const base = deps(db, chain);
  const round = await runSchedulerOnce(
    { dryRun: false, now: NOW },
    deps(db, chain, {
      query: async (text, params) => {
        if (text.includes('from operations where idempotency_key')) return { rows: [{ id: '42' }] };
        if (base.query === undefined) throw new Error('base.query 不見了');
        return base.query(text, params);
      },
      writeSnapshot: async () => {
        throw new Error('stub：快照表寫不進去');
      },
    }),
  );

  assert.equal(round.results[0]?.outcome, 'executed', '快照是觀測，不該決定這一輪的成敗');
  assert.equal(chain.executeCalls.length, 1);
});

test('重問地板：排程器送出的 amountOutMin 是**新鮮值**，planHash／idempotency_key 也跟著它（不是規劃值）', async () => {
  const planned = encodableStep();
  const fresh = encodableStep({ amountOutMin: 510_000_000_000_000_000n, oracleFloor: 510_000_000_000_000_000n });
  const chain = stubChain({
    rebalance: readyPlan([planned]),
    refresh: async () => ({ ok: true, steps: [fresh], refreshes: [], note: 'stub：地板 +20000 bps' }),
  });

  const { db, round } = dueRound(chain);
  const result = (await round).results[0]!;

  assert.equal(result.outcome, 'executed');
  assert.equal(chain.refreshCalls.length, 1, '送出前一定要問一次地板');
  assert.equal(chain.refreshCalls[0]?.strategyId, 1n, 'effectiveFeeBps 的 key 是鏈上 strategy id');
  assert.equal(chain.refreshCalls[0]?.executor, EXECUTOR, 'oracle 從 executor.oracle() 讀，所以要傳 executor');
  assert.equal(
    chain.executeCalls[0]?.steps[0]?.amountOutMin,
    510_000_000_000_000_000n,
    '上鏈的是新鮮的地板，不是規劃時凍結的那一個',
  );
  assert.deepEqual(
    chain.executeCalls[0]?.steps[0]?.inputs,
    fresh.inputs,
    'inputs 裡的 amountOutMin 也要是新的：那是 router 的滑價檢查（合約今天不會替我們覆寫它）',
  );
  assert.equal(
    result.plan?.planHash,
    planHashFor([fresh], 1_800_000_300n),
    'planHash 必須描述真的會上鏈的那組參數（operations.payload_hash 就是它）',
  );
  assert.notEqual(result.plan?.planHash, planHashFor([planned], 1_800_000_300n), '不能還是規劃值那個 hash');
  assert.equal(db.operations[0]?.payloadHash, result.plan?.planHash);
});

test('重問地板失敗（問不到）→ blocked：一筆都不送、operations 一列都不寫', async () => {
  const chain = stubChain({
    rebalance: readyPlan([encodableStep()]),
    refresh: async () => ({
      ok: false,
      kind: 'quote-failed',
      reason: '送出前重問地板失敗：step#0 previewSwap(...)（TwapUnavailable）',
    }),
  });

  const { db, round } = dueRound(chain);
  const result = (await round).results[0]!;

  assert.equal(result.outcome, 'blocked', '問不到地板是「這一輪不做」，不是「試過了失敗」');
  assert.match(result.reason, /重問地板失敗/);
  assert.equal(chain.executeCalls.length, 0, '沒有新鮮的地板就不簽名、不送');
  assert.equal(db.operations.length, 0, 'blocked 不是「試過了」：不該留下 operations');
});

test('重問地板失敗（地板崩掉）→ noop：市場狀態不是設定錯，而且同樣不送', async () => {
  const chain = stubChain({
    rebalance: readyPlan([encodableStep()]),
    refresh: async () => ({
      ok: false,
      kind: 'floor-collapsed',
      reason: `送出前重問地板：step#0 差 -${MAX_FLOOR_WORSENING_BPS} bps 已超過惡化上限`,
    }),
  });

  const { db, round } = dueRound(chain);
  const result = (await round).results[0]!;

  assert.equal(result.outcome, 'noop');
  assert.equal(chain.executeCalls.length, 0);
  assert.equal(db.operations.length, 0);
});

test('refreshFloors：用**新鮮值**（不是 max(規劃, 新鮮)），並重建 inputs 讓 router 也拿到新地板', async () => {
  const planned = encodableStep({ oracleFloor: 500_000_000_000_000_000n, amountOutMin: 500_000_000_000_000_000n });
  // 地板變差 50 bps（還在 MAX_FLOOR_WORSENING_BPS 之內）：新鮮值比規劃值**低**。取 max 會留下 500e15，
  // 那正是「用過期的高值去擋已經下來的成交」（router 就 revert Too little received）。
  const freshFloor = 497_500_000_000_000_000n;
  const refreshed = await refreshFloors({ publicClient: floorClient({ minimum: freshFloor }), oracle: EXECUTOR, steps: [planned], feeBps: 0 });

  assert.equal(refreshed.ok, true);
  if (!refreshed.ok) return;
  assert.equal(refreshed.steps[0]?.amountOutMin, amountOutMinWithBuffer(freshFloor), '用新鮮值覆寫（max 會留 500e15），再加 buildStep 的緩衝');
  assert.equal(refreshed.steps[0]?.oracleFloor, freshFloor, 'oracleFloor 也換成新鮮值（它是稽核欄位）');
  const [, inputAmountIn, inputAmountOutMin, inputPath, payerIsUser] = decodeAbiParameters(
    V3_INPUT_ABI,
    refreshed.steps[0]!.inputs[0]!,
  );
  assert.equal(inputAmountOutMin, amountOutMinWithBuffer(freshFloor), 'inputs 裡的 amountOutMin 必須一起換：那是 router 的地板');
  assert.equal(inputAmountIn, planned.amountIn, 'amountIn 不該被動到');
  assert.equal(
    inputPath,
    encodePacked(['address', 'uint24', 'address'], [TOKEN_IN, 2500, TOKEN_OUT]),
    'path（含 fee tier）必須逐字保留',
  );
  assert.equal(payerIsUser, true);
  assert.equal(refreshed.refreshes[0]?.deltaBps, -50, '地板變差 0.5% ＝ -50 bps');
});

test('refreshFloors：地板變好時 deltaBps 是正的（規劃值與新鮮值的差距要看得見）', async () => {
  const planned = encodableStep({ oracleFloor: 500_000_000_000_000_000n, amountOutMin: 500_000_000_000_000_000n });
  const refreshed = await refreshFloors({
    publicClient: floorClient({ minimum: 505_000_000_000_000_000n }),
    oracle: EXECUTOR,
    steps: [planned],
    feeBps: 0,
  });
  assert.equal(refreshed.ok, true);
  if (!refreshed.ok) return;
  assert.equal(refreshed.refreshes[0]?.deltaBps, 100, '505/500 − 1 ＝ +100 bps');
  assert.equal(refreshed.steps[0]?.amountOutMin, amountOutMinWithBuffer(505_000_000_000_000_000n));
  assert.match(refreshed.note, /\+100 bps/);
});

test('refreshFloors：地板惡化超過上限 → floor-collapsed（不是照送），上限正好等於邊界時也擋', async () => {
  const planned = encodableStep({ oracleFloor: 500_000_000_000_000_000n, amountOutMin: 500_000_000_000_000_000n });
  // 差 100 bps ＝ 剛好 MAX_FLOOR_WORSENING_BPS：擋。
  const collapsed = await refreshFloors({
    publicClient: floorClient({ minimum: 495_000_000_000_000_000n }),
    oracle: EXECUTOR,
    steps: [planned],
    feeBps: 0,
  });
  assert.equal(collapsed.ok, false);
  if (collapsed.ok) return;
  assert.equal(collapsed.kind, 'floor-collapsed');
  assert.match(collapsed.reason, /-100 bps/);

  // 差 50 bps：還在預算內，照送（新鮮值）。
  const tolerated = await refreshFloors({
    publicClient: floorClient({ minimum: 497_500_000_000_000_000n }),
    oracle: EXECUTOR,
    steps: [planned],
    feeBps: 0,
  });
  assert.equal(tolerated.ok, true);
});

test('refreshFloors：previewSwap 失敗／minimum 是 0／inputs 解不開 → quote-failed（絕不回舊值）', async () => {
  const planned = encodableStep();

  const rpcDown = await refreshFloors({
    publicClient: floorClient({ error: new Error('HTTP request failed: 403 Forbidden') }),
    oracle: EXECUTOR,
    steps: [planned],
    feeBps: 0,
  });
  assert.equal(rpcDown.ok, false);
  if (rpcDown.ok) return;
  assert.equal(rpcDown.kind, 'quote-failed');
  assert.match(rpcDown.reason, /403 Forbidden/);

  const noFloor = await refreshFloors({ publicClient: floorClient({ minimum: 0n }), oracle: EXECUTOR, steps: [planned], feeBps: 0 });
  assert.equal(noFloor.ok, false);
  if (noFloor.ok) return;
  assert.equal(noFloor.kind, 'quote-failed');
  assert.match(noFloor.reason, /NoFloor/);

  // `step()` 的 inputs 是假值：連自己要送什麼都讀不出來時，不該覆寫它。
  const undecodable = await refreshFloors({
    publicClient: floorClient({ minimum: 1n }),
    oracle: EXECUTOR,
    steps: [step()],
    feeBps: 0,
  });
  assert.equal(undecodable.ok, false);
  if (undecodable.ok) return;
  assert.equal(undecodable.kind, 'quote-failed');
  assert.match(undecodable.reason, /inputs\[0\]/);
});

test('refreshFloors：feeBps 走 minGrossFor（fee 0 ≠ fee 2500），而且每個 step 各問一次', async () => {
  const planned = encodableStep({ oracleFloor: 500_000_000_000_000_000n, amountOutMin: 500_000_000_000_000_000n });
  const quoted: bigint[] = [];
  const client = {
    readContract: async () => {
      quoted.push(1n);
      return [500_000_000_000_000_000n, 500_000_000_000_000_000n];
    },
  } as unknown as PublicClient;

  const refreshed = await refreshFloors({ publicClient: client, oracle: EXECUTOR, steps: [planned, planned], feeBps: 2500 });
  assert.equal(refreshed.ok, true);
  if (!refreshed.ok) return;
  assert.equal(quoted.length, 2, '每一個 step 都要各問一次（地板是逐 step 的）');
  // ceil(500e15 * 10000 / 7500) ＝ 666_666_666_666_666_667
  assert.equal(
    refreshed.steps[0]?.amountOutMin,
    amountOutMinWithBuffer(666_666_666_666_666_667n),
    'minGross = ceil(floor * 10000/(10000−feeBps))，再加 buildStep 的 10 bps 緩衝',
  );
});
