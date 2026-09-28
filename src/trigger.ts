/**
 * Trigger policy — decides WHEN each audit lane fires.
 *
 * Sources of triggers (all cheap, local, deterministic):
 *
 * 1. `goal_created` (ledger, or backfilled from goal files)
 *    -> SPEC audit: generate DoD checklist. Async — the worker proceeds;
 *       steers point at gaps when the checklist lands.
 * 2. `completion_requested` (ledger)
 *    -> GAP audit BEFORE pi-goal-x archives the goal at turn_end. Gaps
 *       become [STEER:OPUS] Tier-3 continuation work, not a post-mortem.
 *       `goal_completed` is only logged for bookkeeping.
 * 3. Turn-interval sweep (every AUDITGAP_TURN_INTERVAL turns)
 *    -> COVER audit: verify up to AUDITGAP_COVER_MAX_CALLS pending items
 *       with the cheap lane.
 * 4. Plateau (verified count unchanged across AUDITGAP_PLATEAU_SWEEPS
 *    sweeps while items remain pending/failed)
 *    -> escalate: GAP audit with the spec lane. Plateau is the
 *       deterministic stalemate detector (watchdog), per the design.
 *
 * The policy is pure: it returns actions, the caller executes them
 * (fire-and-forget async) and reports failures via notify.
 */

import type { DodChecklist, GoalLedgerEvent } from "./types.js";
import { pendingItems, verifiedCount } from "./dod.js";

export const TURN_INTERVAL = () => Number(process.env.AUDITGAP_TURN_INTERVAL ?? "30");
export const COVER_MAX_CALLS = () => Number(process.env.AUDITGAP_COVER_MAX_CALLS ?? "5");
export const PLATEAU_SWEEPS = () => Number(process.env.AUDITGAP_PLATEAU_SWEEPS ?? "2");

export type AuditAction =
  | { type: "spec-audit"; goalId: string; objective: string; reason: "goal_created" | "backfill" | "manual" }
  | { type: "gap-audit"; goalId: string; reason: "completion_requested" | "plateau" | "manual" }
  | { type: "cover-check"; goalId: string; itemIds: string[]; reason: "interval_sweep" };

export interface TriggerInput {
  turn: number;
  /** New events from this poll. */
  events: GoalLedgerEvent[];
  /** Goals we already know about (ledger + backfill), mapped to their objective. */
  knownGoals: Map<string, string>;
  /** Loader for the current checklist, if any. */
  loadChecklist: (goalId: string) => DodChecklist | null;
  /** Manually forced actions (slash commands) — bypass policy gates. */
  force?: AuditAction[];
}

interface GoalTracking {
  goalId: string;
  lastSweepTurn: number;
  lastVerifiedCount: number;
  plateauStrikes: number;
  completionHandled: boolean;
}

export class TriggerPolicy {
  private tracking = new Map<string, GoalTracking>();

  private track(goalId: string): GoalTracking {
    let t = this.tracking.get(goalId);
    if (!t) {
      t = {
        goalId,
        lastSweepTurn: -TURN_INTERVAL(), // first sweep eligible immediately
        lastVerifiedCount: 0,
        plateauStrikes: 0,
        completionHandled: false,
      };
      this.tracking.set(goalId, t);
    }
    return t;
  }

  forget(goalId: string): void {
    this.tracking.delete(goalId);
  }

  evaluate(input: TriggerInput): AuditAction[] {
    const actions: AuditAction[] = [];
    if (input.force && input.force.length > 0) return input.force;

    // -- Event-driven triggers ------------------------------------------
    for (const event of input.events) {
      if (event.type === "goal_created") {
        this.track(event.goalId);
        // No checklist yet -> spec audit. If a dod.json already exists
        // (e.g. re-created goal with same id), skip — the checklist is
        // still authoritative.
        if (!input.loadChecklist(event.goalId)) {
          actions.push({ type: "spec-audit", goalId: event.goalId, objective: event.objective, reason: "goal_created" });
        }
      } else if (event.type === "completion_requested") {
        const t = this.track(event.goalId);
        // Fire once per completion request. completion_requested arrives
        // before goal_completed (deferred archival at turn_end), so a
        // steer injected now still lands while the goal is active.
        if (!t.completionHandled) {
          t.completionHandled = true;
          // Fire regardless of checklist presence — runGapAudit generates
          // a checklist on the fly when none exists.
          actions.push({ type: "gap-audit", goalId: event.goalId, reason: "completion_requested" });
        }
      } else if (event.type === "goal_completed" || event.type === "goal_aborted") {
        this.forget(event.goalId);
      }
    }

    // -- Interval sweep + plateau detection ------------------------------
    if (TURN_INTERVAL() > 0 && input.turn > 0 && input.turn % TURN_INTERVAL() === 0) {
      for (const [goalId] of input.knownGoals) {
        const t = this.track(goalId);
        if (input.turn - t.lastSweepTurn < TURN_INTERVAL()) continue;
        const checklist = input.loadChecklist(goalId);
        if (!checklist) continue;
        const pending = pendingItems(checklist);
        if (pending.length === 0) continue;

        // Cover sweep (budget-bounded).
        const itemIds = pending.slice(0, COVER_MAX_CALLS()).map((i) => i.id);
        if (itemIds.length > 0) {
          actions.push({ type: "cover-check", goalId, itemIds, reason: "interval_sweep" });
        }

        // Plateau: verified count stuck while work remains -> escalate.
        const verified = verifiedCount(checklist);
        if (verified === t.lastVerifiedCount) {
          t.plateauStrikes++;
        } else {
          t.plateauStrikes = 0;
          t.lastVerifiedCount = verified;
        }
        if (t.plateauStrikes >= PLATEAU_SWEEPS()) {
          t.plateauStrikes = 0;
          actions.push({ type: "gap-audit", goalId, reason: "plateau" });
        }
        t.lastSweepTurn = input.turn;
      }
    }

    return actions;
  }
}
