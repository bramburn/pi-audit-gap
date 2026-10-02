/**
 * Tier-3 steering-message builders.
 *
 * Same tagging discipline as pi-harvest: every synthetic supervision
 * message starts with `[STEER:<PROVIDER>]` so downstream slicers classify
 * it as Tier 3 (supervisor), never a user prompt. Provider tags come
 * from AUDITGAP_SPEC_PROVIDER / AUDITGAP_STEER_PROVIDER /
 * AUDITGAP_COVER_PROVIDER (uppercased, sanitized), defaulting to OPUS / DS.
 *
 * Steers POINT AT the dod.json artifact rather than duplicating its
 * state — the checklist file is the source of truth (a weak worker model
 * must not be able to rewrite supervision state via chat).
 */

import type { DodChecklist, DodItem } from "./types.js";

const MAX_STEER_BYTES = 16 * 1024;

export function steerProviderTag(lane: "spec" | "cover" | "steer"): string {
  const envKey = lane === "spec" ? "AUDITGAP_SPEC_PROVIDER" : lane === "cover" ? "AUDITGAP_COVER_PROVIDER" : "AUDITGAP_STEER_PROVIDER";
  const fallback = lane === "spec" || lane === "steer" ? "OPUS" : "DS";
  // The steer (gap-audit) lane rides the spec lane when it has no own
  // pick, so its provider tag falls back to the spec provider tag.
  const raw = (
    process.env[envKey] ??
    (lane === "steer" ? process.env.AUDITGAP_SPEC_PROVIDER : undefined) ??
    fallback
  ).trim().toUpperCase();
  const sanitized = raw.replace(/[^A-Z0-9_-]/g, "");
  return sanitized.length > 0 ? sanitized : fallback;
}

export function steerPrefix(lane: "spec" | "cover" | "steer", subLabel?: string): string {
  const sub = subLabel?.trim();
  return "[STEER:" + steerProviderTag(lane) + "]" + (sub ? "[" + sub + "]" : "");
}

export function enforceSteerSize(body: string): string {
  if (Buffer.byteLength(body, "utf8") <= MAX_STEER_BYTES) return body;
  const buf = Buffer.from(body, "utf8");
  const sliced = buf.subarray(0, MAX_STEER_BYTES).toString("utf8");
  const lastNewline = sliced.lastIndexOf("\n");
  const cut = lastNewline > 0 ? sliced.slice(0, lastNewline) : sliced;
  return cut + "\n[... steer clamped by pi-audit-gap ...]";
}

function itemLine(item: DodItem): string {
  return "- " + item.id + ": " + item.requirement + (item.evidence ? " (" + item.evidence + ")" : "");
}

/**
 * Steer sent when the spec checklist has just been generated: the worker
 * learns what "done" means while it still has context budget.
 */
export function buildSpecSteerBody(checklist: DodChecklist, dodFilePath: string): string {
  const lines: string[] = [];
  lines.push(steerPrefix("spec", "SPEC CHECKLIST"));
  lines.push("Goal: " + checklist.objective);
  lines.push("Definition-of-done checklist generated — " + checklist.items.length + " item(s):");
  for (const item of checklist.items) lines.push(itemLine(item));
  lines.push("Track progress against: " + dodFilePath);
  lines.push("Implement every item before requesting goal completion.");
  return enforceSteerSize(lines.join("\n"));
}

/**
 * Steer sent on completion_requested when gaps exist. Lands BEFORE
 * pi-goal-x archives the goal (deferred archival at turn_end), so gaps
 * become continuation work.
 */
export function buildGapSteerBody(
  checklist: DodChecklist,
  missingRequirements: string[],
  summary: string,
  dodFilePath: string,
): string {
  const failed = checklist.items.filter((i) => i.status === "failed");
  const pending = checklist.items.filter((i) => i.status === "pending");
  const lines: string[] = [];
  lines.push(steerPrefix("steer", "GAP AUDIT"));
  lines.push("Goal completion requested, but coverage gaps remain — DO NOT stop yet.");
  if (summary) lines.push("Auditor summary: " + summary);
  if (failed.length > 0) {
    lines.push("Failed items:");
    for (const item of failed) lines.push(itemLine(item));
  }
  if (pending.length > 0) {
    lines.push("Still pending:");
    for (const item of pending.slice(0, 10)) lines.push(itemLine(item));
    if (pending.length > 10) lines.push("- ... and " + (pending.length - 10) + " more (see " + dodFilePath + ")");
  }
  if (missingRequirements.length > 0) {
    lines.push("Requirement areas MISSING from the plan entirely:");
    for (const r of missingRequirements) lines.push("- " + r);
  }
  lines.push("Fix the above, then re-request completion. Checklist: " + dodFilePath);
  return enforceSteerSize(lines.join("\n"));
}

/** Steer sent when a cover sweep fails items mid-task. */
export function buildCoverSteerBody(checklist: DodChecklist, itemIds: string[], dodFilePath: string): string {
  const failed = checklist.items.filter((i) => itemIds.includes(i.id) && i.status === "failed");
  if (failed.length === 0) return "";
  const lines: string[] = [];
  lines.push(steerPrefix("cover", "COVERAGE CHECK"));
  lines.push("Coverage verification failed " + failed.length + " checklist item(s):");
  for (const item of failed) lines.push(itemLine(item));
  lines.push("Address these before continuing. Checklist: " + dodFilePath);
  return enforceSteerSize(lines.join("\n"));
}
