import { createServer as createHttpServer } from 'node:http';
import { createPublicClient, http } from 'viem';
import type { Address } from 'viem';
import { activeChain } from './chain-object.js';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { alertCounts, healthStatusFor, listOpenAlerts } from './alerts.js';
import type { AlertCounts } from './alerts.js';
import { listPortfolioActivity, readOperatorActivity, readOperatorOverview, runOperatorClose, runOperatorRedeem } from './operator.js';
import { EXECUTOR_ORACLE_ABI, ORACLE_OF_ABI, listPriceableAssets } from './assets.js';
import type { PriceableAsset, TradableProbe } from './assets.js';
import { authenticate, issueNonce, login, parseLoginBody } from './auth.js';
import { getConfig, getSessionKeyConfig } from './config.js';
import { query } from './db.js';
import { AppError, ValidationError } from './errors.js';
import { createStrategy, getStrategy, listStrategies, publishVersion } from './strategies.js';
import type { PublishVersionInput } from './strategies.js';
import { listPortfolios, enrollPortfolio } from './portfolios.js';
import { buildRenewalParams, recordRenewalResult, resolveBundlerUrl } from './renewal.js';
import {
  OPERATOR_REBALANCE_ENV,
  createPortfolioStatusReader,
  operatorRebalanceEnabled,
  previewOperatorRebalance,
  runOperatorRebalance,
} from './operator.js';
import type { OperatorActivityRow, OperatorPlanPreview, OperatorRebalanceResult, PortfolioStatusReader } from './operator.js';

/** Hard cap on request bodies: strategy payloads are small; anything bigger is a mistake or an attack. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Error codes that mean "the database is unreachable" rather than "your request is wrong".
 * These become 503 so a load balancer can take the instance out of rotation.
 */
const DB_DOWN_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  '08000',
  '08001',
  '08006',
  '57P01',
  '57P03',
]);

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/** `CORS_ALLOWED_ORIGINS` 未設定時的預設值：vite dev server 的兩個常見 origin。 */
export const DEFAULT_CORS_ALLOWED_ORIGINS: readonly string[] = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/** preflight 允許的方法：本 API 只有這兩個（OPTIONS 是 preflight 本身）。 */
export const CORS_ALLOWED_METHODS = 'GET, POST, OPTIONS';

/** preflight 允許的請求標頭：`content-type` 給 JSON body，`authorization` 給 bearer token。 */
export const CORS_ALLOWED_HEADERS = 'authorization, content-type';

/** preflight 結果可以快取多久（秒）。10 分鐘：夠久到不做多餘的 preflight，夠短到改設定會生效。 */
export const CORS_MAX_AGE_SECONDS = 600;

export type CorsConfig = { allowedOrigins: readonly string[] };

/**
 * 解析 `CORS_ALLOWED_ORIGINS`（逗號分隔的**完整 origin**，例：`https://app.cre8.xyz`）。
 *
 * 刻意不支援 `*`：這支 API 用 `Authorization: Bearer` 認證，而 `*` 不能與 credentials 併用；就算硬用，
 * 也等於讓任何網站讀到帶 token 的回應。空字串／未設定 = dev 預設，不是「全開」。
 */
export function resolveCorsConfig(env: NodeJS.ProcessEnv = process.env): CorsConfig {
  const raw = env.CORS_ALLOWED_ORIGINS?.trim() ?? '';
  const origins =
    raw === ''
      ? [...DEFAULT_CORS_ALLOWED_ORIGINS]
      : raw
          .split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin !== '');
  return { allowedOrigins: origins.map((origin) => origin.toLowerCase()) };
}

/**
 * 請求的 `Origin` 在清單裡就回傳**它的原樣字串**（要放進 `Access-Control-Allow-Origin`），否則 null。
 *
 * 回具體 origin 而不是 `*`：請求帶 `Authorization`，`*` 不能與 `access-control-allow-credentials` 併用，
 * 而且會讓任何來源都讀得到回應。大小寫只影響比對（origin 的 scheme/host 本來就不分大小寫）。
 */
export function allowedCorsOrigin(origin: string | undefined, cors: CorsConfig): string | null {
  if (typeof origin !== 'string' || origin === '') return null;
  return cors.allowedOrigins.includes(origin.toLowerCase()) ? origin : null;
}

/**
 * 把 CORS 標頭放到**所有**回應上（含錯誤），並處理 preflight。
 *
 * 用 `res.setHeader` 而不是 `sendJson()` 的參數是刻意的：`writeHead()` 會把 setHeader 過的值與它自己的
 * 合併，所以 401／404／405 這些由 `sendError()`／`methodNotAllowed()` 送出的回應也一併帶到，不需要每個
 * 分支都記得傳。
 *
 * 不在清單裡的 origin：**不送任何 CORS 標頭**，讓瀏覽器自己擋——但回應照常完成，不是 500，也不是
 * 403。CORS 是瀏覽器的規則，不是認證；擋不擋得住取決於 `authenticate()`，與這裡無關。
 */
