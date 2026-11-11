# Runbook

Last updated: 2026-11-06

Everything from zero to "one end-to-end verification run". All commands assume the working directory
is `cre8-protocol/`.

---

## 0. Three repositories and the workspace

| Repository | Path | Toolchain | Git |
|---|---|---|---|
| cre8-contracts | `./cre8-contracts` | Foundry | its own repository |
| backend | `./backend` | Bun | its own repository |
| db | `./db` | SQL | its own repository |

⚠ `cre8-protocol/` **is not a git repository**. Running `git status` in it gives
`fatal: not a git repository`. Check changes inside each subdirectory.

---

## 1. Postgres

```bash
docker start cre8-postgres 2>/dev/null || docker run -d --name cre8-postgres \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=cre8_atp \
  -p 5432:5432 -v cre8-postgres-data:/var/lib/postgresql/data postgres:16-alpine
```

Connection string: `postgres://postgres:postgres@127.0.0.1:5432/cre8_atp`

## 2. API only (no chain)

```bash
cd backend && bun install && bun run migrate && bun test
```

Expect **473 pass / 16 skip / 0 fail**, and `bun run typecheck` exit 0.

> The 16 skips are the on-chain tests, which require **`RPC_URL` to be non-empty** as well as
> `DATABASE_URL`. `backend/.env` leaves `RPC_URL` empty, so they skip — **normal, not a failure**.
>
> Note that `DATABASE_URL` is required even for the pure unit tests: `getConfig()` throws without it, so
> Postgres must be up (§1) before `bun test` can run at all.

---

## 3. Anvil fork (the on-chain dev environment)

### 3.1 First start

```bash
anvil --fork-url https://bsc-rpc.publicnode.com --chain-id 56 --port 8545
```

⚠ **Do not pass `--fork-block-number`** — pinning an old block makes anvil hit a 403 while fetching dev
accounts at startup and exit.

⚠ `--chain-id 56` is not optional. Anvil defaults to chain id 31337, while the viem client binds
`chain: bsc` (56) and fails with a chain mismatch.

### 3.2 Periodic refresh (**about every 55 minutes**) ⚠ the easiest thing to forget

```bash
bash backend/scripts/refresh-anvil.sh
```

The script dumps the current state → stops the old anvil → starts a new one (forking the latest block) →
loads the state → verifies three things → prints the next recommended refresh time.

**Why this is needed**: anvil asks upstream about its own pinned block, and once that block is old it is
treated as archive → cold-address queries return 403. publicnode's window is about 75 minutes. See
[pitfalls §2.1](./pitfalls.zh-TW.md).

**Symptom** (time to run the script):
```
failed to get account for 0x...: HTTP error 403 ... "Archive requests require a personal token"
```

Configurable: `ANVIL_PORT` (default 8545), `BSC_RPC_URL` (default publicnode), `FOUNDRY_BIN`.

### 3.3 Deploying our own Atp contracts (**usually unnecessary**)

⚠ **Do not run `cre8-contracts/scripts/deploy-fork.sh`.** Every run starts a **brand new** anvil fork and
overwrites `deployments/fork.json` — the existing registry and every deployed account disappear, and all
`strategies.onchain_id` values in the DB become invalid.

If a redeploy really is needed:
```bash
cd cre8-contracts
forge script script/DeployAtp.s.sol \
  --rpc-url http://127.0.0.1:8545 --broadcast --skip-simulation \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```
Then take the addresses from `broadcast/DeployAtp.s.sol/56/run-latest.json` (**never hardcode** them; they
change every run), update `deployments/fork.json` and the backend's `REGISTRY_ADDRESS`, and rebuild
`strategies.onchain_id` in the DB.

**Anvil private keys are public test keys, for a local fork only.** Both `0xac0974be…` and `0x59c6995e…`
appearing in this document are public anvil default accounts.

---

## 4. Pointing the backend at the chain

```bash
cd backend
DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/cre8_atp' \
RPC_URL='http://127.0.0.1:8545' \
OPERATOR_PRIVATE_KEY='0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' \
REGISTRY_ADDRESS='<registry>' \
EXECUTOR_ADDRESS='<executor>' \
SESSION_KEY_MASTER_SEED='<32 bytes hex>' \
PORT=8081 AUTH_DOMAIN=localhost bun src/index.ts
```

