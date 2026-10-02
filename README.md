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
          │    batch (Anthropic Messages Batches API or OpenRouter Batch API),
          │    poll status every few turns, route completions
          ──▶ fire-and-forget lane calls; failures notify, never crash
```

- **dod.json is the source of truth** for coverage state, stored at `.pi/audit-gap/<goalId>/dod.json`. Chat steers only *point at* it — a weak worker model must not be able to self-report progress into the supervision record.
- **`completion_requested` is the interception point.** pi-goal-x defers archival to `turn_end`, so a steer injected on `completion_requested` still lands while the goal is active.
- **Plateau escalation**: if the verified-item count is stuck across `AUDITGAP_PLATEAU_SWEEPS` sweeps while items remain open, the policy escalates from the cheap lane back to the spec lane — a deterministic stalemate detector, no LLM involved.
- **Payload assembly is fully local** (no LLM routing): `git ls-files` inventory, route-ish file extraction, recent commits, `git diff --stat` — clamped to 64 KB. The strong model does the intelligent part on the receiving end.

## Configuration

### Picking models interactively (no env vars needed)

Run `/auditgap-settings` to open the settings menu and choose **Select spec model**, **Select steer model**, **Select batch runner model**, or **Select cover model**. Each entry opens the same typeahead-searchable model list as pi's built-in `/model` selector (fuzzy filter across provider, model id, and name), built from pi's own catalogue — every provider and model you already configured via `/login` or `models.json`. After a pick the menu reopens, so several lanes can be configured in one pass; choose **Done** (or press Esc) to exit.

The four lanes:

- **spec** (Opus lane): requirement elicitation at `goal_created` — the DoD checklist generator.
- **steer** (gap-audit lane): the model that audits coverage at `completion_requested` / plateau and authors the `[STEER:*]` gap messages. Optional — with no pick, gap audits keep riding the **spec** model.
- **batch runner**: the model batch-queued audits are submitted as when `AUDITGAP_SPEC_BATCH=1`. Optional — with no pick, batch jobs use the **spec** model. The picker only lists batch-capable models: native Anthropic-API models and anything served from an `openrouter.ai` base (OpenRouter Batch API), so e.g. `claude-opus-5-5` direct or `moonshot/kimi-k3` via OpenRouter.
- **cover** (cheap lane): per-item pass/fail verification sweeps.

The pick is stored per project in `.pi/audit-gap/settings.json` as `{ provider, modelId }` (no secrets — API keys and base URLs are resolved through pi's ModelRegistry at apply time) and translated into the lane env vars below. A stored selection overrides env for its lane; `/auditgap-settings clear [spec|steer|batch|cover]` removes it and restores your env config. Transport is derived from the model: `anthropic-messages` APIs drive the native Anthropic transport; everything else uses the OpenAI-compatible chat/completions lane. Batch mode stays enabled for Anthropic picks and for OpenAI-compatible picks on an `openrouter.ai` base (the queue dispatches to OpenRouter's Batch API); it is force-disabled only for OpenAI-compatible spec picks on other bases, where no batch API exists.

Outside the TUI (RPC/JSON/print modes) the picker falls back to pi's flat `select` dialog.

### Environment variables

Copy `.env.example` and set the lane credentials (or export in your shell / pi launch config). Only needed for lanes without a stored `/auditgap-settings` selection.

| Variable | Lane | Required | Notes |
|----------|------|----------|-------|
| `AUDITGAP_SPEC_API` | spec | no | `anthropic` (native) or `openai` (OpenRouter/LiteLLM/proxies). Default `openai`. Drives the **direct** lane |
| `AUDITGAP_SPEC_BATCH` | spec | no | `1` = route spec work through a batch API (~50% off, minutes-to-hours latency) |
| `AUDITGAP_SPEC_BATCH_API` | batch | no | `anthropic` (native Messages Batches API, direct Anthropic bases) or `openrouter` (OpenRouter Batch API). **Default: derived** — `openrouter.ai` in `AUDITGAP_SPEC_BASE_URL` → `openrouter`, otherwise `anthropic` |
| `AUDITGAP_SPEC_BASE_URL` / `AUDITGAP_SPEC_API_KEY` / `AUDITGAP_SPEC_MODEL` | spec | yes* | *falls back to pi-harvest's `VERIFIER_*`. For Anthropic: `https://api.anthropic.com/v1` + `sk-ant-...` |
| `AUDITGAP_SPEC_MAX_TOKENS` | spec | no | default `8192` (Anthropic requires `max_tokens`) |
| `AUDITGAP_STEER_BASE_URL` / `AUDITGAP_STEER_API_KEY` / `AUDITGAP_STEER_MODEL` | steer | no | gap-audit / `[STEER:*]` lane. **Every var falls back to the spec lane's**, so gap audits ride the spec model unless you pick (or set) a steer model |
| `AUDITGAP_STEER_API` | steer | no | `anthropic` or `openai`; default: the spec lane's transport |
| `AUDITGAP_STEER_PROVIDER` | steer tag | no | `[STEER:*]` provider tag; default: the spec provider tag (`OPUS`) |
| `AUDITGAP_BATCH_BASE_URL` / `AUDITGAP_BATCH_API_KEY` / `AUDITGAP_BATCH_MODEL` | batch | no | batch-runner credentials. **Every var falls back to the spec lane's**; only batch-capable endpoints make sense (Anthropic direct or `openrouter.ai`) |
| `AUDITGAP_BATCH_API` | batch | no | `anthropic` or `openrouter`; set automatically by a batch-lane pick, derived from the base URL otherwise |
| `AUDITGAP_BATCH_MAX_TOKENS` | batch | no | default: the spec lane's `AUDITGAP_SPEC_MAX_TOKENS` (`8192`) |
| `AUDITGAP_COVER_BASE_URL` / `AUDITGAP_COVER_API_KEY` / `AUDITGAP_COVER_MODEL` | cover | yes | **always OpenAI-compatible**. DeepSeek direct (`https://api.deepseek.com/v1`) or OpenRouter (`https://openrouter.ai/api/v1` + any model id, e.g. `deepseek/deepseek-chat`) |
| `AUDITGAP_SPEC_PROVIDER` / `AUDITGAP_COVER_PROVIDER` | steer tag | no | default `OPUS` / `DS` → `[STEER:OPUS]`, `[STEER:DS]` |
| `AUDITGAP_BATCH_POLL_EVERY_TURNS` / `AUDITGAP_BATCH_POLL_MIN_SECS` | batch | no | defaults `5` turns / `60` s between batch status polls |
| `AUDITGAP_TURN_INTERVAL` | trigger | no | default `30` turns between coverage sweeps |
| `AUDITGAP_COVER_MAX_CALLS` | budget | no | default `5` cover calls per sweep |
| `AUDITGAP_PLATEAU_SWEEPS` | trigger | no | default `2` stuck sweeps before spec-lane escalation |
| `AUDITGAP_SPEC_TIMEOUT_MS` / `AUDITGAP_COVER_TIMEOUT_MS` | http | no | defaults `600000` / `120000` |
| `AUDITGAP_MAX_RETRIES` | http | no | default `2`, backoff 1 s → 2 s on 429/5xx/timeout |
| `AUDITGAP_DONE_RETENTION_DAYS` | storage | no | days to keep archived checklists in `.pi/audit-gap/done/` (default `30`; `0` = keep forever) |

