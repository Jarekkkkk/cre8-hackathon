# CRE8 ATP handover (as of 2026-11-06)

Last updated: 2026-11-06
Replaces: `docs/archive/handoff-2026-11-06.zh-TW.md` (its "next step is Kernel deployment" and
"60 tests passed" are both obsolete)

> **This document is a point-in-time record.** It describes the state on 2026-11-06, before the mainnet
> deployment and before the public UI was integrated. For the current state see the root
> [`README.md`](../README.md) and [`backend/docs/production-state.md`](../backend/docs/production-state.md).
>
> What has changed since this snapshot, in short: the contracts are **deployed on BNB Chain mainnet**,
> the backend runs on Railway with Postgres, the scheduler is live in dry-run, the frontend is deployed
> at `beta.cre8.finance` with the full public UI, and deposit / automatic allocation / scheduled
> rebalancing / withdrawal / full close have all been exercised with real transactions. The test suite
> below reads 450; it is now 473.

**Completed at the time: Kernel session-key authorization. Next step then: a user signing channel.**

---

## 0. The 30-second version

CRE8 is migrating from a **pooled vault (shared treasury plus shares)** to **ATP (Automated Token
Portfolio): one non-custodial smart account per user**, with the architecture modelled on Glider.

The first release covers **equity index funds** only: target weights plus a rebalance schedule, with
bStock tokens on BSC as the underlying, and PancakeSwap Universal Router as the venue (payment through
Permit2). **Rules live off-chain, assets live on-chain**, and the session key's permission boundary is
the only thing connecting the two.

Accepted cost: performance fees are abandoned; revenue becomes a swap fee.

The code lives in three separate repositories: `cre8-contracts` (Foundry), `backend` (Bun + TS +
Postgres), `db` (SQL).

---

## 1. State as of 2026-11-06

### 1.1 Done

