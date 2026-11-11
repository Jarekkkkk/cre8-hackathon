# cre8-atp-backend

The off-chain backend for CRE8 ATP. Bun + TypeScript + Postgres, using `pg` directly and **no ORM**
(matching the web app). The default chain is BNB Chain mainnet (chain 56). It currently provides the
strategy data layer, version publishing, SIWE (EIP-4361) wallet-signature auth, portfolio renewal, and a
**bundler relay** (`POST /bundler` — browsers cannot reach alto directly, see §bundler relay).

## Architecture

```
HTTP → src/index.ts (startup: config → migrate → listen)
         └─ src/server.ts (node:http routing, JSON, error mapping, auth gate)
              ├─ src/auth.ts (SIWE nonce, EIP-4361 verification, session token)
              └─ src/strategies.ts (domain logic + pure validation)
                   └─ src/db.ts (pg Pool, query, transaction, migrate)
                        └─ Postgres (schema in ../db/migrations)
```

| File | Responsibility |
| --- | --- |
| `src/config.ts` | Reads env; `DATABASE_URL` is required, `PORT` defaults to 8080, `CHAIN_ID` to 56, `AUTH_DOMAIN` to `localhost`. |
| `src/auth.ts` | In-memory nonce/session store, EIP-4361 (SIWE) verification (viem `parseSiweMessage` + `recoverMessageAddress`), `authenticate()`. |
| `src/db.ts` | A single `Pool`, `query()`, `withTransaction()`, `migrate()` (checksums + advisory lock). |
| `src/errors.ts` | `AppError` / `ValidationError` / `NotFoundError`, so the domain layer never knows about HTTP. |
| `src/strategies.ts` | `listStrategies`, `getStrategy`, `createStrategy`, `publishVersion`, plus allocation and schedule validation. |
| `src/portfolios.ts` | `enrollPortfolio`, `listPortfolios`, `requireOwnedPortfolio`: portfolio reads and writes, with owner checks. |
| `src/renewal.ts` | Renewal: derives a new session key (`nextRenewalKeyIndex` / `buildRenewalKey`), `buildRenewalParams`, `recordRenewalResult`. |
| `src/server.ts` | Routing, body parsing (1 MB limit), errors → JSON, CORS, access log, the `POST /bundler` relay and its method allowlist. |
| `src/index.ts` | Startup and graceful shutdown (SIGINT/SIGTERM). |
| `src/migrate.ts` | `bun run migrate`: migrations only, no server. |
| `test/strategies.test.ts` | Pure-function and HTTP route tests for validation (the route layer accepts injected `createStrategy` / `publishVersion`, so no DB needed); DB integration tests are gated on `DATABASE_URL`. |
| `test/auth.test.ts` | SIWE nonce/login/session and provider ownership; signs inside the test with viem `createSiweMessage` and a random wallet, exercising the full HTTP flow. |
| `test/renewal.test.ts` | `/portfolios` listing, `renewal-params` / `renewal-result`, route dispatch, CORS and the `/bundler` relay (including "not forwarded when outside the allowlist"); DB, chain, clock and the bundler upstream are all replaced with fakes via DI. |

`node:http` rather than express: this round had seven routes and one fewer dependency. `route()` in
`server.ts` is the only place that would change, so moving to express or Fastify later does not touch the
domain layer.

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | ✅ | — | Postgres connection string; `getConfig()` throws without it. |
| `PORT` | | `8080` | HTTP port, 1–65535. |
| `CHAIN_ID` | | `56` | EIP-155 chain id; 56 = BSC mainnet, 97 = testnet. The SIWE message must bind the same chain. |
| `AUTH_DOMAIN` | | `localhost` | EIP-4361 `domain`: the site authority the wallet signs (host only, port allowed, no scheme or path). Must be set to your own domain in production. |
| `AUTH_URI` | | `http://<AUTH_DOMAIN>` | EIP-4361 `uri`: the resource this sign-in refers to. Must be an absolute http/https URI; set `https://app…` in production. |
| `RPC_URL` | | empty | JSON-RPC endpoint; currently only reported by `/health`. |
| `EXECUTOR_ADDRESS` | ✅ at renewal/enroll | empty | The target the session key's CallPolicy allows (the rebalance executor). Without it, enrollment and `renewal-params` fail naming the variable. |
| `SESSION_KEY_MASTER_SEED` | ✅ at renewal/enroll | empty | The HD master seed (`0x` + 64 hex) for deriving session keys. The private key never enters the DB; only the derivation path `m/44'/60'/0'/0/<index>` is stored. |
| `BUNDLER_URL` | | `http://127.0.0.1:3001` | Upstream for `POST /bundler` (alto). `renewal-params` also returns it to the frontend as **information**. Empty means the default. |
| `CORS_ALLOWED_ORIGINS` | | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated allowed origins (full origin, case-insensitive). Unset means the dev default; `*` is not supported. |
| `MIN_SESSION_GAS_WEI` | | `500000000000000` | Per-account gas threshold (0.0005 BNB, about 20 rebalances). See the note under "account funding" in the runbook. |

