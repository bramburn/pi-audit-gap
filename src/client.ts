/**
 * Audit lanes: OpenAI-compatible chat/completions clients.
 *
 * Two independent lanes with independent env configuration and budgets:
 *
 * - SPEC lane (sparse, high-level): requirement elicitation at
 *   goal_created, gap detection at completion_requested / plateau.
 *   Intended for a strong, batch-discounted model (e.g. Claude Opus).
 *   Falls back to pi-harvest's VERIFIER_* env when AUDITGAP_SPEC_* is
 *   unset, so an existing pi-harvest config works out of the box.
 *
 * - COVER lane (cheap, volume): per-item pass/fail verification of DoD
 *   checklist entries during periodic sweeps. Intended for a cheap fast
 *   model (e.g. DeepSeek flash).
 *
 * Same retry/backoff policy as pi-harvest: exponential 1 s -> 2 s on
 * 429/5xx/timeouts, VerifierUnavailableError after the final attempt.
 * Both lanes return strictly validated JSON — no prose, no fences.
 */

import {
  AuditGapConfigError,
  AuditGapUnavailableError,
  type CoverCheckResponse,
  type SpecAuditResponse,
} from "./types.js";
import { buildGapPayload, buildSpecPayload, MAX_PAYLOAD_BYTES } from "./assemble.js";

export type Lane = "spec" | "cover";

interface LaneConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  retries: number;
}

function readLaneConfig(lane: Lane): LaneConfig {
  const prefix = lane === "spec" ? "AUDITGAP_SPEC" : "AUDITGAP_COVER";
  // Spec lane falls back to pi-harvest's VERIFIER_* so a single
  // supervisor endpoint can serve both extensions during bring-up.
  const fallback = lane === "spec";
  const baseUrl =
    process.env[prefix + "_BASE_URL"]?.replace(/\/+$/, "") ??
    (fallback ? process.env.VERIFIER_BASE_URL?.replace(/\/+$/, "") : undefined) ??
    "";
  const apiKey =
    process.env[prefix + "_API_KEY"] ??
    (fallback ? process.env.VERIFIER_API_KEY : undefined) ??
    "";
  const model =
    process.env[prefix + "_MODEL"] ??
    (fallback ? process.env.VERIFIER_MODEL : undefined) ??
    "";
  const defaultTimeout = lane === "spec" ? 600000 : 120000;
  const timeoutMs = Number(process.env[prefix + "_TIMEOUT_MS"] ?? String(defaultTimeout));
  const retries = Number(process.env.AUDITGAP_MAX_RETRIES ?? "2");
  const missing: string[] = [];
  if (!baseUrl) missing.push(prefix + "_BASE_URL");
  if (!apiKey) missing.push(prefix + "_API_KEY");
  if (!model) missing.push(prefix + "_MODEL");
  if (missing.length > 0) throw new AuditGapConfigError(missing);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AuditGapConfigError([prefix + "_TIMEOUT_MS (must be a positive number)"]);
  }
  return { baseUrl, apiKey, model, timeoutMs, retries };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SPEC_SYSTEM_PROMPT = [
  "You are a senior product engineer doing REQUIREMENT ELICITATION for a coding goal.",
  "A weaker worker model will implement the goal below. Weak models decompose epics",
  "shallowly and confidently miss whole feature areas (e.g. asked for a helpdesk inbox,",
  "they build the ticket list but forget internal notes, compose, forward, reply-all,",
  "rich-text editor, and file upload).",
  "",
  "Your job: enumerate what DONE means for this goal as a machine-checkable checklist.",
  "Each item must be independently verifiable from the repository contents — name the",
  "files/modules/routes where evidence would appear. Do not write prose paragraphs.",
  "",
  "Also list the top risks — requirement areas the worker is most likely to miss given",
  "the goal and the repo shape.",
  "",
  "Output strictly JSON with exactly these fields and no others:",
  JSON.stringify({
    checklist: [
      {
        id: "string — short kebab-case slug, unique within the checklist",
        requirement: "string — one sentence, the observable feature/behavior",
        acceptance_criteria: "string — how to verify from repo contents (files/routes/tests to look for)",
      },
    ],
    risks: ["string — one sentence per risk"],
  }, null, 2),
  "",
  "Return JSON only. Do not wrap it in markdown fences. Do not add prose.",
].join("\n");

