# CRE8 ATP — Asset Tokenization Protocol

**Tokenized index funds on BNB Chain, with non-custodial accounts and delegated rebalancing.**

Users deposit USDT into a fund. The protocol deploys a dedicated smart account for them, buys
the fund's target assets on-chain, and keeps the weights aligned over time by executing scheduled
rebalances — without ever holding the user's keys or requiring a signature for routine maintenance.

- **Live app:** https://beta.cre8.finance
- **Network:** BNB Chain mainnet (chain id `56`)
- **Contracts:** deployed and verified — see [`cre8-contracts/deployments/mainnet.json`](cre8-contracts/deployments/mainnet.json)

> This repository is a consolidated snapshot of four repositories (`backend`, `cre8-app`,
> `cre8-contracts`, `db`) prepared for hackathon submission. Each directory keeps its own
> `package.json` / `foundry.toml` and can be developed independently.

---

## The problem

Tokenized funds usually force a trade-off:

- **Custodial / pooled** — the operator holds the assets. Users trust a balance in a database.
- **Fully manual** — the user signs every swap. Unusable for anything periodic.

Recreating an index fund needs three things that conflict: *the user owns the assets*, *rebalancing
is frequent*, and *the user is not present every time*. CRE8 ATP resolves this with ERC-4337 smart
accounts plus a narrowly scoped session key.

## How it works

```
Deposit (USDT transfer, 1 signature)
        │
        ▼
┌───────────────────────┐        ┌──────────────────────┐
│  User's Kernel account │◄───────│  Session key (scoped) │
│  one per (owner, fund) │        │  CallPolicy allows    │
└───────────┬───────────┘        │  ONLY executeRebalance│
            │ approve (1 sig, once)└──────────────────────┘
            ▼
┌───────────────────────┐        ┌──────────────────────┐
│   AtpExecutor          │───────►│ PancakeSwap Router    │
│  floor check + fee cut │        │ V3 pool / multi-hop   │
└───────────────────────┘        └──────────────────────┘
```

### 1. One smart account per (owner, fund)

The account address is derived, not stored:

```
salt  = keccak256(abi.encodePacked("cre8-atp:kernel-v3.3", owner, strategyId))
index = uint256(salt)
```

The same owner re-depositing into the same fund returns to the **same** account — gas, approvals
and session keys persist. Counterfactual deployment means nothing exists on-chain until the first
deposit.

### 2. A session key that cannot move funds

The backend derives an ECDSA key from a master seed (`SESSION_KEY_MASTER_SEED`) at
`m/44'/60'/0'/0/<portfolioId>` and installs it as a Kernel permission validator.

Its `CallPolicy` permits **exactly one** call — `AtpExecutor.executeRebalance`. It cannot
transfer, approve, or call anything else. A compromised backend key can, at worst, rebalance within
the fund's own mandate; it cannot withdraw.

Anything that moves money *out* — approvals, withdrawals, closing a position — requires an
**owner-signed** UserOp. That is why the frontend asks for a signature on deposit and withdrawal
but not on rebalancing.

### 3. Price floors, not agent trust

Every swap step must carry an `amountOutMin` at or above an on-chain TWAP floor:

```
floor = TWAP(asset/numeraire) × (1 − maxSlippage)
```

`AtpExecutor` re-derives the floor at execution time and reverts if the agent's value is below it.
A malicious or buggy planner cannot drain a fund through bad pricing.

The planner additionally refuses to send steps whose estimated price impact exceeds a budget, and
routes through the better of several pools (see "Routing" below).

### 4. The exchange leg

`AtpExecutor` swaps through PancakeSwap's Universal Router with Permit2:

```
account ──ERC20 approve──► AtpExecutor ──Permit2──► Universal Router ──► V3 pool
```

The executor never custodies funds between transactions, and it enforces:

- an asset allowlist taken from the fund's registry version
- a per-call floor check
- a protocol fee that is bounded at the registry level

## Repository layout

