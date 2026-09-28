# pi-audit-gap

> Goal-coverage supervision for [`pi.dev`](https://pi.dev) — pairs with [`pi-goal-x`](https://github.com/bramburn/pi-goal-x) to catch the failure mode compile-streak supervision can't: a worker that spends hours happily building **60 % of the requirements**.

`pi-harvest` supervises *execution* (compiler-failure loops). `pi-audit-gap` supervises *coverage* (requirement blindness). It reads pi-goal-x's goal ledger, generates a machine-checkable **Definition-of-Done checklist** per goal with a sparse high-level auditor, verifies items with a cheap model, and injects `[STEER:*]` Tier-3 messages **before** the goal is archived — gaps become continuation work, not a post-mortem.

## Why a separate extension (not a pi-goal-x fork)

pi-goal-x owns goal *state*; this extension owns *audit and intervention*. The integration surface is pi-goal-x's durable append-only ledger, `.pi/goals/goal_events.jsonl` — consumed with a byte-offset diff, never deep-imported. If pi-goal-x changes, only the ledger adapter is affected.

## How it works

```
turn_end ──▶ poll goal_events.jsonl (byte-offset diff, O(new events))
          ──▶ backfill missed goal_created from .pi/goals/active_goal_*.md
          ──▶ TriggerPolicy.evaluate()
                ├─ goal_created            ──▶ SPEC audit (Opus lane) ──▶ dod.json
                ├─ completion_requested    ──▶ GAP audit (Opus lane) ──▶ [STEER:OPUS] before archival
                └─ every N turns + plateau ──▶ COVER checks (DeepSeek lane, budget-bounded)
          ──▶ fire-and-forget lane calls; failures notify, never crash
```

- **dod.json is the source of truth** for coverage state, stored at `.pi/audit-gap/<goalId>/dod.json`. Chat steers only *point at* it — a weak worker model must not be able to self-report progress into the supervision record.
- **`completion_requested` is the interception point.** pi-goal-x defers archival to `turn_end`, so a steer injected on `completion_requested` still lands while the goal is active.
- **Plateau escalation**: if the verified-item count is stuck across `AUDITGAP_PLATEAU_SWEEPS` sweeps while items remain open, the policy escalates from the cheap lane back to the spec lane — a deterministic stalemate detector, no LLM involved.
- **Payload assembly is fully local** (no LLM routing): `git ls-files` inventory, route-ish file extraction, recent commits, `git diff --stat` — clamped to 64 KB. The strong model does the intelligent part on the receiving end.

## Configuration

Copy `.env.example` and set the lane credentials (or export in your shell / pi launch config).

| Variable | Lane | Required | Notes |
|----------|------|----------|-------|
| `AUDITGAP_SPEC_BASE_URL` / `AUDITGAP_SPEC_API_KEY` / `AUDITGAP_SPEC_MODEL` | spec (Opus) | yes* | *falls back to pi-harvest's `VERIFIER_*` |
| `AUDITGAP_COVER_BASE_URL` / `AUDITGAP_COVER_API_KEY` / `AUDITGAP_COVER_MODEL` | cover (DeepSeek) | yes | cheap, high-volume verifier |
| `AUDITGAP_SPEC_PROVIDER` / `AUDITGAP_COVER_PROVIDER` | steer tag | no | default `OPUS` / `DS` → `[STEER:OPUS]`, `[STEER:DS]` |
| `AUDITGAP_TURN_INTERVAL` | trigger | no | default `30` turns between coverage sweeps |
| `AUDITGAP_COVER_MAX_CALLS` | budget | no | default `5` cover calls per sweep |
| `AUDITGAP_PLATEAU_SWEEPS` | trigger | no | default `2` stuck sweeps before spec-lane escalation |
| `AUDITGAP_SPEC_TIMEOUT_MS` / `AUDITGAP_COVER_TIMEOUT_MS` | http | no | defaults `600000` / `120000` |
| `AUDITGAP_MAX_RETRIES` | http | no | default `2`, backoff 1 s → 2 s on 429/5xx/timeout |

## Slash commands

All under the single `auditgap` namespace:

- `/auditgap status` — turn counter, ledger offset, goal/checklist summary, lane config, last error.
- `/auditgap spec <goalId>` — manually request a spec audit (DoD checklist generation).
- `/auditgap audit <goalId>` — manually request a gap audit against the checklist.
- `/auditgap dod <goalId>` — print the checklist with per-item status.

## TUI widget

```
[AuditGap] Turn: 64 | Goals: 1 | SpecCalls: 3 | CoverCalls: 10 | GapSteers: 2
```

## Installation

```bash
# From a local checkout
pi install C:\dev\pi-audit-gap -l --approve
```

Requires [`pi-goal-x`](https://github.com/bramburn/pi-goal-x) to be installed — its goal ledger is the trigger source. Composes alongside `pi-harvest` (steer tags keep supervision tiers distinguishable for downstream DPO slicing).

## Development

```bash
npm install
npm test   # 36 unit tests across ledger/dod/trigger/steer+assemble
npm run build  # tsc → dist/
```

## License

MIT
