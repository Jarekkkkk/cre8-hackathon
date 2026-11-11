# cre8-app

The CRE8 frontend. Vite + React 19 + TypeScript. Public pages keep the original design CSS;
forms and drawers use shadcn / Tailwind v4 (no preflight).

## Technology choices

| Layer | Choice | Why |
|---|---|---|
| Build | Vite 7 | dev server starts in <200ms; HMR matters a lot when the work is "change one table column" |
| Server state | `@tanstack/react-query` | Caching, retries, and the `isPending`/`error` state machine. Hand-rolling this always misses a branch |
| Client state | `zustand` | Only wallet connection and the token. Context would do, but zustand selectors avoid re-rendering the whole tree |
| Styling | Design CSS + shadcn / Tailwind v4 | Public pages keep the source classes; tool pages use accessible components, with `sx-` prefixed tokens |
| Chain access | `viem` | Complete types, and the same version as the backend (`2.57.x`) |

The visual language (colour, radii, type, card and button shapes) comes from the app pages in
`bnb-agent-vaults/web`. The landing and docs pages are deliberately not referenced.

## Layout

```
src/
  lib/
    api.ts        backend contract (types + fetch wrapper + ApiError)
    format.ts     pure formatting: 1e8 fixed point → "$511,338.07", bps, addresses, dates
    query.ts      QueryClient and queryKeys (retry 1, no automatic refetch)
    wallet.ts     EIP-6963 discovery, connect, personal_sign, dev private-key signing
  store/
    session.ts    token / expiresAt / address (sessionStorage)
    wallet.ts     connection state (the provider stays at module level, not in the store)
  components/     TopBar / Badge・Note・Field・ErrorNote
  features/
    auth/         SIWE sign-in
    portfolios/   portfolio list
    status/       drift detail
  styles/         tokens.css / base.css / components.css
```

## Development

```bash
bun install --frozen-lockfile # Bun 1.4.4
bun test tests
bun run dev        # http://localhost:5173
bun run typecheck
bun run build
```

The backend must be running on `127.0.0.1:8081`. `vite.config.ts` proxies `/api/*` to it (stripping the
prefix), so **the frontend always calls relative paths** — same origin means no CORS and no preflight,
and a reverse proxy does the same job in production.

`VITE_API_BASE` can override the prefix (default `/api`).

### Sign-in

1. Connect a wallet (EIP-6963 list, or the private-key entry point in dev builds)
2. `POST /api/auth/nonce` to get a SIWE challenge
3. The wallet signs with `personal_sign`
4. `POST /api/auth/login` exchanges it for a token → stored in sessionStorage

**Why sessionStorage rather than localStorage**: this app moves money, so the token's exposure window
should be no longer than "this tab is open". A refresh does not require re-signing; closing the tab
clears it.

**The wallet connection does not survive a refresh** (a `provider` is not serialisable, and writing a
private key or provider into storage puts the key in the browser). After a refresh you are
"signed in, wallet not connected" — the TopBar says so, and both the renewal card and the sign-in page
offer an in-place reconnect (`components/WalletConnect.tsx`). **No sign-out and start over.**

## What this version covers

Two complete paths:

1. **Sign-in → portfolio list → drift detail**
2. **Renewal**: `GET /renewal-params` → send a sudo UserOp with the owner wallet → `POST /renewal-result`

The renewal UI is deliberately split into "see what you are signing → tick to confirm → send": it costs
gas and it changes on-chain permissions.

3. **Rebalance**: confirm → `POST /portfolios/:id/rebalance` → result (outcome / SwapExecuted / steps)

### Three design rules for rebalancing

**① The frontend does not guess what to swap.** Planning happens on the backend (DB prices + on-chain
quotes + impact cap + a guard that refuses to send improvements that are not improvements). The `steps`
in the response are exactly what was sent. Showing an "estimate" first would be a promise that gets
overturned.

**② `403 OPERATOR_REBALANCE_DISABLED` is not treated as a permission error.** It is a deployment switch:
without `ENABLE_OPERATOR_REBALANCE=true` the endpoint **does not exist**. The card says that plainly
instead of throwing "403 Forbidden" and sending someone to check their token.

**③ Results are shown verbatim.** `reason` is the sentence the scheduler wrote (including which layer
failed); the frontend does not rewrite it as "failed". `noop` and `blocked` are **correct outcomes**, not
errors — e.g. "drift 595 bps is not lower than the current 595 bps; sending would only cost gas".

Measured (both paths verified):

```
flag off → HTTP 403 code=OPERATOR_REBALANCE_DISABLED
flag on  → 200 {portfolioId, outcome, reason, txHash, userOpHash,
                swapExecuted, expectedSwaps, gasUsed, steps}
           against #5 (drift 0) → noop, no money moved, no gas burned
```

## The renewal path

```
GET /api/portfolios/:id/renewal-params     backend derives a new key (no signing, no chain, no DB write)
  ↓ initConfig (each entry is calldata addressed to the account itself)
owner wallet signs a sudo UserOp            createKernelAccount + signerToEcdsaValidator
  ↓ bundlerTransport = /api/bundler         ⚠ must carry Authorization: Bearer <token>
alto (through the backend relay)            six whitelisted methods
  ↓ receipt
POST /api/portfolios/:id/renewal-result     backend records it in session_keys
```

