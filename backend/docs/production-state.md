# Production state (mainnet)

> Last updated: 2026-11-09

## Live

| Component | Location | Status |
|---|---|---|
| **AtpRegistry** | `0xf429929c9fc89446c08fd4c201543b40d7d3d67a` | Mainnet, bytecode present |
| **AtpExecutor** | `0x547764c2a6f789986f0f3e532c115ffc7e3ac9e7` | Mainnet, bytecode present |
| **AtpMultiPoolOracle** | `0x6a31f0c5180e5d25accf5775da98e2404a46d869` | Mainnet |
| Oracle WBNB/USDT | `0x7c7df82b4c27251db247af363f99e595d42a8d78` | Mainnet |
| Oracle NVDAB/USDT | `0xebf5a243e79436b49dcfb8092968b161e323d873` | Mainnet |
| **api service** | `https://api-production-7f13.up.railway.app` | Railway, SUCCESS |
| **alto bundler** | `https://alto-production-c309.up.railway.app` | Railway, SUCCESS (v1.2.5 + safe-mode) |
| **scheduler** | Railway internal (no public domain) | SUCCESS, **dry-run**, one round every 60s |
| **Postgres** | Railway (private network) | SUCCESS, 18 migrations |

Measured health check:

```json
{"status":"ok","service":"cre8-atp-backend","chainId":56,"rpcConfigured":true,
 "db":"ok","alerts":{"critical":0,"warn":0,"open":0}}
```

Deployer: `0x70fc55f8BF3BE3E599566417A1a58c9bf6a7c60c` (a fresh wallet, not an anvil test account)
Deployment cost: 0.000299 BNB across 7 transactions

Measured bundler response:

    eth_supportedEntryPoints → ["0x0000000071727De22E5E9d8BAf0edAc6f37da032"]
    eth_chainId              → 0x38 (56)

## Not done yet

| # | Item | Blocker |
|---|---|---|
| 1 | ~~alto bundler~~ | ✅ done |
| 2 | ~~scheduler service~~ | ✅ deployed, **dry-run**; needs `SCHEDULER_LIVE=1` to actually send |
| 3 | Frontend deployment | `VITE_CHAIN_ID=56` + `VITE_RPC_URL` + `VITE_API_BASE` |
| 4 | First real-money round | waits on 1–3 |
| 5 | registry owner → Safe | owner's call: move after testing (see todo §4) |
| 6 | alert delivery | TODO §3 |
| 7 | **alto shares the deployer key** | `EXECUTOR_PRIVATE_KEY` is currently the deployer key. Before launch these must be split: the alto hot wallet should hold only a small BNB balance |

## Deployment lessons worth keeping

* `railway up` uploads the *linked project root*, not the CWD → use `railway up .deploy --path-as-root`
* `railway up` targets the **linked service** by default → `railway add --service api` first, then name it
* The sandbox cannot write `~/.railway` → `HOME=<workspace> railway ...`
* publicnode requires a token for archive queries: `forge` got a 403 while verifying receipts, even though
  the transactions succeeded

## One image, two roles

`SERVICE_ROLE` decides what starts (`docker-entrypoint.sh`):

| Service | SERVICE_ROLE | Starts |
|---|---|---|
| api | `api` (default) | `bun src/index.ts` |
| scheduler | `scheduler` | `bun run scripts/scheduler.ts --loop --interval $SCHEDULER_INTERVAL …` |

**`--live` must be enabled explicitly with `SCHEDULER_LIVE=1`.** Without it the scheduler only observes.
The cost of "forgot to set a variable at deploy time" should be "it does not move money", never "it
moved money".

Verification (local docker):

    SERVICE_ROLE=api        → [entrypoint] role=api port=8081
    SERVICE_ROLE=scheduler  → [entrypoint] role=scheduler interval=60s dry-run
    SERVICE_ROLE=bogus      → explicit error, exit 1 (no silent fallback to api)

Measured in production: rounds 1/2/3 at 60-second intervals, no errors, `claimed 0 portfolios`
(there were no portfolios yet).

## Next steps

1. Frontend deployment (`VITE_CHAIN_ID=56` + API base)
2. First real money: the deployer creates a portfolio and deposits a small USDT amount
3. Confirm the scheduler can really send its first round under `--live`
