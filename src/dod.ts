/**
 * Definition-of-Done store.
 *
 * `.pi/audit-gap/<goalId>/dod.json` is the SOURCE OF TRUTH for coverage
 * state. Chat steers only point at it — they never carry the state —
 * because a weak worker model must not be able to "self-report" progress
 * into the supervision record (per the design: checklist status is
 * supervision state, not chat).
 *
 * Writes are atomic (tmp + rename). Reads tolerate a missing/corrupt
 * file by returning null. On goal_completed / goal_aborted the checklist
 * is archived to done/<goalId>/ and pruned after AUDITGAP_DONE_RETENTION_DAYS
 * (default 30; 0 = keep forever).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteJson } from "./fsutil.js";
import type { DodChecklist, DodItem, DodItemStatus } from "./types.js";

export const AUDIT_DIR_REL = path.join(".pi", "audit-gap");

/** Mirror of pi-goal-x's safeIdPart: keep goal ids filesystem-safe. */
export function safeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function auditDir(cwd: string): string {
  return path.resolve(cwd, AUDIT_DIR_REL);
}

export function goalDir(cwd: string, goalId: string): string {
  return path.join(auditDir(cwd), safeIdPart(goalId));
}

export function dodPath(cwd: string, goalId: string): string {
  return path.join(goalDir(cwd, goalId), "dod.json");
}

/** Archive root: checklists of completed/aborted goals move here. */
export function doneDir(cwd: string): string {
  return path.join(auditDir(cwd), "done");
}

export function archivedDodPath(cwd: string, goalId: string): string {
  return path.join(doneDir(cwd), safeIdPart(goalId), "dod.json");
}

/**
 * How long archived checklists are kept, in days. Set
 * AUDITGAP_DONE_RETENTION_DAYS=0 to keep archived checklists forever.
 */
export function doneRetentionDays(): number {
  const raw = process.env.AUDITGAP_DONE_RETENTION_DAYS;
  if (raw === undefined || raw === "") return 30;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 30;
  return n;
}

/**
 * Move an active checklist into done/ after the goal completes or is
 * aborted. Mirrors the batch queue's archiveJob pattern. Returns true when
 * a checklist was archived. Best-effort: a stale copy left behind (e.g.
 * unlink refused by a Windows file lock) is harmless — the active path is
 * only read for tracked goals, and a re-created goal with the same id gets
 * a fresh spec audit because its active dod.json is gone.
 */
export function archiveDod(cwd: string, goalId: string): boolean {
  const src = dodPath(cwd, goalId);
  let checklist: unknown;
  try {
    checklist = JSON.parse(fs.readFileSync(src, "utf8"));
  } catch {
    return false;
  }
  atomicWriteJson(archivedDodPath(cwd, goalId), checklist);
  try {
    fs.unlinkSync(src);
  } catch {
    // Locked by a concurrent reader — the archive copy is authoritative.
  }
  try {
    fs.rmdirSync(goalDir(cwd, goalId));
  } catch {
    // Non-empty goal dir (stray files) — leave it for a human to inspect.
  }
  return true;
}

/**
 * Delete archived checklists older than `maxAgeDays` (based on the
 * checklist's updatedAt). Returns the goal ids removed. A maxAgeDays of 0
 * disables pruning. Never throws — housekeeping must not crash the host.
 */
export function pruneArchivedDods(cwd: string, maxAgeDays: number = doneRetentionDays()): string[] {
  if (maxAgeDays <= 0) return [];
  const root = doneDir(cwd);
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  for (const name of entries) {
    const entryDir = path.join(root, name);
    const file = path.join(entryDir, "dod.json");
    try {
      if (!fs.statSync(file).isFile()) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<DodChecklist>;
      const updatedAt = typeof parsed.updatedAt === "string" ? Date.parse(parsed.updatedAt) : NaN;
      const ageMs = Number.isFinite(updatedAt) ? Date.now() - updatedAt : Number.POSITIVE_INFINITY;
      if (ageMs <= maxAgeMs) continue;
      fs.rmSync(entryDir, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Unreadable entry — leave it in place for a human to inspect.
    }
  }
  return removed;
}

export function loadDod(cwd: string, goalId: string): DodChecklist | null {
  try {
    const raw = fs.readFileSync(dodPath(cwd, goalId), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Partial<DodChecklist>;
    if (typeof obj.goalId !== "string" || !Array.isArray(obj.items)) return null;
    return obj as DodChecklist;
  } catch {
    return null;
  }
}

export function saveDod(cwd: string, checklist: DodChecklist): void {
  atomicWriteJson(dodPath(cwd, checklist.goalId), checklist);
}

/** Create a fresh checklist from spec-lane output. */
export function createDod(
  cwd: string,
  goalId: string,
  objective: string,
  items: Array<{ id: string; requirement: string; acceptanceCriteria: string }>,
  authoredBy?: string,
): DodChecklist {
  const now = new Date().toISOString();
  const checklist: DodChecklist = {
    goalId,
    objective,
    createdAt: now,
    updatedAt: now,
    authoredBy,
    items: items.map((i) => ({ ...i, status: "pending" as DodItemStatus })),
  };
  saveDod(cwd, checklist);
  return checklist;
}

export function updateItem(
  cwd: string,
  goalId: string,
  itemId: string,
  status: DodItemStatus,
  evidence?: string,
): DodChecklist | null {
  const checklist = loadDod(cwd, goalId);
  if (!checklist) return null;
  const item = checklist.items.find((i) => i.id === itemId);
  if (!item) return null;
  item.status = status;
  if (evidence !== undefined) item.evidence = evidence;
  item.updatedAt = new Date().toISOString();
  checklist.updatedAt = new Date().toISOString();
  saveDod(cwd, checklist);
  return checklist;
}

export function pendingItems(checklist: DodChecklist): DodItem[] {
  return checklist.items.filter((i) => i.status === "pending" || i.status === "failed");
}

export function failedItems(checklist: DodChecklist): DodItem[] {
  return checklist.items.filter((i) => i.status === "failed");
}

export function verifiedCount(checklist: DodChecklist): number {
  return checklist.items.filter((i) => i.status === "verified").length;
}

/** True when at least one item is failed — used to fire gap steers. */
export function hasFailures(checklist: DodChecklist): boolean {
  return failedItems(checklist).length > 0;
}
