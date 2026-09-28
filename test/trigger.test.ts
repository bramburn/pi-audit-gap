/** Tests for the trigger policy. */

import { test } from "node:test";
import assert from "node:assert/strict";

import { TriggerPolicy, type AuditAction } from "../dist/trigger.js";
import { createDod, type DodChecklist } from "../dist/dod.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GoalLedgerEvent } from "../dist/types.js";

function withTempDir(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auditgap-trigger-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function baseInput(overrides: Partial<Parameters<TriggerPolicy["evaluate"]>[0]>) {
  return {
    turn: 1,
    events: [] as GoalLedgerEvent[],
    knownGoals: new Map<string, string>(),
    loadChecklist: () => null,
    ...overrides,
  };
}

test("goal_created fires spec-audit when no checklist exists", () => {
  const policy = new TriggerPolicy();
  const events: GoalLedgerEvent[] = [
    { type: "goal_created", goalId: "g1", objective: "build inbox", sisyphus: false, autoContinue: true, at: "t" },
  ];
  const actions = policy.evaluate(baseInput({ events }));
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], { type: "spec-audit", goalId: "g1", objective: "build inbox", reason: "goal_created" });
});

test("goal_created does not re-fire when a checklist already exists", () => {
  withTempDir((cwd) => {
    createDod(cwd, "g1", "obj", [{ id: "a", requirement: "r", acceptanceCriteria: "x" }]);
    const policy = new TriggerPolicy();
    const events: GoalLedgerEvent[] = [
      { type: "goal_created", goalId: "g1", objective: "build inbox", sisyphus: false, autoContinue: true, at: "t" },
    ];
    const actions = policy.evaluate(
      baseInput({ events, loadChecklist: (gid) => (gid === "g1" ? createDod(cwd, gid, "obj", []) : null) }),
    );
    assert.equal(actions.filter((a) => a.type === "spec-audit").length, 0);
  });
});

test("completion_requested fires gap-audit once per goal", () => {
  const policy = new TriggerPolicy();
  const events: GoalLedgerEvent[] = [
    { type: "completion_requested", goalId: "g1", at: "t" },
    { type: "completion_requested", goalId: "g1", at: "t2" },
  ];
  const knownGoals = new Map([["g1", "obj"]]);
  const first = policy.evaluate(baseInput({ events, knownGoals }));
  assert.equal(first.filter((a: AuditAction) => a.type === "gap-audit").length, 1);
  const second = policy.evaluate(baseInput({ events: [], knownGoals, turn: 2 }));
  assert.equal(second.filter((a: AuditAction) => a.type === "gap-audit").length, 0);
});

test("goal_completed forgets tracking; later completion re-fires", () => {
  const policy = new TriggerPolicy();
  const knownGoals = new Map([["g1", "obj"]]);
  policy.evaluate(baseInput({ events: [{ type: "completion_requested", goalId: "g1", at: "t" }], knownGoals }));
  policy.evaluate(baseInput({ events: [{ type: "goal_completed", goalId: "g1", at: "t2" }], knownGoals, turn: 2 }));
  const actions = policy.evaluate(baseInput({ events: [{ type: "completion_requested", goalId: "g1", at: "t3" }], knownGoals, turn: 3 }));
  assert.equal(actions.filter((a) => a.type === "gap-audit").length, 1);
});

test("interval sweep fires cover-check for pending items, budget-bounded", () => {
  withTempDir((cwd) => {
    const items = Array.from({ length: 9 }, (_, i) => ({ id: "item-" + i, requirement: "r" + i, acceptanceCriteria: "x" }));
    createDod(cwd, "g1", "obj", items);
    const stored = new Map<string, DodChecklist>([["g1", loadDodOrThrow(cwd, "g1")]]);
    const policy = new TriggerPolicy();
    const knownGoals = new Map([["g1", "obj"]]);
    process.env.AUDITGAP_TURN_INTERVAL = "30";
    process.env.AUDITGAP_COVER_MAX_CALLS = "5";
    try {
      const actions = policy.evaluate(
        baseInput({ turn: 30, events: [], knownGoals, loadChecklist: (gid) => stored.get(gid) ?? null }),
      );
      const cover = actions.filter((a) => a.type === "cover-check");
      assert.equal(cover.length, 1);
      assert.equal(cover[0].type === "cover-check" && cover[0].itemIds.length, 5);
    } finally {
      delete process.env.AUDITGAP_TURN_INTERVAL;
      delete process.env.AUDITGAP_COVER_MAX_CALLS;
    }
  });
});

function loadDodOrThrow(cwd: string, goalId: string): DodChecklist {
  // local import cycle avoidance: createDod already wrote; re-read via dod module
  const loaded = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "audit-gap", goalId, "dod.json"), "utf8")) as DodChecklist;
  return loaded;
}

test("plateau escalates to gap-audit after configured sweeps", () => {
  withTempDir((cwd) => {
    createDod(cwd, "g1", "obj", [{ id: "a", requirement: "r", acceptanceCriteria: "x" }]);
    const checklist = loadDodOrThrow(cwd, "g1");
    const policy = new TriggerPolicy();
    const knownGoals = new Map([["g1", "obj"]]);
    process.env.AUDITGAP_TURN_INTERVAL = "10";
    process.env.AUDITGAP_PLATEAU_SWEEPS = "2";
    try {
      // Sweep 1 (turn 10): verified count 0 -> strike 1, no escalation.
      const a1 = policy.evaluate(baseInput({ turn: 10, events: [], knownGoals, loadChecklist: () => checklist }));
      assert.equal(a1.filter((x) => x.type === "gap-audit").length, 0);
      // Sweep 2 (turn 20): still 0 -> strike 2 -> escalate.
      const a2 = policy.evaluate(baseInput({ turn: 20, events: [], knownGoals, loadChecklist: () => checklist }));
      assert.equal(a2.filter((x) => x.type === "gap-audit").length, 1);
      assert.equal(a2.find((x) => x.type === "gap-audit")?.type === "gap-audit" && (a2.find((x) => x.type === "gap-audit") as { reason: string }).reason, "plateau");
    } finally {
      delete process.env.AUDITGAP_TURN_INTERVAL;
      delete process.env.AUDITGAP_PLATEAU_SWEEPS;
    }
  });
});

test("no sweep when no goals are known", () => {
  const policy = new TriggerPolicy();
  process.env.AUDITGAP_TURN_INTERVAL = "30";
  try {
    const actions = policy.evaluate(baseInput({ turn: 30, events: [] }));
    assert.equal(actions.length, 0);
  } finally {
    delete process.env.AUDITGAP_TURN_INTERVAL;
  }
});

test("forced actions bypass policy gates", () => {
  const policy = new TriggerPolicy();
  const force: AuditAction[] = [{ type: "gap-audit", goalId: "gx", reason: "manual" }];
  const actions = policy.evaluate(baseInput({ turn: 7, events: [], force }));
  assert.deepEqual(actions, force);
});