function applyCors(req: IncomingMessage, res: ServerResponse, cors: CorsConfig): void {
  // 同一個 URL 會因為 Origin 不同而回應不同標頭，所以快取必須按 Origin 分開。
  res.setHeader('vary', 'Origin');
  const origin = allowedCorsOrigin(req.headers.origin, cors);
  if (origin === null) return;

  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-credentials', 'true');
}

/** OPTIONS preflight：204 + 允許的方法／標頭／快取時間，不進路由（也不需要 token）。 */
function sendPreflight(req: IncomingMessage, res: ServerResponse, cors: CorsConfig): void {
  if (allowedCorsOrigin(req.headers.origin, cors) !== null) {
    res.setHeader('access-control-allow-methods', CORS_ALLOWED_METHODS);
    res.setHeader('access-control-allow-headers', CORS_ALLOWED_HEADERS);
    res.setHeader('access-control-max-age', String(CORS_MAX_AGE_SECONDS));
  }
  res.writeHead(204, { 'content-length': '0' });
  res.end();
}

// ---------------------------------------------------------------------------
// bundler relay
// ---------------------------------------------------------------------------

/**
 * `POST /bundler` 放行的方法：續期流程真的會用到的那六個，一個不多。
 *
 * **白名單，不是黑名單**：這支 relay 帶著使用者的 session token，能碰到 bundler 就等於能
 * 代替使用者發 UserOp。黑名單（排除 `eth_sendRawTransaction` 之類）永遠會漏一個，白名單漏掉的
 * 代價只是一個 403。
 */
export const BUNDLER_METHOD_WHITELIST: ReadonlySet<string> = new Set([
  'eth_sendUserOperation',
  'eth_estimateUserOperationGas',
  'eth_getUserOperationReceipt',
  'eth_getUserOperationByHash',
  'eth_supportedEntryPoints',
  'eth_chainId',
]);

/** 上游 timeout。gas 估算＋送 op 本來就要幾秒，30 秒是「正常慢」與「卡死」的分界。 */
export const BUNDLER_TIMEOUT_MS = 30_000;

/**
 * Dependencies the routes need. Injectable so route tests can run without a database;
 * production calls `createServer()` and gets the real implementations. Partial overrides are
 * merged over the defaults, so a test can stub one dependency and leave the rest real.
 */
export type ServerDeps = {
  createStrategy: typeof createStrategy;
  publishVersion: typeof publishVersion;
  enrollPortfolio: typeof enrollPortfolio;
  listPortfolios: typeof listPortfolios;
  buildRenewalParams: typeof buildRenewalParams;
  recordRenewalResult: typeof recordRenewalResult;
  /**
   * `GET /portfolios/:id/status`。預設的那一份**帶 TTL 快取**（`createPortfolioStatusReader` 在
   * `createServer()` 之前建好，所以快取跨請求存活）；測試換成 stub 就不必真的讀鏈。
   */
  portfolioActivity: (id: number, wallet: string) => Promise<unknown>;
  /** operator 總覽（rebalance dashboard）。 */
  operatorOverview: () => Promise<unknown>;
  /** 把部位按比例賣成 numeraire（提領成 USDT 的前半段）。 */
  operatorRedeem: (portfolioId: number, wallet: string, usdE8: bigint) => Promise<unknown>;
  /** 清倉：把全部部位賣成 numeraire。 */
  operatorClose: (portfolioId: number, wallet: string) => Promise<unknown>;
  portfolioStatus: PortfolioStatusReader;
  /** `POST /portfolios/:id/rebalance`（會動錢；預設實作見 `operator.ts`）。 */
  operatorRebalance: (portfolioId: number, wallet: string) => Promise<OperatorRebalanceResult>;
  /**
   * 營運端觸發某一輪再平衡（**不檢查 owner**）。
   *
   * `POST /portfolios/:id/rebalance` 會 `requireOwnedPortfolio`（那是給使用者的）。
   * 營運端要跑的是別人的投組，所以另開一條：傳一個 no-op 的 `requireOwnedPortfolio`。
   * 安全性仍由**鏈上**保證 —— 送出去的是 session key 的 UserOp，executor 會驗
   * enrollment / asset allowlist / oracle 地板；這支端點只能「觸發排程器跑一輪」。
   */
  operatorForceRebalance: (portfolioId: number) => Promise<OperatorRebalanceResult>;
  /** 營運端全域活動流：誰、在哪個策略上被處理（含成敗與前後漂移）。 */
  operatorActivity: (limit: number) => Promise<OperatorActivityRow[]>;
  /**
   * 營運端的 dry-run 預覽（**不送交易、不花錢**）。
   *
   * 為什麼需要：`/portfolios/:id/plan` 會做 owner 檢查，營運端排查「為什麼某一檔沒被買」
   * 時完全看不到規劃器的 note（只有 owner 看得到）。這支用 no-op 的 owner 檢查繞過，
   * 權限模型與 `/operator/portfolios/:id/rebalance` 一致。
   */
  operatorPlanPreview: (portfolioId: number) => Promise<OperatorPlanPreview>;
  /** 營運端代為清倉（**不檢查 owner**）。與 force rebalance 同一條權限模型。 */
  operatorForceClose: (portfolioId: number) => Promise<unknown>;
  /** 這一輪會做什麼（dry-run）。唯讀，所以**不**受 `ENABLE_OPERATOR_REBALANCE` 限制。 */
  planPreview: (portfolioId: number, wallet: string) => Promise<OperatorPlanPreview>;
  /**
   * operator rebalance 的部署開關。不給 = 每次請求讀 `ENABLE_OPERATOR_REBALANCE`
   * （與 CORS／bundler URL 同一個做法：env 的解析留在 server 層）。
   */
  operatorRebalanceEnabled: () => boolean;
  /** CORS 允許清單。不給 = 每次請求從 `CORS_ALLOWED_ORIGINS` 解析（見 `resolveCorsConfig`）。 */
  cors?: CorsConfig;
  /**
   * `POST /bundler` 的上游位址。不給 = 每次請求從 `BUNDLER_URL` 解析（見 `resolveBundlerUrl`），
   * 與 CORS 同一個做法：env 的解析留在 server 層，`config.ts` 不用動。
   */
  bundlerUrl?: string;
  /**
   * 打上游用的 fetch。測試注入假 fetcher 就能斷言「白名單外的方法一次都沒送出去」——
   * 那是「不轉發」唯一能證明的方式，光看回應碼證明不了。
   */
  bundlerFetch?: typeof fetch;
  /** `GET /assets`：create fund 的資產選單。注入讓路由測試不必連 DB。 */
  listAssets: () => Promise<PriceableAsset[]>;
};

