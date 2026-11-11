# CRE8 ATP documentation

CRE8 moved from a pooled vault to **ATP (Automated Token Portfolio)**: one non-custodial smart
account per user, with the architecture modelled on Glider. The first release covers equity index
funds only — target weights plus a rebalance schedule, with bStock tokens on BSC as the underlying.

---

## Where to start

**New to this project → read in this order:**

1. [HANDOFF.md](./HANDOFF.md) — current state, what is done, what to do next
2. [pitfalls.zh-TW.md](./pitfalls.zh-TW.md) — the traps we already hit. **This one saves you the most time**
3. [decisions.zh-TW.md](./decisions.zh-TW.md) — why things are built this way, including decisions that were overturned
4. [runbook.zh-TW.md](./runbook.zh-TW.md) — how to start it, how to verify, how to debug

**Before you change anything**: read the "diagnostic discipline" appendix in `pitfalls`. This project
has many cases where the error message points at the wrong thing.

---

## Documentation map

### Living documents (kept up to date)

| Document | Content | When to read |
|---|---|---|
| [HANDOFF.md](./HANDOFF.md) | Current state, open items, next decision points | Every handover, end of every milestone |
| [pitfalls.zh-TW.md](./pitfalls.zh-TW.md) | Traps actually hit: symptom → cause → fix | **First stop when something behaves oddly** |
| [decisions.zh-TW.md](./decisions.zh-TW.md) | Decision log: options, choice, rationale, risk, owner | Before an architectural change, or when questioning a design |
| [runbook.zh-TW.md](./runbook.zh-TW.md) | Environment startup, verification commands, troubleshooting table | Whenever you need to run something |

### Historical design documents (kept verbatim, not revised)

| Document | Content |
|---|---|
| [atp-pivot-plan.zh-TW.md](./atp-pivot-plan.zh-TW.md) | Migration plan: five layers, retire/reuse/build, phased schedule |
| [atp-pivot-executor-spec.zh-TW.md](./atp-pivot-executor-spec.zh-TW.md) | Executor skeleton spec: Registry/Executor interfaces, minGross derivation, command allowlist |

Both were written on 2026-11-06 and **have not been revised**. Where they conflict with the current
system, `HANDOFF.md` and `decisions.md` win.

### Archive

| Path | Content | Why it is kept |
|---|---|---|
| [archive/handoff-2026-11-06.zh-TW.md](./archive/handoff-2026-11-06.zh-TW.md) | The handover document as of 2026-11-06 | It records the state and known traps of that moment. **Superseded by the current HANDOFF** |
| [archive/legacy-vault/](./archive/legacy-vault/) | The old pooled vault architecture: `VAULT_RULES_V2`, `ARCHITECTURE`, `strategy-v3` product decisions, old index | **Abandoned architecture — not a reference for current behaviour.** Kept to explain *why* we migrated |

---

> **Translation status**: the index and the operational documents are in English.
> `HANDOFF`, `pitfalls`, `decisions`, `runbook` and the two pivot documents are still in Chinese and keep
> their `.zh-TW.md` suffix until they are translated; links above point at the current files.

## How this documentation is maintained

1. **`pitfalls` records only traps we actually hit**, never "this might be a problem". Every entry
   needs symptom → cause → fix.
2. **`decisions` is append-only; entries are never rewritten.** When a decision is overturned, mark the
   original `⚠ superseded by D-xx` and keep it — **an overturned decision is more valuable than a
   correct one**, because it records which line of reasoning does not work.
3. **Historical documents are preserved verbatim**, with a header noting their status and what replaced
   them. Their body is not edited.
4. **Numbers must be verifiable.** Any "N tests pass" or "the address is 0x…" should come from something
   actually run or looked up, not from memory.

---

## Related locations

| Location | Description |
|---|---|
| `../backend/README.md` | Backend in full (API, validation rules, env, runbook) |
| `../db/README.md` | Schema overview and JSON shapes |
| `../cre8-contracts/src/atp/*.sol` | Contract implementation (final authority) |
| `../cre8-contracts/deployments/mainnet.json` | Mainnet deployment record (authority) |
| `../cre8-contracts/deployments/fork.json` | Fork deployment record |

The three sub-projects each have their own git root (`cre8-contracts/`, `backend/`, `db/`); the
`cre8-protocol/` directory itself is **not** a git repository. In this consolidated repository they
are directories of one repository.
