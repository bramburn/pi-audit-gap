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
          │     ├─ goal_created            ──▶ SPEC audit (Opus lane) ──▶ dod.json
          │     ├─ completion_requested    ──▶ GAP audit (Opus lane) ──▶ [STEER:OPUS] before archival
          │     └─ every N turns + plateau ──▶ COVER checks (DeepSeek lane, budget-bounded)
          ──▶ batch monitor (when AUDITGAP_SPEC_BATCH=1): submit queued audits as ONE
          │    Anthropic Messages Batch, poll status every few turns, route completions
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
| `AUDITGAP_SPEC_API` | spec | no | `anthropic` (native, **required for batch**) or `openai` (OpenRouter/LiteLLM/proxies). Default `openai` |
| `AUDITGAP_SPEC_BATCH` | spec | no | `1` = route spec work through the Anthropic Messages Batches API (50% off, minutes-to-hours latency) |
| `AUDITGAP_SPEC_BASE_URL` / `AUDITGAP_SPEC_API_KEY` / `AUDITGAP_SPEC_MODEL` | spec | yes* | *falls back to pi-harvest's `VERIFIER_*`. For Anthropic: `https://api.anthropic.com/v1` + `sk-ant-...` |
| `AUDITGAP_SPEC_MAX_TOKENS` | spec | no | default `8192` (Anthropic requires `max_tokens`) |
| `AUDITGAP_COVER_BASE_URL` / `AUDITGAP_COVER_API_KEY` / `AUDITGAP_COVER_MODEL` | cover | yes | **always OpenAI-compatible**. DeepSeek direct (`https://api.deepseek.com/v1`) or OpenRouter (`https://openrouter.ai/api/v1` + any model id, e.g. `deepseek/deepseek-chat`) |
| `AUDITGAP_SPEC_PROVIDER` / `AUDITGAP_COVER_PROVIDER` | steer tag | no | default `OPUS` / `DS` → `[STEER:OPUS]`, `[STEER:DS]` |
| `AUDITGAP_BATCH_POLL_EVERY_TURNS` / `AUDITGAP_BATCH_POLL_MIN_SECS` | batch | no | defaults `5` turns / `60` s between batch status polls |
| `AUDITGAP_TURN_INTERVAL` | trigger | no | default `30` turns between coverage sweeps |
| `AUDITGAP_COVER_MAX_CALLS` | budget | no | default `5` cover calls per sweep |
| `AUDITGAP_PLATEAU_SWEEPS` | trigger | no | default `2` stuck sweeps before spec-lane escalation |
| `AUDITGAP_SPEC_TIMEOUT_MS` / `AUDITGAP_COVER_TIMEOUT_MS` | http | no | defaults `600000` / `120000` |
| `AUDITGAP_MAX_RETRIES` | http | no | default `2`, backoff 1 s → 2 s on 429/5xx/timeout |

### Anthropic batch mode

With `AUDITGAP_SPEC_API=anthropic` + `AUDITGAP_SPEC_BATCH=1`, spec-lane audits are spooled durably to `.pi/audit-gap/queue/<job>.json`, grouped into **one** `POST /v1/messages/batches` submission, and polled (`GET /v1/messages/batches/{id}` → signed results URL) every few turns. Completed results feed the same handlers as direct calls — `dod.json` updates and `[STEER:OPUS]` injection happen whenever the batch lands. Terminal jobs archive to `queue/done/`. Manual `/auditgap spec|audit` always uses the direct lane because a human is waiting, and gap audits at `completion_requested` stay latency-critical — batch steers there can arrive after pi-goal-x has archived the goal.

## Relationship to pi-harvest (no duplication)

| | pi-harvest | pi-audit-gap cover lane |
|---|---|---|
| Supervises | **execution** — compile-failure loops | **coverage** — DoD checklist adherence |
| Trigger | compiler signature streak ≥ 3, thrashing | turn-interval sweep, plateau |
| Payload | Neat Slice of the failing conversation | goal + one checklist item + repo inventory |
| Output | DPO/SFT training pairs + splice/rewind | dod.json status + occasional steer |
| Steer tag | `[STEER:K3]` | `[STEER:DS]` |

They share only the steer-injection mechanism and (optionally) env credentials — disjoint triggers, payloads, and artifacts.

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
npm test   # 46 unit tests across ledger/dod/trigger/steer/batch
npm run build  # tsc → dist/
```

## License

MIT
