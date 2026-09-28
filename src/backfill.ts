/**
 * Goal-state backfill.
 *
 * pi-goal-x treats ledger append failures as silent, so a `goal_created`
 * event can be lost in a crash window. pi-goal-x ALSO writes each active
 * goal to `.pi/goals/active_goal_<id>.md` as a JSON record prefix
 * followed by a `# Goal Prompt` markdown body. When our poller sees a
 * goal file with no ledger creation event and no dod.json, we backfill:
 * synthesize the objective from the file and let the trigger layer run
 * the spec audit as usual.
 *
 * This is a deliberately minimal parser of a documented-on-disk format —
 * not a deep import of pi-goal-x internals.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { safeIdPart } from "./dod.js";

export const GOALS_DIR_REL = path.join(".pi", "goals");

export interface GoalFileInfo {
  goalId: string;
  objective: string;
  status?: string;
}

/** Find the end of the leading JSON object (string-aware brace match). */
export function findJsonObjectEnd(content: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Extract the user-editable objective from the `# Goal Prompt` body. */
export function extractObjectiveFromBody(body: string): string | undefined {
  const lines = body.replace(/^\s+/, "").split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "# Goal Prompt");
  if (start < 0) return body.trim() || undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "## Progress") {
      end = i;
      break;
    }
  }
  const text = lines.slice(start + 1, end).join("\n").trim();
  return text || undefined;
}

export function parseGoalFile(filePath: string): GoalFileInfo | null {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) return null;
    const content = fs.readFileSync(filePath, "utf8");
    const end = findJsonObjectEnd(content);
    if (end < 0) return null;
    const raw = JSON.parse(content.slice(0, end + 1)) as Record<string, unknown>;
    if (typeof raw.id !== "string") return null;
    const objective =
      extractObjectiveFromBody(content.slice(end + 1)) ??
      (typeof raw.objective === "string" ? raw.objective : "");
    return {
      goalId: raw.id,
      objective,
      status: typeof raw.status === "string" ? raw.status : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Active goals on disk that are missing from `seenGoalIds` (goals we
 * already learned about via the ledger). Used to recover a lost
 * `goal_created`; also the safety net when pi-goal-x is mid-write.
 */
export function backfillCandidates(cwd: string, seenGoalIds: Set<string>): GoalFileInfo[] {
  const root = path.resolve(cwd, GOALS_DIR_REL);
  let entries: string[];
  try {
    if (fs.lstatSync(root).isSymbolicLink()) return [];
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: GoalFileInfo[] = [];
  for (const name of entries) {
    if (!/^active_goal_.*\.md$/.test(name)) continue;
    const rel = path.join(GOALS_DIR_REL, name);
    const normalized = rel.replace(/\\/g, "/");
    if (normalized.includes("..")) continue;
    const parsed = parseGoalFile(path.resolve(cwd, rel));
    if (!parsed) continue;
    if (parsed.status === "complete") continue;
    if (seenGoalIds.has(parsed.goalId) || seenGoalIds.has(safeIdPart(parsed.goalId))) continue;
    out.push(parsed);
  }
  return out;
}
