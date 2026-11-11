# UI/UX Handoff — cre8-app

> For whoever picks up this frontend next (an agent, or later me).
> After reading this you should be able to: change one page without breaking another, know which classes
> must not be touched, and know what to verify when you are done.
>
> Last updated: 2026-11-11 · commit `65b2550` (includes another large UI sync, see §12)

---

## 0. Why this document exists

This frontend has **two visual systems living side by side**, and they step on each other. People who did
not know that — including me — have hit it three times: a colliding variable turned text white,
`className="toast"` collided so the element existed but was invisible, and two `.swap-sub` elements were
dropped into the same grid area and overlapped.

So: **read §2 (the two-zone rule) and §6 (traps already hit) before you touch anything.**

---

## 1. Stack and versions (do not upgrade casually)

| Item | Version | Notes |
|---|---|---|
| React | 19 | |
| Vite | 7 | |
| TypeScript | strict + `noUnusedLocals` + `verbatimModuleSyntax` | an unused import fails the build |
| **shadcn/ui** | CLI 4.157 / `new-york` style | components are source copied into the repo, not an npm dependency |
| Tailwind CSS | **v4** | ⚠ no preflight (see §3) |
| viem, no wagmi | viem 2.x | no wagmi; the wallet talks to an EIP-1193 provider directly |
| @zerodev/sdk | **5.5.11 and 5.4.9 (ecdsa-validator)**, **must match the backend exactly** | a version mismatch breaks Kernel signature validation (AA24) |
| State | zustand (wallet / session) + TanStack Query (server state) | |
| Package manager | bun | `bun install` / `bun run dev` |

```bash
bun install
bun run dev        # :5173, proxies /api → 127.0.0.1:8081 and /rpc → 127.0.0.1:8545
bun run typecheck  # run this before shipping
bun run build      # = typecheck + vite build
```

---

## 2. ★ The two-zone rule (the most important section)

The screens in this app contain two kinds of block with completely different natures. **Decide which zone
you are in first, then how to write it:**

| | **A. Public marketplace pages** | **B. Operator/tool pages** |
|---|---|---|
| Routes | `/` (landing), `/vaults`, `/leaderboard`, `/creator/:id`, `/vault/:slug`, `/funds/:slug`, `/asset/:slug`, `/portfolio` | `/operator`, `/create`, `/create/activate`, `/funds/strategy/:id`, drawers, forms |
| Styling | `styles/vendor/design.css` + `fund-explore.css` (**verbatim copies of the design**) | our own classes + shadcn |
| Rule | **keep the hand-written classes**, do not swap in shadcn | **prefer shadcn components** |
| Why | those classes are part of the design; replacing them is a redesign | the value here is a11y, focus traps and keyboard handling |

### Never do these

```
❌ edit styles/vendor/design.css (it is a verbatim copy; editing it diverges from the source)
❌ replace .fund-row / .dk-table / .ticket with shadcn on marketplace pages
❌ invent class names in zone B (grep the CSS first — .table-wrap was a lesson in blood)
```

### The existing `src/styles/`

`src/main.tsx` imports twelve files in order (**the order is priority; changing it changes appearance**):

```
vendor/fonts.css           self-hosted type
vendor/design.css          design copy — read only
vendor/fund-explore.css    marketplace layout — read only
tokens.css                 colour and spacing variables
shadcn.css                 Tailwind entry + shadcn tokens (see §3)
base.css                   layout foundation
components.css             shared component styles
formal-ui.css              fine adjustment layer for the production UI
public-fund-explore.css    public pages (landing, leaderboard)
public-detail-source.css   detail pages (fund, asset)
complete-ui.css            integration layer for signed-in UI (604 lines, the largest)
design-controls.css        button height and spacing decisions
creators.css               creator leaderboard

(phase-banner.css is gone; the PhaseBanner.tsx and RequireSession.tsx components were deleted too.)
```

**When adding a style, ask yourself**: is this "part of the design copy" (→ do not touch) or "our adjustment
layer" (→ add it to the matching layer, do not start a new file). There are already thirteen CSS files;
another layer makes "which file decides this appearance" harder to answer.