**The two newer variables are only used at enrollment** (`EXECUTOR_ADDRESS` is the CallPolicy target,
`SESSION_KEY_MASTER_SEED` is the HD seed for session keys). Leaving them unset does not break startup, but
`POST /portfolios` then returns a diagnosable error — see [decisions D-17 / D-18](./decisions.zh-TW.md).

⚠ **`SESSION_KEY_MASTER_SEED` may live in an env var in dev; in production it belongs in a KMS.** Leaking
it leaks every session key, and it **must not share a key with the operator**.

⚠ **PORT=8081**: another backend on `:8080` reads `backend/.env`, which has no `REGISTRY_ADDRESS`, so it
reports `rpcConfigured: false` (entirely off-chain). Confirm you are hitting 8081 before verifying.

Health check: `curl -s http://127.0.0.1:8081/health` should include `"rpcConfigured":true,"db":"ok"`.

⚠ The registry address is **specific to this anvil fork**. It must be updated after a fork restart or a
redeploy, and `fork.json` is the authoritative record.

---

## 5. End-to-end verification (the main acceptance for that round)

```bash
cd backend
DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/cre8_atp' \
RPC_URL='http://127.0.0.1:8545' \
OPERATOR_PRIVATE_KEY='0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' \
REGISTRY_ADDRESS='<registry>' \
EXECUTOR_ADDRESS='<executor>' \
SESSION_KEY_MASTER_SEED='0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' \
CHAIN_ID=56 VERIFY_WALLET='0x90F79bf6EB2c4f870365E785982E1f101E93b906' \
bun run scripts/verify-kernel-enroll.ts
```

⚠ **`VERIFY_WALLET` must be a wallet that has never been enrolled.** An already-enrolled wallet hits the
idempotent SELECT, and that portfolio may have no `session_keys` row (old data from before that round), so
`[5b]` fails. The script defaults to anvil #2, which earlier rounds have used — pass #3
(`0x90F7…b906`) or newer.

⚠ **The seed above is the standard BIP32 test vector.** It is for verification only, not a real secret.

**Success criterion: `35/35 checks PASSED`, exit 0.**

It verifies 35 checks in eight groups:
1. `[0]` whether the session-key env is complete
2. `[1]` probe R1: two deploys for the same owner send exactly one transaction
3. `[2]` the strategy's on-chain facts come from the DB (not hardcoded)
4. `[3]` the smart account `enrollPortfolio` produced
5. `[4]` on-chain `enrollments` / `isEnrolled` / `rootValidator` / `ecdsaValidatorStorage`
6. `[5]` `[5b]` DB `account_type='KERNEL'`, lowercase address, and the three-policy snapshot in `session_keys`
7. `[6]` idempotency (second enroll: 0 tx / 0 rows / 0 session_keys rows)
8. `[7]` **the permission is really installed**: rebuilding `initConfig` from the DB snapshot gives the same
   address; omitting `initConfig` gives a different one; `permissionId` agrees three ways
   (rebuilt == DB == chain); `permissionConfig.signer` is the signer **contract**, not the session-key EOA

⚠ Group `[7]` is easy to misread; see [pitfalls §3.8](./pitfalls.zh-TW.md).

⚠ If R1a fails with `HTTP error 403 ... Archive requests`, that is not a code problem — the fork expired.
Run the refresh in §3.2.

### Other verification commands

```bash
# golden-vector regression (compares only, writes nothing)
cd backend && bun run scripts/gen-kernel-golden.ts --check
# expect 14/14 checks passed, exit 0

# unit tests
cd backend && bun test && bun run typecheck

# contract tests (fork tests need BSC_RPC_URL)
cd cre8-contracts && forge test
```

---

## 5.5 Funding an account (the precondition for a session key to do anything)

**A UserOp's gas is paid by the `sender` (the smart account), not by the signer.** An account without BNB
cannot send any op, and the error reads `AA21 didn't pay prefund` or
`Smart Account does not have sufficient funds` — meaningless to a user. See
[pitfalls §3.10](./pitfalls.zh-TW.md).

### Checking whether it can run right now

The response to `POST /portfolios` (and an idempotent repeat) carries a `gas` object:

