/**
 * pi-goal-x goal-ledger poller.
 *
 * pi-goal-x appends typed lifecycle events to
 * `<cwd>/.pi/goals/goal_events.jsonl` (append-only, strictly ordered,
 * written synchronously at each lifecycle point). We consume it with a
 * byte-offset diff: each poll reads only bytes appended since the last
 * poll, splits complete lines (the tail line may be mid-append), and
 * advances the offset past what it successfully parsed.
 *
 * Robustness rules:
 * - Rotation/shrink: if the file is smaller than our offset, the ledger
 *   was reset (or a new session began) — rewind to 0 and re-read.
 * - Malformed lines are counted and skipped, never thrown.
 * - Append failures in pi-goal-x are silent by design, so a crash window
 *   can drop a `goal_created`; the caller compensates by backfilling
 *   from `.pi/goals/active_goal_*.md` (see backfill.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isValidLedgerEvent, type GoalLedgerEvent } from "./types.js";

export const GOAL_LEDGER_REL = path.join(".pi", "goals", "goal_events.jsonl");

export interface LedgerPollResult {
  events: GoalLedgerEvent[];
  malformed: number;
  /** True when the file shrank/rotated and the offset was reset to 0. */
  rotated: boolean;
}

export class GoalLedgerPoller {
  private offset = 0;
  /** Leftover partial line from the previous poll (no trailing \n yet). */
  private pending = "";

  ledgerPath(cwd: string): string {
    return path.resolve(cwd, GOAL_LEDGER_REL);
  }

  currentOffset(): number {
    return this.offset;
  }

  /** Test/helper hook: seed the offset. */
  reset(): void {
    this.offset = 0;
    this.pending = "";
  }

  poll(cwd: string): LedgerPollResult {
    const filePath = this.ledgerPath(cwd);
    let content: string;
    let rotated = false;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size < this.offset) {
        this.offset = 0;
        this.pending = "";
        rotated = true;
      }
      // Read only the tail from the last known offset. stat again after
      // open is unnecessary — a short read just yields fewer events.
      const fd = fs.openSync(filePath, "r");
      try {
        const size = stat.size - this.offset;
        const buf = Buffer.alloc(Math.max(size, 0));
        const read = size > 0 ? fs.readSync(fd, buf, 0, size, this.offset) : 0;
        content = buf.subarray(0, read).toString("utf8");
        this.offset += read;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Missing ledger (pi-goal-x not installed / no goals yet) is a
      // normal state — report nothing.
      return { events: [], malformed: 0, rotated };
    }

    const chunk = this.pending + content;
    const lines = chunk.split("\n");
    // The final element is either "" (chunk ended with \n) or a partial
    // line still being appended — hold it for next poll.
    this.pending = lines.pop() ?? "";

    const events: GoalLedgerEvent[] = [];
    let malformed = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isValidLedgerEvent(parsed)) {
          events.push(parsed);
        } else {
          malformed++;
        }
      } catch {
        malformed++;
      }
    }
    return { events, malformed, rotated };
  }
}

/**
 * Latest event of a given type for a goal, scanning backwards.
 * Used to answer "has this goal already requested completion?" without
 * replaying the whole log on every turn.
 */
export function latestEventForGoal(
  events: GoalLedgerEvent[],
  goalId: string,
  type: GoalLedgerEvent["type"],
): GoalLedgerEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === type && "goalId" in e && e.goalId === goalId) return e;
  }
  return undefined;
}