---

## 3. ★ shadcn's three hard requirements

### 3.1 No preflight (and `@source` is mandatory alongside it)

```css
/* src/styles/shadcn.css */
@import "tailwindcss/theme.css"      layer(theme);
@import "tw-animate-css";            /* Radix's data-state animations need it */
@import "tailwindcss/utilities.css"  layer(utilities);
@source "../";                        /* ⚠ remove this and no utility class is generated */
```

**Why no preflight**: `design.css` relies on browser defaults (heading margins, border widths) to hold its
layout together. Preflight zeroes them and the marketplace layout breaks outright.

**The cost**: the single line `@import "tailwindcss"` also brings in source detection; we import only theme
and utilities, so **we must write `@source` ourselves**. Without it, utilities like `h-4 w-4` are **never
generated**, and the symptom is "the component renders with no styling at all".

### 3.2 Every shadcn token carries an `sx-` prefix

```css
--sx-muted: oklch(0.96 0.01 240);   /* shadcn's near-white surface */
@theme inline { --color-muted: var(--sx-muted); }
```

**Why**: `design.css` already uses `--muted` (grey **text**, `#2B4254`), `--card` and `--border`.
Overwriting them turns an entire `/operator` column into white on white (measured).

> When you need real dark grey text, use `text-[var(--muted)]` (design.css's value), not
> `text-muted-foreground` (shadcn's near-white).

### 3.3 Available shadcn components (already installed)

```
src/components/ui/{sonner,button,badge,sheet,tabs,alert,table}.tsx
```

To add one: `BUN_INSTALL_CACHE_DIR=$PWD/.bun-cache bunx shadcn@latest add <name> --yes`
(bun's default cache directory is not writable in the sandbox).

---

## 4. Established conventions (follow them, do not invent your own)

### 4.1 Toast: `src/components/Toast.tsx`

```ts
const id = toast.pending('Deposit', 'Confirm the transfer in your wallet…');
toast.replace(id, { tone: 'ok', title: 'Deposited 5 USDT', body: txHash });
```

* `pending` **does not auto-dismiss** (it waits for `replace`); the others last 8s / 12s / 15s
* ⚠ **`replace` returns a new id**: multi-stage flows must **capture** it, or the earlier pending toast
  spins forever
* The layer underneath is **sonner** (`ui/sonner.tsx`). Do not hand-roll a toast.

### 4.2 Deep links (for support and operations screenshots)

```
/funds/<slug>?facts=1      opens the Fund facts drawer directly
/funds/<slug>?position=1   opens the My position drawer directly
/funds/<slug>?tab=withdraw switches straight to the Withdraw tab
```

Follow this pattern for a new drawer or tab (`useSearchParams` to seed state) so it can be screenshot-tested.

### 4.3 Always use `<Sheet>` for drawers

```tsx
<Sheet open={open} onOpenChange={setOpen}>
  <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-xl">
```

`p-0` is required: `SheetContent` defaults to `p-6`, and our own padding on top of that becomes two layers.

### 4.4 After a mutation, invalidate the **whole dependency chain**

```ts
await Promise.all([
  invalidateQueries({ queryKey: ['strategies'],           refetchType: 'all' }),
  invalidateQueries({ queryKey: queryKeys.portfolios(token), refetchType: 'all' }),
  invalidateQueries({ queryKey: ['fund-status'],          refetchType: 'all' }),
]);
```

`held` (whether there is a position) depends on `strategies → holding → fund-status`. Invalidating only
`portfolios` leaves the "My position" button missing until a reload (measured).

`refetchType: 'all'` is also required: the `fund-status` key carries `holding?.id`, and in the round right
after enrollment that is `undefined` with `enabled: false` — the default refetch only touches active queries
and skips it.

### 4.5 Copy and language

* **UI copy is always English** (an explicit requirement)
* Amounts and addresses: `formatUsd` / `shortAddress` (`src/lib/format.ts`)
* Never invent performance numbers; the marketplace chart is labelled `Simulated performance`

---

## 5. Wallet and chain (where it bites)

### 5.1 The chain is decided **at build time**

```ts
// src/lib/kernel.ts
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 1337);
```

`.env.production` pins `VITE_CHAIN_ID=56` (mainnet); `.env.development` uses 1337 (a local fork).
**Switching chains means rebuilding**, not changing a runtime variable.

### 5.2 Three account/chain consistency mechanisms (each added after being bitten)

| Mechanism | File | What it does |
|---|---|---|
| Auto-reconnect | `lib/use-auto-connect.ts` | after a reload, reconnects the previous wallet via `eth_accounts` (**no popup**) |
| Watch for switches | `lib/use-account-watch.ts` | `accountsChanged` → updates the wallet store and clears a non-matching SIWE session |
| Chain switch | `lib/wallet.ts` `ensureChain()` | switches to `CHAIN_ID` after connecting, calling `addEthereumChain` if unknown |

**Why they are needed**: a SIWE token is bound to "the wallet at the moment of signing", while `authenticate`
is a pure token→wallet mapping. Switch accounts without clearing the token and you are using A's token to
query B's portfolios → 403 → nothing renders.

### 5.3 The user signs in exactly three places

```
① SIWE sign-in (eth_sign / personal_sign)
② approve (authorising the executor to spend the account's tokens) — only when allowance === 0
③ the final transfer when withdrawing or closing (a sudo UserOp)
```

**Rebalancing needs no user signature** — the session key signs it. If the UI ever suggests otherwise, that
is a bug.

---

## 6. ★ Traps already hit (debug in this order)

| Symptom | Real cause | Fix |
|---|---|---|
| The element exists but is invisible | the `className` collides with `design.css` (`.toast` sets `opacity: 0`) | prefix it (`app-toast`), or grep the design copy first |
| Text is near-white and unreadable | shadcn's `--muted` overwrote design.css's `--muted` | give every shadcn token an `sx-` prefix |
| A component renders with no styling | missing `@source` → utilities not generated | `@source "../"` in `src/styles/shadcn.css` |
| Two lines of text overlap | `.swap-sub` is the ticket grid's `sub` area, and two elements were placed in one cell | merge into a single `.swap-sub` |
| A button silently goes grey with no explanation | a `disabled` condition with no matching copy | add a `fine` line under the button |
| A toast spins forever | the pending id was never captured by `replace` | `const id = toast.replace(...)` and replace that |
| "My position" appears only after a reload | only `portfolios` invalidated; `strategies` / `refetchType` missed | see §4.4 |
| The Max button immediately says "exceeds the fund value" | `toFixed(2)` rounds up | the maximum must **round down**: `Math.floor(x*100)/100` |
| The wallet shows a 0 balance and predicts failure | MetaMask simulates known chain ids against its own backend | use 1337 locally (it does not know it); that is why 1337 exists |
| Signature rejected (AA24) | the wallet is not the account owner, or the frontend `index` disagrees with the backend salt | `sendSudoCalls` derives the counterfactual address and compares first, and says so in words |

---

## 6.5 ⚠ "It only runs on my machine" — a `~/node_modules` at home

The first CI run caught two errors **that would never appear locally**:

| Error | Real cause |
|---|---|
| `vite.config.ts: Cannot find module 'node:url'` | TypeScript searches parent directories for `node_modules` and found `~/node_modules/@types/node` |
| `"EventEmitter" is not exported by "__vite-browser-external"` | same cause; it found `~/node_modules/events` |

**How to verify (important)**: copy the source into a clean directory outside the home directory, e.g.
`/private/tmp/cre8-app-check.XXXXXX`, excluding the root `.git/`, `node_modules/`, `dist/` and
`.bun-cache/`, and run with the same **Bun 1.4.4** as CI:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run build
```

Do not just change `HOME`: TypeScript's parent-directory module resolution depends on where the source
lives. While the source is still under your home directory it can still read `~/node_modules`.

> If your machine has no `~/node_modules` these errors never appear — but they will on someone else's
> machine, and on a GitHub runner. **That is the reason to have CI.**

## 7. Directory map

```
src/
├── App.tsx                 routes + useAutoConnect / useAccountWatch / Toaster
├── components/
│   ├── Toast.tsx           ← the only toast entry point (sonner adapter)
│   ├── WalletMenu.tsx      connect / SIWE sign-in / wallet warning
│   ├── ui/                 shadcn components (copied source)
│   └── ui.tsx              Note / ErrorNote / Badge / Spinner (design.css styling)
├── features/
│   ├── fund/FundPage.tsx   ★ the most complex page: Deposit / Withdraw / Close, two drawers
│   ├── reference/          ★ public pages (landing, leaderboard, creator, asset, fund overview)
│   │                       12 files: Leaderboard, CreatorPage, FundOverview, AssetPage,
│   │                       Performance, Profile, RecentTrades, ReferenceSheet…
│   ├── operator/           operator dashboard (scheduler heartbeat, activity, Run round)
│   ├── create/             fund creation (CreateFundPage is the real activation flow)
│   ├── vaults/             marketplace directory
│   └── strategy/, portfolios/, auth/
├── reference/              ★ static data tree for public pages (components/data/lib)
│   ├── data/               reference funds, assets, price series (stock-venue-data.ts, 1077 lines)
│   └── lib/
├── lib/
│   ├── api.ts              every API type and call (Bearer token)
│   ├── kernel.ts           ★ CHAIN_ID, sendSudoCalls, approve, sendSweep, sendWithdraw
│   ├── wallet.ts           EIP-1193, ensureChain, signing
│   ├── use-auto-connect.ts / use-account-watch.ts
│   └── format.ts / query.ts
├── store/                  wallet.ts / session.ts (zustand)
└── styles/                 see §2
```

---

## 8. Acceptance checklist (run after any UI change)

```
□ bun run typecheck              zero errors (noUnusedLocals catches unused imports)
□ bun run build                  succeeds
□ bun run test                   19 pass / 0 fail (three files under tests/)
□ look at four screens by hand:
   /                            **landing** (not the SPA's /vaults)
   /vaults                      the marketplace layout **has not changed** (the easiest thing to break)
   /funds/elon-universe         Deposit / Withdraw / Close are all reachable
   /operator                    the System block's labels are **readable** (dark grey, not near-white)
□ deep links open drawers: ?facts=1 / ?position=1
□ a toast appears and then disappears (it does not spin forever)
□ a guest (signed out) can see `/vaults`, `/funds/:slug`, `/portfolio` (see §12)
```

---

## 9. Deployment (out of scope here, but a few couplings you must know)

```
Cloudflare Pages (project cre8-atp) + public/_worker.js proxying /api → the Railway api
```

* `AUTH_DOMAIN` **must equal the host the user visits** (e.g. `beta.cre8.finance`), or SIWE rejects it
* Current domain: `https://beta.cre8.finance` (`app.cre8.finance` is taken by the existing Vercel site)
* Details in `docs/deploy-cloudflare.md`

---

## 10. Related documents

| Document | Content |
|---|---|
| `../docs/shadcn-adoption.md` | adoption order, which components to swap and which not, the full derivation of the two traps |
| `deploy-cloudflare.md` | deployment, the `/api` proxy, the three places to change for a new domain |
| `architecture.md` | overall frontend architecture |
| `user-flow.md` | the user's complete journey |
| `../../../docs/pitfalls.zh-TW.md` | backend/chain traps (many UI symptoms have a backend root cause) |
| `../../../backend/docs/mainnet-todo.md` | pre-launch checklist (including the V2 routing and safe-mode status) |

---

## 11. If you only remember three things

1. **Choose the zone first**: marketplace pages keep hand-written classes, tool pages use shadcn.
2. **Do not override `design.css`**, and do not collide with its classes or variables — shadcn tokens use the
   `sx-` prefix.
3. **Finish asynchronous state transitions**: capture the id returned by toast `replace`, and invalidate the
   whole dependency chain after a mutation. Those two caused "a toast that spins forever" and "a button that
   only appears after a reload".

## 12. The 2026-11-11 production UI sync

* Production UI source: the merged commit `0xJoooe/bnb-agent-vaults`
  `4045d854402090255cb36b8b4a84d4f4a30f5561`. No uncommitted changes from the source workspace were brought
  across.
* `styles/formal-ui.css` applies only to the `atp-formal-market` / `atp-formal-fund` public pages. Vendor
  CSS, shadcn tokens and the trading / wallet / API logic were not modified. Vendor's global square-corner
  rule has very high precedence, so covers, thumbnails and period buttons are overridden with page-scoped
  id selectors.
* Nine fund covers and thumbnails are paired by `data/fund-covers.ts`. Asset versions, sizes and SHA-256 are
  recorded in `../docs/ui-sync-assets-2026-11-11.json`.
* Directory search, category, asset and sort state live in the query string; a fund page's "All funds" link
  carries the filter back. Fund facts holds the model, data notes and Creator, and returns focus to the
  trigger on close.
* Performance is still the existing since-inception simulated data; changing the period only changes the
  curve, it does not produce new returns. Your position uses the existing account valuation and must not be
  presented as the whole fund's size.
* `.env.production` is now genuinely committed: `VITE_CHAIN_ID=56`, `VITE_API_BASE=/api`. Both are public
  build settings. Deployment still uses the Cloudflare Git integration; no new deploy workflow.
* The operator holdings table now uses the existing shadcn Table container, scrolling inside the table on
  narrow screens.
* Local acceptance: frozen install outside the home directory, typecheck, production build; no full-page
  horizontal overflow at 320/390/1280px on the directory, both fund pages, Create and Operator; drawer deep
  links, keyboard focus, the Withdraw tab, the Close entry point, and toast display and expiry. Screens that
  need a position used a local API fixture; no real wallet signing or on-chain transaction was verified.
* Setup note: importing only `theme` and `utilities` in `shadcn.css` means utilities are not generated; the
  explicit `@source "../"` in that file is what turns them back on.

## 13. The 2026-11-11 full public-UI integration (supersedes §12's nine-fund limit)

* The full source is pinned at `0xJoooe/bnb-agent-vaults@0f3196d37821561050dee1176d9d33e3b51c5d5e`: 30
  funds (Themes 5 / Public figures 18 / X voices 7), 219 asset pages, 218 Create options.
  `../docs/public-ui-source.json` records the source, original file hashes, and the runtime and fund
  payload hashes.
* `scripts/sync-public-ui.mjs <source-repo>` reads only the specified clean source tree; output goes to
  `src/reference/`. Original NAV, source rebalances and person data are preserved intact. Type modules drop
  the server imports they do not need.
* New public-page components live in `features/reference/`; the source CSS is in
  `public-fund-explore.css` / `public-detail-source.css`. `complete-ui.css` only adds integration styling;
  vendor and shadcn tokens are unchanged. Vendor's square-corner rule is highly specific, so exceptions are
  scoped with `#root` / `#atp-reference-sheet`.
* New drawers still use shadcn Sheet: `?performance=1`, `?trades=1`, `?update=<id>`, `?tokens=1`. Mobile
  ordering is `?ticket=1`; `?tab=withdraw` still goes straight to withdrawal. The older facts / position
  deep links are preserved. Closing a drawer restores keyboard focus to the existing trigger.
* Financial statistics follow the source's selected-period NAV, calendar-day annualisation, and alignment to
  the previous NAV day of the historical risk-free reference rate; Sharpe and volatility need at least 90
  consecutive daily returns. The full method lives in Performance details rather than cluttering the main
  page.
* Current holdings in `public-funds.ts` drift with daily prices; ATP target weights use `backtest.targets`,
  and drifted weights must never be treated as the target. Unsupported assets are not mapped to USDT.
* `/create` is a full designer with export; native activation moved to `/create/activate`. Only allocations
  with exact addresses are imported, checked one by one against the API's tradable list; other design rules
  are explicitly confirmed not to execute.
* `/reference-data/demo-funds` is a read-only GET/HEAD proxy to a fixed upstream and does not forward wallet
  credentials. A daily update must contain the same complete catalogue, continuous NAV, matching statistics
  and a complete rebalance structure; a failed validation is not applied. Asset pages still show their own
  data timestamp and do not pretend to be live quotes.
* Kernel, wallet, SIWE, session, API types and the signing implementation were not changed; the existing
  mutation invalidation is intact. Deployment still uses the Cloudflare Git integration on chain 56; the
  production sign-in domain is still beta.cre8.finance.
* Detailed acceptance and limitations are in `../docs/public-ui-integration.md`; the tests use a read-only
  wallet fixture and send no real signature or transaction.

## 14. The 2026-11-11 DESIGN alignment and the creator leaderboard

* The approved specification for ATP is collected in the root `../DESIGN.md`, with the source still pinned
  to the same commit as the public UI. `design-controls.css` is the control integration layer and preserves
  the existing mechanics of vendor, `src/reference/` and shadcn.
* `PhaseBanner` and its dedicated styles are removed site-wide; the short model/history labels are not
  removed.
* Fixed the blue backgrounds, surface colours and off-brand positive/negative colours caused by old token
  overrides; primary and secondary buttons and both existing class spellings now share one specification.
  Wallet 40px/10px, period buttons 36px square (40px on a coarse pointer), in-ticket actions 52px/11px,
  mobile primary action 56px.
* The Sheet close button gained an explicit data-slot; the icon stays 16px with a 40px hit area, and the
  existing Escape, focus trap and focus restoration are preserved.
* The X-voices badge moved under `.public-portrait`, alongside the cropped photo in `.fund-thumb`; only the
  photo is cropped, never the X badge.
* The leaderboard is now one creator address per row. All 30 reference models currently belong to CRE8, so
  one creator is shown. Theme figures and X voices cannot be treated as creators. `lib/creators.ts`
  normalises addresses, de-duplicates funds, and sorts missing values last.
* The ranking figure is the equal-weighted average of available model returns over the selected period; a 1Y
  shorter than a year uses data since that model's inception, and the screen states the sample size and the
  short history. This is not holder return or real AUM. Fund followers are not summed to fake a de-duplicated
  headcount.
* A creator detail page shows only that address's funds; search, period and the return path are preserved,
  using this site's return-URL validation.
* Kernel, API, wallet, SIWE, session and the transaction handlers are unchanged. UI acceptance signs nothing
  and sends no transaction.

---

## 15. Successor's note (after the 2026-11-11 integration, recorded by the previous agent)

§12–§14 were written by the integrator. This section adds only what they did not write and what bites.

### 15.1 `/` is the landing page, implemented in **two places** — miss one and it breaks

```
dev / preview : the `landing-home` middleware in vite.config.ts
                rewrites `/` to `/landing/index.html`
production    : public/_worker.js
                rewrites `/` to `/landing/` and hands it to env.ASSETS
```

**When changing the home page look at both**: change only vite and it works locally but maybe not live;
change only the worker and `vite dev` shows nothing. Static files live in `public/landing/`, and after a
build in `dist/landing/`.

### 15.2 `_worker.js` had no test coverage at all

`vite dev` never executes it, so problems only appear after a deploy. The integrator added
`tests/worker.test.ts` (129 lines) covering the `/api` proxy and the `/` → landing rewrite.
**If you touch `_worker.js`, run `bun run test`.**

### 15.3 Three of my fixes were kept (do not delete them later)

```
the events → node_modules/events/events.js alias in vite.config.ts   (@zerodev/sdk needs it)
@types/node in package.json and "node" in tsconfig                   (vite.config uses node:url)
.github/workflows/ci.yml                                            (typecheck/build on PRs)
```

Reasons in §6.5: all three fix "it only passes locally because of `~/node_modules`, and CI fails".

### 15.4 The measured numbers for this integration

```
bun run typecheck  → 0 errors
bun run test       → 19 pass / 0 fail (3 files)
bun run build      → built in 2.51s
dist/              → contains _worker.js, landing/, fund-covers/
chainId            → `chainId:56` appears 23 times in the bundle, `chainId:1337` zero times
```

> ⚠ **Do not judge the chain configuration by whether the string `1337` appears in the bundle.** Chart data
> points contain decimals like `0.9340011421991337` — I once wrongly reported that production was pointing
> at a local chain because of it. Look for the field-qualified form (`chainId:56`), or use vite's `loadEnv`.