| Item | Status |
|---|---|
| AtpRegistry / AtpExecutor / PancakeV3TwapOracle | Done, 85 tests passed / 1 skipped (fork tests need `BSC_RPC_URL`) |
| Backend API (SIWE, strategy CRUD, on-chain mirroring, enroll) | Done, **450 pass / 4 skip / 0 fail** (`scripts/` now typechecked too), typecheck exit 0 |
| DB (8 tables, 3 migrations) | Done |
| Kernel v3 smart account deployment | Done |
| `@zerodev/sdk` migration | Done, zero behaviour change (`factoryData` byte-identical across 904 hex characters) |
| **Kernel session-key authorization** | **Done**, `verify-kernel-enroll.ts` **37/37 PASSED**; the session key has been proven to send an on-chain op, and privilege escalation is blocked at two layers |
| bundler (alto) availability | Done, **v1.2.5 + `safe-mode=true`** (v1.2.8's SafeValidator is broken against EP v0.7) |
| EIP-7702 feasibility | The protocol is live (BSC Pascal, 2025-03-20) and alto supports type-4 by default; **decided not to use it in v1** |
| Long-term anvil fork availability | `refresh-anvil.sh` built (the answer to the 75-minute shelf life) |
| **Account funding** | Done, `POST /portfolios` returns a `gas` object; `scripts/fund-account.ts` |
| **sudo-key renewal path** | **Proven**: a UserOp signed by the sudo key can install and revoke permissions, and the new session key works immediately (`scripts/renew-session-key.ts`) |
| **`enrollment_intents`** | Done; pins `validUntil` so the account address can be rebuilt (fixes D-21's orphaned-account bug) |
| **Renewal HTTP API** | Done: `GET /portfolios`, `GET /portfolios/:id/renewal-params`, `POST /portfolios/:id/renewal-result`, `POST /bundler` (relay) + CORS |
| **`cre8-app/` frontend** | Done (Vite + TS + bun); **the full renewal flow was exercised from a real browser** (see §1.4) |

### 1.2 Session-key authorization (completed this round)

When `enrollPortfolio` deploys the smart account it **installs three permission policies at once** and
writes the session-key reference into the DB:

- **Call**: may only call `AtpExecutor.executeRebalance` (selector `0x1b977850`)
- **Gas**: a `1e18` wei budget (⚠ one-shot, accumulated across ops, never reset)
- **Timestamp**: `now + 365 days`

The session key is derived from the master seed at `m/44'/60'/0'/0/<index>`, with
`index = keccak256(owner, strategyId) mod 2^31-1` — a pure function that does not depend on a DB id (see
[decisions D-19](./decisions.zh-TW.md)). **The DB stores only the derivation path `key_ref`; the private
key never enters the DB.**

Evidence (**as measured then**; the suite now reads 120 passes because funding was added afterwards):

```
bun test              107 pass / 1 skip / 0 fail
bun run typecheck     exit 0
verify-kernel-enroll  35/35 PASSED, exit 0
on-chain permission   permissionConfig(permissionId) exists, all three policies present,
                      permissionId agrees three ways (rebuilt == DB == chain)
end to end (real)     executeRebalance signed by the session key succeeded (tx 0x27155988…)
escalation            blocked by alto first (AA23 reverted, no userOpHash);
                      forced past alto, status=0 (tx 0x61f418e1…)
```

### 1.3 What the previous round (Kernel deployment) did

Enrollment now **actually deploys a non-custodial Kernel v3.3 account**, uses it to call
`AtpRegistry.enroll`, and writes `account_type='KERNEL'`.

**Zero contract changes** — `AtpRegistry.enroll(account, id)` is authorised for
`msg.sender == account || msg.sender == owner` (`AtpRegistry.sol:177`), so the operator could already
register on the account's behalf.

Key design point: **the salt includes `strategyId`** (one account per person per strategy), because
`_enrollments` is keyed by account and overwrites the whole record. See
[decisions D-01](./decisions.zh-TW.md).

Evidence (**as measured then**; 120 passes now):

```
bun test              83 pass / 1 skip / 0 fail
bun run typecheck     exit 0
verify-kernel-enroll  20/20 PASSED, exit 0
on-chain              account has code, enrollments=1/1/false, isEnrolled=true,
                      rootValidator=0x01++validator,
                      validator.ecdsaValidatorStorage(account) = the user EOA
idempotency           second enroll: same id, 0 tx, 0 new rows
crash retry           delete the DB row and rerun: success, 0 deploy tx, exactly 1 row at the end
```

---

### 1.4 The frontend renewal flow, end to end from a browser (this round)

`cre8-app/` was a **minimal harness** at the time (its UI would later be replaced by the existing
UI/UX), but the `POST /bundler` relay and the frontend signing handshake are the parts that survive.

Measured (real browser, dev private-key mode = anvil #3):

```
✔ SIWE sign-in
✔ GET /portfolios → id 5, gas.ready true
✔ GET /portfolios/5/renewal-params → new key m/…/24806714, permissionId 0xf67556bf
✔ eth_sendUserOperation → 0x1800dc13…5d1488e0e
✔ userOp receipt → success: true, actualGasUsed 0x86bdb
✔ transaction receipt → status success, block 132029098
✔ POST /portfolios/5/renewal-result → ok: true
```

Independently verified on-chain: `permissionConfig(0xf67556bf)` exists (signer =
ECDSA_SIGNER_CONTRACT), and the DB gained one `session_keys` row while the old row was left untouched.

**Verified with real MetaMask** (2026-11-07):

```
EIP-6963 detected 3 wallets (Phantom / MetaMask / SafePal) → MetaMask chosen
SIWE sign-in            ✔
renewal UserOp signing  ✔ personal_sign over the 32-byte userOpHash succeeded, MetaMask did not refuse
userOpHash matches local computation  ✔
tx 0xea39ec63…          status success, block 132044083
new permission 0x075d78e3   exists on-chain
new session key         ✔ proven to send executeRebalance on-chain (tx 0xbc61f99b…, status success)
escalation still blocked ✔ reverts during validation; an invalid op never reaches the mempool
```

**So EIP-712 is not needed** — that Plan B can be dropped. See [pitfalls §7.3](./pitfalls.zh-TW.md).

---

### 1.5 Indexer + scheduler (completed this round)

**Indexer** (`src/drift.ts` / `pricing.ts` / `positions.ts` / `snapshot.ts` / `holdings-scan.ts`)
- The drift universe is `registry.version(strategyId, enrollment.version).assets` — **not** a global
  allowlist (see D-24)
- Off-chain TWAP pricing agrees with the deployed oracle **to the last bit (0 ppm)**
- Multicall3 `aggregate3` with `allowFailure`, one round trip
- Unknown holdings: recorded in `unknown_token_count` for operations to watch, **not** blocked (the
  executor cannot sell them anyway)

**Rebalancing** (`src/rebalance-plan.ts` + `scripts/execute-rebalance.ts`)
- `noop` / `blocked` / `ready`, and **an empty step list is unrepresentable by type**
- `amountIn` truncated down twice and clamped to the holding; `minGross` matches the contract's
  `_minGross` character for character
- `deadline` comes from **block time**, not the wall clock

**Scheduler** (`src/scheduler.ts` + `scripts/scheduler.ts`)
- Claims with `FOR UPDATE SKIP LOCKED`; **live mode advances `next_run_at` inside the same transaction**
  (prevents double execution)
- `dryRun` defaults to true; **dry-run does not advance `next_run_at`** (otherwise monitoring would push
  a real rebalance out by a whole interval)
- Four pre-checks (account is KERNEL / key installed on-chain / seed derivation matches / allowance plus
  balance), **run in dry-run too**
- Automatically verifies session keys newest to oldest, skipping ones that are not installed

**Measured (local fork; the session key really swapped tokens)**

```
manual trigger  tx 0x5d74693d…  drift 5000 → 1 bps
scheduler       tx 0x2e6c0b8a…  drift 2501 → 1 bps
                operations state=confirmed attempts=1
                SwapExecuted 1 (== the number of steps)
                WBNB −250064641256153007 (== amountIn) / USDT +173671864767889195047 (== net)
                used key = 0xf67556bf (installed), not the newest 0x7db20115 (not installed)
```

**Unverified / known gaps**
1. **Multi-asset (>2)**: the oracle pinned one pool, so the planner returned `blocked` for
   `targets.length !== 2` → waiting on D-23 (per-call oracle)
2. **Liquidity and order splitting**: the USDT side of `NVDAB/USDT` holds roughly 207k, and the oracle's
   `maxSlippageBps` is 100 (1%) → any larger portfolio **necessarily** hits `BelowFloor`. Splitting
   orders is a hard requirement, not an optimisation
3. **Two operational pieces missing for unattended running**: ~~no alerts~~ (**added since:
   `scheduler_alerts` + `/health` degraded + `--alerts`**); session-key renewal was manual (and
   `renew-session-key.ts` throws on an already-renewed account, see `pitfalls §8.21`);
   `backend/.env` is now complete
4. **Real BSC not verified**: this whole round was simulated on a local fork
5. **Multi-round convergence not verified**: every run was a single round

---

### 1.6 Multi-asset rebalancing (D-23, completed this round)

**Problem**: `AtpExecutor` had a single immutable oracle, and `PancakeV3TwapOracle` pinned one pool — so
it could only rebalance WBNB↔USDT, and an equity index could not be executed at all.

**Solution**: add `AtpMultiPoolOracle` (a router) holding an "asset → per-pair `PancakeV3TwapOracle`" map,
with `previewSwap` purely forwarding. **`AtpExecutor` was not touched.**

- Bytecode census: `STATICCALL 3`, and **`CALL`/`CALLCODE`/`DELEGATECALL`/`SELFDESTRUCT` all 0** → it is
  physically incapable of moving funds
- Adding a new underlying = deploy one per-pair oracle and send one `setOracle`; **the executor does not
  need redeploying**

**Also fixed a real bug** (`pitfalls §8.14`): `PancakeV3TwapOracle`'s pair check was one-sided, so an
unknown token paired with USDT would be quoted off token1's price → the floor could be computed too low.

**Measured (3 assets, real chain)**

```
new account 0xb008dcff… (new strategy = new salt = new address)
tx 0x5cc9aff8… block 132164357 success gasUsed 773884
SwapExecuted 2 (WBNB→USDT 388414465242697445, USDT→NVDAB 135355485280000000000)
drift 2689 → 2 bps (WBNB +2 / NVDAB −2 / USDT 0)
nonce key 0x0002 ++ permissionId 0xe95382df → proves the permission validator, not sudo
negative control WBNB.transfer → InvalidCallData() 0x1c49f4d1
```

**Three findings that bite**

1. **`enroll` must come from the registry owner or the account itself** (`AtpRegistry.sol:177`) → once
   the owner is a multisig in production, this path blocks enrollment outright
2. **Kernel nonce-key layout**: 2 bytes `validationType` (`0x0002` = permission) + 4 bytes
   `permissionId`, the rest zero
3. **In hub mode USDT is "collect first, pay later"**, so the net change can be small or even negative.
   Any assertion of the form "USDT must increase" is wrong once there are multiple assets

---

## 2. What the system looks like

### Five layers

```
⑤ Application   strategy = an index definition (assets + weights + schedule + fee + version)
④ Execution     off-chain keeper (policy engine) + signing
③ Settlement    EntryPoint v0.7 + bundler (alto) + paymaster + eRPC
② Authorization session key (Kernel permissions / SmartSession, ERC-7579)
① Account       Kernel v3.3 smart account (one per person per strategy)
```

### Four core invariants

1. **Rules off-chain, assets on-chain**, connected only by the session key's permission boundary
2. **The only on-chain place that moves money is the Executor**; the session key can only call it
3. **Every swap's net output after fees ≥ the oracle floor**:
   `minGross = ceil(oracleFloor / (1 − swapFeeBps/10000))`
4. **A strategy is data, not logic**: changing weights or schedule means publishing a new version, and
   users do not need to re-sign

### Fee model

| Fee | Taken where | Who receives it |
|---|---|---|
| pool fee (0.05% / 0.25% / 1%) | inside the swap, taken by the pool | LPs |
| our swap fee (30–300 bps) | after the swap, on the output side, split by the Executor | us (admin-only, changeable) |
| infrastructure fee / subscription | **deferred** (originally planned via x402) | — |

---

## 3. Backlog (suggested order)

### 3.1 ⚠ Known limits once the session key is live (three walls)

These are not bugs; they are costs we accepted knowingly. They all point at the same thing: **we had no
user signing channel**.

| Limit | Consequence | Source |
|---|---|---|
| **Timestamp expiry** (1 year) | After expiry the portfolio loses the ability to execute, and it **cannot be fixed from the backend** | [D-15](./decisions.zh-TW.md) |
| **GasPolicy budget exhaustion** (`1e18` wei, ~3000 ops) | Once spent, the permission goes **permanently silent** and never resets | [D-14](./decisions.zh-TW.md), [pitfalls §3.4](./pitfalls.zh-TW.md) |
| **Permissions are fixed at deploy time** | Changing permissions = changing accounts (an existing account cannot be upgraded) | [D-13](./decisions.zh-TW.md) |

Two more to remember before doing a migration:

- **Old data is not backfilled**: KERNEL portfolios created before this change are accounts with no
  permissions installed, and the idempotent SELECT returns them as-is → they never upgrade. There are no
  production users yet, but a future migration has to handle it.
- **Enrollment does not fund the account**: the gas for a session-key op is paid by **the account
  itself**. A new account without BNB cannot send an op — the funding flow must exist before launch.
- **The timestamp policy's time comparison is untested**: we only confirmed it is installed on-chain
  (permissionId includes it and all three agree). Really testing it means pushing anvil's time past
  `validUntil`, which pollutes the shared fork, so it is deferred.

### 3.2 Next step: a user signing channel

**This single decision clears all three walls above**, plus EIP-1271 SIWE.

Options undecided: WalletConnect (closest to existing wallets) / embedded wallet (Privy, Dynamic — best
UX but introduces a vendor) / a local CLI (fastest, worst experience). See
[decisions open-1](./decisions.zh-TW.md).

### 3.3 Afterwards

| # | Item | Notes |
|---|---|---|
| 1 | Scheduler + indexer | Read the chain, compute drift, trigger `executeRebalance`. ⚠ note that **a successful op ≠ tokens actually swapped** ([pitfalls §3.5](./pitfalls.zh-TW.md)) |
| 2 | ~~enrollment funding flow~~ | **Done**: `POST /portfolios` returns gas state (`ready` / `shortfallWei` / `estimatedOps`); locally via `scripts/fund-account.ts`. See [D-20](./decisions.zh-TW.md) and [runbook §5.5](./runbook.zh-TW.md) |
| 3 | EIP-1271 / ERC-6492 | SIWE only accepts EOAs today; smart-account signatures need `verifySiweMessage` plus RPC |
| 4 | Permission backfill for old portfolios | See §3.1; needs a migration script or a re-enroll flow |
| 5 | Pin addresses in the deploy scripts | `DeployAtp.s.sol` and `deploy-fork.sh` each carry a hardcoded pin; two sources drift |
| 6 | `GET /strategies/:id/versions` | Would let the 201 response carry `Location` |
| 7 | Real mainnet deployment | The same script with a different `--rpc-url` and a funded account, plus buying a keyed RPC then (D-16) |
| 8 | R2 concurrent dual-open | See [D-12](./decisions.zh-TW.md); decided to defer |
| 9 | Bring `scripts/` into typecheck | `tsconfig` includes only `src/**` and `test/**`, so a broken script goes unnoticed ([pitfalls §5.2](./pitfalls.zh-TW.md)) |
| 10 | Kernel version upgrade policy | Frozen at v3.3. Upgrading changes every new account's address; see [decisions open-2](./decisions.zh-TW.md) |

---

## 4. Confirm green before changing anything

```bash
cd backend && bun test
```

Expect **450 pass / 4 skip / 0 fail** (`scripts/` is typechecked too). The single skip is an on-chain
integration test (it requires a non-empty `RPC_URL`) and **is normal**.

For on-chain verification follow [runbook §3.2 and §5](./runbook.zh-TW.md).

---

## 5. Documentation map

| To learn | Read |
|---|---|
| Why the migration, the five layers, the schedule | [atp-pivot-plan.zh-TW.md](./atp-pivot-plan.zh-TW.md) |
| The Executor's interface spec | [atp-pivot-executor-spec.zh-TW.md](./atp-pivot-executor-spec.zh-TW.md) |
| **Why it is built this way** | [decisions.zh-TW.md](./decisions.zh-TW.md) |
| **Which traps were hit (read this first)** | [pitfalls.zh-TW.md](./pitfalls.zh-TW.md) |
| How to run it, troubleshooting | [runbook.zh-TW.md](./runbook.zh-TW.md) |
| The 2026-11-06 handover (historical) | [archive/handoff-2026-11-06.zh-TW.md](./archive/handoff-2026-11-06.zh-TW.md) |
| The old pooled vault (**abandoned**, for contrast only) | [archive/legacy-vault/](./archive/legacy-vault/) |

### Authoritative sources across the three repositories

| Location | Content |
|---|---|
| `cre8-contracts/src/atp/*.sol` | Contract implementation (final authority) |
| `cre8-contracts/test/atp/*.t.sol` | Unit tests and fork tests |
| `cre8-contracts/deployments/mainnet.json` | Mainnet deployment record |
| `backend/src/*.ts` | Backend implementation |
| `backend/src/addresses.ts` | Single in-code source for protocol constants |
| `backend/README.md` | The backend in full (API, validation rules, env, runbook) |
| `db/migrations/*.sql` | The schema (single source of truth) |
| `db/README.md` | Schema overview and JSON shapes |

---

## 6. The first thing to tell a successor

> Read [decisions](./decisions.zh-TW.md) and [pitfalls](./pitfalls.zh-TW.md) first — those two save you
> the most time. Then run `cd backend && bun test` and confirm 450 passes. Before touching the chain,
> read [runbook §3.2](./runbook.zh-TW.md) (anvil has a 75-minute shelf life).

One warning: **the biggest lesson in this project's history is that a conclusion reached by reading code
must be verified by measurement.** In this round alone, three judgements derived from source were
overturned by on-chain measurement (MetaFactory behaviour, the safe-mode root cause, the anvil head-block
offset). See the [pitfalls appendix](./pitfalls.zh-TW.md).