/**
 * `GET /assets` 的預設實作：DB 那一份 + 鏈上的「這個資產有沒有註冊 oracle」。
 *
 * 為什麼要問鏈：create fund 讓使用者選一個 router 報不出價的資產，等於建了一個**永遠不會執行**的策略，
 * 而錯誤要到第一次再平衡才會以 `OracleNotSet` 出現（實際發生過：CRCLB / MUB）。
 *
 * 沒有 RPC 或沒有 executor 時回 `tradable: null`（未知）—— **不要預設成 true**：
 * 那會把「查不到」變成「可以交易」。
 */
async function defaultListAssets(): Promise<PriceableAsset[]> {
  let probe: TradableProbe | undefined;
  try {
    const config = getConfig();
    // executor 位址在 session-key 設定裡（`getSessionKeyConfig` 才會檢查它有沒有設）。
    const executor = (() => {
      try {
        return getSessionKeyConfig().executorAddress;
      } catch {
        return null;
      }
    })();
    if (config.rpcUrl !== null && executor !== null) {
      const client = createPublicClient({ chain: activeChain(), transport: http(config.rpcUrl) });
      const router = (await client.readContract({
        address: executor,
        abi: EXECUTOR_ORACLE_ABI,
        functionName: 'oracle',
      })) as Address;
      probe = {
        router,
        oracleOf: async (asset) =>
          (await client.readContract({
            address: router,
            abi: ORACLE_OF_ABI,
            functionName: 'oracleOf',
            args: [asset as Address],
          })) as string,
      };
    }
  } catch {
    // 查不到就回 null：讓 UI 顯示「未知」，而不是謊報可交易。
    probe = undefined;
  }
  return listPriceableAssets(undefined, probe);
}

const defaultDeps: ServerDeps = {
  createStrategy,
  publishVersion,
  enrollPortfolio,
  listPortfolios,
  buildRenewalParams,
  recordRenewalResult,
  // 只有這一個是在 import 時就建好的：快取要跨請求存活，不能每個請求重建一份。
  portfolioStatus: createPortfolioStatusReader(),
  operatorRebalance: runOperatorRebalance,
  operatorActivity: (limit) => readOperatorActivity(limit),
  // 與 force rebalance 用同一個「不檢查 owner」的注入；差別是這支只讀不送。
  operatorPlanPreview: (portfolioId) =>
    previewOperatorRebalance(portfolioId, 'operator', { requireOwnedPortfolio: async () => ({ id: portfolioId }) as never }),
  operatorForceClose: (portfolioId) =>
    runOperatorClose(portfolioId, 'operator', { requireOwnedPortfolio: async () => ({ id: portfolioId }) as never }),
  // 營運端：同樣的送出管線，只是換掉 owner 檢查（見型別上的說明）。
  operatorForceRebalance: (portfolioId) =>
    runOperatorRebalance(portfolioId, 'operator', {
      // 回傳一個假的 portfolio：這個路徑不讀它的欄位，只是要讓 owner 檢查通過。
      requireOwnedPortfolio: async () => ({ id: portfolioId }) as never,
    }),
  planPreview: previewOperatorRebalance,
  operatorRebalanceEnabled,
  listAssets: defaultListAssets,
  portfolioActivity: (id, wallet) => listPortfolioActivity(id, wallet),
  operatorOverview: () => readOperatorOverview(),
  operatorRedeem: (portfolioId, wallet, usdE8) => runOperatorRedeem(portfolioId, wallet, usdE8),
  operatorClose: (portfolioId, wallet) => runOperatorClose(portfolioId, wallet),
};