### Batch mode (Anthropic direct or OpenRouter)

With `AUDITGAP_SPEC_BATCH=1`, spec-lane audits are spooled durably to `.pi/audit-gap/queue/<job>.json` and grouped into **one** batch submission, polled every few turns. All queued jobs are submitted as the **batch-runner model** (`/auditgap-settings` → *Select batch runner model*, or `AUDITGAP_BATCH_*`, falling back to the spec lane). Two submission APIs:

- **Anthropic** (direct Anthropic base URLs): one `POST /v1/messages/batches`, polled via `GET /v1/messages/batches/{id}` → signed results URL.
- **OpenRouter** (when the spec base URL is `openrouter.ai`, or `AUDITGAP_SPEC_BATCH_API=openrouter`): one `POST /api/v1/batches` with chat-completions-shaped request bodies; OpenRouter returns `202 Accepted` and the poll response carries the results **inline** (no signed URL). The submission tries the plain model id first and retries once with the `:batch` variant if OpenRouter rejects it.

Completed results feed the same handlers as direct calls — `dod.json` updates and `[STEER:*]` injection happen whenever the batch lands. Terminal jobs archive to `queue/done/`. Manual `/auditgap spec|audit` always uses the direct lane because a human is waiting, and gap audits at `completion_requested` stay latency-critical — batch steers there can arrive after pi-goal-x has archived the goal.

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

Audit pipeline (single `auditgap` namespace):

- `/auditgap status` — turn counter, ledger offset, goal/checklist summary, lane config, last error.
- `/auditgap spec <goalId>` — manually request a spec audit (DoD checklist generation).
- `/auditgap audit <goalId>` — manually request a gap audit against the checklist.
- `/auditgap dod <goalId>` — print the checklist with per-item status.

Lane model selection:

- `/auditgap-settings` — settings menu: select spec / steer / batch-runner / cover model (each opens the same searchable picker as `/model`), show effective config, clear a selection. After a pick the menu reopens; **Done** or Esc exits.
- `/auditgap-settings spec` / `/auditgap-settings steer` / `/auditgap-settings batch` / `/auditgap-settings cover` — jump straight to the picker for one lane.
- `/auditgap-settings status` — stored selections + effective env (keys redacted) + transport/batch state.
- `/auditgap-settings clear [spec|steer|batch|cover]` — drop stored selection(s); env config takes over again.

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
npm test   # unit tests across ledger/dod/trigger/steer/batch/settings
npm run build  # tsc → dist/
```

## License

MIT
