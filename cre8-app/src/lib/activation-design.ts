import {
  reviveBuilder,
  assetOf,
  cashShare,
  DRAFT_STORAGE_KEY,
} from "../reference/lib/fund-builder";
export type ActivationDesign = {
  name: string;
  weights: Record<string, number>;
  symbols: Record<string, string>;
};
// 草稿僅作為表單輸入；資產仍須與登入後 API 的確切地址核對，不能直接成為交易授權。
export function activationDesign(value: unknown): ActivationDesign | null {
  const design = reviveBuilder(value, "demo");
  if (!design || !design.rows.length) return null;
  const weights: Record<string, number> = {},
    symbols: Record<string, string> = {};
  for (const row of design.rows) {
    const asset = assetOf(row.key),
      token = asset.token.toLowerCase();
    weights[token] = (weights[token] || 0) + Math.round(row.share * 100) / 100;
    symbols[token] = asset.symbol;
  }
  const cash = Math.round(cashShare(design.rows) * 100) / 100;
  if (cash > 0) {
    const token = "0x55d398326f99059ff775485246999027b3197955";
    weights[token] = (weights[token] || 0) + cash;
    symbols[token] = "USDT";
  }
  return { name: design.name, weights, symbols };
}
export function savedActivationDesign(): ActivationDesign | null {
  try {
    return activationDesign(
      JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || "null"),
    );
  } catch {
    return null;
  }
}