export function createServer(overrides: Partial<ServerDeps> = {}): Server {
  const deps: ServerDeps = { ...defaultDeps, ...overrides };
  return createHttpServer((req, res) => {
    void handleRequest(req, res, deps);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const startedAt = Date.now();
  const method = req.method ?? 'GET';
  let path = req.url ?? '/';

  res.on('finish', () => {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        msg: 'http_request',
        method,
        path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      }),
    );
  });

  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    path = url.pathname;

    // CORS 是每個回應都要做的事（含錯誤與 401），所以放在路由之前，不在任何一個 handler 裡。
    const cors = deps.cors ?? resolveCorsConfig();
    applyCors(req, res, cors);
    // preflight 不進路由：它不帶 token、沒有 body，也不該被任何 method 檢查判成 405。
    if (method === 'OPTIONS') {
      sendPreflight(req, res, cors);
      return;
    }

    await route(req, res, url, deps);
  } catch (err) {
    sendError(res, err);
  }
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ServerDeps,
): Promise<void> {
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const [root] = segments;

  if (root === 'health' && segments.length === 1) {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    return health(res);
  }

  // GET /assets — create fund 的資產選單。要認證：它是「站上可交易的東西」的內部清單，
    // 而且這支 API 的其他資料也全部要 token（只有 /health 是公開的）。
  if (root === 'assets' && segments.length === 1) {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    await authenticate(req.headers.authorization);
    sendJson(res, 200, { assets: await deps.listAssets() });
    return;
  }

  if (root === 'auth') {
    if (segments.length === 2 && segments[1] === 'nonce') {
      if (method !== 'POST') return methodNotAllowed(res, ['POST']);
      return nonceRoute(res);
    }
    if (segments.length === 2 && segments[1] === 'login') {
      if (method !== 'POST') return methodNotAllowed(res, ['POST']);
      return loginRoute(req, res);
    }
  }

  if (root === 'strategies') {
    if (segments.length === 1) {
      if (method === 'GET') return listRoute(res, url);
      if (method === 'POST') return createRoute(req, res, deps);
      return methodNotAllowed(res, ['GET', 'POST']);
    }
    if (segments.length === 2) {
      if (method !== 'GET') return methodNotAllowed(res, ['GET']);
      return detailRoute(res, parsePositiveInteger(segments[1] ?? '', 'strategy id'));
    }
    if (segments.length === 3 && segments[2] === 'versions') {
      if (method !== 'POST') return methodNotAllowed(res, ['POST']);
      return publishVersionRoute(
        req,
        res,
        parsePositiveInteger(segments[1] ?? '', 'strategy id'),
        deps,
      );
    }
  }

  if (root === 'portfolios') {
    // `/portfolios` 有 GET（列表）與 POST（enroll）兩個 method，`/portfolios/:id/<action>` 有兩個子路由。
    // 分派一律先看 segment 數量、再看 method：只看前綴的話 `POST /portfolios/:id/renewal-result` 會被
    // 「POST /portfolios」吃掉（它也是 POST，只差在路徑長度）。
    if (segments.length === 1) {
      if (method === 'GET') return listPortfoliosRoute(req, res, deps);
      if (method === 'POST') return enrollRoute(req, res, deps);
      return methodNotAllowed(res, ['GET', 'POST']);
    }
    if (segments.length === 3) {
      const portfolioId = () => parsePositiveInteger(segments[1] ?? '', 'portfolio id');
      if (segments[2] === 'renewal-params') {
        if (method !== 'GET') return methodNotAllowed(res, ['GET']);
        return renewalParamsRoute(req, res, portfolioId(), deps);
      }
      if (segments[2] === 'renewal-result') {
        if (method !== 'POST') return methodNotAllowed(res, ['POST']);
        return renewalResultRoute(req, res, portfolioId(), deps);
      }
      if (segments[2] === 'status') {
        if (method !== 'GET') return methodNotAllowed(res, ['GET']);
        return portfolioStatusRoute(req, res, portfolioId(), deps);
      }
      if (segments[2] === 'rebalance') {
        if (method !== 'POST') return methodNotAllowed(res, ['POST']);
        return operatorRebalanceRoute(req, res, portfolioId(), deps);
      }
      if (segments[2] === 'close') {
        if (method !== 'POST') return methodNotAllowed(res, ['POST']);
        const closeWallet = await authenticate(req.headers.authorization);
        sendJson(res, 200, await deps.operatorClose(portfolioId(), closeWallet));
        return;
      }
      if (segments[2] === 'redeem') {
        if (method !== 'POST') return methodNotAllowed(res, ['POST']);
        return redeemRoute(req, res, portfolioId(), deps);
      }
      if (segments[2] === 'activity') {
        if (method !== 'GET') return methodNotAllowed(res, ['GET']);
        return portfolioActivityRoute(req, res, portfolioId(), deps);
      }
      if (segments[2] === 'plan') {
        if (method !== 'GET') return methodNotAllowed(res, ['GET']);
        return planPreviewRoute(req, res, portfolioId(), deps);
      }
    }
  }

  // `GET /operator/portfolios/:id/plan` —— 營運端 dry-run 預覽（不送交易、不檢查 owner）。
  if (root === 'operator' && segments.length === 4 && segments[1] === 'portfolios' && segments[3] === 'plan') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    await authenticate(req.headers.authorization);
    const id = Number(segments[2]);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'INVALID_ID', 'portfolio id must be a positive integer');
    sendJson(res, 200, await deps.operatorPlanPreview(id));
    return;
  }

  // `POST /operator/portfolios/:id/close` —— 營運端代為清倉（不檢查 owner）。
  if (root === 'operator' && segments.length === 4 && segments[1] === 'portfolios' && segments[3] === 'close') {
    if (method !== 'POST') return methodNotAllowed(res, ['POST']);
    await authenticate(req.headers.authorization);
    const id = Number(segments[2]);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'INVALID_ID', 'portfolio id must be a positive integer');
    sendJson(res, 200, await deps.operatorForceClose(id));
    return;
  }

  // `POST /operator/portfolios/:id/rebalance` —— 營運端手動觸發一輪（不檢查 owner）。
  if (root === 'operator' && segments.length === 4 && segments[1] === 'portfolios' && segments[3] === 'rebalance') {
    if (method !== 'POST') return methodNotAllowed(res, ['POST']);
    await authenticate(req.headers.authorization);
    const id = Number(segments[2]);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'INVALID_ID', 'portfolio id must be a positive integer');
    sendJson(res, 200, await deps.operatorForceRebalance(id));
    return;
  }

  // `GET /operator/activity?limit=50` —— 跨所有投組的操作歷史（誰、哪個策略、成敗）。
  if (root === 'operator' && segments.length === 2 && segments[1] === 'activity') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    await authenticate(req.headers.authorization);
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new AppError(400, 'INVALID_LIMIT', 'limit must be a positive integer');
    }
    sendJson(res, 200, { activity: await deps.operatorActivity(limit) });
    return;
  }

  if (root === 'operator' && segments.length === 2 && segments[1] === 'overview') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    // 只要求登入，不依 owner 過濾：這是內部儀表板。之後要做 `OPERATOR_WALLETS` 白名單就加在這裡。
    await authenticate(req.headers.authorization);
    sendJson(res, 200, await deps.operatorOverview());
    return;
  }

  if (root === 'bundler' && segments.length === 1) {
    if (method !== 'POST') return methodNotAllowed(res, ['POST']);
    return bundlerRelayRoute(req, res, deps);
  }

  sendJson(res, 404, {
    error: { code: 'NOT_FOUND', message: `no route for ${method} ${url.pathname}` },
  });
}

