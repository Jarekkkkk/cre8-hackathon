import { query as dbQuery } from './db.js';

/**
 * 可定價資產清單（`priceable_assets`）。
 *
 * 為什麼需要這支：create fund 的資產選單不能寫死在前端。`priceable_assets` 是**站上自己維護**的表
 * （bStock 沒有官方 token list），只有它有「這個代幣能不能定價、decimals 是多少、哪一個是 numeraire」。
 * 前端若複製一份清單，會在有人新增代幣時安靜地過期 —— 而症狀是「選單裡有、送出卻失敗」。
 *
 * 只回 `enabled = true`：停用中的資產仍然在表裡（歷史策略還會引用它），但不該出現在**新的**選單裡。
 */
export type PriceableAsset = {
  address: string;
  symbol: string;
  decimals: number;
  /** true = 計價的基準幣（USDT）。策略的每一條腿都是 `資產 ↔ numeraire`。 */
  isNumeraire: boolean;
  /**
   * executor 的 oracle router 有沒有為這個資產註冊 per-pair oracle。
   *
   * `false` = 合約會 revert `OracleNotSet`，**買不進去也賣不掉** —— 在 create fund 的選單裡
   * 這種資產等於一個永遠不會執行的策略。`null` = 查不到（沒有 RPC 或沒設 executor），
   * UI 應該當成「未知」而不是「可以」。
   */
  tradable: boolean | null;
};

type QueryFn = (text: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>;

const SQL_ASSETS = `
  select address, symbol, decimals, is_numeraire
    from priceable_assets
   where enabled
   order by is_numeraire desc, symbol asc
`;

export const ORACLE_OF_ABI = [
  {
    type: 'function',
    name: 'oracleOf',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export const EXECUTOR_ORACLE_ABI = [
  {
    type: 'function',
    name: 'oracle',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export type TradableProbe = {
  /** executor 的 oracle router 位址（`AtpMultiPoolOracle`）。 */
  router: string;
  /** 對 router 呼叫 `oracleOf(asset)`；未註冊時回 `0x0`。 */
  oracleOf: (asset: string) => Promise<string>;
};

/**
 * 有 `probe` 就順便問鏈上「這個資產有沒有註冊 oracle」。沒有 probe → `tradable: null`（未知）。
 *
 * ⚠ 這一欄**不能預設成 true**：create fund 讓使用者選一個 router 報不出價的資產，等於建了一個
 * 永遠不會執行的策略 —— 而且錯誤要到第一次再平衡才會出現（`OracleNotSet`）。
 */
export async function listPriceableAssets(
  query: QueryFn = dbQuery,
  probe?: TradableProbe,
): Promise<PriceableAsset[]> {
  const { rows } = await query(SQL_ASSETS);

  const assets: PriceableAsset[] = [];
  for (const row of rows) {
    const fields = row as Record<string, unknown>;
    const address = fields.address;
    const symbol = fields.symbol;
    const decimals = fields.decimals;
    if (typeof address !== 'string' || typeof symbol !== 'string' || typeof decimals !== 'number') {
      // 這張表是自己維護的；一列壞掉代表有人手動改過 DB。大聲失敗比回一個 `undefined` 的 symbol 好。
      throw new Error(`priceable_assets 有一列形狀不對：${JSON.stringify(row)}`);
    }
    const isNumeraire = fields.is_numeraire === true;
    let tradable: boolean | null = null;
    if (probe !== undefined) {
      if (isNumeraire) {
        // numeraire 不需要 per-pair oracle：它本身就是計價單位。
        tradable = true;
      } else {
        // ⚠ 這裡一定要自己 try/catch。`probe.oracleOf` 每一次都是鏈上讀取，而它失敗的原因
        // 與「這個部署沒有 executor」無關 —— fork 的 archive 窗口過了（publicnode 對歷史 storage
        // 回 403）、RPC 抖一下、節點換了，都會讓它拋。把例外漏出去，整個 `GET /assets` 就變 500，
        // 而這個端點要回答的是「有哪些資產可以選」，不是「鏈現在好不好」。
        // 查不到就是 `null`（未知），前端會顯示 unknown 並允許選 —— 那比整頁壞掉好。
        try {
          const oracle = await probe.oracleOf(address);
          tradable = oracle !== '0x0000000000000000000000000000000000000000';
        } catch {
          tradable = null;
        }
      }
    }
    assets.push({ address, symbol, decimals, isNumeraire, tradable });
  }
  return assets;
}