Copy `.env.example` to `.env`; `.env` is not committed. **Do not** put a real RPC URL or connection
string in the repo.

## Commands

```bash
bun install
cp .env.example .env       # fill in DATABASE_URL

bun run dev                # bun --watch src/index.ts (migrates on startup)
bun run migrate            # apply migrations only
bun run start              # bun src/index.ts
bun run typecheck          # tsc --noEmit (two tsconfigs: src + test)
bun test                   # bun's built-in runner; DB tests skip without DATABASE_URL
```

Requires Bun >= 1.4 (`engines` in `package.json`). Bun runs TypeScript natively, so there is no build step
and no tsx.

### Tests and the DB

```bash
# pure functions + auth/route tests (no DB)
bun test

# with DB integration tests; use a disposable database, the tests migrate and create/delete rows
DATABASE_URL='postgres://postgres@127.0.0.1:5432/cre8_atp_test' bun test
```

### Tests that send on-chain transactions (`RUN_CHAIN_TESTS=1`)

Four tests **really send on-chain transactions**: `createStrategy` mirrors to `AtpRegistry`,
`publishVersion` goes on-chain, and `enrollPortfolio` performs a counterfactual deploy. They are **off by
default**, even with a complete `.env`:

| Test | File |
| --- | --- |
| `DB: strategy and version round trip` | `test/strategies.test.ts` |
| `DB: POST /strategies/:id/versions publishes a version over HTTP` | `test/strategies.test.ts` |
| `DB: provider ownership is enforced end to end over HTTP` | `test/auth.test.ts` |
| `enrollPortfolio mirrors to chain and writes portfolio + smart account` | `test/portfolios.test.ts` |

Why a separate switch: "the backend is fully configured" (`RPC_URL` / `OPERATOR_PRIVATE_KEY` /
`REGISTRY_ADDRESS`) only means **the server** can work, not that **tests** may touch the chain. Enabling
them automatically once `.env` is filled would turn `bun test` into a script that writes to the chain, and
these four tests share one operator account's nonce.

```bash
# default: those four skip, everything else runs (0 fail)
bun test

# really write on-chain: never omit the timeout, and never use --concurrent
RUN_CHAIN_TESTS=1 bun test --timeout=120000
```

Two details, both learned the hard way:

- **`--timeout` is not optional.** Sending a transaction and waiting for the receipt takes seconds (the
  `enrollPortfolio` test measured 13–15 s end to end), and bun's default is 5 s per test. A timed-out test
  **does not stop the underlying send**, so the next test reads a stale nonce on the same operator account
  and fails with `NonceTooLowError`. Measured: `RUN_CHAIN_TESTS=1 bun test` without `--timeout` gives 4
  failures; with `--timeout=120000` it is 410 pass / 0 fail two runs in a row.
- **Do not use `--concurrent`.** It parallelises tests within a file and the nonces collide. Note also that
  `bun test --concurrent 1` is **invalid** in bun 1.4: `--concurrent` takes no value, so the `1` is treated
  as a filename filter and you get "The following filters did not match any test files: 1". Bun already
  runs one file at a time, so the correct invocation is **only `--timeout`, no `--concurrent`**.

⚠ Those four tests send transactions to the chain at `RPC_URL` and leave strategy rows in the database at
`DATABASE_URL`. **Only run them against a local anvil fork (e.g. `http://127.0.0.1:8545`), never mainnet.**

Tests that only **read** the chain (`test/pricing.crosscheck.test.ts`, the real-chain checks in
`test/rebalance-plan.test.ts`, `test/snapshot.integration.test.ts`) are unaffected by this switch: they
send no transactions and take no nonce, so they are safe to parallelise; they skip only when the fork is
unavailable.

### Fork integration test (anvil forking BSC mainnet)

Needs three terminals or background processes: the anvil fork, a chain-configured backend, and the
integration script.

