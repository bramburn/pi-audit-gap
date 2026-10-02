/**
 * pi-audit-gap — extension entry.
 *
 * Wires the pipeline together:
 *
 *   turn_end -> poll goal ledger (byte-offset diff)
 *             -> backfill missed goal_created from .pi/goals/*.md
 *             -> TriggerPolicy.evaluate() -> actions
 *             -> fire-and-forget lane calls -> dod.json updates
 *             -> [STEER:*] Tier-3 messages via sendUserMessage
 *
 * Slash commands:
 *   /auditgap status            — telemetry + budget counters
 *   /auditgap spec [goalId]     — manual spec audit (Opus lane)
 *   /auditgap audit [goalId]    — manual gap audit (steer lane)
 *   /auditgap dod [goalId]      — print the DoD checklist
 *   /auditgap-settings          — settings menu: pick spec / steer /
 *                                 batch-runner / cover models from pi's
 *                                 catalogue (searchable picker, same UX
 *                                 as /model), show or clear selections.
 *                                 Stores { provider, modelId } per project
 *                                 in .pi/audit-gap/settings.json; after a
 *                                 pick the menu reopens so several lanes
 *                                 can be configured in one pass.
 *
 * Design mirrors pi-harvest: minimal local runtime interfaces (builds
 * without pi's typings), fire-and-forget audits so the pi runtime is
 * never blocked on HTTP, failures surface via notify and never crash.
 */

import { GoalLedgerPoller } from "./ledger.js";
import { backfillCandidates } from "./backfill.js";
import {
  archiveDod,
  createDod,
  dodPath,
  failedItems,
  loadDod,
  pendingItems,
  pruneArchivedDods,
  updateItem,
  verifiedCount,
} from "./dod.js";
import type { DodChecklist, SpecAuditResponse } from "./types.js";
import {
  gapSystemPrompt,
  invokeCoverCheck,
  invokeGapAudit,
  invokeSpecAudit,
  specBatchEnabled,
  specSystemPrompt,
  stripJsonFences,
  validateGapAuditResponse,
  validateSpecAuditResponse,
  anthropicBatchStatus,
  anthropicSubmitBatch,
  batchApi,
  fetchBatchResults,
  openrouterBatchStatus,
  openrouterSubmitBatch,
  steerTransport,
  type GapAuditResponse,
} from "./client.js";
import { buildGapPayload, buildSpecPayload } from "./assemble.js";
import {
  buildJobParams,
  enqueueJob,
  listJobs,
  pollSubmittedJobs,
  submitPendingJobs,
  type BatchClient,
} from "./batch.js";
import { TriggerPolicy, type AuditAction } from "./trigger.js";
import { buildCoverSteerBody, buildGapSteerBody, buildSpecSteerBody } from "./steer.js";
import { AuditGapConfigError } from "./types.js";
import {
  applyLaneSelections,
  loadSettings,
  setLaneSelection,
  type LaneApplyResult,
  type ModelRegistryLike,
} from "./settings.js";
import { pickLaneModel, type PickerComponent, type PickerTheme } from "./model-picker.js";

// ---------------------------------------------------------------------------
// Minimal runtime interfaces (same pattern as pi-harvest)
// ---------------------------------------------------------------------------

interface UiHelpers {
  setStatus?(key: string, content: unknown): void;
  notify?(message: string, level?: string): void;
  select?(title: string, options: string[]): Promise<string | undefined>;
  custom?<T>(
    factory: (
      tui: unknown,
      theme: PickerTheme,
      keybindings: unknown,
      done: (result: T) => void,
    ) => PickerComponent | Promise<PickerComponent>,
    options?: unknown,
  ): Promise<T>;
}

interface PiContext {
  ui: UiHelpers;
  cwd: string;
  model?: { id?: string; name?: string; provider?: string } | undefined;
  modelRegistry?: unknown;
  mode?: string;
  hasUI?: boolean;
  sessionManager?: { getSessionId(): string };
  [key: string]: unknown;
}