/**
 * GET /health — 200 when Postgres answers, 503 otherwise. chainId is the configured default chain.
 *
 * `alerts` 是排程器的未解決警示計數（見 `alerts.ts` 與 `db/migrations/0013`）。兩個規則決定它的形狀：
 *   * 有 critical 未解決 → `status: "degraded"`，但 **HTTP 仍是 200**：實例還能服務，只是需要人看。
 *     把 503 用在這裡會讓負載平衡器把一個能用的實例下線 —— 「該看一下」變成「服務中斷」。
 *     503 留給它原本的理由：Postgres 掛掉。
 *   * 讀警示失敗 → `alerts: null`，`status` 不受影響。health 不該因為告警表壞掉而掛，那會讓
 *     真正的問題（DB 掛掉 vs 警示表掛掉）更難分辨。
 */
async function health(res: ServerResponse): Promise<void> {
  const config = getConfig();
  let db: 'ok' | 'down' = 'ok';
  try {
    await query('select 1');
  } catch {
    db = 'down';
  }

  let alerts: AlertCounts | null = null;
  try {
    alerts = alertCounts(await listOpenAlerts(query));
  } catch {
    alerts = null;
  }

  sendJson(res, db === 'ok' ? 200 : 503, {
    status: healthStatusFor(db, alerts),
    service: 'cre8-atp-backend',
    chainId: config.chainId,
    rpcConfigured: config.rpcUrl !== null,
    db,
    uptimeSeconds: Math.round(process.uptime()),
    alerts,
  });
}

/** POST /auth/nonce — mint a single-use nonce plus the EIP-4361 fields the wallet must sign. */
function nonceRoute(res: ServerResponse): void {
  sendJson(res, 200, issueNonce());
}

/** POST /auth/login — exchange { message, signature } for a bearer session token. */
async function loginRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const credentials = parseLoginBody(await readJsonBody(req));
  const session = await login(credentials.message, credentials.signature);
  sendJson(res, 200, session);
}

