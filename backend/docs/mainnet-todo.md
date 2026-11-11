# Pre-mainnet checklist (2026-11)

Ordered by "what bites us first". Status: `[x]` done, `[ ]` not done.

## 1. Scheduler supervisor `[x]`

- `scheduler_status` table (migration 0018): every round writes a heartbeat (`started_at` /
  `last_finished_at` / `rounds` / `dry_run` / `limit` / `threshold` / `last_summary` / `last_error` / `pid`)
- `/operator/overview` returns `scheduler`; `/operator` shows alive / dry-run / LIVE / last-round counters
- **Why not derive this from `portfolios.last_checked_at`**: when no portfolio is due, that timestamp is
  old and looks like a dead scheduler — and "it died" and "there was nothing to do" need different responses
- Runs on Railway as its own service: `bun run scripts/scheduler.ts --loop --live --interval 60 --limit 20`;
  Railway restarts it on exit (`restartPolicyType: ON_FAILURE`)

## 2. Move secrets out `[ ]`

- `OPERATOR_PRIVATE_KEY`, `SESSION_KEY_MASTER_SEED`, `DATABASE_URL` currently live in `backend/.env`
- On Railway they are set as Variables (the equivalent of a secret manager); `.env` is not committed
  (already in `.gitignore`)
- Outstanding: a **seed rotation procedure** (changing the seed invalidates every session key and needs
  a full renewal sweep)

## 3. Alert delivery `[ ]` (deferred by the owner)

- Today there is only the `scheduler_alerts` table, `GET /health` and an `--alerts` CLI
- No email / Slack / pager. At minimum a critical needs an outbound notification, or nobody will look

## 4. Registry owner → multisig / timelock `[ ]` — deferred until mainnet testing finishes

- `AtpRegistry` owner is a single EOA today (the deployer `0x70fc55f8…7c60c`)
- At the contract level the owner can `setFee`, `registerStrategy` and `pause`

### Decision (2026-11, made by the owner)

**Keep the single EOA for now and move to a Safe once mainnet testing is complete.** Rationale:

* Settings change often during testing (fee, strategy registration, pause); routing each through a
  multisig would slow iteration down
* Moving back is painful, and there is no real user money yet
* The key currently exists only in `backend/.env.mainnet` (chmod 600, gitignored), so the risk is bounded

### Three things to remember before the transfer

1. **The emergency `setPaused` path has to stay usable after the transfer** — if the Safe threshold is
   too high (3-of-5 with only 2 signers online), you cannot stop the protocol when it matters.
   Emergency pause should be a low threshold (1-of-2 or 2-of-3); routine settings changes are the ones
   that deserve a high threshold.
2. Confirm `OPERATOR_PRIVATE_KEY` (the deployer) no longer needs any owner permission first, otherwise
   you get a silent failure: "the contract is owned by the Safe, but some script still assumes the EOA".
3. Run `preflight --strict` afterwards — it checks the registry owner and warns on a single EOA under
   `--strict`. That warning should disappear once the transfer is done. That check exists for this.

### Why this cannot be forgotten

A single-EOA owner means "one private key controls the whole protocol". That is acceptable today only
because **there is no real user money** and we are testing intensively. The moment this goes public, it
is the top risk on the list.

## 5. Real BSC deployment verification + first small real-money round `[ ]`

- `DeployAtp.s.sol` has been exercised repeatedly on a fork; on mainnet we still need to confirm the
  pool fee tiers, Permit2 and Universal Router addresses
- Run the minimum amount (e.g. 20 USDT) through deposit → rebalance → withdraw and reconcile gas

## 9. `V2_SWAP_EXACT_IN` needs an extra approval layer in the executor `[ ]`

| Item | Value |
|---|---|
| State | `ROUTE_V2_ENABLED` is **off** by default (V3 only) |
| Actual cause | **Not** "the router does not support this command" — see the correction below |

### Correction: my earlier conclusion was wrong

I originally concluded that Pancake's Universal Router does not implement `V2_SWAP_EXACT_IN`.
Direct measurement overturned it:

    ① send command 0x08 with empty input
       → revert 0x3b99b53d (SliceOutOfBounds, calldata parsing failed)
       an unrecognised command would return 0xd76a1e9e (InvalidCommandType)

    ② send command 0x08 with well-formed input (USDT→DOGE, payerIsUser=true)
       → revert 0xd81b2f2e (Permit2's AllowanceExpired(0))

② is decisive: the router **does** recognise the command, and it routes the V2 funding leg through
**Permit2** as well. What is wrong is *who is approved* — that call had no approval at all, so it
stopped at Permit2's allowance check.

### So why did our executor revert

The executor's `_swap` only does these two things:

    tokenIn.forceApprove(address(permit2), step.amountIn);
    permit2.approve(step.tokenIn, address(universalRouter), uint160(step.amountIn), deadline);

Those prepare the **V3 leg**. The V2 payer leg needs a different approval (the V2 payer is not
Permit2's spender — which address it is needs one real call made with approvals in place). So
`payerIsUser=true` reverts on V2 because the approval is wrong — and the EntryPoint simulation only
returned a bare `0x`.

### What enabling V2 requires

1. Take an address that **holds USDT and already has every plausible approval**, send a real V2 command
   to the Universal Router, and see which layer reverts (Permit2? the V2 router's ERC20 allowance?).
   Only this tells you who else needs approval.
2. Change `AtpExecutor._swap` accordingly (a contract change) → redeploy the executor.
3. Cost of redeployment: **every user must re-approve and reinstall their session key (one signature each)**.

### Conclusion

V2 buys 1.3% (on that 0.5 USDT DOGE trade) and costs a migration for every user.
**Stay V3-only for now**; do the contract change once "many assets" genuinely needs V2 depth.

### The lesson that still stands

"An allowlist permits a command" only means our contract will not block it. To confirm the downstream
can execute it you must send **one real call with the correct approvals** — a quoter returning a number
tells you nothing about that.
