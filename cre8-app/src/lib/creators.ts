import { periodMetrics } from '../reference/lib/fund-explore';
import type { Period } from '../reference/lib/fund-explore';
import type { ReferenceFund } from './public-funds';

// 名稱只映射已知的目錄建立者，不用基金題材人物或 X handle 推測身分。
export const CRE8_CREATOR = '0x7b2938433f063553a6bf70a8161121010e391a11';
export function isCre8CreatorWallet(address: string | null): boolean {
  return address?.toLowerCase() === CRE8_CREATOR;
}

export type Creator = {
  id: string;
  name: string;
  funds: ReferenceFund[];
  averageReturn: number | null;
  measuredFunds: number;
  partial: boolean;
};
export const creatorName = (id: string): string => id === CRE8_CREATOR ? 'CRE8' : `${id.slice(0, 6)}…${id.slice(-4)}`;
export const creatorPath = (id: string): string => `/creator/${id === CRE8_CREATOR ? 'cre8' : id}`;
export const creatorId = (id: string | undefined): string | null => {
  const normalized = id?.toLowerCase();
  if (normalized === 'cre8') return CRE8_CREATOR;
  return normalized && /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : null;
};

/** 每檔基金等權重的模型報酬平均，不是持有人收益，也不使用模型規模冒充資金權重。 */
export function rankCreators(funds: readonly ReferenceFund[], period: Period): Creator[] {
  const groups = new Map<string, ReferenceFund[]>();
  for (const fund of funds) {
    const id = creatorId(fund.creator);
    if (id === null) continue;
    const entries = groups.get(id) ?? [];
    if (!entries.some(entry => entry.slug === fund.slug)) entries.push(fund);
    groups.set(id, entries);
  }
  return [...groups].map(([id, entries]) => {
    const metrics = entries.map(fund => periodMetrics(fund, period));
    const returns = metrics.map(metric => metric.returnPct).filter((value): value is number => value !== null && Number.isFinite(value));
    return {
      id, name: creatorName(id), funds: entries,
      averageReturn: returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
      measuredFunds: returns.length,
      partial: metrics.some(metric => metric.partial),
    };
  }).sort((a, b) => {
    if (a.averageReturn === null) return b.averageReturn === null ? a.id.localeCompare(b.id) : 1;
    if (b.averageReturn === null) return -1;
    return b.averageReturn - a.averageReturn || a.id.localeCompare(b.id);
  });
}