Measured (using this app's own `lib/api.ts` + `lib/kernel.ts`):

```
before renewal  pid 0xb357c054 installed true
new key m/44'/60'/0'/0/24806719 | pid 0xc87a3d81 | 2 calldata entries
on-chain success | gasUsed 552381
recorded in DB  pid 0xc87a3d81
after renewal   configured 0xc87a3d81 installed true → the scheduler uses 0xc87a3d81
```

### Two integration traps (both hit in practice)

**① `/api/bundler` is an authenticated endpoint.**
Without `Authorization: Bearer <token>` it is a 401, and it only allows six whitelisted methods.
`kernel.ts` passes headers via `http(url, { fetchOptions: { headers } })` and raises the timeout to 60
seconds (viem's 10-second default is not enough to estimate gas, send the op and wait for a receipt).

**② The SDK's `entryPoint` wants an object, not an address string.**

```ts
{ address, version: '0.7' }   // ✓
'0x0000000071727De22E5E9d8BAf0edAc6f37da032'   // ✗ → Error: Unsupported entry point version
```

The message never mentions that you passed a string. `kernel.ts` now keeps the object as a constant and
verifies the backend's address equals it.

## Two deliberate display decisions

**① When status cannot be read, show no drift number at all.**
If `GET /portfolios/:id/status` fails (503), the page shows only the error — never "drift 0, no rebalance
needed". A plausible-looking zero is far more dangerous than an error message.

**② `sessionKey` on `GET /portfolios/:id/status` has two keys.**

| Field | Meaning |
|---|---|
| `configured` | The newest row in the DB (what the list page shows). **May not be installed on-chain** |
| `usable` | The one the scheduler will actually use (verified newest to oldest) |

When they differ the UI warns: "the key recorded in the DB is not installed on-chain; X will be used".
`usable === null` may only be read as "no usable key" **when `error === null`**.

## Verifying

`lib/format.ts` uses no DOM, no fetch and no React, so it can be checked directly:

```bash
bun -e 'import {formatUsdE8} from "./src/lib/format.ts"; console.log(formatUsdE8("51133807293686"))'
# $511,338.07
```

All amounts go through BigInt: `123456789012345678` → `$1,234,567,890.12` (Number loses precision).

## One contract trap worth recording

`GET /portfolios` returns **`{ portfolios: [...] }`**, not a bare array. Declaring the type as
`Portfolio[]` produces no TypeScript complaint (`request<T>` is only an assertion), but at runtime the
`.map` throws and the page goes blank. `lib/api.ts` now spells out the wire shape and unwraps it on the
client.

---

## UI/UX (following the bnb-agent-vaults design)

`src/styles/vendor/` is copied from `bnb-agent-vaults/web/app/`: `design.css` (the design system, 4506
lines), `fund-explore.css` (the vaults page), `fonts.css` + `fonts/` (self-hosted type). **They are plain
CSS with no Tailwind directives.**

The load order in `main.tsx` is deliberate: vendor first (tokens + global reset + existing component
rules), then our own `tokens/base/components.css` on top. The other way round, their
`button { background:none }` would override our components.

### The full public UI (2026-11-11)

The source is pinned at `0xJoooe/bnb-agent-vaults@0f3196d37821561050dee1176d9d33e3b51c5d5e`: 30 funds,
219 underlying-asset pages, 218 selectable Create assets. Source and hashes are recorded in
[public-ui-source.json](docs/public-ui-source.json); the integration approach is described in
[public-ui-integration.md](docs/public-ui-integration.md).

* `/vaults`: market themes / public figures / X voices, with search, sort, period and a filter that
  survives navigation.
* `/funds/:slug`: original cover, person introduction, holdings, asset hover, historical chart, max
  drawdown, performance details (Sharpe / volatility), full recent trades with sources.
* `/asset/:slug`: the underlying company/asset introduction and price history, with the tokenised version
  as secondary information. USDT is cash only.
* `/leaderboard`, `/creator/:id`: source-fund ranking and creator directory.
* `/portfolio`, `/portfolios`: native accounts and real API data; modelled returns are never presented as
  a user's performance.

Historical charts use the originally published NAV; current weights are never back-filled into history.
Official figures are reconstructed from holdings dates, and X voices replay the source's post model —
neither is proof of that person's executed trades. Original disclosure and post links are preserved.
A read-only `/reference-data/demo-funds` accepts the source's full daily update; incomplete data or a
failed request keeps the previous cut-off date.

### Create fund (`/create`) and activation (`/create/activate`)

`/create/design` is the full source designer: assets, weights, strategies, rules, X handle, cover, draft
and JSON export. From a finished design you can enter the native activation form; what CRE8 can actually
execute today is a **target-weight allocation**. Importing brings only exact token addresses and weights
— other rules are never silently turned into an execution strategy. Before activation you confirm the
allocation mode, and every address must still pass the backend's tradable-asset list.

All three steps are real backend calls (steps 1 and 3 touch the chain):
```
POST /strategies                  → strategy.id (mirrored to the on-chain Registry, measured ~1.7s)
POST /strategies/:id/versions     → v1 (allocation.assets[].weightBps must sum to exactly 10000, ~3.1s)
POST /portfolios { strategyId }   → portfolio.id (deploys the smart account + installs the session key, ~6.0s)
```
Progress is shown step by step — a spinner that says nothing for 30 seconds makes people press the button
again.

Weights are summed in **bps** to decide whether they total 100%: `33.3 + 33.3 + 33.4` is not 100 in
floating point.