/** GET /strategies?limit=50&offset=0&provider=0x…&public=true */
async function listRoute(res: ServerResponse, url: URL): Promise<void> {
  const provider = url.searchParams.get('provider')?.trim() ?? '';
  const page = await listStrategies({
    limit: parseQueryInteger(url.searchParams.get('limit'), 'limit'),
    offset: parseQueryInteger(url.searchParams.get('offset'), 'offset'),
    provider: provider === '' ? undefined : provider,
    isPublic: parseBoolean(url.searchParams.get('public'), 'public'),
  });
  sendJson(res, 200, page);
}

/** GET /strategies/:id — metadata plus version history (newest first). */
async function detailRoute(res: ServerResponse, id: number): Promise<void> {
  sendJson(res, 200, await getStrategy(id));
}

/**
 * POST /strategies — create metadata only; versions are published separately.
 * Requires a bearer token: the provider is the session wallet, and any `provider` in the body is
 * ignored (authenticate() runs before the body is read, so an unauthenticated call is 401 even
 * when the payload is invalid).
 */
async function createRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const provider = await authenticate(req.headers.authorization);
  const body = await readJsonBody(req);
  const strategy = await deps.createStrategy(body, provider);
  sendJson(res, 201, strategy, { location: `/strategies/${strategy.id}` });
}

/**
 * POST /strategies/:id/versions — append a version; the created version record is the response.
 * Requires a bearer token; publishVersion enforces that the session wallet owns the strategy.
 */
async function publishVersionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  id: number,
  deps: ServerDeps,
): Promise<void> {
  const provider = await authenticate(req.headers.authorization);
  const body = await readJsonBody(req);
  // publishVersion expects an object; without this guard a JSON `null` body would be a 500.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('INVALID_VERSION', 'request body must be a JSON object');
  }
  const version = await deps.publishVersion(id, body as PublishVersionInput, provider);
  sendJson(res, 201, version);
}

/**
 * POST /portfolios — enroll the authenticated wallet into a strategy (on-chain + DB).
 * Body is { strategyId }. Requires a bearer token; the wallet is the session wallet.
 */
async function enrollRoute(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const provider = await authenticate(req.headers.authorization);
  const body = await readJsonBody(req);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('INVALID_PORTFOLIO', 'request body must be a JSON object');
  }
  const strategyId = parsePositiveInteger(String((body as Record<string, unknown>).strategyId ?? ''), 'strategyId');
  const portfolio = await deps.enrollPortfolio(strategyId, provider);
  sendJson(res, 201, portfolio, { location: `/portfolios/${portfolio.id}` });
}

/**
 * GET /portfolios — 目前登入錢包的 portfolio 列表（含 gas 狀態與現行 session key）。
 *
 * 只回 token 對應錢包的列：`authenticate()` 給出的地址就是查詢條件，網址沒有任何「查誰」的參數，
 * 所以不存在「改一個 query string 就讀到別人的 portfolio」這條路。
 */
async function listPortfoliosRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const wallet = await authenticate(req.headers.authorization);
  sendJson(res, 200, { portfolios: await deps.listPortfolios(wallet) });
}

/**
 * GET /portfolios/:id/renewal-params — 派生一把新的 session key，回傳組 UserOp 所需的一切。
 *
 * 不簽章、不上鏈、不寫 DB：後端只做瀏覽器做不到的那件事（用 master seed 派生金鑰）。
 */
async function renewalParamsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  id: number,
  deps: ServerDeps,
): Promise<void> {
  const wallet = await authenticate(req.headers.authorization);
  sendJson(res, 200, await deps.buildRenewalParams(id, wallet));
}

/**
 * POST /portfolios/:id/renewal-result — 前端回報續期 UserOp 已上鏈，後端記進 `session_keys`。
 *
 * 鏈是權威：這裡只記錄，不驗證 txHash 是否真的上鏈，也不動舊的那一列。
 */
async function renewalResultRoute(
  req: IncomingMessage,
  res: ServerResponse,
  id: number,
  deps: ServerDeps,
): Promise<void> {
  const wallet = await authenticate(req.headers.authorization);
  const body = await readJsonBody(req);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('INVALID_RENEWAL', 'request body must be a JSON object');
  }
  sendJson(res, 200, await deps.recordRenewalResult(id, wallet, body as Record<string, unknown>));
}

// ---------------------------------------------------------------------------
// GET /portfolios/:id/status ＋ POST /portfolios/:id/rebalance
// ---------------------------------------------------------------------------

/**
 * `GET /portfolios/:id/status` — 這個 portfolio **現在**的持倉、目標、漂移與 blocked 原因。
 *
 * 刻意**不**放進 `GET /portfolios`：那個列表是頁面一進來就會打的，而這裡的每一列都要掃日誌＋
 * 讀多個池＋定價。塞進去等於讓「看一眼清單」變成一件很貴的事。
 *
 * 擁有者檢查在 `portfolioStatus` 裡（`requireOwnedPortfolio`，與 `renewal-params` 同一條），
 * 而且**在快取之前**：快取以 portfolioId 為 key，先查快取就等於讓別的錢包讀到算好的狀態。
 */
