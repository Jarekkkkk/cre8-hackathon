/**
 * 後端 API 客戶端。形狀照 `backend/src/server.ts` 的實際實作：
 *   POST /auth/nonce  -> SiweChallenge（無外層 wrapper）
 *   POST /auth/login  -> { message, signature } → { token, expiresAt }
 *   GET  /portfolios  -> Portfolio[]（**直接是陣列**，不是 { portfolios: [...] }）
 *   所有錯誤都是 { error: { code, message } }
 *
 * 一律走相對路徑 `/api`（dev 由 vite proxy 轉到 127.0.0.1:8081）。同源就沒有 CORS 與 preflight。
 */

const BASE: string = import.meta.env.VITE_API_BASE ?? '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export type SiweChallenge = {
  nonce: string;
  domain: string;
  chainId: number;
  uri: string;
  statement: string;
  version: string;
  issuedAt: string;
  expiresAt: string;
};

export type SessionCredentials = { token: string; expiresAt: string };

export type SmartAccountRef = {
  chainId: number;
  address: string;
  owner: string;
  accountType: string;
};

export type GasState = {
  address?: string;
  balanceWei?: string;
  minimumWei?: string;
  ready?: boolean;
  shortfallWei?: string;
  estimatedOps?: number;
} | null;

export type SessionKeyState = {
  permissionId: string;
  sessionKeyAddress: string;
  keyRef: string;
  expiresAt: string;
  status: string;
} | null;

export type Portfolio = {
  id: number;
  userId: string;
  strategyId: number;
  /** `strategies.name`（使用者取的基金名）。null = 這一列沒有 join 到策略，前端退回顯示 id。 */
  strategyName: string | null;
  version: number;
  scheduleState: string;
  createdAt: string;
  smartAccounts: SmartAccountRef[];
  gas: GasState;
  sessionKey: SessionKeyState;
};

export type DriftAssetRow = {
  asset: string;
  symbol: string;
  targetBps: number;
  currentBps: number;
  deltaBps: number;
  usdValueE8: string;
};

export type StatusHolding = {
  asset: string;
  symbol: string;
  amountWei: string;
  decimals: number;
  usdValueE8: string;
  priceSource: string;
};

export type SessionKeyReport = {
  /** DB 記的最新那把（＝`GET /portfolios` 顯示的那把）。**可能沒安裝在鏈上。** */
  configured: { permissionId: string; keyRef: string; installed: boolean; expiresAt: string | null; status: string | null } | null;
  /** 排程器實際會用的那把（由新到舊逐把驗 `permissionConfig().signer`）。 */
  usable: { permissionId: string; keyRef: string; expiresAt: string | null; status: string | null } | null;
  /** 讀不到安裝狀態時的錯誤。`usable === null` **只有在 `error === null`** 時才可以讀成「沒有可用的 key」。 */
  error: string | null;
};

export type PortfolioStatus = {
  portfolioId: number;
  /** executor 位址（approve 的 spender）。null = 這個部署沒設 EXECUTOR_ADDRESS。 */
  executorAddress: string | null;
  /**
   * 這個帳戶的原生幣 gas 狀態。**一個帳戶 = 一個「owner + 策略」組合**，所以 gas 是各自獨立的：
   * 這檔基金還能不能動，取決於它自己還有多少 BNB。
   * `null` = 查不到（RPC 掛），不是「餘額 0」。
   */
  gas: GasState;
  account: string;
  block: string;
  totalUsdE8: string;
  complete: boolean;
  holdings: StatusHolding[];
  unpriced: unknown[];
  targets: { asset: string; symbol: string; weightBps: number }[];
  drift: {
    grossDriftBps: number;
    maxAbsDeltaBps: number;
    needsRebalance: boolean;
    thresholdBps: number;
    assets: DriftAssetRow[];
  };
  blocked: unknown[];
  sessionKey?: SessionKeyReport | null;
};

