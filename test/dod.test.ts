/** Tests for the DoD store and goal-file backfill. */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createDod,
  dodPath,
  failedItems,
  hasFailures,
  loadDod,
  pendingItems,
  safeIdPart,
  updateItem,
  verifiedCount,
} from "../dist/dod.js";
import { backfillCandidates, extractObjectiveFromBody, findJsonObjectEnd, parseGoalFile } from "../dist/backfill.js";

function withTempDir(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auditgap-dod-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("safeIdPart sanitizes filesystem-hostile goal ids", () => {
  assert.equal(safeIdPart("goal:42/inbox?"), "goal-42-inbox-");
  assert.equal(safeIdPart("plain-goal_1"), "plain-goal_1");
});

test("createDod -> loadDod roundtrip with pending items", () => {
  withTempDir((cwd) => {
    const checklist = createDod(
      cwd,
      "g1",
      "build a unified inbox",
      [
        { id: "internal-notes", requirement: "Internal notes on tickets", acceptanceCriteria: "route + model present" },
        { id: "reply-all", requirement: "Reply-all expands recipients", acceptanceCriteria: "handler exists" },
      ],
      "opus",
    );
    assert.equal(checklist.items.length, 2);
    assert.equal(checklist.items[0].status, "pending");
    assert.ok(fs.existsSync(dodPath(cwd, "g1")));

    const loaded = loadDod(cwd, "g1");
    assert.ok(loaded);
    assert.equal(loaded.goalId, "g1");
    assert.equal(loaded.items.length, 2);
    assert.equal(loaded.authoredBy, "opus");
  });
});

test("updateItem transitions status and records evidence", () => {
  withTempDir((cwd) => {
    createDod(cwd, "g1", "obj", [{ id: "a", requirement: "r", acceptanceCriteria: "ac" }]);
    const updated = updateItem(cwd, "g1", "a", "verified", "found handler.ts");
    assert.ok(updated);
    assert.equal(updated.items[0].status, "verified");
    assert.equal(updated.items[0].evidence, "found handler.ts");

    const missing = updateItem(cwd, "g1", "nope", "verified");
    assert.equal(missing, null);
  });
});

test("pendingItems / failedItems / verifiedCount / hasFailures", () => {
  withTempDir((cwd) => {
    createDod(cwd, "g1", "obj", [
      { id: "a", requirement: "r1", acceptanceCriteria: "x" },
      { id: "b", requirement: "r2", acceptanceCriteria: "y" },
      { id: "c", requirement: "r3", acceptanceCriteria: "z" },
    ]);
    updateItem(cwd, "g1", "a", "verified");
    updateItem(cwd, "g1", "b", "failed", "no evidence");

    const checklist = loadDod(cwd, "g1")!;
    assert.equal(verifiedCount(checklist), 1);
    assert.deepEqual(pendingItems(checklist).map((i) => i.id).sort(), ["b", "c"]);
    assert.deepEqual(failedItems(checklist).map((i) => i.id), ["b"]);
    assert.equal(hasFailures(checklist), true);
    assert.equal(pendingItems(checklist).length, 2); // pending + failed both need work
  });
});

test("loadDod returns null for missing or corrupt files", () => {
  withTempDir((cwd) => {
    assert.equal(loadDod(cwd, "ghost"), null);
    fs.mkdirSync(path.dirname(dodPath(cwd, "bad")), { recursive: true });
    fs.writeFileSync(dodPath(cwd, "bad"), "{broken");
    assert.equal(loadDod(cwd, "bad"), null);
  });
});

// --- backfill ---------------------------------------------------------------

test("findJsonObjectEnd is string-aware", () => {
  const content = '{"id":"g1","objective":"has } inside string"} trailing';
  const end = findJsonObjectEnd(content);
  assert.equal(content[end], "}");
  assert.equal(content.slice(0, end + 1), '{"id":"g1","objective":"has } inside string"}');
});

test("extractObjectiveFromBody reads the # Goal Prompt section", () => {
  const body = "\n# Goal Prompt\nBuild a unified inbox with compose.\n\n## Progress\n- did stuff\n";
  assert.equal(extractObjectiveFromBody(body), "Build a unified inbox with compose.");
  assert.equal(extractObjectiveFromBody("no header here"), "no header here");
});

test("parseGoalFile reads pi-goal-x active goal files", () => {
  withTempDir((cwd) => {
    const file = path.join(cwd, "active_goal_g1.md");
    fs.writeFileSync(
      file,
      '{"id":"g1","status":"active","objective":"fallback"}' +
        "\n\n# Goal Prompt\nBuild the inbox.\n\n## Progress\nnone\n",
    );
    const parsed = parseGoalFile(file);
    assert.ok(parsed);
    assert.equal(parsed.goalId, "g1");
    assert.equal(parsed.objective, "Build the inbox.");
    assert.equal(parsed.status, "active");
  });
});

test("backfillCandidates finds active goals missing from the seen set", () => {
  withTempDir((cwd) => {
    const goalsDir = path.join(cwd, ".pi", "goals");
    fs.mkdirSync(goalsDir, { recursive: true });
    fs.writeFileSync(
      path.join(goalsDir, "active_goal_g1.md"),
      '{"id":"g1","status":"active"}' + "\n# Goal Prompt\nInbox\n",
    );
    fs.writeFileSync(
      path.join(goalsDir, "active_goal_g2.md"),
      '{"id":"g2","status":"complete"}' + "\n# Goal Prompt\nDone\n",
    );
    fs.writeFileSync(path.join(goalsDir, "notes.md"), "not a goal file");

    const cands = backfillCandidates(cwd, new Set());
    assert.equal(cands.length, 1);
    assert.equal(cands[0].goalId, "g1");

    // Already seen -> no candidate.
    assert.equal(backfillCandidates(cwd, new Set(["g1"])).length, 0);
  });
});
