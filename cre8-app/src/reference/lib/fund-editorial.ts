import { X_MODEL_DISCLAIMER, normalizeXHandle } from "./x-profile";

const SOURCES: Record<string, { label: string; disclaimer: string }> = {
  "elon-universe": { label: "Thematic model", disclaimer: "CRE8’s thematic allocation, inspired by publicly associated businesses and historical crypto disclosures. It is not Elon Musk’s verified current portfolio. Model weights are determined by CRE8; no affiliation or endorsement is implied." },
  "pelosi-disclosed-equity": { label: "Public disclosures", disclaimer: "A CRE8-selected subset of Pelosi household transaction disclosures, primarily those of Paul Pelosi. Disclosures may be delayed and do not establish current positions. Model weights are not the household’s actual allocations. No affiliation or endorsement is implied." },
  "berkshire-disclosed-equities": { label: "Public filings", disclaimer: "Based on the CRE8-supported selection from Berkshire Hathaway’s June 30, 2026 13F equity disclosure, with retained source weights normalized to 100%. GOOG is combined into GOOGL. It excludes cash, bonds and subsidiaries, and is not Berkshire’s complete or current portfolio. No affiliation or endorsement is implied." },
  "trump-universe": { label: "Disclosures + thematic model", disclaimer: "A CRE8 model combining selected publicly disclosed equities with related assets. Disclosed value ranges do not establish actual weights or current holdings. Only CRE8-supported stocks are included and their source weights are normalized to 100%. This is not Donald Trump’s verified portfolio; no affiliation or endorsement is implied." },
};
// Investor-facing explanations of the approved model. These do not change selection, weights or trading rules.
export const FUND_METHODOLOGY: Record<string, readonly string[]> = {
  mag7: [
    "Mag7 brings together seven large US technology and growth businesses: Apple, Microsoft, Alphabet, Amazon, NVIDIA, Meta and Tesla. CRE8 uses this fixed, named basket to provide exposure to consumer devices, enterprise software, cloud services, digital advertising, AI computing and electric vehicles in one model.",
    "Each company receives approximately one seventh of the target allocation, or 14.29%. Equal weighting gives every constituent a similar starting influence rather than allowing the largest company by market capitalization to dominate. This is an editorially selected seven-stock portfolio; membership does not automatically change with a market ranking.",
    "The historical model deploys its initial capital in eight weekly tranches, allocating each tranche across the same target weights. It then rebalances monthly. Investors should expect a concentrated equity allocation whose results depend on these seven businesses and their overlapping growth exposures.",
  ],
  "ai-buildout": [
    "AI Buildout focuses on the physical infrastructure needed to expand AI computing. CRE8 selects businesses across the supply chain rather than concentrating the model entirely in AI software: processors, custom chips and networking, semiconductor manufacturing, memory, data-center equipment and electricity infrastructure.",
    "The model assigns 20% to NVIDIA as its largest individual position; Broadcom and TSMC receive 15% each. AMD, Micron, Vertiv, Constellation Energy and GE Vernova receive 10% each. In total, 70% targets semiconductors and memory, with the remaining 30% in data-center equipment and power-related businesses. These fixed weights express the model’s chosen emphasis; they are not market-cap weights or a mechanical ranking of AI stocks.",
    "Initial capital enters in eight weekly tranches, followed by monthly rebalancing to the stated targets. The approach offers a focused view of AI infrastructure spending, with concentrated exposure to the investment cycles of the selected companies.",
  ],
  "multi-asset-balanced": [
    "Multi-Asset Balanced combines several different sources of market exposure in a single model: broad US equities, US Treasury funds, gold and Bitcoin. CRE8 chooses a small set of representative instruments so that the allocation can be understood at the asset-class level, rather than as a long list of individual stocks.",
    "Target weights are 35% in SPY for US large-cap equities, 20% in IEF for 7–10-year Treasuries, 10% in TLT for Treasuries with more than 20 years to maturity, 20% in gold exposure through XAUt, 10% in Bitcoin and a 5% USDT cash buffer. The weights are fixed model choices, not optimized forecasts. The mix retains material equity, interest-rate, gold and crypto exposure.",
    "The model allocates its initial capital once. It rebalances when an asset’s weight moves more than five percentage points away from its target, using the next common trading day supported by the historical observations. It does not run a monthly reset or automatically change the target mix in response to a forecast.",
  ],
  "crypto-leaders": [
    "Crypto Leaders is a CRE8-selected basket of ten established crypto networks and assets. The selection brings together Bitcoin, smart-contract networks, payment networks and blockchain infrastructure. It is a fixed model universe, with Bitcoin and Ethereum providing its largest combined exposure.",
    "Bitcoin receives 30% and Ethereum 20%. BNB, Solana and XRP each receive 10%; Dogecoin and Cardano each receive 5%; TRON receives 4%; Avalanche and Chainlink each receive 3%. This gives half of the target portfolio to Bitcoin and Ethereum while spreading the other half across eight additional assets. Constituents and weights do not automatically follow a top-ten market-cap table.",
    "The historical model invests its initial capital in eight weekly tranches and rebalances monthly. It holds the named assets without borrowing, leverage or liquidity-pool strategies. The portfolio remains fully exposed to crypto-market movements, including the common risks shared by its constituents.",
  ],
  "treasury-reserve": [
    "Treasury Reserve builds a US Treasury allocation around short maturities, with smaller positions farther along the maturity curve. CRE8 selects three Treasury ETFs whose stated maturity ranges make each part of the portfolio easy to distinguish.",
    "The model targets 70% in SGOV, which covers 0–3-month Treasury bills; 20% in IEF for 7–10-year Treasuries; and 10% in TLT for Treasuries with more than 20 years to maturity. The short-term fund forms the core, while the medium- and long-term funds introduce greater exposure to changes in longer-term bond prices. This is a Treasury-fund allocation, not a fixed-yield cash account.",
    "Initial capital is allocated once and target weights are restored monthly. Historical results use distribution-adjusted prices of the underlying ETFs. The model does not add lending income, assume a guaranteed return or treat tokenized fund units as direct cash deposits.",
  ],
  "elon-universe": [
    "Elon Universe is a CRE8-constructed thematic basket built around Tesla, SpaceX and crypto assets linked to Elon Musk through historical public associations or disclosures. Its purpose is to make that investment universe accessible as one allocation. The selection and its weights are CRE8 model decisions, not a reconstruction of Musk’s net worth or verified current trading account.",
    "The full target portfolio is 35% Tesla, 35% SpaceX, 15% Bitcoin, 10% Dogecoin and 5% Ethereum. The two companies therefore represent 70% of the intended allocation, with 30% in crypto. A public connection to an asset does not establish how much of it Musk currently owns.",
    "The historical model has an explicit two-stage treatment: from January through June 2026 it excludes SpaceX and proportionally scales the other four targets to 100%. On July 1 it rebalances existing model capital into the full five-asset mix. It then holds the composition until a model review; it does not automatically follow personal transactions or social posts.",
  ],
  "pelosi-disclosed-equity": [
    "Pelosi Disclosed Equity starts from publicly disclosed Pelosi household equity transactions, primarily those associated with Paul Pelosi. CRE8 selects ten common-stock exposures from that disclosed universe, creating an investable model spanning large technology companies, semiconductors, software and energy-related businesses.",
    "Alphabet, Amazon, Apple, Broadcom, Microsoft, NVIDIA and Salesforce each receive an 11% target weight. Bloom Energy, Intel and Vistra share the remaining 23% at approximately 7.67% each. This weighting deliberately creates a defined ten-stock basket; disclosure records do not provide these exact portfolio percentages or establish current household allocations.",
    "The historical model allocates once and holds until the composition is reviewed, without scheduled monthly rebalancing. It models the selected shares rather than reproducing every disclosed transaction or option contract. Public disclosures can be delayed, and the model should be read as a selected disclosure-based portfolio rather than a live copy of the household’s account.",
  ],
  "berkshire-disclosed-equities": [
    "Berkshire Disclosed Equities selects CRE8-supported stocks from Berkshire Hathaway’s June 30, 2026 equity disclosure. Corporate cash, bonds and subsidiaries are outside this model.",
    "The portfolio holds Apple, American Express, Alphabet, Coca-Cola and Chevron. Unsupported source holdings are excluded, and the retained source weights are proportionally normalized to 100%. GOOG exposure is explicitly combined into GOOGL.",
    "The historical model allocates once and holds until review. Current weights move with prices. The model is a selected supported subset, not Berkshire’s complete portfolio or actual account performance.",
  ],
  "trump-universe": [
    "Trump Universe uses a CRE8-selected basket of supported publicly disclosed equities alongside Trump Media & Technology Group. Disclosure ranges do not establish exact personal weights.",
    "The portfolio includes DJT, Apple, NVIDIA, Microsoft, Amazon, Broadcom, Meta, Tesla and JPMorgan Chase. Unsupported assets are excluded and retained source weights are proportionally normalized to 100%.",
    "Initial model capital is allocated once and held until a composition review. There is no automatic copying of private trades, disclosures or social-media posts. Simulated returns are not personal account returns.",
  ],
};
export const FUND_SUMMARIES: Record<string, readonly string[]> = {
  mag7: [
    "Mag7 is a fixed basket of Apple, Microsoft, Alphabet, Amazon, NVIDIA, Meta and Tesla. CRE8 selects these seven businesses to combine consumer devices, software, cloud services, digital advertising, AI computing and electric vehicles in one concentrated allocation.",
    "Each company starts at approximately 14.29%, giving every constituent a similar influence. The model deploys initial capital in eight weekly tranches and rebalances monthly to equal targets. This is an equity-focused strategy with substantial exposure to technology and growth businesses.",
  ],
  "ai-buildout": [
    "AI Buildout follows the physical expansion of AI, selecting eight businesses across chips, manufacturing, memory, data-center equipment and power. CRE8 allocates 70% to semiconductors and memory, and 30% to equipment and power-related businesses.",
    "NVIDIA receives 20%; Broadcom and TSMC receive 15% each; AMD, Micron, Vertiv, Constellation Energy and GE Vernova receive 10% each. Initial capital enters in eight weekly tranches, followed by monthly rebalancing to these fixed targets.",
  ],
  "multi-asset-balanced": [
    "Multi-Asset Balanced combines broad US equities, Treasuries, gold and Bitcoin. CRE8 targets 35% SPY, 20% IEF, 10% TLT, 20% gold through XAUt, 10% Bitcoin and a 5% USDT cash buffer, using a small number of representative instruments for each exposure.",
    "The model allocates initial capital once. It rebalances when an asset moves more than five percentage points away from its target, using the next supported common trading day. The allocation retains exposure to equity, bond, gold and crypto market movements.",
  ],
  "crypto-leaders": [
    "Crypto Leaders brings together ten CRE8-selected crypto assets, with half of the target portfolio in Bitcoin and Ethereum. The basket spans payment networks, smart-contract platforms and blockchain infrastructure, using a fixed constituent list.",
    "Targets are Bitcoin 30%, Ethereum 20%, BNB/Solana/XRP 10% each, Dogecoin/Cardano 5% each, TRON 4%, and Avalanche/Chainlink 3% each. Initial capital enters in eight weekly tranches, with monthly rebalancing. The model holds the assets without borrowing, leverage or liquidity-pool strategies.",
  ],
  "treasury-reserve": [
    "Treasury Reserve uses three Treasury ETFs to emphasize short maturities while retaining some medium- and long-term bond exposure. CRE8 targets 70% SGOV for 0–3-month bills, 20% IEF for 7–10-year Treasuries and 10% TLT for maturities above 20 years.",
    "Initial capital is allocated once and weights are restored monthly. Historical results use distribution-adjusted ETF prices. The longer-maturity positions add sensitivity to bond-price movements; this is a Treasury-fund portfolio with variable returns.",
  ],
  "elon-universe": [
    "Elon Universe combines businesses and crypto assets publicly associated with Elon Musk. CRE8 sets model targets of 35% Tesla, 35% SpaceX, 15% Bitcoin, 10% Dogecoin and 5% Ethereum. These weights express the theme and do not establish Musk’s actual holdings.",
    "The historical model excludes SpaceX through June 2026 and scales the other targets proportionally. On July 1 it rebalances existing capital into the full five-asset mix, then holds until a composition review. There is no automatic copying of personal trades or social posts.",
  ],
  "pelosi-disclosed-equity": [
    "Pelosi Disclosed Equity selects ten common stocks from public Pelosi household transaction disclosures, primarily those associated with Paul Pelosi. Alphabet, Amazon, Apple, Broadcom, Microsoft, NVIDIA and Salesforce each receive 11%; Bloom Energy, Intel and Vistra share the remaining 23%.",
    "CRE8 assigns these model weights rather than inferring current household percentages from disclosure records. The model allocates once and holds until review. It covers selected share exposures; disclosure delays and the model’s selection limit how closely it can represent the household’s portfolio.",
  ],
  "berkshire-disclosed-equities": [
    "A five-stock selection from Berkshire Hathaway’s June 2026 equity disclosure: Apple, American Express, Alphabet, Coca-Cola and Chevron. The basket focuses on the supported holdings within that disclosed universe.",
    "CRE8 removes unsupported holdings and scales the remaining source weights to 100%. Initial capital is allocated once and held until review; current displayed weights drift with prices.",
  ],
  "trump-universe": [
    "A CRE8-selected basket of publicly disclosed equities with DJT. It combines technology leaders and JPMorgan Chase with a direct Trump Media exposure; these are model choices, not verified personal weights.",
    "Only supported stocks are included, with retained source weights proportionally scaled to 100%. Initial capital is allocated once and held until review; public disclosure ranges do not establish exact holdings or trading dates.",
  ],
};
export function fundEditorial(f: { slug: string; group?: string; strategy: string; xHandle?: string; sourceModel?: {description:string;scope:string;notes:string[];backtested?:boolean;historyKind?:string} }) {
  if (f.sourceModel) {
    const replay=f.sourceModel.historyKind==="post-replay";
    const paragraphs=[f.sourceModel.description,f.sourceModel.scope.split(/(?<=\.) /)[0]+(f.sourceModel.backtested?replay?" Historical results replay available public-post signals.":" Historical results follow the reported holding dates.":"")];
    return {description:paragraphs.join("\n\n"),paragraphs,methodology:[f.sourceModel.scope,...f.sourceModel.notes],sourceLabel:f.group==="x-voices"?"AI-inferred index":"Published holdings model",
      disclaimer:[f.group==="x-voices"?X_MODEL_DISCLAIMER:"A selected disclosure-based CRE8 model, not the named person’s verified personal account or the institution’s complete portfolio. No affiliation or endorsement is implied.",f.sourceModel.backtested?replay?"Performance is inferred from CRE8’s defined replay of available public-post signals, before fees and costs. Missing source events and unobserved positions can materially change results. These are not executed trades or personal account returns. The latest dated source estimate reconciles current model targets. Token execution is unavailable.":"Performance reconstructs the supported selection at reported holding dates, before fees and costs. Source publication delays and unknown intraperiod trades are not modeled. Holdings changes are not executed trades. Token execution is unavailable.":"Targets and updates are reconstructed reference allocations, not executed trades. Historical returns and token execution are unavailable."].join(" "),xHandle:normalizeXHandle(f.xHandle)};
  }
  const source = f.group === "x-voices" ? { label: "AI-inferred index", disclaimer: X_MODEL_DISCLAIMER } : SOURCES[f.slug] ?? { label: "Thematic model", disclaimer: "An illustrative CRE8 model portfolio. Asset selection and target weights are determined by CRE8. Simulated results use historical underlying prices and do not represent live fund returns, guaranteed performance or investment advice." };
  const paragraphs = FUND_SUMMARIES[f.slug] ?? [f.strategy];
  return { description: paragraphs.join("\n\n"), paragraphs, methodology: FUND_METHODOLOGY[f.slug] ?? paragraphs, sourceLabel: source.label, disclaimer: source.disclaimer, xHandle: normalizeXHandle(f.xHandle) };
}