interface ExtensionAPI {
  on(event: "turn_end", handler: (event: unknown, ctx: PiContext) => void | Promise<void>): void;
  on(event: string, handler: (...args: unknown[]) => void | Promise<void>): void;
  sendUserMessage(
    content: string,
    options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
  ): void;
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: PiContext) => Promise<void> | void;
    },
  ): void;
}

const STATUS_KEY = "auditgap";

interface LastError {
  source: "spec" | "gap" | "cover";
  message: string;
  ts: string;
}

export default function auditGapExtension(pi: ExtensionAPI): void {
  let turnCounter = 0;
  let poller = new GoalLedgerPoller();
  const policy = new TriggerPolicy();
  /** goalId -> objective, from ledger + backfill. */
  const knownGoals = new Map<string, string>();
  let specCalls = 0;
  let coverCalls = 0;
  let gapSteers = 0;
  let lastError: LastError | null = null;
  let inFlight = 0;
  // Batch monitor cadence.
  let lastBatchPollTurn = 0;
  let lastBatchPollMs = 0;
  let batchPollInFlight = false;

  function renderStatus(): string {
    return (
      "[AuditGap] Turn: " +
      turnCounter +
      " | Goals: " +
      knownGoals.size +
      " | SpecCalls: " +
      specCalls +
      " | CoverCalls: " +
      coverCalls +
      " | GapSteers: " +
      gapSteers +
      (inFlight > 0 ? " | InFlight: " + inFlight : "")
    );
  }

  function paint(ctx: PiContext): void {
    ctx.ui?.setStatus?.(STATUS_KEY, renderStatus());
  }

  function notify(ctx: PiContext, message: string, level: string = "info"): void {
    ctx.ui?.notify?.("[AuditGap] " + message, level);
  }

  function recordFailure(ctx: PiContext, source: LastError["source"], err: unknown): void {
    const msg = (err as Error)?.message ?? String(err);
    lastError = { source, message: msg, ts: new Date().toISOString() };
    console.error("[AuditGap] " + source + " failed: " + msg);
    notify(ctx, source + " failed: " + msg, "warn");
  }

  function sendSteer(ctx: PiContext, body: string): void {
    if (!body) return;
    try {
      pi.sendUserMessage(body, { deliverAs: "steer" });
    } catch (err) {
      notify(ctx, "sendUserMessage failed: " + ((err as Error)?.message ?? String(err)), "warn");
    }
  }

  // -------------------------------------------------------------------------
  // /auditgap-settings — lane model selection from pi's catalogue
  // -------------------------------------------------------------------------

  /**
   * Apply stored selections to the AUDITGAP_* env vars. Called on
   * session_start (verbose: report applied lanes) and after picker
   * actions (the caller reports the specific lane itself).
   */
  async function applyStoredSelections(ctx: PiContext, verbose: boolean): Promise<LaneApplyResult[]> {
    const results = await applyLaneSelections(ctx.cwd, ctx.modelRegistry as ModelRegistryLike | undefined);
    if (verbose) {
      for (const r of results) {
        if (r.status === "applied") {
          notify(ctx, r.lane + " lane model: " + r.detail + " (from /auditgap-settings)", "info");
        } else if (r.status === "missing" || r.status === "failed") {
          notify(ctx, r.lane + " lane selection not applied: " + r.detail, "warning");
        }
      }
    }
    return results;
  }

  function redact(value: string | undefined): string {
    if (!value) return "<unset>";
    if (value.length <= 10) return "••••••••";
    return value.slice(0, 7) + "…";
  }

  type SettingsLane = "spec" | "steer" | "batch" | "cover";

  const LANE_LABELS: Record<SettingsLane, string> = {
    spec: "Spec",
    steer: "Steer",
    batch: "Batch runner",
    cover: "Cover",
  };

  async function selectLaneModel(ctx: PiContext, lane: SettingsLane): Promise<void> {
    const choice = await pickLaneModel(
      { mode: ctx.mode ?? "tui", ui: ctx.ui as never },
      ctx.modelRegistry as never,
      lane,
      { batchCapableOnly: lane === "batch" },
    );
    if (!choice) {
      notify(ctx, "No model picked — " + lane + " lane unchanged", "info");
      return;
    }
    setLaneSelection(ctx.cwd, lane, choice);
    const results = await applyStoredSelections(ctx, false);
    const mine = results.find((r) => r.lane === lane);
    if (mine?.status === "applied") {
      notify(
        ctx,
        LANE_LABELS[lane] + " lane → " + choice.provider + "/" + choice.modelId +
          " (stored in .pi/audit-gap/settings.json)",
        "info",
      );
    } else {
      notify(
        ctx,
        "Stored " + choice.provider + "/" + choice.modelId + " but could not apply it: " + (mine?.detail ?? "unknown") +
          " — check /login or models.json for this provider",
        "warning",
      );
    }
  }

  async function clearLaneSelection(ctx: PiContext, lane: SettingsLane | undefined): Promise<void> {
    const lanes: SettingsLane[] = lane ? [lane] : ["spec", "steer", "batch", "cover"];
    for (const l of lanes) {
      setLaneSelection(ctx.cwd, l, undefined);
    }
    await applyStoredSelections(ctx, false);
    notify(
      ctx,
      "Cleared " + (lane ?? "all lanes") + " model selection — env config back in effect",
      "info",
    );
  }

  function showSettingsStatus(ctx: PiContext): void {
    const stored = loadSettings(ctx.cwd);
    const lines: string[] = ["AuditGap lane model settings (.pi/audit-gap/settings.json):"];
    for (const lane of ["spec", "steer", "batch", "cover"] as const) {
      const sel = stored?.[lane];
      const prefix = "AUDITGAP_" + lane.toUpperCase();
      // Steer and batch ride the spec lane when they have no stored pick.
      const effectiveModel =
        process.env[prefix + "_MODEL"] ??
        ((lane === "steer" || lane === "batch") ? process.env.AUDITGAP_SPEC_MODEL : undefined) ??
        "<unset>";
      const effectiveBase =
        process.env[prefix + "_BASE_URL"] ??
        ((lane === "steer" || lane === "batch") ? process.env.AUDITGAP_SPEC_BASE_URL : undefined) ??
        "<unset>";
      lines.push(
        " " + lane + ": " +
          (sel ? sel.provider + "/" + sel.modelId + " (stored)" : "no stored selection") +
          " | effective: " + effectiveModel + " @ " + effectiveBase +
          " key:" + redact(process.env[prefix + "_API_KEY"]),
      );
    }
    lines.push(
      "Spec transport: " + (process.env.AUDITGAP_SPEC_API ?? "openai") +
        (specBatchEnabled() ? " (batch on)" : "") +
        " | batch API: " + batchApi() +
        " | steer transport: " + steerTransport() +
        " | change with: /auditgap-settings",
    );
    ctx.ui?.notify?.(lines.join("\n"), "info");
  }

  async function settingsMenu(ctx: PiContext): Promise<void> {
    if (!ctx.hasUI || typeof ctx.ui?.select !== "function") {
      notify(ctx, "Usage: /auditgap-settings spec | steer | batch | cover | status | clear [lane]", "warn");
      return;
    }
    // Loop: after each action (e.g. a model pick) the menu reopens, so
    // several lanes can be configured in one pass. "Done" or Esc exits.
    for (;;) {
      const choice = await ctx.ui.select(
        "AuditGap settings",
        [
          "Select spec model (Opus lane)",
          "Select steer model (gap-audit lane)",
          "Select batch runner model",
          "Select cover model (cheap lane)",
          "Show current settings",
          "Clear spec model selection",
          "Clear steer model selection",
          "Clear batch runner model selection",
          "Clear cover model selection",
          "Done",
        ],
      );
      if (!choice || choice === "Done") return;
      try {
        if (choice === "Select spec model (Opus lane)") await selectLaneModel(ctx, "spec");
        else if (choice === "Select steer model (gap-audit lane)") await selectLaneModel(ctx, "steer");
        else if (choice === "Select batch runner model") await selectLaneModel(ctx, "batch");
        else if (choice === "Select cover model (cheap lane)") await selectLaneModel(ctx, "cover");
        else if (choice === "Show current settings") showSettingsStatus(ctx);
        else if (choice === "Clear spec model selection") await clearLaneSelection(ctx, "spec");
        else if (choice === "Clear steer model selection") await clearLaneSelection(ctx, "steer");
        else if (choice === "Clear batch runner model selection") await clearLaneSelection(ctx, "batch");
        else if (choice === "Clear cover model selection") await clearLaneSelection(ctx, "cover");
      } catch (err) {
        notify(ctx, "settings error: " + ((err as Error)?.message ?? String(err)), "warn");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Result handlers — shared by the direct lane and the batch queue.
  // -------------------------------------------------------------------------

  function handleSpecAuditResult(ctx: PiContext, goalId: string, objective: string, res: SpecAuditResponse): void {
    const checklist = createDod(
      ctx.cwd,
      goalId,
      objective,
      res.checklist.map((c) => ({
        id: c.id,
        requirement: c.requirement,
        acceptanceCriteria: c.acceptance_criteria,
      })),
      process.env.AUDITGAP_SPEC_MODEL ?? process.env.VERIFIER_MODEL ?? "unknown",
    );
    notify(
      ctx,
      "Spec checklist for " + goalId + ": " + checklist.items.length + " item(s)" +
        (res.risks.length > 0 ? " | risks: " + res.risks.length : ""),
      "info",
    );
    sendSteer(ctx, buildSpecSteerBody(checklist, dodPath(ctx.cwd, goalId)));
  }

  function handleGapAuditResult(ctx: PiContext, goalId: string, gap: GapAuditResponse): void {
    for (const v of gap.itemVerdicts) {
      if (v.verdict === "pass") {
        updateItem(ctx.cwd, goalId, v.id, "verified", v.reason);
      } else if (v.verdict === "fail") {
        updateItem(ctx.cwd, goalId, v.id, "failed", v.reason);
      }
    }
    const fresh = loadDod(ctx.cwd, goalId);
    if (!fresh) return;
    const stillOpen = pendingItems(fresh).length + failedItems(fresh).length;
    notify(
      ctx,
      "Gap audit for " + goalId + ": " + stillOpen + " open item(s)" +
        (gap.missingRequirements.length > 0 ? " | " + gap.missingRequirements.length + " missing requirement area(s)" : "") +
        " — " + gap.summary,
      "info",
    );
    if (stillOpen > 0 || gap.missingRequirements.length > 0) {
      sendSteer(ctx, buildGapSteerBody(fresh, gap.missingRequirements, gap.summary, dodPath(ctx.cwd, goalId)));
      gapSteers++;
    }
  }

  // -------------------------------------------------------------------------
  // Action executors (fire-and-forget)
  // -------------------------------------------------------------------------

  /** Batch-credentials needed to build Anthropic batch request params. */
  function specRequestConfig(): { model: string; maxTokens: number } {
    return {
      model: process.env.AUDITGAP_BATCH_MODEL ?? process.env.AUDITGAP_SPEC_MODEL ?? process.env.VERIFIER_MODEL ?? "claude-opus-5.5",
      maxTokens: Number(process.env.AUDITGAP_BATCH_MAX_TOKENS ?? process.env.AUDITGAP_SPEC_MAX_TOKENS ?? "8192"),
    };
  }

  /**
   * Batch-mode enqueue for spec-lane actions. Returns false when batch
   * mode is off (caller falls back to the direct lane).
   */
  function tryEnqueueBatchJob(ctx: PiContext, kind: "spec-audit" | "gap-audit", goalId: string, objective: string): boolean {
    if (!specBatchEnabled()) return false;
    try {
      const params =
        kind === "spec-audit"
          ? buildJobParams({
              ...specRequestConfig(),
              systemPrompt: specSystemPrompt(),
              userContent: buildSpecPayload({ objective, cwd: ctx.cwd }),
            })
          : buildJobParams({
              ...specRequestConfig(),
              systemPrompt: gapSystemPrompt(),
              userContent: buildGapPayload({ checklist: loadDod(ctx.cwd, goalId)!, cwd: ctx.cwd }),
            });
      if (kind === "gap-audit" && !loadDod(ctx.cwd, goalId)) {
        // Gap audit needs a checklist; without one a spec job is the
        // useful batch request (checklist steer doubles as gap list).
        enqueueJob(ctx.cwd, "spec-audit", goalId, params, objective);
      } else {
        enqueueJob(ctx.cwd, kind, goalId, params, objective);
      }
      return true;
    } catch (err) {
      recordFailure(ctx, "spec", err);
      return true; // batch mode is on — do not ALSO fire the direct lane
    }
  }

  function runSpecAudit(ctx: PiContext, goalId: string, objective: string, opts?: { direct?: boolean }): void {
    if (!opts?.direct && tryEnqueueBatchJob(ctx, "spec-audit", goalId, objective)) return;
    inFlight++;
    paint(ctx);
    void (async () => {
      try {
        const res = await invokeSpecAudit({ objective, cwd: ctx.cwd });
        specCalls++;
        handleSpecAuditResult(ctx, goalId, objective, res);
      } catch (err) {
        if (err instanceof AuditGapConfigError) {
          notify(ctx, "Spec lane not configured — " + err.message, "warning");
        } else {
          recordFailure(ctx, "spec", err);
        }
      } finally {
        inFlight--;
        paint(ctx);
      }
    })();
  }

  function runGapAudit(ctx: PiContext, goalId: string, opts?: { direct?: boolean }): void {
    const objective = knownGoals.get(goalId) ?? "";
    const existing = loadDod(ctx.cwd, goalId);
    if (!opts?.direct && tryEnqueueBatchJob(ctx, "gap-audit", goalId, objective)) return;
    inFlight++;
    paint(ctx);
    void (async () => {
      try {
        if (!existing) {
          // No checklist yet (spec audit lost or failed) — generate one
          // now and steer from it; better late than never.
          const res = await invokeSpecAudit({ objective, cwd: ctx.cwd });
          specCalls++;
          handleSpecAuditResult(ctx, goalId, objective, res);
        }
        const checklist = loadDod(ctx.cwd, goalId);
        if (!checklist) return;
        const gap: GapAuditResponse = await invokeGapAudit({ checklist, cwd: ctx.cwd });
        specCalls++;
        handleGapAuditResult(ctx, goalId, gap);
      } catch (err) {
        if (err instanceof AuditGapConfigError) {
          notify(ctx, "Spec lane not configured — " + err.message, "warning");
        } else {
          recordFailure(ctx, "gap", err);
        }
      } finally {
        inFlight--;
        paint(ctx);
      }
    })();
  }

  function runCoverCheck(ctx: PiContext, goalId: string, itemIds: string[]): void {
    const checklist = loadDod(ctx.cwd, goalId);
    if (!checklist) return;
    const items = checklist.items.filter((i) => itemIds.includes(i.id));
    if (items.length === 0) return;
    inFlight += items.length;
    paint(ctx);
    void (async () => {
      try {
        const results = await Promise.all(
          items.map((item) =>
            invokeCoverCheck({
              objective: checklist.objective,
              itemId: item.id,
              requirement: item.requirement,
              acceptanceCriteria: item.acceptanceCriteria,
              cwd: ctx.cwd,
            }).catch((err: unknown) => ({ verdict: "unknown" as const, reason: (err as Error)?.message ?? String(err) })),
          ),
        );
        coverCalls += items.length;
        results.forEach((res, i) => {
          const status = res.verdict === "pass" ? "verified" : res.verdict === "fail" ? "failed" : "pending";
          updateItem(ctx.cwd, goalId, items[i].id, status, res.reason);
        });
        const fresh = loadDod(ctx.cwd, goalId);
        if (fresh) {
          const body = buildCoverSteerBody(fresh, itemIds, dodPath(ctx.cwd, goalId));
          if (body) {
            sendSteer(ctx, body);
            gapSteers++;
          }
        }
        paint(ctx);
      } finally {
        inFlight -= items.length;
        paint(ctx);
      }
    })();
  }

  function dispatch(ctx: PiContext, action: AuditAction): void {
    if (action.type === "spec-audit") {
      runSpecAudit(ctx, action.goalId, action.objective);
    } else if (action.type === "gap-audit") {
      runGapAudit(ctx, action.goalId);
    } else {
      runCoverCheck(ctx, action.goalId, action.itemIds);
    }
  }

  // -------------------------------------------------------------------------
  // Anthropic batch monitor: submit pending jobs, poll submitted ones,
  // route completed results into the shared handlers.
  // -------------------------------------------------------------------------

  // Dispatch on the batch API at call time so /auditgap-settings picks
  // (which rewrite the spec base URL/model) take effect without a reload.
  const batchClient: BatchClient = {
    submit: (entries) => (batchApi() === "openrouter" ? openrouterSubmitBatch(entries) : anthropicSubmitBatch(entries)),
    status: (batchId) => (batchApi() === "openrouter" ? openrouterBatchStatus(batchId) : anthropicBatchStatus(batchId)),
    // Only the Anthropic transport fetches results from a signed URL;
    // OpenRouter returns them inline in the poll response.
    results: (url) => fetchBatchResults(url),
  };

  const BATCH_POLL_EVERY_TURNS = () => Number(process.env.AUDITGAP_BATCH_POLL_EVERY_TURNS ?? "5");
  const BATCH_POLL_MIN_SECS = () => Number(process.env.AUDITGAP_BATCH_POLL_MIN_SECS ?? "60");

  function maintainBatchQueue(ctx: PiContext): void {
    if (!specBatchEnabled() || batchPollInFlight) return;
    const now = Date.now();
    if (
      turnCounter - lastBatchPollTurn < BATCH_POLL_EVERY_TURNS() &&
      now - lastBatchPollMs < BATCH_POLL_MIN_SECS() * 1000
    ) {
      return;
    }
    lastBatchPollTurn = turnCounter;
    lastBatchPollMs = now;
    batchPollInFlight = true;
    void (async () => {
      try {
        // 1. Submit everything pending as ONE Anthropic batch.
        const submitted = await submitPendingJobs(ctx.cwd, batchClient);
        if (submitted > 0) {
          notify(ctx, batchApi() + " batch submitted: " + submitted + " audit request(s)", "info");
        }
        // 2. Poll submitted batches; route completions.
        const resolved = await pollSubmittedJobs(ctx.cwd, batchClient);
        for (const { job, outcome } of resolved) {
          if (!outcome) continue; // still processing (or transient poll error)
          specCalls++;
          if (!outcome.ok || outcome.text === undefined) {
            recordFailure(ctx, job.kind === "spec-audit" ? "spec" : "gap", new Error(outcome.error ?? "empty batch result"));
            continue;
          }
          try {
            const parsed = JSON.parse(stripJsonFences(outcome.text)) as unknown;
            if (job.kind === "spec-audit") {
              const res = validateSpecAuditResponse(parsed);
              handleSpecAuditResult(ctx, job.goalId, job.objective ?? knownGoals.get(job.goalId) ?? "", res);
            } else {
              const gap = validateGapAuditResponse(parsed);
              handleGapAuditResult(ctx, job.goalId, gap);
            }
          } catch (err) {
            recordFailure(ctx, job.kind === "spec-audit" ? "spec" : "gap", err);
          }
        }
      } catch (err) {
        if (err instanceof AuditGapConfigError) {
          notify(ctx, "Spec lane not configured — " + err.message, "warning");
        } else {
          recordFailure(ctx, "spec", err);
        }
      } finally {
        batchPollInFlight = false;
        paint(ctx);
      }
    })();
  }

  // -------------------------------------------------------------------------
  // turn_end hook: poll ledger -> backfill -> evaluate -> dispatch
  // -------------------------------------------------------------------------

  pi.on("turn_end", (_event, ctx) => {
    turnCounter++;
    const c = ctx as PiContext;

    const result = poller.poll(c.cwd);
    for (const e of result.events) {
      if (e.type === "goal_created") knownGoals.set(e.goalId, e.objective);
    }
    if (result.rotated && result.events.length > 0) {
      notify(c, "Goal ledger rotated — re-read from offset 0", "info");
    }

    // Backfill: goal files on disk that we never saw created (silent
    // append failure in pi-goal-x). Synthesize the creation trigger.
    try {
      const seen = new Set<string>();
      for (const id of knownGoals.keys()) {
        seen.add(id);
      }
      for (const cand of backfillCandidates(c.cwd, seen)) {
        knownGoals.set(cand.goalId, cand.objective);
        notify(c, "Backfilled goal from state file: " + cand.goalId, "info");
        dispatch(c, { type: "spec-audit", goalId: cand.goalId, objective: cand.objective, reason: "backfill" });
      }
    } catch {
      // Backfill is best-effort.
    }

    try {
      const actions = policy.evaluate({
        turn: turnCounter,
        events: result.events,
        knownGoals,
        loadChecklist: (goalId) => loadDod(c.cwd, goalId),
      });
      for (const action of actions) dispatch(c, action);
    } catch (err) {
      recordFailure(c, "spec", err);
    }

    // Archival: completed/aborted goals move their checklist to done/ so
    // the active audit root only holds live goals; archived checklists
    // past retention are pruned. Runs after all dispatches so in-flight
    // gap-audit writes for the goal have landed. Best-effort housekeeping.
    for (const event of result.events) {
      if (event.type !== "goal_completed" && event.type !== "goal_aborted") continue;
      try {
        archiveDod(c.cwd, event.goalId);
        const pruned = pruneArchivedDods(c.cwd);
        if (pruned.length > 0) {
          notify(c, "Pruned " + pruned.length + " archived checklist(s) past retention", "info");
        }
      } catch {
        // Never crash the host over housekeeping.
      }
    }

    // Batch monitor: submit newly enqueued jobs, poll in-flight batches.
    try {
      maintainBatchQueue(c);
    } catch {
      // Best-effort; cadence will retry next turn.
    }
    paint(c);
  });

  // -------------------------------------------------------------------------
  // Slash commands
  // -------------------------------------------------------------------------

  pi.registerCommand("auditgap-settings", {
    description: "Lane model selection menu. Subcommands: spec | steer | batch | cover | status | clear [lane]",
    handler: async (args, ctx) => {
      const c = ctx as PiContext;
      try {
        const [sub, sub2] = (args ?? "").trim().split(/\s+/).filter(Boolean);
        if (sub === "spec" || sub === "steer" || sub === "batch" || sub === "cover") {
          await selectLaneModel(c, sub);
        } else if (sub === "status") {
          showSettingsStatus(c);
        } else if (sub === "clear") {
          await clearLaneSelection(c, sub2 === "spec" || sub2 === "steer" || sub2 === "batch" || sub2 === "cover" ? sub2 : undefined);
        } else {
          await settingsMenu(c);
        }
      } catch (err) {
        notify(c, "settings error: " + ((err as Error)?.message ?? String(err)), "warn");
      }
    },
  });

  // Apply stored model selections on every session start so restarts and
  // /reload pick them up without touching env vars by hand.
  pi.on("session_start", (_event, ctx) => {
    const c = ctx as PiContext;
    applyStoredSelections(c, true).catch((err: unknown) => {
      notify(c, "settings apply failed: " + ((err as Error)?.message ?? String(err)), "warn");
    });
  });

  pi.registerCommand("auditgap", {
    description: "pi-audit-gap controls. Subcommands: status | spec [goalId] | audit [goalId] | dod [goalId] | models: /auditgap-settings",
    handler: async (args, ctx) => {
      const c = ctx as PiContext;
      const rawArgs = (args ?? "").trim();
      const [sub, ...rest] = rawArgs.split(/\s+/);
      const goalArg = rest.join(" ").trim();
      const focusedGoalId = goalArg || (knownGoals.size === 1 ? Array.from(knownGoals.keys())[0] : "");

      if (sub === "spec") {
        if (!focusedGoalId || !knownGoals.has(focusedGoalId)) {
          notify(c, "Usage: /auditgap spec <goalId> (known: " + Array.from(knownGoals.keys()).join(", ") + ")", "warn");
          return;
        }
        // Manual triggers always use the direct lane — a human is waiting.
        runSpecAudit(c, focusedGoalId, knownGoals.get(focusedGoalId)!, { direct: true });
        notify(c, "Spec audit requested for " + focusedGoalId, "info");
        return;
      }

      if (sub === "audit") {
        if (!focusedGoalId || !knownGoals.has(focusedGoalId)) {
          notify(c, "Usage: /auditgap audit <goalId> (known: " + Array.from(knownGoals.keys()).join(", ") + ")", "warn");
          return;
        }
        // Direct lane: gap audits at completion time are latency-critical
        // (must land before pi-goal-x archives the goal).
        runGapAudit(c, focusedGoalId, { direct: true });
        notify(c, "Gap audit requested for " + focusedGoalId, "info");
        return;
      }

      if (sub === "dod") {
        if (!focusedGoalId) {
          notify(c, "Usage: /auditgap dod <goalId> (known: " + Array.from(knownGoals.keys()).join(", ") + ")", "warn");
          return;
        }
        const checklist = loadDod(c.cwd, focusedGoalId);
        if (!checklist) {
          notify(c, "No dod.json for " + focusedGoalId + " — run /auditgap spec " + focusedGoalId, "warn");
          return;
        }
        const lines = [
          "DoD for " + focusedGoalId + ": " + verifiedCount(checklist) + "/" + checklist.items.length + " verified @ " + dodPath(c.cwd, focusedGoalId),
        ];
        for (const item of checklist.items) {
          lines.push(" [" + item.status + "] " + item.id + ": " + item.requirement);
        }
        notify(c, lines.join("\n"), "info");
        return;
      }

      // Default: status
      const pendingJobs = listJobs(c.cwd, "pending-submit").length;
      const submittedJobs = listJobs(c.cwd, "submitted").length;
      const lines = [
        renderStatus(),
        "Ledger offset: " + poller.currentOffset(),
        "Spec lane: " + (process.env.AUDITGAP_SPEC_MODEL ?? process.env.VERIFIER_MODEL ?? "<unset>") +
          " (" + (process.env.AUDITGAP_SPEC_API ?? "openai") +
          (specBatchEnabled() ? ", batch:" + batchApi() : "") + ")" +
          " | Steer lane: " + (process.env.AUDITGAP_STEER_MODEL ?? process.env.AUDITGAP_SPEC_MODEL ?? "<unset>") +
          " (" + steerTransport() + ")" +
          " | Batch runner: " + (process.env.AUDITGAP_BATCH_MODEL ?? process.env.AUDITGAP_SPEC_MODEL ?? "<unset>") +
          (specBatchEnabled() ? " (" + batchApi() + ")" : "") +
          " | Cover lane: " + (process.env.AUDITGAP_COVER_MODEL ?? "<unset>") + " (openai-compatible)",
        "Batch queue: " + pendingJobs + " pending-submit, " + submittedJobs + " submitted" +
          " | poll every " + (process.env.AUDITGAP_BATCH_POLL_EVERY_TURNS ?? "5") + " turn(s)",
        "Interval: " + (process.env.AUDITGAP_TURN_INTERVAL ?? "30") +
          " | CoverMax: " + (process.env.AUDITGAP_COVER_MAX_CALLS ?? "5") +
          " | PlateauSweeps: " + (process.env.AUDITGAP_PLATEAU_SWEEPS ?? "2"),
      ];
      if (lastError) {
        lines.push("LastError: " + lastError.source + " @ " + lastError.ts + " — " + lastError.message);
      }
      for (const [goalId, objective] of knownGoals) {
        const checklist = loadDod(c.cwd, goalId);
        lines.push(
          "Goal " + goalId + ": " +
          (checklist
            ? verifiedCount(checklist) + "/" + checklist.items.length + " verified, " + pendingItems(checklist).length + " pending"
            : "no checklist") +
          " — " + objective.slice(0, 80),
        );
      }
      c.ui?.notify?.(lines.join("\n"), "info");
      paint(c);
    },
  });
}