const GAP_SYSTEM_PROMPT = [
  "You are a senior product engineer doing GAP DETECTION before a coding goal is closed.",
  "You are given the goal, its Definition-of-Done checklist (with current verification",
  "status), the repository inventory, and recent change activity.",
  "",
  "For each checklist item marked pending or failed, judge whether the repository shows",
  "credible evidence of implementation. Mark items you cannot find evidence for as",
  "'fail' with a one-line reason. Do NOT trust any status the worker claimed in chat —",
  "only repo evidence counts.",
  "",
  "Also list material requirement areas missing entirely from the checklist itself.",
  "",
  "Output strictly JSON with exactly these fields and no others:",
  JSON.stringify({
    item_verdicts: [
      { id: "string — checklist item id", verdict: "pass | fail | unknown", reason: "string — one line" },
    ],
    missing_requirements: ["string — requirement areas absent from the checklist and the repo"],
    summary: "string — 1-2 sentence overall judgment",
  }, null, 2),
  "",
  "Return JSON only. Do not wrap it in markdown fences. Do not add prose.",
].join("\n");

const COVER_SYSTEM_PROMPT = [
  "You are a strict coverage verifier.",
  "You are given ONE Definition-of-Done item (requirement + acceptance criteria), the",
  "goal it belongs to, and the repository inventory with recent changes.",
  "",
  "Judge from repository evidence whether the item is implemented well enough to mark",
  "verified. 'unknown' when the inventory is insufficient to tell. Be strict: a",
  "stub, TODO, or partial implementation is 'fail', never 'pass'.",
  "",
  "Output strictly JSON with exactly these fields and no others:",
  JSON.stringify({
    verdict: "pass | fail | unknown",
    reason: "string — one line of evidence",
  }, null, 2),
  "",
  "Return JSON only. Do not wrap it in markdown fences. Do not add prose.",
].join("\n");

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function stripJsonFences(raw: string): string {
  let s = raw.trim();
  const m = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/i);
  if (m) s = m[1].trim();
  return s;
}

export function validateSpecAuditResponse(value: unknown): SpecAuditResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Spec response is not a JSON object");
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.checklist) || obj.checklist.length === 0) {
    throw new Error("Spec response: checklist must be a non-empty array");
  }
  const checklist = obj.checklist.map((item, i) => {
    if (!item || typeof item !== "object") throw new Error("Spec response: checklist[" + i + "] not an object");
    const it = item as Record<string, unknown>;
    if (typeof it.id !== "string" || typeof it.requirement !== "string" || typeof it.acceptance_criteria !== "string") {
      throw new Error("Spec response: checklist[" + i + "] needs string id/requirement/acceptance_criteria");
    }
    return { id: it.id, requirement: it.requirement, acceptance_criteria: it.acceptance_criteria };
  });
  const risks = Array.isArray(obj.risks) ? obj.risks.filter((r): r is string => typeof r === "string") : [];
  return { checklist, risks };
}

export interface GapAuditResponse {
  itemVerdicts: Array<{ id: string; verdict: "pass" | "fail" | "unknown"; reason: string }>;
  missingRequirements: string[];
  summary: string;
}

export function validateGapAuditResponse(value: unknown): GapAuditResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Gap response is not a JSON object");
  }
  const obj = value as Record<string, unknown>;
  const rawVerdicts = Array.isArray(obj.item_verdicts) ? obj.item_verdicts : [];
  const itemVerdicts = rawVerdicts.map((v, i) => {
    if (!v || typeof v !== "object") throw new Error("Gap response: item_verdicts[" + i + "] not an object");
    const vv = v as Record<string, unknown>;
    if (typeof vv.id !== "string") throw new Error("Gap response: item_verdicts[" + i + "] needs string id");
    const verdict: "pass" | "fail" | "unknown" =
      vv.verdict === "pass" || vv.verdict === "fail" || vv.verdict === "unknown" ? vv.verdict : "unknown";
    return { id: vv.id, verdict, reason: typeof vv.reason === "string" ? vv.reason : "" };
  });
  const missingRequirements = Array.isArray(obj.missing_requirements)
    ? obj.missing_requirements.filter((r): r is string => typeof r === "string")
    : [];
  const summary = typeof obj.summary === "string" ? obj.summary : "";
  return { itemVerdicts, missingRequirements, summary };
}

