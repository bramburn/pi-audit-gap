/**
 * Deterministic, local-only payload assembly.
 *
 * Hard rule (same as pi-harvest's slicing): NO LLM calls to decide what
 * goes into an audit payload. Routing is mechanical — the strong model
 * does the intelligent part (requirement elicitation / gap judgment) on
 * the receiving end, with the full inventory in front of it. Asking the
 * weak worker model to pick "relevant files" is precisely the judgment
 * it fails at.
 *
 * Everything is clamped: unbounded repo scans and diffs must never
 * balloon the audit payload (or the LLM bill).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DodChecklist } from "./types.js";

export const MAX_INVENTORY_LINES = 2000;
export const MAX_COMMITS = 30;
export const MAX_GIT_DIFF_LINES = 200;
export const MAX_PAYLOAD_BYTES = 64 * 1024;

const SKIP_PREFIXES = [".git/", ".pi/", "node_modules/", "dist/", "target/", "build/", ".venv/", "__pycache__/"];

const TRUNCATION_MARKER = "\n[... clamped by pi-audit-gap ...]\n";

export function enforcePayloadSize(payload: string, maxBytes: number = MAX_PAYLOAD_BYTES): string {
  if (Buffer.byteLength(payload, "utf8") <= maxBytes) return payload;
  const buf = Buffer.from(payload, "utf8");
  const sliced = buf.subarray(0, maxBytes).toString("utf8");
  const lastNewline = sliced.lastIndexOf("\n");
  const cut = lastNewline > 0 ? sliced.slice(0, lastNewline) : sliced;
  return cut + TRUNCATION_MARKER;
}

function shouldSkipRelPath(rel: string): boolean {
  const normalized = rel.replace(/\\/g, "/");
  for (const prefix of SKIP_PREFIXES) {
    if (normalized.startsWith(prefix) || normalized.includes("/" + prefix)) return true;
  }
  return false;
}

/**
 * Repo inventory: prefer `git ls-files` (tracked files only — stable,
 * fast, skips junk); fall back to a bounded directory walk when git is
 * unavailable or cwd is not a repo.
 */
export function buildRepoInventory(cwd: string): string[] {
  try {
    const raw = execFileSync("git", ["ls-files"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !shouldSkipRelPath(l))
      .slice(0, MAX_INVENTORY_LINES);
  } catch {
    // Not a git repo / git missing — bounded walk.
  }
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || out.length >= MAX_INVENTORY_LINES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_INVENTORY_LINES) return;
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(cwd, abs).replace(/\\/g, "/");
      if (shouldSkipRelPath(rel)) continue;
      if (e.isDirectory()) walk(abs, depth + 1);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk(cwd, 0);
  return out;
}

/** Route-ish files from the inventory — helps the auditor see the domain surface. */
export function extractRouteFiles(inventory: string[]): string[] {
  const patterns = /(routes?\/|pages\/|app\/.*\/(page|route)\.|controllers\/|endpoints?\/|handlers\/|api\/|\.routes\.(ts|js|py)$|router\.(ts|js)$)/i;
  return inventory.filter((p) => patterns.test(p)).slice(0, 200);
}

export function recentCommits(cwd: string, max: number = MAX_COMMITS): string[] {
  try {
    const raw = execFileSync("git", ["log", "--oneline", "-" + String(max)], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

export function gitDiffSummary(cwd: string): string | null {
  try {
    const raw = execFileSync("git", ["diff", "--stat"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return raw.trim().length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export interface SpecPayloadInput {
  objective: string;
  cwd: string;
}

/**
 * Spec-lane payload: goal + repo inventory + domain surface + recent
 * history. The auditor's job is REQUIREMENT ELICITATION — enumerating
 * what "done" means for this goal — so it does not need worker output,
 * only the goal text and the shape of the codebase.
 */
export function buildSpecPayload(input: SpecPayloadInput): string {
  const inventory = buildRepoInventory(input.cwd);
  const routes = extractRouteFiles(inventory);
  const commits = recentCommits(input.cwd);
  const parts: string[] = [];
  parts.push("=== GOAL (from pi-goal-x) ===");
  parts.push(input.objective);
  parts.push("\n=== REPO INVENTORY (files) ===");
  parts.push(inventory.join("\n") || "(empty)");
  if (routes.length > 0) {
    parts.push("\n=== DOMAIN SURFACE (route/controller-ish files) ===");
    parts.push(routes.join("\n"));
  }
  if (commits.length > 0) {
    parts.push("\n=== RECENT COMMITS ===");
    parts.push(commits.join("\n"));
  }
  return enforcePayloadSize(parts.join("\n"));
}

export interface GapPayloadInput {
  checklist: DodChecklist;
  cwd: string;
}

/**
 * Gap-lane payload: the DoD checklist + current repo shape + what has
 * changed. The auditor's job is GAP DETECTION — which checklist items
 * appear unimplemented, based on file names/paths and the diff stat,
 * NOT on running the code.
 */
export function buildGapPayload(input: GapPayloadInput): string {
  const inventory = buildRepoInventory(input.cwd);
  const routes = extractRouteFiles(inventory);
  const diff = gitDiffSummary(input.cwd);
  const commits = recentCommits(input.cwd);
  const parts: string[] = [];
  parts.push("=== GOAL ===");
  parts.push(input.checklist.objective);
  parts.push("\n=== DEFINITION-OF-DONE CHECKLIST ===");
  for (const item of input.checklist.items) {
    parts.push("- [" + item.status + "] " + item.id + ": " + item.requirement);
    parts.push("    acceptance: " + item.acceptanceCriteria);
    if (item.evidence) parts.push("    evidence: " + item.evidence);
  }
  parts.push("\n=== REPO INVENTORY (files) ===");
  parts.push(inventory.join("\n") || "(empty)");
  if (routes.length > 0) {
    parts.push("\n=== DOMAIN SURFACE ===");
    parts.push(routes.join("\n"));
  }
  if (diff) {
    parts.push("\n=== UNCOMMITTED CHANGES (diff --stat) ===");
    parts.push(diff);
  }
  if (commits.length > 0) {
    parts.push("\n=== RECENT COMMITS ===");
    parts.push(commits.join("\n"));
  }
  return enforcePayloadSize(parts.join("\n"));
}
