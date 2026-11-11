// Navigation metadata only: never used to value a fund or authorize a trade.
const periods = ["7D", "30D", "90D", "1Y", "ALL"] as const;
type Period = typeof periods[number];
export type ExploreFilters = { q: string; category: string; assets: string[]; period: Period; sort: string };
export const performancePeriod = (value: string | null | undefined): Period => periods.includes(value as Period) ? value as Period : "1Y";
export function exploreFilters(href: string): ExploreFilters {
  const q = new URL(href).searchParams;
  return {
    q: (q.get("q") || "").slice(0, 100),
    category: q.get("category") === "people" ? "public-figures" : ["themes", "public-figures", "x-voices"].includes(q.get("category") || "") ? q.get("category")! : "all",
    assets: [...new Set((q.get("assets") || "").split(","))].filter(a => ["stocks", "crypto", "rwa"].includes(a)),
    period: performancePeriod(q.get("period")),
    sort: ["holders", "tvl", "dd", "age"].includes(q.get("sort") || "") ? q.get("sort")! : "perf",
  };
}
export function exploreUrl(href: string, filters: ExploreFilters): string {
  const url = new URL(href), values = {
    q: filters.q.slice(0, 100), category: filters.category === "all" ? "" : filters.category,
    assets: filters.assets.join(","), period: performancePeriod(filters.period), sort: filters.sort === "perf" ? "" : filters.sort,
  };
  for (const [key, value] of Object.entries(values)) { if (value) url.searchParams.set(key, value); else url.searchParams.delete(key); }
  return url.href;
}
export function fundDetailUrl(href: string, listHref: string, period: string): string {
  const list = new URL(listHref), url = new URL(href, list);
  url.searchParams.set("period", performancePeriod(period));
  if (url.origin === list.origin) url.searchParams.set("returnTo", list.pathname + list.search + list.hash);
  return url.href;
}
export function fundReturnUrl(href: string, fallback: string, referrer = ""): string {
  const here = new URL(href), home = new URL(fallback, here);
  const parent = (value: string, listOnly: boolean) => {
    if (!value || value.length > 4096) return null;
    try {
      const url = new URL(value, here);
      if (url.origin !== here.origin || url.username || url.password || url.protocol !== here.protocol) return null;
      if (url.pathname === home.pathname) return url.href;
      if (listOnly) return null;
      const root = home.pathname.replace(/vaults(?:\.html|\/)?$/, "");
      return ["portfolio", "leaderboard", "agent"].some(name => url.pathname === root + name + "/" || url.pathname === root + name + ".html") || url.pathname.startsWith(root + "creator/") ? url.href : null;
    } catch { return null; }
  };
  return parent(here.searchParams.get("returnTo") || "", true) || parent(referrer, false) || home.href;
}
