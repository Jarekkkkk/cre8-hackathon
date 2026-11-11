/** ATP 票券的相容型別；完整目錄與歷史資料由 public-fund-adapter 接上已核准來源。
 * 參考配置與真實帳戶資料分開，持有帳戶時仍使用 API 的即時目標與餘額。 */

export type MockHolding = {
  symbol: string;
  /** bps（10000 = 100%）。與後端 `allocation.assets[].weightBps` 同一個單位。 */
  weightBps: number;
};

export type MockFund = {
  slug: string;
  name: string;
  symbol: string;
  thesis: string;
  /** 卡片上的短句（設計稿 `FUND_ART.subtitle`）；比 `thesis` 短，`thesis` 留給展開後的說明。 */
  subtitle: string;
  /** 設計稿 `FUND_ART.type`，例如 `Stocks + Crypto`。 */
  kind: string;
  /** `public/logos/people/<portrait>.jpg`。沒有的基金用 `mark` 當縮寫。 */
  portrait?: string;
  /** `fund-mark` 的文字（設計稿的 marks：M7 / AI / CL / MA / TR）。 */
  mark: string;
  risk: 'High' | 'Medium' | 'Low';
  /** 再平衡節奏；`none` = 不自動再平衡。 */
  rebalance: 'monthly' | 'drift' | 'none';
  holdings: MockHolding[];
};

/** 權重總和檢查：範例資料也要自洽，不然畫面會出現「100% 卻少 3%」這種沒人會去查的錯。 */
export {PUBLIC_FUNDS as MOCK_FUNDS} from './public-fund-adapter';
