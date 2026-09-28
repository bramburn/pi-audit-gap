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
 *   /auditgap audit [goalId]    — manual gap audit (Opus lane)
 *   /auditgap dod [goalId]      — print the DoD checklist
 *
 * Design mirrors pi-harvest: minimal local runtime interfaces (builds
 * without pi's typings), fire-and-forget audits so the pi runtime is
 * never blocked on HTTP, failures surface via notify and never crash.
 */

import { GoalLedgerPoller } from "./ledger.js";
import { backfillCandidates } from "./backfill.js";
import {
  createDod,
  dodPath,
  failedItems,
  loadDod,
  pendingItems,
  updateItem,
  verifiedCount,
} from "./dod.js";
import type { DodChecklist } from "./types.js";
import { invokeCoverCheck, invokeGapAudit, invokeSpecAudit, type GapAuditResponse } from "./client.js";
import { TriggerPolicy, type AuditAction } from "./trigger.js";
import { buildCoverSteerBody, buildGapSteerBody, buildSpecSteerBody } from "./steer.js";
import { AuditGapConfigError } from "./types.js";

// ---------------------------------------------------------------------------
// Minimal runtime interfaces (same pattern as pi-harvest)
// ---------------------------------------------------------------------------

interface UiHelpers {
  setStatus?(key: string, content: unknown): void;
  notify?(message: string, level?: string): void;
}

interface PiContext {
  ui: UiHelpers;
  cwd: string;
  model?: { id?: string; name?: string; provider?: string } | undefined;
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
  // Action executors (fire-and-forget)
  // -------------------------------------------------------------------------

  function runSpecAudit(ctx: PiContext, goalId: string, objective: string): void {
    inFlight++;
    paint(ctx);
    void (async () => {
      try {
        const res = await invokeSpecAudit({ objective, cwd: ctx.cwd });
        specCalls++;
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

  function runGapAudit(ctx: PiContext, goalId: string): void {
    const objective = knownGoals.get(goalId) ?? "";
    const existing = loadDod(ctx.cwd, goalId);
    inFlight++;
    paint(ctx);
    void (async () => {
      try {
        let checklist: DodChecklist;
        if (!existing) {
          // No checklist yet (spec audit lost or failed) — generate one
          // now and steer from it; better late than never.
          const res = await invokeSpecAudit({ objective, cwd: ctx.cwd });
          specCalls++;
          checklist = createDod(
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
        } else {
          checklist = existing;
        }
        const gap: GapAuditResponse = await invokeGapAudit({ checklist, cwd: ctx.cwd });
        specCalls++;
        for (const v of gap.itemVerdicts) {
          if (v.verdict === "pass") {
            updateItem(ctx.cwd, goalId, v.id, "verified", v.reason);
          } else if (v.verdict === "fail") {
            updateItem(ctx.cwd, goalId, v.id, "failed", v.reason);
          }
        }
        const fresh = loadDod(ctx.cwd, goalId) ?? checklist;
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
    paint(c);
  });

  // -------------------------------------------------------------------------
  // Slash commands
  // -------------------------------------------------------------------------

  pi.registerCommand("auditgap", {
    description: "pi-audit-gap controls. Subcommands: status | spec [goalId] | audit [goalId] | dod [goalId]",
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
        runSpecAudit(c, focusedGoalId, knownGoals.get(focusedGoalId)!);
        notify(c, "Spec audit requested for " + focusedGoalId, "info");
        return;
      }

      if (sub === "audit") {
        if (!focusedGoalId || !knownGoals.has(focusedGoalId)) {
          notify(c, "Usage: /auditgap audit <goalId> (known: " + Array.from(knownGoals.keys()).join(", ") + ")", "warn");
          return;
        }
        runGapAudit(c, focusedGoalId);
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
      const lines = [
        renderStatus(),
        "Ledger offset: " + poller.currentOffset(),
        "Spec lane: " + (process.env.AUDITGAP_SPEC_MODEL ?? process.env.VERIFIER_MODEL ?? "<unset>") +
          " | Cover lane: " + (process.env.AUDITGAP_COVER_MODEL ?? "<unset>"),
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