/** `GET /portfolios/:id/activity` — 最近幾輪的執行紀錄（含前後快照的漂移與總值）。 */
async function portfolioActivityRoute(
  req: IncomingMessage,
  res: ServerResponse,
  id: number,
  deps: ServerDeps,
): Promise<void> {
  const wallet = await authenticate(req.headers.authorization);
  sendJson(res, 200, { activity: await deps.portfolioActivity(id, wallet) });
}

async function portfolioStatusRoute(
  req: IncomingMessage,
  res: ServerResponse,
  id: number,
  deps: ServerDeps,
): Promise<void> {
  const wallet = await authenticate(req.headers.authorization);
  sendJson(res, 200, await deps.portfolioStatus(id, wallet));
}

/**
 * `GET /portfolios/:id/plan` — **dry-run**：這一輪會做什麼、不會做什麼、以及為什麼。
 *
 * 唯讀，所以**不**受 `ENABLE_OPERATOR_REBALANCE` 限制：它不寫 operations、不推進 `next_run_at`、
 * 不送交易。生產環境（開關關著、排程器自己在跑）正是最需要它的情境 ——
 * 「為什麼我的投組停住了」的答案不該要求先開一個能動錢的開關。
 *
 * 慢（實測 2–3 秒，要讀鏈、估價、算 impact），但它回答的正是「現在按下去會怎樣」。
 */
async function planPreviewRoute(
  req: IncomingMessage,
  res: ServerResponse,
  id: number,
  deps: ServerDeps,
): Promise<void> {
  const wallet = await authenticate(req.headers.authorization);
  sendJson(res, 200, await deps.planPreview(id, wallet));
}

/**
 * `POST /portfolios/:id/rebalance` — 對單一 portfolio 真的跑一次 live 再平衡。
 *
 * **這是唯一一支會動錢的端點，所以它預設不存在**：`ENABLE_OPERATOR_REBALANCE` 不等於字面值
 * `true` 就 403。一個「用 POST 就能讓伺服器動錢」的端點不該預設可用；生產環境可能永遠不該開它
 * （那裡是排程器自己在跑）。
 *
 * 三個檢查的順序是刻意的：
 *   ① `authenticate()` —— 沒有 token 是 401（與其他寫入路由一致，check 在 body 之前）。
 *   ② `ENABLE_OPERATOR_REBALANCE` —— 沒開就 403，**在碰 DB 與鏈之前**。這是部署層的事實，
 *      與「這個 portfolio 是誰的」無關，先講清楚比讓使用者等到擁有者檢查之後才知道便宜得多。
 *   ③ 擁有者檢查 —— 在 `operatorRebalance` 裡（`requireOwnedPortfolio`）。
 *
 * 回應一律 200：`blocked`／`noop` 是**請求被正常處理之後的結果**，不是這支 API 的錯誤。
 * 只有「沒開」「不是你的」「沒有這個 portfolio」「內部炸掉」才是 4xx/5xx。
 */
/**
 * `POST /portfolios/:id/redeem` —— 把部位**按比例**賣成 numeraire。
 *
 * 為什麼是「按比例」而不是「賣到剛好夠」：按比例賣完每個資產的權重不變，所以投組仍然貼著 mandate，
 * 排程器也不會立刻把它買回來。使用者要提領 USDT，前端接著再送一筆 owner-signed 的 transfer
 * （兩段分開是刻意的：賣出是 session key、轉出是 owner，權限本來就不同）。
 */
async function redeemRoute(
  req: IncomingMessage,
  res: ServerResponse,
  id: number,
  deps: ServerDeps,
): Promise<void> {
  const wallet = await authenticate(req.headers.authorization);
  const body = await readJsonBody(req);
  const usd = (body as { usd?: unknown }).usd;
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) {
    throw new AppError(400, 'INVALID_AMOUNT', 'body.usd must be a positive number');
  }
  // 8 位小數的整數（與 totalUsdE8 同一個刻度）。
  const usdE8 = BigInt(Math.round(usd * 1e8));
  sendJson(res, 200, await deps.operatorRedeem(id, wallet, usdE8));
}

async function operatorRebalanceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  id: number,
  deps: ServerDeps,
): Promise<void> {
  const wallet = await authenticate(req.headers.authorization);
  const enabled = deps.operatorRebalanceEnabled ?? operatorRebalanceEnabled;
  if (!enabled()) {
    throw new AppError(
      403,
      'OPERATOR_REBALANCE_DISABLED',
      `operator rebalance 需要 ${OPERATOR_REBALANCE_ENV}=true 才會啟用（這支端點會用 session key 送出鏈上交易、` +
        '真的動到投組裡的錢；排程器自己在跑的時候不需要它）。這是部署層的開關，未啟用時這個端點不存在',
    );
  }
  sendJson(res, 200, await deps.operatorRebalance(id, wallet));
}

// ---------------------------------------------------------------------------
// POST /bundler — bundler relay
// ---------------------------------------------------------------------------

