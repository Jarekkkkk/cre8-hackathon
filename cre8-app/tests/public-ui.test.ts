import { test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { catalogueTargets } from "../src/data/public-fund-adapter";
import {
  REFERENCE_FUNDS,
  REFERENCE_METADATA,
  REFERENCE_ASSETS,
  RISK_FREE,
  referenceHoldings,
} from "../src/lib/public-funds";
import {
  periodSeries,
  periodMetrics,
  analyzeFundPerformance,
  selectFunds,
} from "../src/reference/lib/fund-explore";
import { recentUpdateSources } from "../src/reference/lib/recent-trades";
import {
  ASSETS,
  canPickAsset,
  emptyBuilder,
  addAsset,
} from "../src/reference/lib/fund-builder";
import { activationDesign } from "../src/lib/activation-design";
import { safePublicReturn } from "../src/lib/public-navigation";
import { assetReturnUrl } from "../src/reference/lib/asset-navigation";
import {
  validReferenceUpdate,
  refreshReferenceData,
} from "../src/lib/reference-refresh";
const snapshot = JSON.parse(
  fs.readFileSync("src/reference/data/funds.json", "utf8"),
);
const source = JSON.parse(
  fs.readFileSync("docs/public-ui-source.json", "utf8"),
);
test("full published catalogue and all figures remain available; withdrawn figures stay hidden", () => {
  expect(REFERENCE_FUNDS).toHaveLength(30);
  expect(REFERENCE_ASSETS).toHaveLength(219);
  expect(ASSETS.filter(canPickAsset)).toHaveLength(218);
  expect(
    REFERENCE_FUNDS.some((f) =>
      /ansem|arthur-hayes|michael-burry/.test(f.slug),
    ),
  ).toBe(false);
  expect(REFERENCE_FUNDS.filter((f) => f.sourceModel).length).toBe(21);
  expect(REFERENCE_FUNDS.filter((f) => f.group === "x-voices").length).toBe(7);
  expect(source.commit).toBe("0f3196d37821561050dee1176d9d33e3b51c5d5e");
  expect(REFERENCE_FUNDS).toEqual(snapshot.funds);
});
test("every model has its approved cover, real holdings, history and all recorded updates", () => {
  for (const fund of REFERENCE_FUNDS) {
    const meta = REFERENCE_METADATA[fund.slug];
    expect(fs.existsSync(path.join("public", meta.cover.src))).toBe(true);
    expect(meta.holdings.length).toBeGreaterThan(0);
    expect(meta.updates.length).toBeGreaterThan(0);
    expect(fund.nav!.length).toBeGreaterThan(90);
    for (const row of meta.holdings) {
      expect(row.weight!).toBeGreaterThan(0);
      if (row.preview?.logo)
        expect(
          fs.existsSync(path.join("public", row.preview.logo.split("?")[0])),
        ).toBe(true);
    }
    if (fund.sourceModel) {
      expect(meta.profile).not.toBeNull();
      expect(meta.updates).toEqual(fund.sourceModel.updates!);
      for (const update of meta.updates)
        expect(recentUpdateSources(update, fund.group).length).toBeGreaterThan(
          0,
        );
    }
  }
});
test("selected-window returns and drawdowns match original histories across all30models", () => {
  for (const fund of REFERENCE_FUNDS)
    for (const period of ["7D", "30D", "90D", "1Y", "ALL"] as const) {
      const points = periodSeries(fund, period),
        stats = analyzeFundPerformance(points, RISK_FREE),
        metrics = periodMetrics(fund, period);
      expect(stats.returnPct!).toBeCloseTo(metrics.returnPct!, 10);
      expect(stats.maxDrawdown!).toBeCloseTo(metrics.maxDrawdown!, 10);
      if (period === "7D" || period === "30D") {
        expect(stats.sharpe).toBeNull();
        expect(stats.volatility).toBeNull();
      } else {
        expect(Number.isFinite(stats.sharpe)).toBe(true);
        expect(Number.isFinite(stats.volatility)).toBe(true);
      }
    }
  const f = REFERENCE_FUNDS.find(
    (f) => f.slug === "leopold-aschenbrenner-situational",
  )!;
  expect(
    analyzeFundPerformance(periodSeries(f, "1Y"), RISK_FREE).sharpe!,
  ).toBeCloseTo(1.0776863587932, 12);
});
test("Sharpe uses historical excess returns and rejects stale references and zero variance", () => {
  const begin = Date.UTC(2026, 0, 1),
    returns = Array.from({ length: 90 }, (_, i) => (i % 2 ? 0.02 : -0.01));
  let v = 1;
  const points = [
    { t: begin, v },
    ...returns.map((r, i) => ({
      t: begin + (i + 1) * 86400000,
      v: (v *= 1 + r),
    })),
  ];
  const rates = {
    series: "DGS3MO" as const,
    source: "fixture",
    through: "2026-04-01",
    rates: Array.from({ length: 91 }, (_, i) => ({
      date: new Date(begin + i * 86400000).toISOString().slice(0, 10),
      annualPct: 4,
    })),
  };
  const expected =
    ((0.005 - Math.expm1(Math.log1p(0.04) / 365)) /
      (0.015 * Math.sqrt(90 / 89))) *
    Math.sqrt(365);
  expect(analyzeFundPerformance(points, rates).sharpe!).toBeCloseTo(
    expected,
    10,
  );
  expect(
    analyzeFundPerformance(points, { ...rates, rates: rates.rates.slice(0, 1) })
      .sharpe,
  ).toBeNull();
  expect(analyzeFundPerformance(points, null).volatility!).toBeGreaterThan(0);
  expect(
    analyzeFundPerformance(
      points.map((p) => ({ ...p, v: 1 })),
      rates,
    ).sharpe,
  ).toBeNull();
});
test("cash stays USDT without a price chart, market cap or performance claim", () => {
  const cash = REFERENCE_ASSETS.find((a) => a.symbol === "USDT")!;
  expect(cash.name).toBe("USDT");
  expect(cash.history).toHaveLength(0);
  expect(cash.size).toBeNull();
  const restored = referenceHoldings([
    { p: "Idle", loc: "USDT in fund", w: 100 },
  ]);
  expect(restored[0].asset).toBe("USDT");
  expect(restored[0].preview?.price).toBeNull();
  expect(
    referenceHoldings([{ p: "Fund", loc: "NVDAB", w: 100 }])[0].asset,
  ).toBe("NVDA");
});
test("search and category filters cover X voices and underlying company names", () => {
  expect(
    selectFunds(REFERENCE_FUNDS, "", "x-voices", "perf", "1Y"),
  ).toHaveLength(7);
  expect(
    selectFunds(REFERENCE_FUNDS, "NVIDIA", "all", "perf", "1Y").length,
  ).toBeGreaterThan(1);
});
test("activation imports only allocation addresses and weights, without authorizing or translating other rules", () => {
  let design = addAsset(emptyBuilder(), "BTC", "demo");
  design = { ...design, name: "Test allocation" };
  const plan = activationDesign(design)!;
  expect(plan.name).toBe(design.name);
  expect(Object.values(plan.weights).reduce((a, b) => a + b, 0)).toBe(100);
  expect(
    Object.keys(plan.weights).every((a) => /^0x[0-9a-f]{40}$/.test(a)),
  ).toBe(true);
  expect(
    activationDesign({ rows: [{ key: "NOT_A_REAL_ASSET", share: 100 }] }),
  ).toBeNull();
  expect(activationDesign(null)).toBeNull();
});
test("deep-link returns retain same-origin discovery context and reject external redirects", () => {
  const origin = "https://cre8-atp.pages.dev";
  expect(safePublicReturn("/leaderboard?period=90D", origin)).toBe(
    "/leaderboard?period=90D",
  );
  expect(safePublicReturn("https://evil.example/vaults", origin)).toBe(
    "/vaults",
  );
  expect(safePublicReturn("//evil.example/vaults", origin)).toBe("/vaults");
  expect(
    assetReturnUrl(
      origin +
        "/asset/stock-aapl?returnTo=" +
        encodeURIComponent("/funds/mag7?period=90D"),
      origin + "/vaults/",
    ),
  ).toBe(origin + "/funds/mag7?period=90D");
});
test("daily reference update requires the complete same catalogue and real completed dates", () => {
  const fresh = structuredClone(snapshot);
  fresh.through = "2026-11-10";
  for (const fund of fresh.funds) {
    fund.nav.push({ t: Date.UTC(2026, 10, 11) - 1, v: fund.sharePrice });
    fund.backtest.through = fresh.through;
    for (const [period, days] of [
      ["7D", 7],
      ["30D", 30],
      ["90D", 90],
      ["ALL", fund.nav.length - 1],
    ] as const) {
      const points = fund.nav.slice(-days - 1);
      fund.returns[period] = (points.at(-1)!.v / points[0].v - 1) * 100;
      let peak = points[0].v,
        drop = 0;
      for (const point of points) {
        peak = Math.max(peak, point.v);
        drop = Math.min(drop, (point.v / peak - 1) * 100);
      }
      fund.maxDrawdown[period] = drop;
    }
  }
  expect(validReferenceUpdate(fresh, "2026-11-10")).toBe(true);
  expect(
    validReferenceUpdate(
      { ...fresh, funds: fresh.funds.slice(1) },
      "2026-11-10",
    ),
  ).toBe(false);
  expect(
    validReferenceUpdate({ ...fresh, through: "2026-11-12" }, "2026-11-10"),
  ).toBe(false);
  const truncated = structuredClone(fresh);
  truncated.funds[0].nav = [
    truncated.funds[0].nav[0],
    truncated.funds[0].nav.at(-1),
  ];
  expect(validReferenceUpdate(truncated, "2026-11-10")).toBe(false);
  const missingTrades = structuredClone(fresh);
  delete missingTrades.funds.find((f: any) => f.sourceModel).sourceModel
    .updates[0].trades;
  expect(validReferenceUpdate(missingTrades, "2026-11-10")).toBe(false);
  const droppedHistory = structuredClone(fresh);
  droppedHistory.funds
    .find((f: any) => f.sourceModel)
    .sourceModel.updates.pop();
  expect(validReferenceUpdate(droppedHistory, "2026-11-10")).toBe(false);
  const droppedModel = structuredClone(fresh);
  delete droppedModel.funds.find((f: any) => f.sourceModel).sourceModel;
  expect(validReferenceUpdate(droppedModel, "2026-11-10")).toBe(false);
  const wrongReturn = structuredClone(fresh);
  wrongReturn.funds[0].returns["7D"] += 1;
  expect(validReferenceUpdate(wrongReturn, "2026-11-10")).toBe(false);
  const wrongSharePrice = structuredClone(fresh);
  wrongSharePrice.funds[0].sharePrice += 0.01;
  expect(validReferenceUpdate(wrongSharePrice, "2026-11-10")).toBe(false);
  fresh.funds[0].positions[0].w = NaN;
  expect(validReferenceUpdate(fresh, "2026-11-10")).toBe(false);
});
test("failed public reference reads keep every existing observation and date", async () => {
  const before = JSON.stringify(REFERENCE_FUNDS);
  const mock: typeof fetch = async () =>
    new Response("unavailable", { status: 503 });
  expect(await refreshReferenceData(Date.UTC(2026, 10, 11, 1), mock)).toBe(
    false,
  );
  expect(JSON.stringify(REFERENCE_FUNDS)).toBe(before);
});
test("UI public assets preserve pinned identities and the wallet implementation stays isolated", () => {
  const bytes = fs.readFileSync("src/reference/data/funds.json");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    source.fundsSha256,
  );
  expect(
    fs.readFileSync("src/reference/components/fund-builder.tsx", "utf8"),
  ).not.toContain("next/image");
  expect(
    fs.readFileSync("src/reference/components/fund-builder.tsx", "utf8"),
  ).not.toContain("process.env");
});

test("mandate weights come from source targets rather than drifted current holdings", () => {
  for (const fund of REFERENCE_FUNDS)
    expect(
      catalogueTargets(fund).reduce((sum, row) => sum + row.weightBps, 0),
    ).toBe(10000);
  const fund = REFERENCE_FUNDS.find((f) => f.slug === "mag7")!;
  expect(
    catalogueTargets(fund).find((t) => t.symbol === "AMZNB")!.weightBps,
  ).toBe(
    Math.round(
      fund.backtest.targets.find((t) => t.symbol === "AMZNB")!.weight * 100,
    ),
  );
});