| Directory | What it is | Stack |
|---|---|---|
| `cre8-contracts/` | Registry, executor, oracles + Foundry tests | Solidity 0.8.24, Foundry |
| `backend/` | REST API, planner, scheduler, ERC-4337 signing | Bun, TypeScript, viem, ZeroDev |
| `cre8-app/` | Web app (marketplace, fund pages, management) | React 19, Vite 7, Tailwind v4, shadcn/ui |
| `db/` | Postgres migrations | SQL |
| `docs/` | Architecture notes, decisions, runbooks, pitfalls | Markdown |

## Deployed contracts (BNB Chain, chain id 56)

| Contract | Address |
|---|---|
| `AtpRegistry` | `0xf429929c9fc89446c08fd4c201543b40d7d3d67a` |
| `AtpExecutor` | `0x547764c2a6f789986f0f3e532c115ffc7e3ac9e7` |
| `AtpMultiPoolOracle` | `0x6a31f0c5180e5d25accf5775da98e2404a46d869` |
| `PancakeV3TwapOracle` (WBNB/USDT) | `0x7c7df82b4c27251db247af363f99e595d42a8d78` |
| `PancakeV3TwapOracle` (DOGE/USDT) | `0x90ee0746cd1e32f55c0188bbe1e60a954cea1fd1` |

Full list, oracle pools and fee tiers: [`cre8-contracts/deployments/mainnet.json`](cre8-contracts/deployments/mainnet.json).

## Running locally

Each directory is self-contained.

### Contracts

```bash
cd cre8-contracts
forge build
forge test
```

### Backend

```bash
cd backend
cp .env.example .env          # fill in DATABASE_URL, RPC_URL, OPERATOR_PRIVATE_KEY, SESSION_KEY_MASTER_SEED
bun install
bun run migrate
bun run dev                   # http://127.0.0.1:8081
```

`bun run test` runs the full suite. `bun run preflight` validates a mainnet configuration
(17 checks: RPC, registry wiring, oracle pools, session key derivation, gas balances).

### Frontend

```bash
cd cre8-app
bun install
bun run dev                   # http://localhost:5173, proxies /api → :8081 and /rpc → :8545
```

Build-time configuration lives in `.env.production` (`VITE_CHAIN_ID`, `VITE_RPC_URL`,
`VITE_API_BASE`). `bun run test` covers the public UI, the edge worker, and the creator ranking.

## Notes on design decisions

A few choices are deliberate and documented in `docs/` rather than left implicit:

- **The chain id is fixed at build time.** `VITE_CHAIN_ID` is baked into the bundle so a build
  cannot silently point at the wrong network.
- **Rebalance routing prefers the better pool, not a pinned one.** The planner compares candidate
  V3 paths (and multi-hop via WBNB) with a quoter and emits the best one. The *price floor* still
  comes from the oracle's pinned pool, so planning stays conservative while execution gets the
  better fill. `Universal Router`'s `V3_SWAP_EXACT_IN` accepts arbitrary-length paths, so this
  needs no contract change. A V2 candidate path exists behind `ROUTE_V2_ENABLED` and is **off by
  default** pending on-chain verification.
- **Empty portfolios are paused, not deleted.** The account address is derived from
  `(owner, strategy)`, so deleting the portfolio row would make a later deposit look like a
  different account. Closing a position pauses the schedule instead.
- **A gas threshold, not a gas estimate.** Each account must hold ≥ `0.0005 BNB` before a round
  runs (≈ 20 rebalances at BSC gas prices). Routine maintenance is paid by the account, so it has
  to be funded; the threshold is kept small so a small test deposit is not blocked by it.

## Status

Working end-to-end on BNB Chain mainnet: deposit, automatic allocation, scheduled rebalancing,
withdrawal and full position close, each verified with real transactions.

Known limitations are tracked in [`docs/mainnet-todo.zh-TW.md`](docs/mainnet-todo.zh-TW.md)
(Chinese). The most relevant:

- The bundler runs with `safe-mode` disabled because tracing-capable RPCs are not available on a
  free tier; a paid RPC restores it.
- Contract ownership is still an EOA. It moves to a multisig before wider use.
- Fund performance figures in the public marketplace are **modelled**, not realised, and the UI
  labels them as such.

## Licence

MIT — see [`LICENSE`](LICENSE).
