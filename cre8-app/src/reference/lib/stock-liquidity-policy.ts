/** Planning-list evidence only. Neither a pool snapshot nor an indicative RFQ authorizes a trade. */
export const STOCK_LIQUIDITY_POLICY = {
  quoteReserveRaw: "50000000000000000000000",
  depthRaw: "10000000000000000000000",
  probeRaw: "100000000000000000000",
  notionalRaw: "50000000000000000000000",
  maxImpactBps: 200,
} as const;
export const STOCK_USDT = "0x55d398326f99059ff775485246999027b3197955";
export type IndicativeQuote = {
  inputToken: string; outputToken: string; inputRaw: string; outputRaw: string; minOutputRaw: string;
  priceImpactBps: number; marketStatus: string; quotedAt: string;
};
export type StockLiquidityEntry = {
  token: string; symbol: string; checkedAt: string;
  method: "pcsx-indicative-rfq" | "pancake-v3";
  small?: IndicativeQuote | null; buy?: IndicativeQuote | null; sell?: IndicativeQuote | null;
  pools?: { address: string; quoteBalanceRaw?: string; depthUpRaw?: string | null; depthDownRaw?: string | null; liquidityGapWithin25?: boolean | null; liquidity?: string; unlocked?: boolean }[];
  errors?: string[];
};
const address = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value) && !/^0x0{40}$/.test(value);
const raw = (value: unknown): bigint | null => typeof value === "string" && /^[1-9][0-9]{0,77}$/.test(value) && BigInt(value) < 1n << 256n ? BigInt(value) : null;
const loss = (expected: bigint, actual: bigint) => actual >= expected ? 0n : ((expected - actual) * 10000n + expected - 1n) / expected;
const quote = (q: IndicativeQuote | null | undefined, from: string, to: string, amount: bigint) => !!q
  && q.inputToken === from && q.outputToken === to && raw(q.inputRaw) === amount
  && raw(q.outputRaw) !== null && raw(q.minOutputRaw) !== null && BigInt(q.minOutputRaw) <= BigInt(q.outputRaw)
  && Number.isSafeInteger(q.priceImpactBps) && Math.abs(q.priceImpactBps) <= STOCK_LIQUIDITY_POLICY.maxImpactBps
  && Number.isFinite(Date.parse(q.quotedAt)) && typeof q.marketStatus === "string";

export function stockLiquiditySufficient(entry: StockLiquidityEntry | null | undefined): boolean {
  if (!entry || !address(entry.token) || !Number.isFinite(Date.parse(entry.checkedAt))) return false;
  if (entry.method === "pancake-v3") return !!entry.pools?.some(pool => address(pool.address)
    && raw(pool.quoteBalanceRaw) !== null && BigInt(pool.quoteBalanceRaw!) >= BigInt(STOCK_LIQUIDITY_POLICY.quoteReserveRaw)
    && raw(pool.depthUpRaw) !== null && BigInt(pool.depthUpRaw!) >= BigInt(STOCK_LIQUIDITY_POLICY.depthRaw)
    && raw(pool.depthDownRaw) !== null && BigInt(pool.depthDownRaw!) >= BigInt(STOCK_LIQUIDITY_POLICY.depthRaw)
    && pool.liquidityGapWithin25 === false && raw(pool.liquidity) !== null && pool.unlocked === true);
  if (entry.method !== "pcsx-indicative-rfq") return false;
  const size = BigInt(STOCK_LIQUIDITY_POLICY.notionalRaw), probe = BigInt(STOCK_LIQUIDITY_POLICY.probeRaw);
  if (!quote(entry.small, STOCK_USDT, entry.token, probe) || !quote(entry.buy, STOCK_USDT, entry.token, size)) return false;
  if (!quote(entry.sell, entry.token, STOCK_USDT, BigInt(entry.buy!.minOutputRaw))) return false;
  const times = [entry.small!, entry.buy!, entry.sell!].map(q => Date.parse(q.quotedAt));
  if (Math.max(...times) - Math.min(...times) > 60000 || times.some(at => at > Date.parse(entry.checkedAt))) return false;
  // Compare large-vs-small buy output, then a conservative round trip using BOTH quoted floors.
  // “closed” is recorded, not converted into an execution promise; this is a saved planning snapshot.
  return loss(BigInt(entry.small!.outputRaw) * size, BigInt(entry.buy!.outputRaw) * probe) <= BigInt(STOCK_LIQUIDITY_POLICY.maxImpactBps)
    && loss(size, BigInt(entry.sell!.minOutputRaw)) <= BigInt(STOCK_LIQUIDITY_POLICY.maxImpactBps);
}
