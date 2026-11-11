// 公開文件與模型配置各自保有日期。申報未提供模型權重或完整成交紀錄。
type FundDisclosure = {
  date: string;
  title: string;
  detail: string;
  url: string;
};

export const FUND_DISCLOSURES: Record<string, readonly FundDisclosure[]> = {
  "berkshire-disclosed-equities": [
    {
      date: "2026-06-30",
      title: "Berkshire Hathaway · Q2 2026 holdings",
      detail: "Quarter-end SEC Form 13F, filed Aug 14, 2026.",
      url: "https://www.sec.gov/Archives/edgar/data/1067983/000119312526352200/0001193125-26-352200-index.htm",
    },
    {
      date: "2026-03-31",
      title: "Berkshire Hathaway · Q1 2026 holdings",
      detail: "Quarter-end SEC Form 13F, filed May 15, 2026.",
      url: "https://www.sec.gov/Archives/edgar/data/1067983/000119312526226661/0001193125-26-226661-index.htm",
    },
    {
      date: "2025-12-31",
      title: "Berkshire Hathaway · Q4 2025 holdings",
      detail: "Quarter-end SEC Form 13F, filed Feb 17, 2026.",
      url: "https://www.sec.gov/Archives/edgar/data/1067983/000119312526054580/0001193125-26-054580-index.htm",
    },
  ],
  "pelosi-disclosed-equity": [
    {
      date: "2026-05-15",
      title: "Pelosi household · 2025 financial disclosure",
      detail:
        "Annual House disclosure signed May 15, 2026. Includes reported assets and transactions.",
      url: "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2025/10075701.pdf",
    },
    {
      date: "2026-01-23",
      title: "Pelosi household · Periodic Transaction Report",
      detail:
        "House report signed Jan 23, 2026. See the filing for transaction dates and value ranges.",
      url: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20033725.pdf",
    },
  ],
  "trump-universe": [
    {
      date: "2026-09-17",
      title: "Trump · Periodic Transaction Report",
      detail:
        "OGE Form 278-T signed Sep 17, 2026. See the filing for transaction dates and value ranges.",
      url: "https://www.whitehouse.gov/wp-content/uploads/2026/11/President-Donald-J.-Trump-Periodic-Transaction-Report-09.17.26.pdf",
    },
    {
      date: "2026-06-27",
      title: "Trump · Periodic Transaction Report",
      detail:
        "OGE Form 278-T signed Jun 27, 2026. See the filing for transaction dates and value ranges.",
      url: "https://www.whitehouse.gov/wp-content/uploads/2026/06/President-Donald-J.-Trump-Periodic-Transaction-Report-0.6.25.26-2.pdf",
    },
  ],
};
