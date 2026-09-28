/** Tests for the goal-ledger poller and event validation. */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GoalLedgerPoller, GOAL_LEDGER_REL, latestEventForGoal } from "../dist/ledger.js";
import { isValidLedgerEvent } from "../dist/types.js";

function withTempDir(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auditgap-ledger-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ledgerPath(cwd: string): string {
  const p = path.join(cwd, GOAL_LEDGER_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

test("poll returns empty when ledger is missing", () => {
  withTempDir((cwd) => {
    const poller = new GoalLedgerPoller();
    const res = poller.poll(cwd);
    assert.deepEqual(res.events, []);
    assert.equal(res.malformed, 0);
  });
});

test("poll reads complete lines incrementally by offset", () => {
  withTempDir((cwd) => {
    const file = ledgerPath(cwd);
    const e1 = { type: "goal_created", goalId: "g1", objective: "build inbox", sisyphus: false, autoContinue: true, at: "2026-09-28T00:00:00Z" };
    const e2 = { type: "completion_requested", goalId: "g1", summary: "done?", at: "2026-09-28T01:00:00Z" };
    fs.writeFileSync(file, JSON.stringify(e1) + "\n");

    const poller = new GoalLedgerPoller();
    const first = poller.poll(cwd);
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0].type, "goal_created");
    const offsetAfterFirst = poller.currentOffset();
    assert.ok(offsetAfterFirst > 0);

    // Second poll with nothing appended yields nothing and keeps offset.
    const empty = poller.poll(cwd);
    assert.equal(empty.events.length, 0);
    assert.equal(poller.currentOffset(), offsetAfterFirst);

    // Append more -> only the new event comes through.
    fs.appendFileSync(file, JSON.stringify(e2) + "\n");
    const second = poller.poll(cwd);
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0].type, "completion_requested");
  });
});

test("partial tail line is buffered until completed", () => {
  withTempDir((cwd) => {
    const file = ledgerPath(cwd);
    const whole = JSON.stringify({ type: "goal_completed", goalId: "g1", at: "2026-09-28T02:00:00Z" }) + "\n";
    const half = whole.slice(0, Math.floor(whole.length / 2));
    fs.writeFileSync(file, half);

    const poller = new GoalLedgerPoller();
    const res = poller.poll(cwd);
    assert.equal(res.events.length, 0);

    fs.appendFileSync(file, whole.slice(half.length));
    const res2 = poller.poll(cwd);
    assert.equal(res2.events.length, 1);
    assert.equal(res2.events[0].type, "goal_completed");
  });
});

test("malformed lines are counted, not thrown", () => {
  withTempDir((cwd) => {
    const file = ledgerPath(cwd);
    fs.writeFileSync(
      file,
      "not json\n" +
        JSON.stringify({ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "t" }) +
        "\n{bad\n",
    );
    const poller = new GoalLedgerPoller();
    const res = poller.poll(cwd);
    assert.equal(res.events.length, 1);
    assert.equal(res.malformed, 2);
  });
});

test("rotation (file shrink) resets offset and re-reads", () => {
  withTempDir((cwd) => {
    const file = ledgerPath(cwd);
    const e1 = { type: "goal_created", goalId: "g1", objective: "a", sisyphus: false, autoContinue: true, at: "t1" };
    fs.writeFileSync(file, JSON.stringify(e1) + "\n");
    const poller = new GoalLedgerPoller();
    poller.poll(cwd);

    const e2 = { type: "goal_completed", goalId: "g2", at: "t2" };
    fs.writeFileSync(file, JSON.stringify(e2) + "\n"); // much smaller -> shrink
    const res = poller.poll(cwd);
    assert.equal(res.rotated, true);
    assert.equal(res.events.length, 1);
    assert.equal((res.events[0] as { goalId: string }).goalId, "g2");
  });
});

test("event validation: strict types require payloads, loose types pass", () => {
  assert.equal(
    isValidLedgerEvent({ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "t" }),
    true,
  );
  assert.equal(isValidLedgerEvent({ type: "goal_created", goalId: "g1", at: "t" }), false); // missing objective
  assert.equal(isValidLedgerEvent({ type: "completion_requested", goalId: "g1", at: "t" }), true);
  assert.equal(isValidLedgerEvent({ type: "audit_skipped", reason: "disabled", at: "t" }), true); // loose
  assert.equal(isValidLedgerEvent({ type: "nonsense", at: "t" }), true); // loose pass-through
  assert.equal(isValidLedgerEvent("string"), false);
  assert.equal(isValidLedgerEvent({ type: "goal_created" }), false); // no at
});

test("latestEventForGoal scans backwards", () => {
  const events = [
    { type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "1" },
    { type: "goal_paused", goalId: "g1", reason: "r", at: "2" },
    { type: "goal_resumed", goalId: "g1", at: "3" },
  ] as const;
  const arr = [...events] as import("../dist/types.js").GoalLedgerEvent[];
  const latest = latestEventForGoal(arr, "g1", "goal_paused");
  assert.equal(latest?.type, "goal_paused");
  assert.equal(latestEventForGoal(arr, "g1", "goal_completed"), undefined);
  assert.equal(latestEventForGoal(arr, "g2", "goal_paused"), undefined);
});
