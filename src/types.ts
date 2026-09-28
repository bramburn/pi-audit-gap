/**
 * Shared types and errors for pi-audit-gap.
 *
 * The GoalLedgerEvent union deliberately mirrors pi-goal-x's
 * `extensions/goal-ledger.ts` schema WITHOUT importing it — pi-goal-x
 * has no package exports map, so deep-importing its modules would couple
 * this extension to its internal file layout. The JSONL file contract is
 * the stable surface; these types are our own copy of it.
 */

export type GoalLedgerEvent =
  | { type: "goal_created"; goalId: string; objective: string; sisyphus: boolean; autoContinue: boolean; at: string }
  | { type: "goal_focused"; goalId: string; reason: string; at: string }
  | { type: "goal_unfocused"; reason: string; at: string }
  | { type: "goal_paused"; goalId: string; reason: string; suggestedAction?: string; status?: "paused"; at: string }
  | { type: "goal_resumed"; goalId: string; reason: string; at: string }
  | { type: "goal_tweaked"; goalId: string; changeSummary: string; at: string }
  | { type: "completion_requested"; goalId: string; summary?: string; at: string }
  | { type: "audit_started"; goalId: string; provider?: string; model?: string; thinkingLevel?: string; at: string }
  | { type: "audit_result"; goalId: string; verdict: "approved" | "disapproved" | "error"; report: string; at: string }
  | { type: "audit_skipped"; goalId: string; reason: "disabled" | "user_aborted"; provider?: string; model?: string; thinkingLevel?: string; at: string }
  | { type: "goal_completed"; goalId: string; archivePath?: string; at: string }
  | { type: "goal_aborted"; goalId: string; reason: string; archivePath?: string; at: string };

/** Events whose payloads we validate strictly (the ones we act on). */
const STRICT_TYPES = new Set([
  "goal_created",
  "completion_requested",
  "goal_completed",
  "goal_aborted",
  "goal_paused",
  "goal_resumed",
]);

export function isValidLedgerEvent(value: unknown): value is GoalLedgerEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string" || typeof obj.at !== "string") return false;
  const type = obj.type as GoalLedgerEvent["type"];
  if (!STRICT_TYPES.has(type)) {
    // Loose validation for event types we observe but never act on
    // (goal_focused, audit_*, ...). They pass through for telemetry.
    return true;
  }
  switch (type) {
    case "goal_created":
      return typeof obj.goalId === "string" && typeof obj.objective === "string";
    case "completion_requested":
      return typeof obj.goalId === "string" && (obj.summary === undefined || typeof obj.summary === "string");
    case "goal_completed":
    case "goal_aborted":
      return typeof obj.goalId === "string";
    case "goal_paused":
      return typeof obj.goalId === "string" && typeof obj.reason === "string";
    case "goal_resumed":
      return typeof obj.goalId === "string";
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Definition-of-Done store
// ---------------------------------------------------------------------------

export type DodItemStatus = "pending" | "verified" | "failed" | "waived";

export interface DodItem {
  id: string;
  requirement: string;
  acceptanceCriteria: string;
  status: DodItemStatus;
  /** Cover-lane verdict reason, last steer reference, etc. */
  evidence?: string;
  updatedAt?: string;
}

export interface DodChecklist {
  goalId: string;
  objective: string;
  createdAt: string;
  updatedAt: string;
  /** Model that authored the checklist (spec lane). */
  authoredBy?: string;
  items: DodItem[];
}

// ---------------------------------------------------------------------------
// Lane responses
// ---------------------------------------------------------------------------

export interface SpecChecklistItem {
  id: string;
  requirement: string;
  acceptance_criteria: string;
}

export interface SpecAuditResponse {
  checklist: SpecChecklistItem[];
  risks: string[];
}

export type CoverVerdict = "pass" | "fail" | "unknown";

export interface CoverCheckResponse {
  verdict: CoverVerdict;
  reason: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Missing/invalid env configuration — no point retrying. */
export class AuditGapConfigError extends Error {
  constructor(public readonly missing: string[]) {
    super("Missing or invalid configuration: " + missing.join(", "));
    this.name = "AuditGapConfigError";
  }
}

/** All retries exhausted — caller should catch, surface, and move on. */
export class AuditGapUnavailableError extends Error {
  constructor(public readonly attempts: number, public readonly cause: unknown) {
    super("Audit lane unavailable after " + attempts + " attempt(s): " + ((cause as Error)?.message ?? String(cause)));
    this.name = "AuditGapUnavailableError";
  }
}