```bash
# 1. start the anvil fork (chain 56, resident)
cd ../cre8-contracts
anvil --fork-url https://bsc-rpc.publicnode.com --chain-id 56 --port 8545

# 2. deploy the contracts and note the registry address (another terminal)
forge script script/DeployAtp.s.sol \
  --rpc-url http://127.0.0.1:8545 --broadcast --skip-simulation \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# 3. start a chain-configured backend (8081, to avoid colliding with 8080)
cd ../backend
DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/cre8_atp' \
RPC_URL='http://127.0.0.1:8545' \
OPERATOR_PRIVATE_KEY='0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' \
REGISTRY_ADDRESS='<registry printed in step 2>' \
PORT=8081 AUTH_DOMAIN=localhost bun src/index.ts

# 4. run the end-to-end integration (auth → create strategy → publish version → enroll)
bun run scripts/integration-fork.ts
```

Verify the on-chain state:

```bash
cast call $REGISTRY 'enrollments(address)(uint256,uint16,bool)' $WALLET --rpc-url http://127.0.0.1:8545
# → 1 / 1 / false (strategyId / version / paused)
```

Note: anvil's account private keys are public test keys, **for a local fork only**; a real chain needs your
own wallet.

Without `DATABASE_URL`, the DB tests are reported as skipped (not passed). The integration test migrates
itself and deletes the strategy it created in a `finally` block (versions cascade by FK).

## API

Every response is `application/json; charset=utf-8`, and errors always look like
`{"error":{"code":"...","message":"..."}}`.

| Method | Path | Description | Success |
| --- | --- | --- | --- |
| `GET` | `/health` | 200 when Postgres is reachable, otherwise 503 (`db: "down"`) | 200 |
| `GET` | `/strategies` | List; `limit` (1–100, default 50), `offset`, `provider` (case-insensitive), `public=true\|false` | 200 |
| `GET` | `/strategies/:id` | One strategy plus its version history (newest first) | 200 |
| `POST` | `/auth/nonce` | A one-shot nonce and the SIWE fields (`domain` / `chainId` / `uri` / `statement` / `issuedAt`, TTL 5 min); no body | 200 |
| `POST` | `/auth/login` | Body `{message, signature}` (a complete EIP-4361 message); returns `{token, expiresAt}` | 200 |
| `POST` | `/strategies` | Create strategy metadata; **requires** `Authorization: Bearer <token>` | 201 + `Location` |
| `POST` | `/strategies/:id/versions` | Publish a new version; **requires** a token and must be the strategy's provider | 201 |
| `GET` | `/portfolios` | The signed-in wallet's portfolios (with gas state and the current session key); **requires** a token | 200 |
| `POST` | `/portfolios` | Enroll a strategy; **requires** a token, body `{strategyId}` | 201 + `Location` |
| `GET` | `/portfolios/:id/renewal-params` | Derives a new session key and returns everything the frontend needs to build the renewal UserOp; **requires** a token and ownership | 200 |
| `POST` | `/portfolios/:id/renewal-result` | The frontend reports that the renewal UserOp landed; recorded in `session_keys`; **requires** a token and ownership | 200 |
| `POST` | `/bundler` | Bundler relay: forwards JSON-RPC to `BUNDLER_URL` verbatim and returns it verbatim; **requires** a token, and the method must be allowlisted | the upstream status |

Every authenticated path validates the token **before reading the body**: a request without a token is a
401 even if the body is invalid, never a 400.

### Auth (SIWE / EIP-4361 + session token)

No passwords and no third-party service. The flow is "get the SIWE fields → the frontend builds an
EIP-4361 message with viem → the wallet signs → exchange for a token → call write routes with it". The
message binds **domain + chainId + nonce + issuedAt**, so a message phished to another site or another
chain is unusable.

1. `POST /auth/nonce` returns a one-shot nonce (32 bytes hex, TTL 5 minutes) and the fields needed to build
   the message:
   ```bash
   curl -s -X POST localhost:8080/auth/nonce
   # {"nonce":"<64 hex>","domain":"localhost","chainId":56,"uri":"http://localhost",
   #  "statement":"Sign in to CRE8 ATP","version":"1",
   #  "issuedAt":"2026-11-06T01:00:00.000Z","expiresAt":"2026-11-06T01:05:00.000Z"}
   ```
   `domain` / `chainId` / `uri` / `statement` come from server config (`AUTH_DOMAIN`, `CHAIN_ID`,
   `AUTH_URI`); `issuedAt` is server time, so using it directly makes local clock skew irrelevant.