```json
"gas": {
  "address": "0x2b08…d042",           // ← send BNB here (the smart account, not the session key)
  "balanceWei": "999695781000000000",
  "minimumWei": "500000000000000",     // 0.0005 BNB
  "ready": true,
  "shortfallWei": "0",                 // "0" when ready, otherwise how much more is needed
  "estimatedOps": 3998,                // how many more ops at the current gas price
  "gasPriceKnown": true                // false = gas price unavailable, so estimatedOps is "unknown"
}
```

`ready` only compares the balance against `minimumWei`, independent of gas price. `minimumWei` comes from
`MIN_SESSION_GAS_WEI` (default `5e14` = 0.0005 BNB, about 20 ops).

### Local funding (dev)

```bash
cd backend
OPERATOR_PRIVATE_KEY='0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' \
RPC_URL='http://127.0.0.1:8545' \
bun run scripts/fund-account.ts 0x2b082fadf8f3d620eaa242a9e36817af8640d042 0.05
```

It prints the balance before and after plus `estimatedOps`, and exits 1 when the threshold is not met.

⚠ **This is a dev tool. In production the user must initiate funding** — otherwise the system is not
non-custodial.

### Cost reference

Measured: one op costs about **0.0003 BNB** (gasUsed ≈ 250,000 at an effective BSC gas price of
≈ 1.22 gwei). 1 BNB covers roughly 3300 ops.

⚠ **Anything beyond 1 BNB is unusable** — the session key's GasPolicy budget is `1e18` wei (1 BNB of gas)
and never resets, so it blocks first.

---

## 5.6 Session-key renewal (an internal tool)

⚠ **This is an internal operations tool, not a user interface.** It needs the account's **sudo owner
private key** (`SUDO_PRIVATE_KEY`), so it cannot be used outside dev/fork — in production the user's own
wallet must sign (not yet implemented, see [HANDOFF §3.2](./HANDOFF.md)).

```bash
cd backend
SUDO_PRIVATE_KEY='<the account owner private key>' \
OPERATOR_PRIVATE_KEY='0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' \
RPC_URL='http://127.0.0.1:8545' \
SESSION_KEY_MASTER_SEED='<seed>' \
bun run scripts/renew-session-key.ts --account 0x… --strategy-id 11 [--revoke-only 0x…]
```

### What it does

1. Signs a UserOp with the sudo key that makes the account **call itself** with
   `installValidations(...)` + `grantAccess(...)` (because `Kernel.sol`'s
   `onlyEntryPointOrSelfOrRoot` only passes when `msg.sender == address(this)`)
2. Derives a **new** session key (new index) and a new `validUntil` → a new `permissionId`
3. Verifies `permissionConfig(new id)` exists on-chain with all three policies
4. Optionally revokes the old permission with `--revoke-only <permissionId>`

### Key properties

- **Renewal adds, it does not replace.** The old permission survives until its own `validUntil` (harmless).
  To kill it immediately you must revoke explicitly.
- **`permissionId` differs every time** (it follows the session key, `validUntil` and policy order); never
  hardcode it.
- **Do not re-derive the account address** — use `createKernelAccount({ address })` with the DB's
  authoritative value. See [pitfalls §4.7](./pitfalls.zh-TW.md).

### Proven (on an anvil fork)

```
renewal op signed by the sudo key   tx 0x36cc409b…  success  gasUsed 569481
executing with the new session key  tx 0xb7eec44c…  success  ← renewal really took effect
revoking the old permission         tx 0xaa3e30db…  success  → signer=0x0
```

---

## 6. alto (bundler; needed only for session keys)

⚠ **Use v1.2.5.** v1.2.8's SafeValidator is broken against EP v0.7 (see [pitfalls §1.1](./pitfalls.zh-TW.md)).

### 6.1 Getting the image

`docker pull ghcr.io/pimlicolabs/alto:v1.2.5` is refused (`denied: denied` at the daemon, unaffected by a
clean `DOCKER_CONFIG`). Use the bundled script:

```bash
cd spike/alto
ALTO_TAG=v1.2.5 python3 fetch-image.py     # anonymous token → OCI manifest → blobs → docker-archive
docker load -i alto-v1.2.5-arm64.tar
```

