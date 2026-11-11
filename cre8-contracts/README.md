# cre8-contracts

The CRE8 smart contracts. A standalone project, migrated from the
pooled-vault architecture in `bnb-agent-vaults`: one non-custodial smart account per user, with the
platform only executing and distributing a "weights + schedule" mandate.

## Scope (v1)

- First strategy type: **equity index funds** (target weights + scheduled/drift rebalancing + swaps),
  with BSC bStock tokens (ERC-20) as the underlying.
- Venue: PancakeSwap (Universal Router).
- Fees: pool fee (inside the swap) + swap fee (on the output side, admin-only). Infrastructure fees and
  subscriptions via x402 are deferred.

## Contracts

| File | Description |
| --- | --- |
| `src/atp/AtpRegistry.sol` | Strategy versions (weights + schedule), `swapFeeBps` (admin-only), enrollment |
| `src/atp/AtpExecutor.sol` | The only contract that moves money: `executeRebalance` validates the chain, the command allowlist, and splits the fee |
| `src/atp/interfaces/IOracleFloor.sol` | Oracle floor interface (`previewSwap`) |
| `src/atp/interfaces/IUniversalRouter.sol` | PancakeSwap Universal Router interface and command constants |

## Core invariant

`minGross = ceil(oracleFloor / (1 - swapFeeBps/10000))` — the fee is folded back into the minimum
output so that, after the fee is taken, the user still receives at least the oracle floor. See
`../docs/atp-pivot-executor-spec.md`.

## Toolchain

Foundry 0.8.37 (via_ir, optimizer 200, Cancun), OpenZeppelin 5.4.0 (vendored).

```
forge build
forge test
```

## Upstream dependency versions

- OpenZeppelin Contracts 5.4.0 (`lib/openzeppelin-contracts`, copied from `bnb-agent-vaults` and pinned)
- forge-std (`lib/forge-std`)