2. The frontend combines those fields with **its own address** into a complete EIP-4361 message and signs
   it (`createSiweMessage` from `viem/siwe`, `version: "1"`):
   ```ts
   import { createSiweMessage } from 'viem/siwe';

   const challenge = await (await fetch('/auth/nonce', { method: 'POST' })).json();
   const message = createSiweMessage({
     address: account.address,          // supplied by the signer
     chainId: challenge.chainId,
     domain: challenge.domain,
     uri: challenge.uri,
     statement: challenge.statement,
     version: '1',
     nonce: challenge.nonce,
     issuedAt: new Date(challenge.issuedAt),   // or new Date()
   });
   const signature = await walletClient.signMessage({ account, message });
   ```
   The wallet shows the standard SIWE layout (`<domain> wants you to sign in with your Ethereum account:`
   plus the address, `Sign in to CRE8 ATP`, and `URI` / `Version` / `Chain ID` / `Nonce` / `Issued At`).
3. `POST /auth/login` with a body of just `{"message":"<complete EIP-4361 message>","signature":"0x…"}`:
   ```bash
   curl -s -X POST localhost:8080/auth/login -H 'content-type: application/json' -d '{
     "message": "<complete SIWE message, newlines included>",
     "signature": "0x<65-byte signature>"
   }'
   # {"token":"<64 hex>","expiresAt":"..."}
   ```
   The server checks, in this order (deliberately: validate the envelope, then burn the nonce):
   - The message parses, and `version=1`, `statement`, `domain`, `uri`, `chainId` all equal this server's
     config, otherwise 400 `INVALID_SIWE_MESSAGE` (**the nonce is not consumed**, so a phishing message
     cannot burn the user's challenge).
   - The nonce in the message exists (otherwise 400 `INVALID_NONCE`) and has not passed its TTL (otherwise
     400 `NONCE_EXPIRED`).
   - `issuedAt` is not in the future and does not exceed the nonce TTL plus a 2-minute clock tolerance;
     `expirationTime` / `notBefore`, if present, must also hold, otherwise 400 `SIWE_EXPIRED` /
     `INVALID_SIWE_MESSAGE`.
   - `recoverMessageAddress({ message, signature })` equals the address **inside the message**, otherwise
     401 `INVALID_SIGNATURE`.
   - On success the nonce is deleted immediately (a replay is 400 `INVALID_NONCE`) and a token with a
     24-hour TTL is issued.
4. Write routes carry `Authorization: Bearer <token>`; the server maps the token back to a wallet address,
   and **the provider is always derived from the session** — a `provider` in the body is ignored.
   Publishing a version for a strategy you do not own is 403 `FORBIDDEN`.

Verification uses `recoverMessageAddress` only (EOA); **EIP-1271 contract wallets are not supported**,
because that requires asking the contract over RPC. Supporting it means wiring viem's `verifySiweMessage`
(with a `publicClient`) to `RPC_URL` — a later round.

Nonces and sessions are a **single-process in-memory Map**: a restart invalidates them, and only one
instance can run. Horizontal scaling requires Redis or another shared store (TODO).

```bash
curl -s localhost:8080/health
# {"status":"ok","service":"cre8-atp-backend","chainId":56,"rpcConfigured":false,"db":"ok","uptimeSeconds":3}

curl -s -X POST localhost:8080/strategies -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "name": "Index 500",
  "description": "BSC bStock index",
  "isPublic": true,
  "swapFeeBps": 25
}'
# {"id":1,"provider":"0x<session wallet, lowercase>",...,"swapFeeBps":25,"createdAt":"..."}

curl -s -X POST localhost:8080/strategies/1/versions -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "allocation": {"assets": [
    {"address": "0x00000000000000000000000000000000000000a1", "symbol": "AAPLB", "weightBps": 6000},
    {"address": "0x00000000000000000000000000000000000000b2", "weightBps": 4000}
  ]},
  "schedule": {"kind": "interval", "intervalSeconds": 86400},
  "changeLog": "initial weights"
}'
# {"strategyId":1,"version":1,"allocation":{...},"schedule":{...},"changeLog":"initial weights","activeAt":"...","createdAt":"..."}
```

`POST /strategies/:id/versions` returns **the version record it created** (`strategyId`, `version`,
`allocation`, `schedule`, `changeLog`, `activeAt`, `createdAt`), not the strategy detail. The version number
is assigned by the backend (`max(version)+1`, retried on the unique key under concurrency). A missing
strategy is 404; a failed allocation or schedule validation is 400.

Listings return `{ items, total, limit, offset }`, where `total` is the number of matching rows, not the
page size.

### Validation rules (aligned with the on-chain `AtpRegistry`)

`POST /strategies`:

- `name` is required, non-empty after trimming, ≤ 120 characters. `provider` is **not** read from the body:
  it is derived from the `Authorization` session (a body value is ignored), with a 200-character cap.
- `description` ≤ 2000 characters, default `""`.
- `isPublic` must be a boolean, default `true`.
- `swapFeeBps` must be an integer in 0–300 (a 3% cap, matching `MAX_SWAP_FEE_BPS`), default 0.

`POST /strategies/:id/versions` (`publishVersion()`):

- The body must be an object; `allocation` and `schedule` are required, `changeLog` and `activeAt`
  optional.
- `allocation` must be `{"assets":[{"address":"0x…","symbol"?:" ≤32 chars","weightBps":2500}]}`.
- 1–16 assets (`MAX_VERSION_ASSETS`); an address must be 0x + 40 hex and is lowercased before storage.
- Assets may not repeat within a version (addresses compared case-insensitively).
- `weightBps` must be an integer in 1–10000, and the sum **must be exactly 10000**.
- `schedule` is `{"kind":"interval","intervalSeconds":>=60}` or `{"kind":"cron","cron":"…"}`.
- `changeLog` optional, ≤ 2000 characters; `activeAt` optional, default `now()`.
- A token is required, and the strategy's DB `provider` must equal the session wallet
  (case-insensitively), otherwise 403 `FORBIDDEN`.

Error codes: `INVALID_ALLOCATION`, `ALLOCATION_EMPTY`, `TOO_MANY_ASSETS`, `INVALID_ASSET`,
`DUPLICATE_ASSET`, `WEIGHT_OUT_OF_RANGE`, `WEIGHT_SUM`, `INVALID_SCHEDULE`, `INVALID_VERSION`,
`INVALID_STRATEGY`, `INVALID_SWAP_FEE`, `INVALID_ID`, `INVALID_QUERY`, `INVALID_JSON`, `NOT_FOUND`,
`METHOD_NOT_ALLOWED`, `PAYLOAD_TOO_LARGE`, `DB_UNAVAILABLE`, `INTERNAL`, `UNAUTHORIZED`, `FORBIDDEN`,
`INVALID_AUTH`, `INVALID_NONCE`, `NONCE_EXPIRED`, `INVALID_SIGNATURE`, `INVALID_SIWE_MESSAGE`,
`SIWE_EXPIRED`, `INVALID_RENEWAL`, `KEY_REF_CONFLICT`, `SESSION_KEY_CONFIG`,
`BUNDLER_METHOD_NOT_ALLOWED`, `BUNDLER_UNAVAILABLE`.

## Portfolios and session-key renewal

Three endpoints, all requiring `Authorization: Bearer <token>`. The principle: **the backend only does
what the frontend cannot** — deriving a new session key (which needs the master seed, and must never reach
a browser). Building, signing and sending the UserOp all happen in the frontend.

### `GET /portfolios`

Every portfolio of the signed-in wallet. It returns only rows for the token's wallet
(`lower(portfolios.user_id) = token wallet`); there is no "whose" parameter, so no query string can be
edited to read someone else's portfolio.

```bash
curl -s localhost:8080/portfolios -H "authorization: Bearer $TOKEN"
```

```json
{ "portfolios": [
  { "id": 3, "userId": "0xabc…", "strategyId": 11, "version": 1, "scheduleState": "active",
    "createdAt": "2026-11-06T00:00:00.000Z",
    "smartAccounts": [ { "chainId": 56, "address": "0xdef…", "owner": "0xabc…", "accountType": "KERNEL" } ],
    "gas": { "address": "0xdef…", "balanceWei": "500000000000000", "minimumWei": "500000000000000",
             "ready": true, "shortfallWei": "0", "estimatedOps": 20, "gasPriceKnown": true },
    "sessionKey": { "permissionId": "0xc0449df6", "sessionKeyAddress": "0x123…",
                    "keyRef": "m/44'/60'/0'/0/787718448", "expiresAt": "2028-01-15T08:00:00.000Z",
                    "status": "active" } }
] }
```

- When `gas` or `sessionKey` cannot be read they are **`null`**, and the request still succeeds: `null`
  means "temporarily unavailable", not "zero balance" or "no key".
- `sessionKey` is the **current** one (`status = 'active'` preferred, then newest expiry).
- Errors: 401 `UNAUTHORIZED`; 503 `DB_UNAVAILABLE`.

### `GET /portfolios/:id/renewal-params`

**Derives a new session key and returns everything the frontend needs to build the UserOp. It does not
sign, does not touch the chain, and does not write the DB.**

```bash
curl -s localhost:8080/portfolios/3/renewal-params -H "authorization: Bearer $TOKEN"
```

```json
{
  "portfolioId": 3,
  "strategyId": 11,
  "chainId": 56,
  "ownerAddress": "0xabc…",
  "accountAddress": "0xdef…",
  "executorAddress": "0x6069…",
  "entryPoint": "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  "kernelVersion": "0.3.3",
  "sessionKeyAddress": "0x123…",
  "keyRef": "m/44'/60'/0'/0/787718449",
  "validUntil": 1825512345,
  "expiresAt": "2027-11-06T00:00:00.000Z",
  "permissionId": "0x9ab4cdef",
  "policySnapshot": { "version": 1, "entryPoint": "0x…", "kernelVersion": "0.3.3", "flag": "0x0000",
                      "call": { "…": "…" }, "gas": { "…": "…" }, "timestamp": { "…": "…" },
                      "permissionId": "0x9ab4cdef", "sessionKeyAddress": "0x123…",
                      "expiresAt": "2027-11-06T00:00:00.000Z" },
  "initConfig": ["0x9198bdf5…", "0xe9ae5c53…"],
  "bundlerUrl": "http://127.0.0.1:3001"
}
```

- `accountAddress` is **the authoritative `smart_accounts.address` from the DB, not a re-derivation**: an
  already-deployed account's address depends on the `initConfig` used at the time, and recomputing lands
  on a different (never deployed) address. See `docs/pitfalls` §4.7.
- `initConfig` is two calldata blobs, both addressed to **the account itself** (inside the account
  `msg.sender == self`).
- `validUntil` is `sessionValidUntil()` = now + 365 days (Unix seconds, uint48); `expiresAt` is the same
  instant in ISO.
- The frontend does not need to decode `policySnapshot`, but **must return it verbatim** to
  `renewal-result`.
- **The new key's index always differs from the existing one**:
  `max(index of every existing key_ref, base) + 1`, where `base = keccak256(owner, strategyId) % 2^31`.
  Calling this endpoint twice within the same second returns the **same** key (the index depends only on DB
  state and `validUntil` is second-granular), so a frontend timeout-and-retry does not get a different key
  to sign the previous op with.
- Errors: 401 `UNAUTHORIZED`; 404 `NOT_FOUND` (no such portfolio, or it has no smart account);
  403 `FORBIDDEN` (not yours); 400 `INVALID_ID`; 500 `SESSION_KEY_CONFIG` (missing `EXECUTOR_ADDRESS` or
  `SESSION_KEY_MASTER_SEED`, and the message says which).

### `POST /portfolios/:id/renewal-result`

The frontend records the landed renewal back into the DB. **The chain is authoritative**, so this does not
verify that the txHash actually landed; it only records.

```bash
curl -s -X POST localhost:8080/portfolios/3/renewal-result \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "txHash": "0x…", "userOpHash": "0x…",
  "permissionId": "0x9ab4cdef", "sessionKeyAddress": "0x123…",
  "keyRef": "m/44'\''/60'\''/0'\''/0/787718449", "validUntil": 1825512345,
  "policySnapshot": { "…": "…" }
}'
# {"ok":true,"recorded":{"keyRef":"m/44'/60'/0'/0/787718449","permissionId":"0x9ab4cdef"}}
# duplicate submission (same keyRef again):
# {"ok":true,"recorded":{"…":"…"},"duplicate":true}
```

It inserts a **new** `session_keys` row (`permissions` = `policySnapshot`, `expires_at` = `validUntil`,
`status = 'active'`) with `insert … on conflict (key_ref) do nothing`:

- **The old row is not touched at all**: the old permission remains valid on-chain until its own
  `expires_at`, and changing its status would make the DB assert something untrue about the chain.
- A duplicate submission is not an error: after `on conflict do nothing` the `returning` is empty, the
  response carries `duplicate: true`, and the row count is unchanged.
- A `keyRef` that already belongs to a **different** portfolio is 409 `KEY_REF_CONFLICT` (that is not a
  duplicate submission but two portfolios fighting over one key).
- Errors: 401 `UNAUTHORIZED`; 404 `NOT_FOUND`; 403 `FORBIDDEN`; 400 `INVALID_RENEWAL` (missing `keyRef` /
  `permissionId`, `validUntil` outside uint48, `policySnapshot` not an object), `INVALID_ID`,
  `INVALID_JSON`.

### What the frontend still lacks after `renewal-params`

Two things, and **both are deliberately frontend-side**: the **sudo signer** for `ownerAddress` (the
backend does not have, and should not have, the user's owner key), and the **gas parameters**
(`maxFeePerGas` / `maxPriorityFeePerGas`, read from the chain). The UserOp's `sender` is
`accountAddress` and its `callData` is built from those two `initConfig` calls — all assembled in the
frontend; the backend does not touch it.

**The transport to the bundler is the backend's `POST /bundler`**, not a direct connection from the
frontend: the `bundlerUrl` in the response is only information about where the backend will call, and the
frontend must not use it to send (see the next section).

## CORS

When a browser calls this API from another origin (the vite dev server at `http://localhost:5173`),
`src/server.ts` answers the preflight:

- Allowed origins come from `CORS_ALLOWED_ORIGINS` (comma-separated **full origins**; unset means the dev
  defaults above).
- `OPTIONS` → `204` with `Access-Control-Allow-Methods` (`GET, POST, OPTIONS`),
  `Access-Control-Allow-Headers` (`authorization, content-type`), `Access-Control-Max-Age` (600),
  `Access-Control-Allow-Origin` (**the concrete origin**) and `Access-Control-Allow-Credentials: true`.
- Every response (including 401 / 404 / 405) carries `Access-Control-Allow-Origin` and `Vary: Origin`: the
  same URL returns different headers per origin, so caches must key on origin.
- **An origin outside the list gets no CORS headers at all** (the browser blocks it), but the request is
  still processed — CORS is a browser rule, not authentication; access is decided by `Authorization`.
- `*` is deliberately unsupported: requests carry `Authorization`, and `*` cannot be combined with
  credentials.

## Bundler relay (`POST /bundler`)

### Why it exists

**alto v1.2.5 has no CORS support at all**: `--help` has no relevant flag, `OPTIONS` returns 404 with no
`access-control-*` headers (v1.2.8 added `enable-cors`, but its SafeValidator is broken against EntryPoint
v0.7). A browser therefore cannot connect to the bundler directly:

```
Access to fetch at 'http://127.0.0.1:3001/' from origin 'http://localhost:5173'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header
```

**This is not a dev-only problem — production is the same.** A browser can never reach the bundler
directly, so the API must relay UserOps. The API already has CORS (previous section), so the frontend needs
only a same-origin (or allowlisted) `/bundler`.

### Contract

```bash
curl -s -X POST localhost:8080/bundler   -H "authorization: Bearer $TOKEN" -H 'content-type: application/json'   -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# {"jsonrpc":"2.0","id":1,"result":"0x38"}
```

- The request body **is** the JSON-RPC envelope (`{jsonrpc, id, method, params}`) and the backend forwards
  the received bytes **verbatim** (no re-serialisation) to `BUNDLER_URL`.
- The response is the **upstream status and raw bytes**, including `result` or `error`. **The JSON-RPC error
  shape is not rewritten** — the frontend needs the original `{code, message, data}` to diagnose AA errors,
  and re-wrapping would throw away the only useful clue.
- `Authorization: Bearer <token>` is required (same order as other write routes: token first, then body).
- Upstream timeout is 30 seconds.

### Method allowlist

Only these six are forwarded; everything else is `403` and **not forwarded at all** (checked before
`fetch`):

```
eth_sendUserOperation   eth_estimateUserOperationGas   eth_getUserOperationReceipt
eth_getUserOperationByHash   eth_supportedEntryPoints   eth_chainId
```

It is an **allowlist, not a denylist**: this relay carries the user's session token, and reaching the
bundler means being able to send UserOps on their behalf. A denylist always misses a method; an allowlist
misses at the cost of a 403.

### Error codes

| Case | status | code |
| --- | --- | --- |
| Missing or wrong token | 401 | `UNAUTHORIZED` |
| Body is not valid JSON, or not an object | 400 | `INVALID_JSON` |
| `method` not in the allowlist, or absent | **403** | `BUNDLER_METHOD_NOT_ALLOWED` |
| Upstream unreachable / timeout | **502** | `BUNDLER_UNAVAILABLE` |

A 502 message includes the upstream address (e.g. `bundler http://127.0.0.1:3001/ unreachable (eth_chainId, timeout 30000ms): …`)
but strips URL userinfo — bundler API keys are often embedded there, and printing it would write the key
into logs and the browser. This path touches no private key and never returns a `0x` + 64 hex digest.

## Migrations

- SQL lives in **`../db/migrations`** (`db/` must be checked out next to `backend/`). The path is resolved
  in `src/db.ts` via `import.meta.url`, so `src/` (tsx) and `dist/` (tsc) point at the same directory.
- They run at startup and via `bun run migrate`: sorted by filename, one transaction per file,
  `schema_migrations` records filename + sha256, already-applied files are skipped, and an applied file
  that changed is an error.
- `pg_advisory_lock` prevents two instances migrating concurrently.
- Do not write `BEGIN`/`COMMIT` inside a file, and do not use `CREATE INDEX CONCURRENTLY`. Details in
  [`../db/README.md`](../db/README.md).
- Two files today: `0001_init.sql` (initial schema) and `0002_normalize_provider.sql` (lowercases existing
  `provider` values and adds the `strategies_provider_lowercase` CHECK, so later inserts and updates can
  only be lowercase).

## Design trade-offs

- **Lazy config and pool**: `getConfig()` and `getPool()` initialise on first use, so tests can import
  `strategies.ts` without `DATABASE_URL`, while startup still fails fast when it is missing.
- **Id conversion**: `bigserial` comes back from `pg` as a string; mappers explicitly `Number()` it (far
  below 2^53), while `numeric` columns stay strings to avoid precision loss.
- **Version numbering**: `max(version)+1` with a `(strategy_id, version)` primary key. Concurrent
  publishing retries on the unique-key conflict (at most 3 times) instead of taking a lock.
- **jsonb rather than extra tables**: allocation and schedule are a snapshot of a version, kept as jsonb;
  the shape is enforced twice, by a DB CHECK and by application validation.
- **Route dependency injection**: `createServer(deps)` takes `Partial<ServerDeps>` (`createStrategy`,
  `publishVersion`), so route tests (201/401/403/404/405) need no DB; production uses the defaults and the
  real implementations.
- **Auth in memory plus SIWE**: nonces and sessions are process-local Maps, the message is standard
  EIP-4361, and verification is `parseSiweMessage` + `recoverMessageAddress`, with no JWT and no session
  table. The win is zero extra infrastructure and auth tests that need no DB; the cost is that a restart
  invalidates every token and the service cannot scale horizontally — fine for a single-instance v1, and a
  shared store is required for multiple instances (TODO).
- **The frontend builds the SIWE message**: `/auth/nonce` returns fields only, and the wallet supplies the
  address. If the backend substituted a sample address the frontend would have to rebuild the message,
  creating a second template that can drift; and `createSiweMessage` is already a public viem API.
- **Not using `verifySiweMessage`**: it needs a `publicClient`/RPC (contract wallets go through ERC-6492),
  and this round does not guarantee `RPC_URL`. EOA + `recoverMessageAddress` is enough for current users;
  contract wallets are on the TODO list.
- **Providers are always lowercase**: `validateCreateStrategyInput` lowercases on write, and the DB adds
  `check (provider = lower(provider))` (0002) as a second gate; query parameters are lowercased before the
  exact comparison, so the index is usable.
- **The provider comes from the session**: `createStrategy(body, provider)` and
  `publishVersion(id, body, provider)` take the provider as a parameter and never trust the body;
  `publishVersion` reads the strategy row and compares the owner before writing, returning 403 on mismatch.

## TODO (hardening)

1. Contract wallets (EIP-1271 / ERC-6492): only EOA `recoverMessageAddress` works today; once `RPC_URL` is
   wired, switch to viem's `verifySiweMessage` so a smart account can sign in too.
2. A shared store for sessions and nonces: the in-memory Map only supports one instance; Redis (or
   Postgres) is needed before scaling, along with TTL and concurrency handling.
3. CORS hardening, rate limiting, request ids (the `correlation_id` column already exists), and protections
   beyond body size.
4. Should `GET /strategies/:id` expose private strategies? It does today; with auth in place, visibility
   could be narrowed on that basis.
5. Read/write APIs for operations, positions and performance (the schema is ready; no code yet).
6. Add `details` to error responses (which asset failed) so the web app can show it.
7. Describe the API with OpenAPI; today this README is the only contract.
8. A composite FK for `portfolios.version` (see the known gap in `db/README.md`).