/**
 * `POST /bundler` — 把前端的 JSON-RPC 原樣轉給 `BUNDLER_URL`，再把上游回應原樣回傳。
 *
 * 為什麼需要這支：alto v1.2.5 完全沒有 CORS 支援（`--help` 沒有相關選項，`OPTIONS` 回 404 且不帶任何
 * `access-control-*`），所以**瀏覽器永遠無法直連 bundler** —— 這不是 dev 問題，生產環境一樣。
 * 這支 API 已經有 CORS（`applyCors` 在路由之前跑），於是由後端代送。
 *
 * 兩件事刻意不做：
 * 1. **不改寫 JSON-RPC 的錯誤形狀**：前端要靠 bundler 的 `code`／`message`／`data` 原文診斷 AA 錯誤，
 *    重新包一層等於把唯一有用的線索丟掉。所以回應是「上游的 status 與 bytes」，不走 `sendJson`。
 * 2. **不轉發白名單外的方法**：檢查在 `fetch` 之前，白名單外的請求連上游都碰不到。
 */
async function bundlerRelayRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  // token 先驗、body 後讀：順序與其他寫入路由一致（沒 token 又不合法的 body 是 401，不是 400）。
  await authenticate(req.headers.authorization);

  const raw = await readBodyText(req);
  let request: unknown;
  try {
    request = JSON.parse(raw);
  } catch {
    throw new ValidationError('INVALID_JSON', 'request body must be valid JSON');
  }

  const method = jsonRpcMethod(request);
  // ← 白名單檢查就在這一行，位置在下面的 `send()` 之前：非白名單的方法沒有機會打到上游。
  if (!BUNDLER_METHOD_WHITELIST.has(method)) {
    throw new AppError(
      403,
      'BUNDLER_METHOD_NOT_ALLOWED',
      `bundler method ${JSON.stringify(method)} is not allowed; allowed: ${[...BUNDLER_METHOD_WHITELIST].join(', ')}`,
    );
  }

  const upstream = deps.bundlerUrl ?? resolveBundlerUrl();
  const send = deps.bundlerFetch ?? fetch;
  let upstreamRes: Response;
  try {
    upstreamRes = await send(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      // 原樣轉發收到的 bytes：重新 stringify 會動到前端送出的內容，模糊掉「誰改了什麼」。
      body: raw,
      signal: AbortSignal.timeout(BUNDLER_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AppError(
      502,
      'BUNDLER_UNAVAILABLE',
      `bundler ${redactUrl(upstream)} 無法連上（${method}，timeout ${BUNDLER_TIMEOUT_MS}ms）：${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  const payload = await upstreamRes.text();
  res.writeHead(upstreamRes.status, {
    'content-type': upstreamRes.headers.get('content-type') ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** 取 JSON-RPC 的 `method`；讀不到就回空字串（= 一定不在白名單，回 403 而不是轉發一個殘缺請求）。 */
function jsonRpcMethod(request: unknown): string {
  if (typeof request !== 'object' || request === null) return '';
  const method = (request as { method?: unknown }).method;
  return typeof method === 'string' ? method : '';
}

/**
 * 錯誤訊息要帶上游位址（不然一個「502」等於什麼都沒說），但 URL 的 userinfo 可能就是 bundler 的
 * API key：印出去就等於把它寫進 log 與瀏覽器畫面。只保留 scheme://host:port/path。
 */
function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return raw;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readBodyText(req);
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('INVALID_JSON', 'request body must be valid JSON');
  }
}

/** 讀原始 body（有 1 MB 上限）。relay 要的是「bytes 原樣」，不是解析後的物件。 */
async function readBodyText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', `request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }

  if (size === 0) {
    throw new ValidationError('INVALID_JSON', 'request body is required and must be JSON');
  }

  return Buffer.concat(chunks).toString('utf8');
}

function parsePositiveInteger(raw: string, name: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new ValidationError('INVALID_ID', `${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError('INVALID_ID', `${name} is out of range`);
  }
  return value;
}

function parseQueryInteger(raw: string | null, name: string): number | undefined {
  if (raw === null) return undefined;
  if (!/^-?\d+$/.test(raw)) {
    throw new ValidationError('INVALID_QUERY', `${name} must be an integer`);
  }
  return Number(raw);
}

function parseBoolean(raw: string | null, name: string): boolean | undefined {
  if (raw === null) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ValidationError('INVALID_QUERY', `${name} must be "true" or "false"`);
}

function methodNotAllowed(res: ServerResponse, allowed: string[]): void {
  sendJson(
    res,
    405,
    { error: { code: 'METHOD_NOT_ALLOWED', message: `method not allowed; use ${allowed.join(', ')}` } },
    { allow: allowed.join(', ') },
  );
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent || res.writableEnded) {
    res.end();
    return;
  }

  if (err instanceof AppError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message } });
    return;
  }

  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
  if (DB_DOWN_CODES.has(code)) {
    sendJson(res, 503, { error: { code: 'DB_UNAVAILABLE', message: 'database unavailable' } });
    return;
  }

  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'unhandled request error',
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    }),
  );
  sendJson(res, 500, { error: { code: 'INTERNAL', message: 'internal server error' } });
}
