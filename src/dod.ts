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
 * file by returning null.
 */

import * as fs from "node:fs";
import * as path from "node:path";
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

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
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
