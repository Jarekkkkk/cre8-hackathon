import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
const source = process.argv[2];
if (!source)
  throw new Error(
    "Usage: node --experimental-strip-types scripts/sync-public-ui.mjs /path/to/bnb-agent-vaults",
  );
const pinned = "0f3196d37821561050dee1176d9d33e3b51c5d5e",
  web = path.resolve(source, "web"),
  target = path.resolve("src/reference");
const expectedTree = execFileSync("git", ["rev-parse", `${pinned}^{tree}`], {
  cwd: source,
  encoding: "utf8",
}).trim();
if (
  execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: source,
    encoding: "utf8",
  }).trim() !== expectedTree
)
  throw new Error("Source must match the pinned published UI tree");
if (
  execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: source,
    encoding: "utf8",
  }).trim()
)
  throw new Error("Source working tree must be clean");
for (const folder of ["lib", "data"])
  fs.rmSync(path.join(target, folder), { recursive: true, force: true });
const seen = new Set(),
  receipts = [];
function copy(relative) {
  const file = path.join(web, relative);
  if (seen.has(file)) return;
  seen.add(file);
  const bytes = fs.readFileSync(file),
    destination = path.join(target, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  let body = bytes.toString();
  if (relative === "lib/underlying-assets.ts")
    body =
      body.match(/^export type UnderlyingAsset = \{[\s\S]*?^\};/m)[0] + "\n";
  if (relative === "lib/demo-fund-backtest.ts")
    body = body.match(/^export type ModelAllocationUpdate = .*$/m)[0] + "\n";
  if (/\.(ts|tsx|mjs)$/.test(file)) {
    for (const item of body.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g))
      if (item[1].startsWith(".")) {
        const next = path.resolve(path.dirname(file), item[1]);
        if (/\.(ts|tsx|mjs|json|css)$/.test(next))
          copy(path.relative(web, next));
      }
    body = body.replace(/(from\s+["'][^"']+)\.tsx?(["'])/g, "$1$2");
  }
  if (relative === "lib/asset-navigation.ts")
    body = body
      .replace(
        "[`${root}create/`, `${root}vaults/`]",
        "[`${root}create`, `${root}create/`, `${root}vaults`, `${root}vaults/`]",
      )
      .replace("vault/[a-z0-9-]+/$", "(?:vault|funds)/[a-z0-9-]+/?$");
  if (relative.endsWith(".module.css"))
    body = body.replace(
      /border-radius:([^;}!]+)(?![^;}]*!important)([;}])/g,
      "border-radius:$1!important$2",
    );
  fs.writeFileSync(
    destination,
    /\.(ts|tsx|mjs|css)$/.test(file) ? body : bytes,
  );
  receipts.push({
    source: relative,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
for (const name of [
  "fund-builder.ts",
  "fund-builder-charts.ts",
  "fund-explore.ts",
  "fund-performance.ts",
  "recent-trades.ts",
])
  copy("lib/" + name);
for (const name of [
  "fund-builder.tsx",
  "fund-cover-editor.tsx",
  "x-profile.tsx",
]) {
  const file = path.join(web, "components", name),
    bytes = fs.readFileSync(file);
  let body = bytes.toString();
  body = body
    .replace('import Image from "next/image";', 'import Image from "./Image";')
    .replace(/(from\s+["'][^"']+)\.tsx?(["'])/g, "$1$2");
  if (name === "fund-builder.tsx") {
    body = body
      .replace(
        'import type { SupportLine } from "../lib/fund-worker-support";',
        'import type { SupportLine } from "../lib/support-line";',
      )
      .replace(
        'import { siteNetwork, testnetUrl } from "../lib/site-network";',
        "",
      );
    body = body
      .replace(
        'const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";',
        'const base = "";',
      )
      .replace(
        'const app = (process.env.NEXT_PUBLIC_APP_ORIGIN ?? base).replace(/\\/$/, "");',
        'const app = "";',
      );
    body = body.replace(
      /const testnetCreate = .*?;/,
      'const testnetCreate = "/create/activate";',
    );
  }
  if (name === "fund-builder.tsx")
    body = body.replace(
      "Create this fund on testnet →",
      "Activate a target-weight strategy →",
    );
  if (name === "fund-cover-editor.tsx")
    body = body.replace('process.env.NEXT_PUBLIC_BASE_PATH ?? \"\"', '\"\"');
  if (name === "fund-builder.tsx") {
    body = body.replace(
      'import styles from "./fund-builder.module.css";',
      'import styles from "./fund-builder.module.css";\nimport { Sheet, SheetContent, SheetTitle, SheetDescription } from "../../components/ui/sheet";\nimport { useSearchParams } from "react-router-dom";',
    );
    body = body.replace(
      "const [drawer, setDrawer] = useState<Drawer>(null);",
      `const [drawerParams, setDrawerParams] = useSearchParams();
  const readDrawer = (): Drawer => { const id = Number(drawerParams.get("strategy")); return drawerParams.has("strategy") && state.rows.some(row => row.id === id) ? {mode:"edit",id} : null; };
  const [drawer, setDrawerState] = useState<Drawer>(readDrawer);
  const setDrawer = (next: Drawer) => { setDrawerState(next); const params = new URLSearchParams(window.location.search); if(next) params.set("strategy",String(next.id)); else params.delete("strategy"); setDrawerParams(params,{replace:true}); };
  useEffect(() => { setDrawerState(readDrawer()); }, [drawerParams]);`,
    );
    body = body.replace(
      "  const drawerRef = useModal(drawer !== null);",
      "  const drawerFocus = useRef<HTMLElement | null>(null);",
    );
    body = body.replace(
      '<dialog ref={drawerRef} className={styles.drawer} aria-label={editing ? `${B.assetOf(editing.key).name} strategy` : "Strategy"} onClose={() => setDrawer(null)} onClick={(event) => { if (event.target === event.currentTarget) setDrawer(null); }}>',
      `<Sheet open={drawer !== null} onOpenChange={(open) => { if(!open) setDrawer(null); }}><SheetContent side="right" showCloseButton={false} className={cx(styles.drawer,"public-builder-strategy p-0")} onOpenAutoFocus={() => { drawerFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onCloseAutoFocus={(event) => { if(drawerFocus.current?.isConnected) {event.preventDefault();drawerFocus.current.focus();} }}><SheetTitle className="sr-only">{editing ? B.assetOf(editing.key).name + " strategy" : "Strategy"}</SheetTitle><SheetDescription className="sr-only">Choose a strategy for this asset.</SheetDescription>`,
    );
    body = body.replace(
      "      </dialog>\n\n      <dialog ref={reviewRef}",
      "      </SheetContent></Sheet>\n\n      <dialog ref={reviewRef}",
    );
  }
  fs.writeFileSync(path.join(target, "components", name), body);
  receipts.push({
    source: "components/" + name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  for (const css of bytes.toString().matchAll(/"\.\/([^"]+\.css)"/g))
    copy("components/" + css[1]);
}
copy("components/asset-detail.module.css");
fs.writeFileSync(
  path.join(target, "lib/support-line.ts"),
  "// 僅供設計器顯示，不連入其他啟動器。\nexport type SupportLine={key:string;subject:string;verdict:'runs'|'waits-publisher'|'stays-in-cash'|'blocked';text:string;note:string};\n",
);
// UI 資料直接保留已發佈 runtime；不重新套用最新配置或捏造歷史。
const runtime = fs.readFileSync(path.join(web, "public/assets/app.js"), "utf8");
const payload = JSON.parse(
  runtime
    .split("\n")[0]
    .replace(/^window\.__CRE8_DEMO_FUNDS__=/, "")
    .replace(/;$/, ""),
);
const load = (name) => import(pathToFileURL(path.join(web, "lib", name)).href);
const [
  { UNDERLYING_ASSETS },
  { ASSETS, canPickAsset },
  { STOCK_CATALOG },
  { resolveFundCover },
  { fundProfile },
  { createAssetPreviews },
  { createHoldingsModel },
  { recentModelTrades, modelTradeUpdates },
] = await Promise.all(
  [
    "underlying-assets.ts",
    "fund-builder.ts",
    "stock-catalog.ts",
    "fund-cover.ts",
    "fund-profile.ts",
    "asset-preview.ts",
    "fund-holdings.ts",
    "recent-trades.ts",
  ].map(load),
);
const underlying = JSON.parse(
    fs.readFileSync(path.join(web, "data/underlying-markets/current.json")),
  ),
  raw = JSON.parse(
    gunzipSync(
      fs.readFileSync(
        path.join(web, "data/underlying-markets/receipts.json.gz"),
      ),
    ),
  );
const previews = createAssetPreviews(
  UNDERLYING_ASSETS.map((a) => {
    const b = ASSETS.find((b) => b.key === a.builderKey);
    return {
      ...a,
      name:
        a.slug === "commodity-gold"
          ? a.name
          : b && b.name !== b.key
            ? b.name
            : a.name.replace(
                /,?\s+(?:Inc\.?|Incorporated|Corporation|Corp\.?|plc|Ltd\.?|Limited)$/i,
                "",
              ),
    };
  }),
  underlying.assets,
  raw,
);
const quotes = Object.fromEntries(
  Object.entries(underlying.assets).map(([k, v]) => [
    `${v.kind === "crypto" ? "crypto" : v.kind === "commodity" ? "commodity" : "stock"}:${k}`,
    v,
  ]),
);
const identities = [
  ...STOCK_CATALOG.products
    .filter((p) => p.chainId === 56)
    .map((p) => ({
      symbol: p.symbol,
      ticker: p.ticker,
      address: p.address,
      issuer: p.issuer === "bstock" ? "bStock" : "Ondo",
      chainId: 56,
      marketKey: `stock:${p.ticker}`,
    })),
  ...ASSETS.filter((a) => a.category === "crypto" || a.key === "XAUT").map(
    (a) => ({
      symbol: a.symbol,
      ticker: a.key === "XAUT" ? "GOLD" : a.key,
      address: a.token,
      issuer: a.key === "XAUT" ? "Tether Gold" : "BNB Chain token",
      chainId: 56,
      marketKey: a.key === "XAUT" ? "commodity:GOLD" : `crypto:${a.key}`,
    }),
  ),
  {
    symbol: "USDT",
    ticker: "USDT",
    address: "0x55d398326f99059ff775485246999027b3197955",
    issuer: "BNB Chain token",
    chainId: 56,
    marketKey: "crypto:USDT",
  },
];
const holdings = createHoldingsModel(
  { ...underlying, assets: quotes },
  identities,
  previews,
);
const metadata = Object.fromEntries(
  payload.funds.map((f) => [
    f.slug,
    {
      cover: resolveFundCover(undefined, f),
      profile: fundProfile(f.slug),
      updates:
        f.sourceModel?.updates ??
        modelTradeUpdates(
          recentModelTrades(f),
          f.backtest?.rebalance,
          f.backtest?.allocationUpdates,
        ),
      holdings: f.positions
        .filter((p) => p.w > 1e-10)
        .map((p) =>
          holdings.resolve({
            id: p.loc,
            symbol: p.p === "Idle" ? "USDT" : p.loc,
            chainId: 56,
            weight: p.w,
          }),
        ),
    },
  ]),
);
fs.writeFileSync(
  path.join(target, "data/funds.json"),
  JSON.stringify(payload) + "\n",
);
fs.writeFileSync(
  path.join(target, "data/fund-metadata.json"),
  JSON.stringify(metadata) + "\n",
);
fs.writeFileSync(
  path.join(target, "data/assets.json"),
  JSON.stringify(UNDERLYING_ASSETS) + "\n",
);
fs.writeFileSync(
  path.join(target, "data/asset-index.json"),
  JSON.stringify(
    UNDERLYING_ASSETS.map((a) => ({ ...a, history: a.history.slice(-31) })),
  ) + "\n",
);
for (const folder of ["logos", "fund-covers"])
  fs.cpSync(path.join(web, "public", folder), path.resolve("public", folder), {
    recursive: true,
  });
fs.copyFileSync(
  path.join(web, "app/fund-explore.css"),
  path.resolve("src/styles/public-fund-explore.css"),
);
// 新版基金與交易樣式限定在公開頁；既有 vendor 複本不修改。
const design = fs.readFileSync(path.join(web, "app/design.css"), "utf8"),
  start = design.indexOf("body.fund-detail-redesign");
fs.writeFileSync(
  path.resolve("src/styles/public-detail-source.css"),
  design.slice(start),
);
fs.mkdirSync("docs", { recursive: true });
fs.writeFileSync(
  "docs/public-ui-source.json",
  JSON.stringify(
    {
      repository: "0xJoooe/bnb-agent-vaults",
      commit: pinned,
      runtimeSha256: createHash("sha256").update(runtime).digest("hex"),
      fundsSha256: createHash("sha256")
        .update(fs.readFileSync(path.join(target, "data/funds.json")))
        .digest("hex"),
      funds: payload.funds.length,
      assets: UNDERLYING_ASSETS.length,
      createAssets: ASSETS.filter(canPickAsset).length,
      files: receipts,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Imported ${payload.funds.length} funds, ${UNDERLYING_ASSETS.length} underlying assets and ${ASSETS.filter(canPickAsset).length} Create choices.`,
);