export function validateCoverCheckResponse(value: unknown): CoverCheckResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cover response is not a JSON object");
  }
  const obj = value as Record<string, unknown>;
  const verdict = obj.verdict === "pass" || obj.verdict === "fail" || obj.verdict === "unknown" ? obj.verdict : "unknown";
  return { verdict, reason: typeof obj.reason === "string" ? obj.reason : "" };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

class RetryableHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super("HTTP " + status + ": " + message);
    this.name = "RetryableHttpError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function chatCompletion(
  cfg: LaneConfig,
  systemPrompt: string,
  userContent: string,
): Promise<string> {
  const body = {
    model: cfg.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetch(cfg.baseUrl + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const e = err as Error;
    if (e.name === "AbortError") throw new Error("timed out after " + cfg.timeoutMs + "ms");
    throw new Error("network error: " + e.message);
  }
  clearTimeout(timer);
  if (res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) {
    throw new RetryableHttpError(res.status, res.statusText);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("HTTP " + res.status + ": " + text.slice(0, 500));
  }
  const parsed = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("empty content in choices[0].message.content");
  }
  return content;
}

async function withRetries<T>(lane: Lane, fn: () => Promise<T>): Promise<T> {
  const cfg = readLaneConfig(lane);
  const backoffMs = [1000, 2000];
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRetryable =
        err instanceof RetryableHttpError ||
        (err instanceof Error && /timed out|network error|JSON\.parse failed/.test(err.message));
      if (!isRetryable || attempt >= cfg.retries) break;
      await sleep(backoffMs[Math.min(attempt, backoffMs.length - 1)]);
    }
  }
  throw new AuditGapUnavailableError(cfg.retries + 1, lastError);
}

async function callAndParse<T>(
  lane: Lane,
  systemPrompt: string,
  userContent: string,
  validate: (value: unknown) => T,
): Promise<T> {
  return withRetries(lane, async () => {
    const raw = await chatCompletion(readLaneConfig(lane), systemPrompt, enforceLocal(userContent));
    const cleaned = stripJsonFences(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      throw new Error("JSON.parse failed: " + (err as Error).message + "; first 200 chars: " + cleaned.slice(0, 200));
    }
    return validate(parsed);
  });
}

function enforceLocal(payload: string): string {
  if (Buffer.byteLength(payload, "utf8") <= MAX_PAYLOAD_BYTES) return payload;
  return payload; // assemble.ts already clamps; defensive no-op for direct callers
}

// ---------------------------------------------------------------------------
// Public lane APIs
// ---------------------------------------------------------------------------

/** Spec lane: goal_created -> DoD checklist. */
export async function invokeSpecAudit(input: { objective: string; cwd: string }): Promise<SpecAuditResponse> {
  return callAndParse("spec", SPEC_SYSTEM_PROMPT, buildSpecPayload(input), validateSpecAuditResponse);
}

/** Spec lane: completion_requested / plateau -> gap audit against the checklist. */
export async function invokeGapAudit(input: { checklist: import("./types.js").DodChecklist; cwd: string }): Promise<GapAuditResponse> {
  return callAndParse("spec", GAP_SYSTEM_PROMPT, buildGapPayload(input), validateGapAuditResponse);
}

/** Cover lane: one checklist item -> pass/fail/unknown. */
export async function invokeCoverCheck(input: {
  objective: string;
  itemId: string;
  requirement: string;
  acceptanceCriteria: string;
  cwd: string;
}): Promise<CoverCheckResponse> {
  const parts: string[] = [];
  parts.push("=== GOAL ===");
  parts.push(input.objective);
  parts.push("\n=== CHECKLIST ITEM (" + input.itemId + ") ===");
  parts.push("Requirement: " + input.requirement);
  parts.push("Acceptance criteria: " + input.acceptanceCriteria);
  parts.push("\n=== REPO INVENTORY + RECENT CHANGES ===");
  // Cover payloads reuse the spec payload minus the goal header to stay cheap.
  parts.push(buildSpecPayload({ objective: input.objective, cwd: input.cwd }));
  const payload = parts.join("\n").slice(0, MAX_PAYLOAD_BYTES);
  return callAndParse("cover", COVER_SYSTEM_PROMPT, payload, validateCoverCheckResponse);
}