### 6.2 Starting it

Config: `spike/alto/alto-config-125.json`. Key fields:

| Field | Value | Notes |
|---|---|---|
| `rpc-url` | `http://host.docker.internal:8545` | **`127.0.0.1` inside the container does not reach the host** |
| `entrypoints` | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | EP v0.7 |
| `executor-private-keys` | anvil acct0 private key | required |
| `utility-private-key` | same | for refills |
| `safe-mode` | **`true`** | validation rules must be on |
| `port` | 3001 | avoids the old 3000 |

```bash
docker run -d --name alto-125 -p 127.0.0.1:3001:3001 \
  -v "$PWD/spike/alto/alto-config-125.json:/cfg/alto-config-125.json:ro" \
  ghcr.io/pimlicolabs/alto:v1.2.5 --config /cfg/alto-config-125.json
```

Confirm:
`curl -s -X POST http://127.0.0.1:3001 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_supportedEntryPoints","params":[]}'`

⚠ v1.2.5 does **not** have `network-name` / `enable-cors` / `block-time` (those are v1.2.8 keys). Feeding a
v1.2.8 config to v1.2.5 introduces invalid keys.

### 6.3 Sending an op and verifying

```bash
cd spike/alto && bun run send-userop-125.ts
```

⚠ **To tell whether an op was accepted, look for `userOpHash` in the body, not at the HTTP status.**
JSON-RPC errors live in the body's `error` object while HTTP stays 200.

⚠ With no paymaster the first op is blocked by `Smart Account does not have sufficient funds` → fund the
counterfactual address first (the script already handles this idempotently).

---

## 7. Troubleshooting

| Symptom | Real cause | Action |
|---|---|---|
| `HTTP error 403 ... Archive requests` | the fork's block went stale | `bash backend/scripts/refresh-anvil.sh` |
| `AbiErrorSignatureNotFoundError: selector 0x99410554` | alto v1.2.8's SafeValidator is broken | switch to v1.2.5 |
| `InvalidSelector` on `owner()` | Kernel v3.3 has no such view | use `rootValidator()` + `validator.ecdsaValidatorStorage(account)` |
| `invalid byte sequence` / `unbound variable` in shell | macOS ships bash 3.2 | use `tr` for case changes; do not put a variable next to a full-width character |
| `bash: /bin/ps: Operation not permitted` | sandbox restriction | use `pgrep -fl` |
| `23405 duplicate key` on `smart_accounts` | an idempotent query picked the wrong row (fixed) or two concurrent opens (not fixed) | see [pitfalls §5.1](./pitfalls.zh-TW.md), [decisions D-12](./decisions.zh-TW.md) |
| `bun install` fails with EPERM on `~/.bun/install/cache` | the sandbox blocks the home cache | `BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache bun add ...` |
| A contract reads but a new address returns `0x` | possibly an anvil without a fork | see [pitfalls §2.2](./pitfalls.zh-TW.md) |

---

## 8. Current fixed constants (BSC chain id 56)

All verified over RPC to have code:

| Item | Address |
|---|---|
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| Kernel MetaFactory | `0xd703aaE79538628d27099B8c4f621bE4CCd142d5` |
| Kernel v3.3 KernelFactory | `0x2577507b78c2008Ff367261CB6285d44ba5eF2E9` |
| Kernel v3.3 impl | `0xd6CEDDe84be40893d153Be9d467CD6aD37875b28` |
| ECDSA validator (v3.1+) | `0x845ADb2C711129d4f3966735eD98a9F09fC4cE57` |
| Permit2 | `0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768` |
| PancakeSwap Universal Router | `0x1A0A18AC4BECDDbd6389559687d1A73d8927E416` |

For our own deployment see `cre8-contracts/deployments/mainnet.json` on mainnet and
`deployments/fork.json` for a fork (a fork's addresses die with the fork).

⚠ **Swapping the executor invalidates every session key's CallPolicy** (the target is pinned to the
address), see `pitfalls §8.15`. Rebuild permissions before changing `EXECUTOR_ADDRESS`.

The single in-code source for protocol constants is `backend/src/addresses.ts`; they are deliberately
**not** env vars, for the reason in [decisions D-05](./decisions.zh-TW.md).
