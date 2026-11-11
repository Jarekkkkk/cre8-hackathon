# Deploying to Railway (server + DB + scheduler)

## Why three services

| Service | Start command | Why it cannot be merged |
|---|---|---|
| **api** | `bun src/index.ts` | Must stay resident, be public, and answer health checks |
| **scheduler** | `bun run scripts/scheduler.ts --loop --live --interval 60 --limit 20` | **Must be its own process**: one round holds the process for 40–80 seconds, which would slow request handling; and it has to be restartable on its own |
| **db** | Railway Postgres | `DATABASE_URL` is injected by the platform |

> ⚠ `--live` on the scheduler is the switch that actually sends transactions. Do **not** add it on first
> deploy: run `--loop` (dry-run) first, watch one round's counters (`last round` on `/operator`), and only
> add `--live` once `claimed/executed` look right.

## Environment variables (both api and scheduler)

```
DATABASE_URL=            # injected by Railway
CHAIN_ID=56              # mainnet; a local fork is 1337
RPC_URL=                 # BSC RPC (prefer a paid/archive provider)
BUNDLER_URL=             # alto or a third-party bundler
REGISTRY_ADDRESS=
EXECUTOR_ADDRESS=
OPERATOR_PRIVATE_KEY=    # ← secret
SESSION_KEY_MASTER_SEED= # ← secret
AUTH_DOMAIN=             # SIWE domain
AUTH_URI=                # SIWE uri
ENABLE_OPERATOR_REBALANCE=true
```

**Secrets belong in Railway Variables (its secret manager), never in the repo.**
`.env` is already in `.gitignore`; so is `backend/.env.fork`.

## Where to read the scheduler's health

The `scheduler` row on `/operator`:

```
scheduler   [alive] · LIVE · every 60s · limit 20 · threshold 100 bps · round 137 · pid 1
last round  claimed 3  executed 2  noop 1  blocked 0  failed 0   · finished 42s ago
```

A heartbeat older than **180 seconds** (`HEARTBEAT_STALE_SECONDS`) renders as `stale` — that means the
process died or is stuck, and Railway's `restartPolicyType: ON_FAILURE` will restart it.

## ⚠ `railway up` uploads the *linked project root*, not the current directory

This cost a long time to find: running `railway up` inside `.deploy/` uploaded `backend/` instead (the
root that `railway link` recorded), so the image **never contained the migrations** and the container
failed at startup with:

    ENOENT: no such file or directory, scandir '/app/migrations'

A local `docker build` worked perfectly, which makes this easy to misdiagnose as a Dockerfile problem.

The correct invocation (`--path-as-root` makes PATH the archive root):

```bash
bun run scripts/prepare-deploy.ts                      # build .deploy/ (includes migrations)
railway up .deploy --path-as-root -d --service api     # all three flags matter
```

Other traps, recorded here while they are fresh:

| Symptom | Cause |
|---|---|
| Deployed into the Postgres service and destroyed the database | `railway up` targets the **linked service** by default; after creating Postgres it was the only service. **`railway add --service api` first, then `--service api`** |
| The upload was filtered down to nothing | `.gitignore` participates in upload filtering; a `.deploy/.gitignore` containing a `.deploy/` rule excludes the whole directory → use `--no-gitignore`, and have `prepare-deploy` skip copying `.gitignore` |
| `railway` keeps saying `Failed to set permissions on ~/.railway` | The sandbox cannot write the home directory → `HOME=<writable dir> railway ...` |
| `postgres.railway.internal` fails to resolve locally | Railway's private network only resolves inside the platform; migrations must run **in the container**, not as a local step |

## ⚠ Migrations do not run inside the container

`db/migrations` lives in a **sibling repository** (`cre8-protocol/db`), while the Docker / Railway build
context is only `backend/` — those `.sql` files are not in the image. Therefore:

* The `Dockerfile` sets `MIGRATIONS_ENABLED=0`
* Migrations are a **deployment step**, run with Railway's `DATABASE_URL`:

```bash
railway run bun run src/migrate.ts      # runs with the service's env, no connection string on screen
# or
DATABASE_URL=<railway-postgres-url> bun run src/migrate.ts
```

`railway run` is preferable: it injects the service's environment into a local command, so the connection
string never passes through shell history.

## First-deploy order

1. Create Postgres → note `DATABASE_URL`
2. **Run migrations first**: `railway run bun run src/migrate.ts` (it can run before the image is
   deployed; migrations only need the database)
3. Deploy **api** → `/health` should return `status: ok`
4. Deploy **scheduler** without `--live`, and confirm `last round` on `/operator` shows numbers
5. Add `--live` once that looks right, then watch the first round's `executed`

## Run this before and after every deploy

```bash
MIGRATIONS_ENABLED=0 railway run bun run scripts/preflight.ts --strict
```

`--strict` treats any warning as a failure (mainnet does not accept "known but ignored"). It checks that
the RPC's chain id matches `CHAIN_ID`, that the contract addresses actually have code, that the registry
owner is not a single EOA, that `executor.oracle` is not the zero address, and how many DB migrations
have been applied.