/** 續期：後端用 master seed 派生好的那把新 key（含要在鏈上執行的 install calldata）。 */
export type RenewalParams = {
  portfolioId: number;
  strategyId: number;
  chainId: number;
  ownerAddress: string;
  accountAddress: string;
  executorAddress: string;
  entryPoint: string;
  kernelVersion: string;
  sessionKeyAddress: string;
  keyRef: string;
  validUntil: number;
  expiresAt: string;
  permissionId: string;
  policySnapshot: Record<string, unknown>;
  /** 打給帳戶自己的 install calldata（`msg.sender == self`）。 */
  initConfig: string[];
  /** 後端自己用的 alto 位址。**前端不要用它**（CORS），走 `/api/bundler` relay。 */
  bundlerUrl: string;
};

export type RenewalRecorded = {
  ok: true;
  recorded: { keyRef: string; permissionId: string };
  /** true = 這一把之前就記過了（重送不是錯誤）。 */
  duplicate?: true;
};

type RequestInitLite = {
  method?: 'GET' | 'POST';
  token?: string | null;
  body?: unknown;
  signal?: AbortSignal;
};

async function request<T>(path: string, init: RequestInitLite = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.token) headers.authorization = `Bearer ${init.token}`;

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.signal === undefined ? {} : { signal: init.signal }),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (cause) {
    // fetch 只有在**網路層**失敗時才會 throw；後端的錯誤一律是帶 status 的回應。
    throw new ApiError(0, 'NETWORK', `Cannot reach the backend: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const holder = parsed as { error?: { code?: unknown; message?: unknown } } | null;
    const code = typeof holder?.error?.code === 'string' ? holder.error.code : `HTTP_${response.status}`;
    const message =
      typeof holder?.error?.message === 'string'
        ? holder.error.message
        : typeof parsed === 'string' && parsed.length > 0
          ? parsed
          : response.statusText;
    throw new ApiError(response.status, code, message);
  }

  return parsed as T;
}

/** 取得 SIWE challenge（不花錢、不需要認證）。 */
export function postNonce(): Promise<SiweChallenge> {
  return request<SiweChallenge>('/auth/nonce', { method: 'POST' });
}

/** 用簽好的 SIWE 訊息換 token。 */
export function postLogin(message: string, signature: string): Promise<SessionCredentials> {
  return request<SessionCredentials>('/auth/login', { method: 'POST', body: { message, signature } });
}

/**
 * ⚠ `GET /portfolios` 回的是 **`{ portfolios: [...] }`**，不是裸陣列。
 *
 * 這一行是踩過的坑：型別寫成 `Portfolio[]` 時 TypeScript 不會有任何意見（`request<T>` 是斷言），
 * 但執行期拿到的是物件 → `Array.isArray` 為 false → `.map` 直接 throw，畫面變成空白。
 * 契約錯誤只有「真的打一次」才抓得到，所以這裡把 wire 形狀寫出來，並且**在客戶端拆掉**。
 */
export type PortfolioList = { portfolios: Portfolio[] };

export function getPortfolios(token: string): Promise<Portfolio[]> {
  return request<PortfolioList>('/portfolios', { token }).then((body) => body.portfolios);
}

/** 派生一把新的 session key 並回傳組 UserOp 所需的一切（後端不簽章、不上鏈、不寫 DB）。 */
export function getRenewalParams(token: string, id: number, signal?: AbortSignal): Promise<RenewalParams> {
  return request<RenewalParams>(`/portfolios/${id}/renewal-params`, { token, signal });
}

/** 回報續期 UserOp 已上鏈，後端記進 `session_keys`（鏈才是權威）。 */
export function postRenewalResult(
  token: string,
  id: number,
  body: { keyRef: string; permissionId: string; validUntil: number; policySnapshot: Record<string, unknown> },
): Promise<RenewalRecorded> {
  return request<RenewalRecorded>(`/portfolios/${id}/renewal-result`, { method: 'POST', token, body });
}

/**
 * `POST /portfolios/:id/rebalance` —— **operator 端點**：真的用 session key 送一筆鏈上交易。
 *
 * 規劃（要換什麼、換多少）由後端決定，前端不知道也不該猜：回應裡的 `steps` 才是這一輪實際送的參數。
 *
 * ⚠ 後端預設**關閉**（fail-closed）：回 403 `OPERATOR_REBALANCE_DISABLED`，要開得在後端帶
 * `ENABLE_OPERATOR_REBALANCE=true`。那個 403 不是「權限不足」，是「這個部署沒打算讓人手動觸發」。
 */
export type RebalanceOutcome = 'executed' | 'noop' | 'blocked' | 'reverted' | 'failed';

export type RebalanceStep = {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOutMin: string;
};

export type RebalanceResult = {
  portfolioId: number;
  outcome: RebalanceOutcome;
  /** 排程器寫的那一句話（含哪一層沒過）。**原文照回**，不改寫成「失敗」。 */
  reason: string;
  txHash: string | null;
  userOpHash: string | null;
  /** receipt 裡 executor 發出的 `SwapExecuted` 筆數。null = 有 tx 但讀不到 receipt。 */
  swapExecuted: number | null;
  /** 這一輪規劃了幾個 step（＝應該有幾筆 SwapExecuted）。 */
  expectedSwaps: number;
  gasUsed: string | null;
  steps: RebalanceStep[];
};

/**
 * `GET /portfolios/:id/plan` —— **dry-run** 預覽：這一輪會做什麼、不會做什麼、以及為什麼。
 *
 * 慢（實測 2–3 秒：要讀鏈、估價、算 impact），但它回答的是「現在按下去會怎樣」——
 * 而那正是使用者在按下按鈕之前唯一需要知道的事。唯讀，不受 `ENABLE_OPERATOR_REBALANCE` 限制。
 */
export type RebalancePlanPreview = {
  portfolioId: number;
  outcome: 'ready' | 'noop' | 'blocked';
  /** 排程器寫的那一句話，原文。 */
  reason: string;
  steps: RebalanceStep[];
};

export function getRebalancePlan(token: string, id: number): Promise<RebalancePlanPreview> {
  return request<RebalancePlanPreview>(`/portfolios/${id}/plan`, { token });
}

export function postRebalance(token: string, id: number): Promise<RebalanceResult> {
  return request<RebalanceResult>(`/portfolios/${id}/rebalance`, { method: 'POST', token });
}

/** `GET /assets` — 可定價資產（create fund 的選單來源，不在前端寫死）。 */
export type PriceableAsset = {
  address: string;
  symbol: string;
  decimals: number;
  /** true = 計價基準幣（USDT）。策略的每一條腿都是「資產 ↔ numeraire」。 */
  isNumeraire: boolean;
  /**
   * executor 的 oracle router 有沒有為它註冊 per-pair oracle。
   * `false` = 合約會 revert `OracleNotSet`，買不進去也賣不掉；`null` = 查不到（未知）。
   */
  tradable: boolean | null;
};

export function getAssets(token: string): Promise<PriceableAsset[]> {
  return request<{ assets: PriceableAsset[] }>('/assets', { token }).then((body) => body.assets);
}

/** 建立策略（名稱等）。後端會同時鏡像到鏈上 Registry。 */
export function createStrategy(
  token: string,
  body: { name: string; description?: string; isPublic?: boolean },
): Promise<{ id: number; [key: string]: unknown }> {
  return request('/strategies', { method: 'POST', token, body });
}

/** 發一個版本：`allocation.assets[].weightBps` 必須剛好加總 10000。 */
export function publishVersion(
  token: string,
  strategyId: number,
  body: {
    allocation: { assets: { address: string; weightBps: number }[] };
    schedule: { kind: 'interval'; intervalSeconds: number };
    changeLog?: string;
  },
): Promise<{ strategyId: number; version: number; [key: string]: unknown }> {
  return request(`/strategies/${strategyId}/versions`, { method: 'POST', token, body });
}

/** 把策略 enroll 成一個投組（會部署 smart account、上鏈）。 */
export function enrollPortfolio(token: string, strategyId: number): Promise<Portfolio> {
  return request<Portfolio>('/portfolios', { method: 'POST', token, body: { strategyId } });
}

/** 這個端點會掃 Transfer 日誌、讀池子、定價 —— 實測 2–3 秒，不是卡住。 */
export function getPortfolioStatus(token: string, id: number): Promise<PortfolioStatus> {
  return request<PortfolioStatus>(`/portfolios/${id}/status`, { token });
}

/** 這個投組最近的執行紀錄（含前後快照的漂移與總值）。 */
export function getPortfolioActivity(token: string, portfolioId: number): Promise<{ activity: PortfolioActivity[] }> {
  return request(`/portfolios/${portfolioId}/activity`, { token });
}

export type PortfolioActivity = {
  id: number;
  state: string;
  txHash: string | null;
  userOpHash: string | null;
  attempts: number;
  createdAt: string;
  driftBeforeBps: number | null;
  driftAfterBps: number | null;
  usdBeforeE8: string | null;
  usdAfterE8: string | null;
};

// ---------------------------------------------------------------------------
// Operator 總覽（rebalance dashboard）
// ---------------------------------------------------------------------------

export type OperatorRow = {
  id: number;
  strategyId: number;
  strategyName: string | null;
  version: number;
  scheduleState: string;
  /** 擁有人的錢包地址。與 `account`（Kernel counterfactual 地址）是**兩個不同**的地址。 */
  wallet: string;
  account: string | null;
  nextRunAt: string | null;
  lastCheckedAt: string | null;
  /** 最新快照的觀測點；`null` = 從來沒跑過一輪（不是「0 漂移」）。 */
  observedAt: string | null;
  driftBps: number | null;
  /**
   * 帳戶價值是 0（資金已全部提出，或還沒入金）。
   *
   * 空倉時 `driftBps` 仍然是公式算出來的大數字（空帳戶「完全不在目標上」），
   * 但把它顯示成「9999 bps / rebalance due」會讓人以為壞了 —— 它只是空。
   */
  isEmpty: boolean;
  totalUsdE8: string | null;
  needsRebalance: boolean | null;
  gasWei: string | null;
  sessionKeyExpiresAt: string | null;
  lastOperation: { id: number; state: string; txHash: string | null; createdAt: string } | null;
};

export type SchedulerStatus = {
  startedAt: string;
  lastRoundAt: string | null;
  lastFinishedAt: string | null;
  rounds: number;
  dryRun: boolean;
  roundLimit: number;
  thresholdBps: number;
  intervalSeconds: number;
  lastSummary: Record<string, number>;
  lastError: string | null;
  pid: number | null;
  staleSeconds: number | null;
  alive: boolean;
};

export type OperatorOverview = {
  generatedAt: string;
  /** `null` = 排程器從來沒跑過（不是「死了」）。 */
  scheduler: SchedulerStatus | null;
  alerts: { critical: number; warn: number; open: number } | null;
  lastCheckedAt: string | null;
  portfolios: OperatorRow[];
};

export function getOperatorOverview(token: string): Promise<OperatorOverview> {
  return request<OperatorOverview>('/operator/overview', { token });
}

// ---------------------------------------------------------------------------
// 策略（mandate）
// ---------------------------------------------------------------------------

export type StrategyAllocationAsset = { address: string; weightBps: number };

export type StrategyVersion = {
  strategyId: number;
  version: number;
  allocation: { assets: StrategyAllocationAsset[] };
  schedule: { kind: 'interval'; intervalSeconds: number } | { kind: 'cron'; cron: string };
  changeLog: string | null;
  activeAt: string | null;
  createdAt: string;
};

export type StrategyDetail = {
  id: number;
  provider: string;
  name: string;
  description: string;
  isPublic: boolean;
  swapFeeBps: number;
  createdAt: string;
  onchainId: number | null;
  versions: StrategyVersion[];
};

export function getStrategy(token: string, id: number): Promise<StrategyDetail> {
  return request<StrategyDetail>(`/strategies/${id}`, { token });
}

/** 策略列表（`GET /strategies`，公開資料，帶分頁）。 */
export type StrategySummary = {
  id: number;
  provider: string;
  name: string;
  description: string;
  isPublic: boolean;
  swapFeeBps: number;
  createdAt: string;
  onchainId: number | null;
};

export function listStrategies(token: string): Promise<{ items: StrategySummary[]; total: number }> {
  // 後端的上限是 100（超過回 400 INVALID_PAGINATION）。
  return request('/strategies?limit=100', { token });
}

/**
 * 把部位**按比例**賣成 numeraire（提領成 USDT 的前半段）。
 *
 * 按比例賣 → 賣完每個資產的權重不變 → 投組仍貼著 mandate，排程器不會立刻買回來。
 * 後半段是 owner-signed 的 USDT transfer（前端接著送）。
 */
export type RedeemResult = {
  portfolioId: number;
  outcome: 'executed' | 'noop' | 'blocked' | 'reverted' | 'failed';
  reason: string;
  txHash: string | null;
  steps: { tokenIn: string; tokenOut: string; amountIn: string; amountOutMin: string }[];
  redeemedUsdE8: string;
};

export function redeemPortfolio(token: string, id: number, usd: number): Promise<RedeemResult> {
  return request<RedeemResult>(`/portfolios/${id}/redeem`, { token, method: 'POST', body: { usd } });
}

/**
 * 清倉：把**全部**部位賣成 numeraire（後端 `POST /portfolios/:id/close`）。
 *
 * 與 `redeemPortfolio` 同一條管線，差別只在比例：這一支賣 100%，所以投組會被清空。
 * 賣不掉的部分會留在帳戶裡 —— 前端接著用 `sendSweep` 把它們直接轉回錢包。
 */
export function closePosition(token: string, id: number): Promise<RedeemResult> {
  return request<RedeemResult>(`/portfolios/${id}/close`, { token, method: 'POST' });
}

/**
 * 營運端：手動觸發某一輪再平衡（**不檢查 owner**）。
 *
 * 使用者端的是 `POST /portfolios/:id/rebalance`（要求你是那個投組的 owner）；
 * 營運端要跑別人的投組，所以走 `/operator/...`。鏈上規則不變（session key 的 UserOp、
 * executor 的 enrollment/allowlist/oracle 地板），這支只能「叫排程器跑一輪」。
 */
export function operatorForceRebalance(token: string, id: number): Promise<RebalanceResult> {
  return request<RebalanceResult>(`/operator/portfolios/${id}/rebalance`, { token, method: 'POST' });
}

/**
 * 營運端全域活動流：誰（owner 錢包）在哪個策略上被處理、成功或失敗、前後漂移。
 *
 * 為什麼不是 `/portfolios/:id/activity`：那一支要求你是該投組的 owner。營運端要看全部。
 */
export type OperatorActivityRow = {
  id: number;
  portfolioId: number;
  /** owner 錢包。 */
  wallet: string;
  strategyId: number;
  strategyName: string | null;
  type: string;
  state: string;
  txHash: string | null;
  attempts: number;
  error: string | null;
  createdAt: string;
  driftBeforeBps: number | null;
  driftAfterBps: number | null;
  usdBeforeE8: string | null;
  usdAfterE8: string | null;
};

export function getOperatorActivity(
  token: string,
  limit = 50,
): Promise<{ activity: OperatorActivityRow[] }> {
  return request<{ activity: OperatorActivityRow[] }>(`/operator/activity?limit=${limit}`, { token });
}
