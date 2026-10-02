/** Tests for steer builders and payload assembly. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildCoverSteerBody, buildGapSteerBody, buildSpecSteerBody, steerPrefix, steerProviderTag } from "../dist/steer.js";
import { enforcePayloadSize, extractRouteFiles } from "../dist/assemble.js";
import { stripJsonFences, validateCoverCheckResponse, validateGapAuditResponse, validateSpecAuditResponse } from "../dist/client.js";
import type { DodChecklist } from "../dist/types.js";

function sampleChecklist(overrides?: Partial<DodChecklist>): DodChecklist {
  return {
    goalId: "g1",
    objective: "Build a unified inbox like Freshdesk",
    createdAt: "t",
    updatedAt: "t",
    items: [
      { id: "internal-notes", requirement: "Internal notes on tickets", acceptanceCriteria: "route present", status: "failed", evidence: "no notes module" },
      { id: "reply-all", requirement: "Reply-all expands recipients", acceptanceCriteria: "handler exists", status: "pending" },
      { id: "uploads", requirement: "File upload on tickets", acceptanceCriteria: "upload endpoint", status: "verified" },
    ],
    ...overrides,
  };
}

test("steerProviderTag honors env and sanitizes", () => {
  delete process.env.AUDITGAP_SPEC_PROVIDER;
  delete process.env.AUDITGAP_COVER_PROVIDER;
  delete process.env.AUDITGAP_STEER_PROVIDER;
  assert.equal(steerProviderTag("spec"), "OPUS");
  assert.equal(steerProviderTag("cover"), "DS");
  assert.equal(steerProviderTag("steer"), "OPUS");
  process.env.AUDITGAP_SPEC_PROVIDER = "claude opus 5.5!";
  assert.equal(steerProviderTag("spec"), "CLAUDEOPUS55");
  // Steer lane rides the spec provider tag until it gets its own pick.
  assert.equal(steerProviderTag("steer"), "CLAUDEOPUS55");
  process.env.AUDITGAP_STEER_PROVIDER = "kimi k3";
  assert.equal(steerProviderTag("steer"), "KIMIK3");
  delete process.env.AUDITGAP_SPEC_PROVIDER;
  delete process.env.AUDITGAP_STEER_PROVIDER;
});

test("steerPrefix builds the Tier-3 tag", () => {
  delete process.env.AUDITGAP_SPEC_PROVIDER;
  assert.equal(steerPrefix("spec"), "[STEER:OPUS]");
  assert.equal(steerPrefix("spec", "GAP AUDIT"), "[STEER:OPUS][GAP AUDIT]");
});

test("buildSpecSteerBody lists items and points at dod.json", () => {
  const body = buildSpecSteerBody(sampleChecklist(), "/x/.pi/audit-gap/g1/dod.json");
  assert.ok(body.startsWith("[STEER:OPUS][SPEC CHECKLIST]"));
  assert.ok(body.includes("internal-notes"));
  assert.ok(body.includes("/x/.pi/audit-gap/g1/dod.json"));
});

test("buildGapSteerBody surfaces failed + pending + missing requirements", () => {
  const body = buildGapSteerBody(
    sampleChecklist(),
    ["compose window with rich-text editor"],
    "Core present, collaboration missing",
    "/x/dod.json",
  );
  assert.ok(body.startsWith("[STEER:OPUS][GAP AUDIT]"));
  assert.ok(body.includes("Internal notes on tickets"));
  assert.ok(body.includes("Reply-all expands recipients"));
  assert.ok(body.includes("compose window with rich-text editor"));
});

test("buildCoverSteerBody empty when no failures among checked items", () => {
  const checklist = sampleChecklist();
  assert.equal(buildCoverSteerBody(checklist, ["uploads"], "/x/dod.json"), "");
  const body = buildCoverSteerBody(checklist, ["internal-notes"], "/x/dod.json");
  assert.ok(body.startsWith("[STEER:DS][COVERAGE CHECK]"));
  assert.ok(body.includes("internal-notes"));
});

test("enforcePayloadSize clamps and marks", () => {
  const big = "x".repeat(100 * 1024);
  const clamped = enforcePayloadSize(big, 64 * 1024);
  assert.ok(Buffer.byteLength(clamped) <= 64 * 1024 + 64);
  assert.ok(clamped.includes("clamped by pi-audit-gap"));
});

test("extractRouteFiles finds route-ish paths", () => {
  const inventory = [
    "src/routes/tickets.ts",
    "src/pages/inbox.tsx",
    "src/components/Button.tsx",
    "src/api/webhooks.routes.ts",
    "README.md",
    "src/server/router.ts",
  ];
  const routes = extractRouteFiles(inventory);
  assert.deepEqual(routes.sort(), [
    "src/api/webhooks.routes.ts",
    "src/pages/inbox.tsx",
    "src/routes/tickets.ts",
    "src/server/router.ts",
  ]);
});

test("stripJsonFences unwraps fenced JSON", () => {
  assert.equal(stripJsonFences('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripJsonFences('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripJsonFences('{"a":1}'), '{"a":1}');
});

test("validateSpecAuditResponse enforces shape", () => {
  const ok = validateSpecAuditResponse({
    checklist: [{ id: "a", requirement: "r", acceptance_criteria: "ac" }],
    risks: ["risk one"],
  });
  assert.equal(ok.checklist.length, 1);
  assert.throws(() => validateSpecAuditResponse({ checklist: [], risks: [] }));
  assert.throws(() => validateSpecAuditResponse({ checklist: [{ id: 1, requirement: "r", acceptance_criteria: "x" }], risks: [] }));
  assert.throws(() => validateSpecAuditResponse({ risks: [] }));
});

test("validateGapAuditResponse coerces verdicts and collects missing", () => {
  const ok = validateGapAuditResponse({
    item_verdicts: [
      { id: "a", verdict: "pass", reason: "seen" },
      { id: "b", verdict: "bogus", reason: "?" },
    ],
    missing_requirements: ["compose"],
    summary: "s",
  });
  assert.equal(ok.itemVerdicts[1].verdict, "unknown");
  assert.deepEqual(ok.missingRequirements, ["compose"]);
  assert.throws(() => validateGapAuditResponse(null));
});

test("validateCoverCheckResponse defaults unknown verdict", () => {
  assert.deepEqual(validateCoverCheckResponse({ verdict: "pass", reason: "r" }), { verdict: "pass", reason: "r" });
  assert.equal(validateCoverCheckResponse({ verdict: "nope" }).verdict, "unknown");
  assert.throws(() => validateCoverCheckResponse([]));
});

// assemble payload builders run real git commands — exercise against a
// throwaway repo so the inventory/diff/commit code paths are covered.
test("spec payload includes goal, inventory, and commits in a real repo", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "auditgap-assemble-"));
  try {
    fs.writeFileSync(path.join(cwd, "file.txt"), "hello");
    const run = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    run(["init", "-q"]);
    run(["add", "."]);
    run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
    fs.appendFileSync(path.join(cwd, "file.txt"), " world");

    const assemble = await import("../dist/assemble.js");
    const payload = assemble.buildSpecPayload({ objective: "Build the thing", cwd });
    assert.ok(payload.includes("=== GOAL (from pi-goal-x) ==="));
    assert.ok(payload.includes("Build the thing"));
    assert.ok(payload.includes("file.txt"));
    assert.ok(payload.includes("init"));

    const diff = assemble.gitDiffSummary(cwd);
    assert.ok(diff && diff.includes("file.txt"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
