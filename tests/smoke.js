/**
 * Smoke test: load dist/index.js exactly the way pi's extension loader
 * would (require the CJS build, take the default export, pass a minimal
 * ExtensionAPI) and drive the turn_end pipeline against a fixture goal
 * ledger. No network — lane credentials are intentionally unset so the
 * audit calls exercise the graceful AuditGapConfigError notify path.
 *
 * Run from the repo root:  node tests/smoke.js
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const mod = require("../dist/index.js");
assert.equal(typeof mod.default, "function", "dist/index.js must default-export the extension");

// --- fixture workspace ------------------------------------------------------
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "auditgap-smoke-"));
fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
const ledger = path.join(cwd, ".pi", "goals", "goal_events.jsonl");
const created = {
  type: "goal_created",
  goalId: "smoke-goal",
  objective: "Build a unified inbox like Freshdesk",
  sisyphus: false,
  autoContinue: true,
  at: "2026-09-28T00:00:00Z",
};
fs.writeFileSync(ledger, JSON.stringify(created) + "\n");

// --- mock ExtensionAPI ------------------------------------------------------
const notifications = [];
const steers = [];
const commands = new Map();
let turnEndHandler = null;

const mockUi = {
  notify: (msg, level) => notifications.push({ msg, level }),
  setStatus: () => {},
};

const pi = {
  on: (event, handler) => {
    if (event === "turn_end") turnEndHandler = handler;
  },
  sendUserMessage: (content, opts) => {
    steers.push({ content, opts });
  },
  registerCommand: (name, options) => {
    commands.set(name, options.handler);
  },
};

mod.default(pi);
assert.ok(turnEndHandler, "extension must register a turn_end handler");
assert.ok(commands.has("auditgap"), "extension must register the auditgap command");

const ctx = { ui: mockUi, cwd, model: { provider: "minimax", id: "MiniMax-M3.1" } };

/** Let fire-and-forget async lane calls settle before asserting. */
const tick = () => new Promise((r) => setTimeout(r, 25));

async function main() {
  // --- drive the pipeline -----------------------------------------------------
  turnEndHandler({}, ctx); // turn 1: poll picks up goal_created -> spec audit (config error path)
  await tick();
  assert.ok(
    notifications.some((n) => n.msg.includes("Spec lane not configured")),
    "expected a graceful config-error notify, got: " + JSON.stringify(notifications.map((n) => n.msg)),
  );

  // turn 2: append completion_requested -> gap audit (config error path again)
  fs.appendFileSync(
    ledger,
    JSON.stringify({ type: "completion_requested", goalId: "smoke-goal", summary: "done?", at: "2026-09-28T01:00:00Z" }) + "\n",
  );
  turnEndHandler({}, ctx);
  await tick();
  assert.ok(
    notifications.filter((n) => n.msg.includes("Spec lane not configured")).length >= 2,
    "gap audit should also surface the config-error notify",
  );

  // No steers should have been injected — the lanes never succeeded.
  assert.equal(steers.length, 0, "no steers expected when lanes are unconfigured");

  // Backfill: a goal file with no ledger event must synthesize a trigger.
  fs.writeFileSync(
    path.join(cwd, ".pi", "goals", "active_goal_orphan.md"),
    '{"id":"orphan-goal","status":"active"}' + "\n# Goal Prompt\nWire webhooks.\n",
  );
  turnEndHandler({}, ctx);
  await tick();
  assert.ok(
    notifications.some((n) => n.msg.includes("Backfilled goal from state file: orphan-goal")),
    "expected backfill notify, got: " + JSON.stringify(notifications.map((n) => n.msg)),
  );

  // dod.json artifacts must NOT exist (spec lane never succeeded).
  assert.equal(fs.existsSync(path.join(cwd, ".pi", "audit-gap", "smoke-goal", "dod.json")), false);

  // status command must run without throwing.
  let statusMsg = null;
  mockUi.notify = (msg) => {
    statusMsg = msg;
  };
  commands.get("auditgap")("status", ctx);
  assert.ok(statusMsg && statusMsg.includes("[AuditGap] Turn:"), "status must render the widget line");
  assert.ok(statusMsg.includes("smoke-goal"), "status must list known goals");

  fs.rmSync(cwd, { recursive: true, force: true });
  console.log("smoke ok — pipeline, config-error resilience, backfill, and status all verified");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
