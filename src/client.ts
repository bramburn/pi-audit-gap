/**
 * Audit lanes: LLM client transports.
 *
 * Two independent lanes with independent env configuration and budgets:
 *
 * - SPEC lane (sparse, high-level): requirement elicitation at
 *   goal_created, gap detection at completion_requested / plateau.
 *   Intended for a strong, batch-discounted model (e.g. Claude Opus).
 *   Falls back to pi-harvest's VERIFIER_* env when AUDITGAP_SPEC_* is
 *   unset, so an existing pi-harvest config works out of the box.
 *
 *   Two transports, selected by AUDITGAP_SPEC_API:
 *   - "openai"  (default): OpenAI-compatible POST {base}/chat/completions.
 *     Works with OpenRouter, DeepSeek, LiteLLM, pi-harvest's verifier,
 *     etc. Uses response_format json_object.
 *   - "anthropic": native Anthropic POST {base}/messages (beta). Required
 *     for the native Messages Batches API — one of two batch submission
 *     transports (see batchApi() below).
 *
 * - COVER lane (cheap, volume): per-item pass/fail verification of DoD
 *   checklist entries during periodic sweeps. Always OpenAI-compatible
 *   chat/completions — works with DeepSeek directly or via OpenRouter
 *   (set AUDITGAP_COVER_BASE_URL=https://openrouter.ai/api/v1 and any
 *   OpenRouter model id to spend OpenRouter credits).
 *
 * - STEER lane (gap audits): the model that produces [STEER:*] gap
 *   messages at completion_requested / plateau. Optional — every
 *   AUDITGAP_STEER_* var falls back to the spec lane's config, so without
 *   a /auditgap-settings steer pick gap audits keep riding the spec lane.
 *
 * - BATCH lane (batch runner): the model the batch queue submits jobs as.
 *   Optional — AUDITGAP_BATCH_* falls back to the spec lane's config. Only
 *   batch-capable models make sense here (native Anthropic API or an
 *   openrouter.ai base), so the /auditgap-settings picker filters the
 *   catalogue accordingly.
 *
 * Same retry/backoff policy as pi-harvest: exponential 1 s -> 2 s on
 * 429/5xx/timeouts, AuditGapUnavailableError after the final attempt.
 * All lanes return strictly validated JSON — no prose, no fences.
 */

import {
  AuditGapConfigError,
  AuditGapUnavailableError,
  type CoverCheckResponse,
  type SpecAuditResponse,
} from "./types.js";
import { buildGapPayload, buildSpecPayload, MAX_PAYLOAD_BYTES } from "./assemble.js";

export type Lane = "spec" | "cover" | "steer" | "batch";
export type Transport = "openai" | "anthropic";

interface LaneConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  retries: number;
  maxTokens: number;
}

/** Select the spec-lane transport. Cover lane is always OpenAI-compatible. */
export function specTransport(): Transport {
  const raw = (process.env.AUDITGAP_SPEC_API ?? "openai").trim().toLowerCase();
  return raw === "anthropic" ? "anthropic" : "openai";
}

/**
 * Select the steer-lane (gap-audit) transport. Defaults to the spec
 * lane's transport so an unset steer lane rides the spec lane exactly.
 */
export function steerTransport(): Transport {
  const raw = (process.env.AUDITGAP_STEER_API ?? process.env.AUDITGAP_SPEC_API ?? "openai").trim().toLowerCase();
  return raw === "anthropic" ? "anthropic" : "openai";
}

/** True when spec-lane work should go through the batch queue. */
export function specBatchEnabled(): boolean {
  if ((process.env.AUDITGAP_SPEC_BATCH ?? "").trim() !== "1") return false;
  if (specTransport() === "anthropic") return true;
  // OpenAI-compatible direct lane — the batch queue can still submit via
  // OpenRouter's Batch API when the spec base URL is OpenRouter.
  return batchApi() === "openrouter";
}

/** Which batch submission API the spec queue talks to. */
export type BatchApi = "anthropic" | "openrouter";

/**
 * Select the batch API. AUDITGAP_BATCH_API (batch-lane pick) or
 * AUDITGAP_SPEC_BATCH_API (explicit "openrouter" | "anthropic") win; when
 * unset it is derived from the batch lane base URL (falling back to the
 * spec base URL) so a /auditgap-settings pick of an OpenRouter model
 * batches through OpenRouter without any extra configuration.
 */
export function batchApi(): BatchApi {
  const raw = (process.env.AUDITGAP_BATCH_API ?? process.env.AUDITGAP_SPEC_BATCH_API ?? "").trim().toLowerCase();
  if (raw === "openrouter") return "openrouter";
  if (raw === "anthropic") return "anthropic";
  const base = (
    process.env.AUDITGAP_BATCH_BASE_URL ??
    process.env.AUDITGAP_SPEC_BASE_URL ??
    process.env.VERIFIER_BASE_URL ??
    ""
  ).toLowerCase();
  return base.includes("openrouter.ai") ? "openrouter" : "anthropic";
}

function readLaneConfig(lane: Lane): LaneConfig {
  const prefix = "AUDITGAP_" + lane.toUpperCase();
  // Spec, steer and batch lanes fall back through AUDITGAP_SPEC_* to
  // pi-harvest's VERIFIER_* so a single supervisor endpoint can serve
  // every lane during bring-up. Cover is configured (or picked) on its own.
  const fallback = lane !== "cover";
  const baseUrl =
    process.env[prefix + "_BASE_URL"]?.replace(/\/+$/, "") ??
    (fallback ? process.env.AUDITGAP_SPEC_BASE_URL?.replace(/\/+$/, "") : undefined) ??
    (fallback ? process.env.VERIFIER_BASE_URL?.replace(/\/+$/, "") : undefined) ??
    "";
  const apiKey =
    process.env[prefix + "_API_KEY"] ??
    (fallback ? process.env.AUDITGAP_SPEC_API_KEY : undefined) ??
    (fallback ? process.env.VERIFIER_API_KEY : undefined) ??
    "";
  const model =
    process.env[prefix + "_MODEL"] ??
    (fallback ? process.env.AUDITGAP_SPEC_MODEL : undefined) ??
    (fallback ? process.env.VERIFIER_MODEL : undefined) ??
    "";
  const defaultTimeout = lane === "cover" ? 120000 : 600000;
  const laneTimeout = process.env[prefix + "_TIMEOUT_MS"];
  const specTimeout = lane === "steer" || lane === "batch" ? process.env.AUDITGAP_SPEC_TIMEOUT_MS : undefined;
  const timeoutMs = Number(laneTimeout ?? specTimeout ?? String(defaultTimeout));
  const retries = Number(process.env.AUDITGAP_MAX_RETRIES ?? "2");
  const laneMaxTokens = process.env[prefix + "_MAX_TOKENS"];
  const specMaxTokens = lane === "steer" || lane === "batch" ? process.env.AUDITGAP_SPEC_MAX_TOKENS : undefined;
  const maxTokens = Number(laneMaxTokens ?? specMaxTokens ?? "8192");
  const missing: string[] = [];
  if (!baseUrl) missing.push(prefix + "_BASE_URL");
  if (!apiKey) missing.push(prefix + "_API_KEY");
  if (!model) missing.push(prefix + "_MODEL");
  if (missing.length > 0) throw new AuditGapConfigError(missing);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AuditGapConfigError([prefix + "_TIMEOUT_MS (must be a positive number)"]);
  }
  return { baseUrl, apiKey, model, timeoutMs, retries, maxTokens };
}

// ---------------------------------------------------------------------------
// Prompts (exported for the batch queue, which reuses them verbatim)
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

export function specSystemPrompt(): string {
  return SPEC_SYSTEM_PROMPT;
}

export function gapSystemPrompt(): string {
  return GAP_SYSTEM_PROMPT;
}

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
  const verdict: CoverCheckResponse["verdict"] =
    obj.verdict === "pass" || obj.verdict === "fail" || obj.verdict === "unknown" ? obj.verdict : "unknown";
  return { verdict, reason: typeof obj.reason === "string" ? obj.reason : "" };
}

// ---------------------------------------------------------------------------
// HTTP plumbing — shared
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

function isRetryableHttp(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
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

async function callAndParse<T>(lane: Lane, makeRawCall: () => Promise<string>, validate: (value: unknown) => T): Promise<T> {
  return withRetries(lane, async () => {
    const raw = await makeRawCall();
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

// ---------------------------------------------------------------------------
// OpenAI-compatible transport (spec lane when AUDITGAP_SPEC_API=openai,
// and ALWAYS for the cover lane — DeepSeek / OpenRouter / proxies)
// ---------------------------------------------------------------------------

async function openAiChatCompletion(cfg: LaneConfig, systemPrompt: string, userContent: string): Promise<string> {
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
  if (isRetryableHttp(res.status)) throw new RetryableHttpError(res.status, res.statusText);
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

// ---------------------------------------------------------------------------
// Anthropic native transport (spec lane when AUDITGAP_SPEC_API=anthropic)
// ---------------------------------------------------------------------------

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_BATCH_BETA = "message-batches-2024-09-24";

function anthropicHeaders(cfg: LaneConfig, beta?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": cfg.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (beta) headers["anthropic-beta"] = beta;
  return headers;
}

/** Build the /v1/messages request body. Exported for the batch queue. */
export function buildAnthropicParams(cfg: { model: string; maxTokens: number }, systemPrompt: string, userContent: string): Record<string, unknown> {
  return {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
    temperature: 0,
  };
}

/** Extract concatenated text from an Anthropic message payload. */
export function parseAnthropicText(payload: unknown): string {
  if (!payload || typeof payload !== "object") throw new Error("Anthropic response is not an object");
  const content = (payload as Record<string, unknown>).content;
  if (!Array.isArray(content)) throw new Error("Anthropic response has no content array");
  const parts = content
    .filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
    .filter((b) => b.type === "text")
    .map((b) => (typeof b.text === "string" ? b.text : ""));
  const text = parts.join("");
  if (text.length === 0) throw new Error("Anthropic response has no text block");
  return text;
}

async function anthropicMessage(cfg: LaneConfig, systemPrompt: string, userContent: string): Promise<string> {
  const body = buildAnthropicParams(cfg, systemPrompt, userContent);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetch(cfg.baseUrl + "/messages", {
      method: "POST",
      headers: anthropicHeaders(cfg),
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
  if (isRetryableHttp(res.status)) throw new RetryableHttpError(res.status, res.statusText);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("HTTP " + res.status + ": " + text.slice(0, 500));
  }
  const payload = (await res.json()) as unknown;
  return parseAnthropicText(payload);
}

/** Raw call dispatcher for the spec and steer lanes. */
function specRawCall(cfg: LaneConfig, systemPrompt: string, userContent: string, transport?: Transport): () => Promise<string> {
  const api = transport ?? specTransport();
  if (api === "anthropic") {
    return () => anthropicMessage(cfg, systemPrompt, userContent);
  }
  return () => openAiChatCompletion(cfg, systemPrompt, userContent);
}

// ---------------------------------------------------------------------------
// Anthropic Messages Batches API
// ---------------------------------------------------------------------------

export interface BatchRequestEntry {
  customId: string;
  params: Record<string, unknown>;
}

export interface BatchSubmissionResult {
  batchId: string;
}

/** POST /v1/messages/batches — submit up to 10k requests in one batch. */
export async function anthropicSubmitBatch(entries: BatchRequestEntry[]): Promise<BatchSubmissionResult> {
  if (entries.length === 0) throw new Error("no batch entries to submit");
  const cfg = readLaneConfig("batch");
  const body = {
    requests: entries.map((e) => ({ custom_id: e.customId, params: e.params })),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetch(cfg.baseUrl + "/messages/batches", {
      method: "POST",
      headers: anthropicHeaders(cfg, ANTHROPIC_BATCH_BETA),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const e = err as Error;
    if (e.name === "AbortError") throw new Error("batch submit timed out after " + cfg.timeoutMs + "ms");
    throw new Error("batch submit network error: " + e.message);
  }
  clearTimeout(timer);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("batch submit HTTP " + res.status + ": " + text.slice(0, 500));
  }
  const payload = (await res.json()) as { id?: string };
  if (typeof payload.id !== "string" || payload.id.length === 0) {
    throw new Error("batch submit response missing id");
  }
  return { batchId: payload.id };
}

export type BatchStatus = "in_progress" | "canceling" | "ended";

export interface BatchStatusResult {
  status: BatchStatus;
  resultsUrl?: string;
  requestCounts?: { processing: number; succeeded: number; errored: number; canceled: number; expired: number };
  /** OpenRouter returns per-request results inline in the poll response. */
  outcomes?: Map<string, BatchEntryOutcome>;
  /** Terminal batch-level error (OpenRouter failed/expired/cancelled). */
  error?: string;
}

/** GET /v1/messages/batches/{id} — poll processing state. */
export async function anthropicBatchStatus(batchId: string): Promise<BatchStatusResult> {
  const cfg = readLaneConfig("batch");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetch(cfg.baseUrl + "/messages/batches/" + encodeURIComponent(batchId), {
      method: "GET",
      headers: anthropicHeaders(cfg, ANTHROPIC_BATCH_BETA),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const e = err as Error;
    if (e.name === "AbortError") throw new Error("batch status timed out after " + cfg.timeoutMs + "ms");
    throw new Error("batch status network error: " + e.message);
  }
  clearTimeout(timer);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("batch status HTTP " + res.status + ": " + text.slice(0, 500));
  }
  const payload = (await res.json()) as {
    status?: string;
    results_url?: string;
    request_counts?: BatchStatusResult["requestCounts"];
  };
  const status = payload.status === "ended" || payload.status === "canceling" ? payload.status : "in_progress";
  return {
    status,
    resultsUrl: typeof payload.results_url === "string" ? payload.results_url : undefined,
    requestCounts: payload.request_counts,
  };
}

export interface BatchEntryOutcome {
  ok: boolean;
  text?: string;
  error?: string;
}

/**
 * Parse a batch results body (newline-delimited JSON from the signed
 * results URL). Each line: {custom_id, result: {type: "succeeded",
 * message: {...}} | {type: "error", error: {...}}}.
 * Exported pure — unit-tested against Anthropic-shaped fixtures.
 */
export function parseBatchResults(body: string): Map<string, BatchEntryOutcome> {
  const out = new Map<string, BatchEntryOutcome>();
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const entry = parsed as Record<string, unknown>;
    if (typeof entry.custom_id !== "string") continue;
    const result = entry.result as Record<string, unknown> | undefined;
    if (!result || typeof result !== "object") {
      out.set(entry.custom_id, { ok: false, error: "missing result" });
      continue;
    }
    if (result.type === "succeeded") {
      try {
        out.set(entry.custom_id, { ok: true, text: parseAnthropicText(result.message) });
      } catch (err) {
        out.set(entry.custom_id, { ok: false, error: (err as Error).message });
      }
    } else {
      const errObj = result.error as Record<string, unknown> | undefined;
      const msg =
        errObj && typeof errObj.message === "string"
          ? errObj.message
          : "batch entry " + String(result.type ?? "error");
      out.set(entry.custom_id, { ok: false, error: msg });
    }
  }
  return out;
}

/** GET the signed results URL. No auth headers — the URL is pre-signed. */
export async function fetchBatchResults(resultsUrl: string): Promise<Map<string, BatchEntryOutcome>> {
  const cfg = readLaneConfig("batch");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetch(resultsUrl, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const e = err as Error;
    if (e.name === "AbortError") throw new Error("batch results timed out after " + cfg.timeoutMs + "ms");
    throw new Error("batch results network error: " + e.message);
  }
  clearTimeout(timer);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("batch results HTTP " + res.status + ": " + text.slice(0, 500));
  }
  return parseBatchResults(await res.text());
}

// ---------------------------------------------------------------------------
// OpenRouter Batch API
// ---------------------------------------------------------------------------
//
// A different shape from Anthropic's native Messages Batches API:
//
//   POST {base}/batches     { endpoint, model, requests: [{custom_id, body}] }
//   GET  {base}/batches/{id}   202 Accepted -> poll; results come back INLINE
//
// Request bodies use the chat-completions shape (endpoint
// "/v1/chat/completions") — the same api pi's OpenRouter catalogue reports
// for these models. The durable queue still stores Anthropic-shaped job
// params (shared with the native transport), so submission converts
// params -> chat body here.
//
// Batch runs on a model's ":batch" endpoint variant. The plain catalogue
// id usually resolves on its own, so submission tries it first and retries
// with the ":batch" suffix only when OpenRouter rejects the request.

/** Convert Anthropic-shaped job params into an OpenAI chat-completions body. */
export function openRouterBodyFromParams(params: Record<string, unknown>): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (typeof params.system === "string" && params.system) {
    messages.push({ role: "system", content: params.system });
  }
  if (Array.isArray(params.messages)) {
    for (const m of params.messages) {
      if (m && typeof m === "object") messages.push(m as Record<string, unknown>);
    }
  }
  const body: Record<string, unknown> = {
    messages,
    temperature: typeof params.temperature === "number" ? params.temperature : 0,
    response_format: { type: "json_object" },
  };
  if (typeof params.max_tokens === "number") body.max_tokens = params.max_tokens;
  return body;
}

/** Build the OpenRouter batch submission payload. */
export function buildOpenRouterBatchPayload(entries: BatchRequestEntry[], model: string): Record<string, unknown> {
  return {
    endpoint: "/v1/chat/completions",
    model,
    requests: entries.map((e) => ({ custom_id: e.customId, body: openRouterBodyFromParams(e.params) })),
  };
}

/** POST {base}/batches — submit all queued jobs as one OpenRouter batch. */
export async function openrouterSubmitBatch(entries: BatchRequestEntry[]): Promise<BatchSubmissionResult> {
  if (entries.length === 0) throw new Error("no batch entries to submit");
  const cfg = readLaneConfig("batch");
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/batches";
  const modelsToTry = cfg.model.trim().endsWith(":batch") ? [cfg.model] : [cfg.model, cfg.model + ":batch"];
  for (const model of modelsToTry) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
        body: JSON.stringify(buildOpenRouterBatchPayload(entries, model)),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const e = err as Error;
      if (e.name === "AbortError") throw new Error("batch submit timed out after " + cfg.timeoutMs + "ms");
      throw new Error("batch submit network error: " + e.message);
    }
    clearTimeout(timer);
    if (res.status === 202 || res.status === 200) {
      const payload = (await res.json()) as { id?: string };
      if (typeof payload.id !== "string" || payload.id.length === 0) {
        throw new Error("batch submit response missing id");
      }
      return { batchId: payload.id };
    }
    const text = await res.text().catch(() => "");
    // A model without a plain batch endpoint gets a 400 — retry once with
    // the ":batch" variant before giving up.
    if (res.status === 400 && model === modelsToTry[0] && modelsToTry.length > 1) continue;
    throw new Error("batch submit HTTP " + res.status + ": " + text.slice(0, 500));
  }
  throw new Error("batch submit rejected for " + cfg.model + " and its :batch variant");
}

/** Extract text from a batch entry response (chat-completions or Messages shape). */
function extractOpenRouterText(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const obj = response as Record<string, unknown>;
  if (Array.isArray(obj.choices)) {
    const first = obj.choices[0] as Record<string, unknown> | undefined;
    const content = first?.message ? (first.message as Record<string, unknown>).content : undefined;
    if (typeof content === "string" && content.length > 0) return content;
  }
  try {
    return parseAnthropicText(response);
  } catch {
    return undefined;
  }
}

/**
 * Parse OpenRouter inline batch results — an array of
 * {custom_id, response|error} entries or a record keyed by custom_id.
 * Exported pure — unit-tested against OpenRouter-shaped fixtures.
 */
export function parseOpenRouterResults(results: unknown): Map<string, BatchEntryOutcome> {
  const out = new Map<string, BatchEntryOutcome>();
  const entries: Array<[string, unknown]> = [];
  if (Array.isArray(results)) {
    for (const item of results) {
      if (item && typeof item === "object" && typeof (item as Record<string, unknown>).custom_id === "string") {
        entries.push([(item as Record<string, unknown>).custom_id as string, item]);
      }
    }
  } else if (results && typeof results === "object") {
    for (const [key, value] of Object.entries(results as Record<string, unknown>)) {
      entries.push([key, value]);
    }
  }
  for (const [customId, item] of entries) {
    if (!item || typeof item !== "object") {
      out.set(customId, { ok: false, error: "malformed result entry" });
      continue;
    }
    const obj = item as Record<string, unknown>;
    if (obj.error !== undefined && obj.error !== null) {
      const msg = typeof obj.error === "string" ? obj.error : JSON.stringify(obj.error);
      out.set(customId, { ok: false, error: (msg || "batch entry error").slice(0, 500) });
      continue;
    }
    const text = extractOpenRouterText(obj.response);
    if (text === undefined) {
      out.set(customId, { ok: false, error: "batch entry missing response content" });
      continue;
    }
    out.set(customId, { ok: true, text });
  }
  return out;
}

/** Parse an OpenRouter batch status payload. Exported pure for tests. */
export function parseOpenRouterBatchStatus(payload: unknown): BatchStatusResult {
  if (!payload || typeof payload !== "object") throw new Error("batch status response is not an object");
  const obj = payload as Record<string, unknown>;
  const raw = typeof obj.status === "string" ? obj.status : "";
  if (raw === "completed") {
    return { status: "ended", outcomes: parseOpenRouterResults(obj.results) };
  }
  if (raw === "failed" || raw === "expired" || raw === "cancelled" || raw === "canceled") {
    const err = typeof obj.error === "string" && obj.error ? obj.error : "batch " + raw;
    return { status: "ended", error: err };
  }
  // "validating" | "in_progress" | "processing" | unknown -> still running.
  return { status: "in_progress" };
}

/** GET {base}/batches/{id} — poll processing state; results are inline. */
export async function openrouterBatchStatus(batchId: string): Promise<BatchStatusResult> {
  const cfg = readLaneConfig("batch");
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/batches/" + encodeURIComponent(batchId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const e = err as Error;
    if (e.name === "AbortError") throw new Error("batch status timed out after " + cfg.timeoutMs + "ms");
    throw new Error("batch status network error: " + e.message);
  }
  clearTimeout(timer);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("batch status HTTP " + res.status + ": " + text.slice(0, 500));
  }
  return parseOpenRouterBatchStatus(await res.json());
}

// ---------------------------------------------------------------------------
// Public lane APIs
// ---------------------------------------------------------------------------

/** Spec lane: goal_created -> DoD checklist. */
export async function invokeSpecAudit(input: { objective: string; cwd: string }): Promise<SpecAuditResponse> {
  const cfg = readLaneConfig("spec");
  return callAndParse("spec", specRawCall(cfg, SPEC_SYSTEM_PROMPT, buildSpecPayload(input)), validateSpecAuditResponse);
}

/** Spec lane: completion_requested / plateau -> gap audit against the checklist. */
export async function invokeGapAudit(input: { checklist: import("./types.js").DodChecklist; cwd: string }): Promise<GapAuditResponse> {
  const cfg = readLaneConfig("steer");
  return callAndParse("steer", specRawCall(cfg, GAP_SYSTEM_PROMPT, buildGapPayload(input), steerTransport()), validateGapAuditResponse);
}

/** Cover lane: one checklist item -> pass/fail/unknown. OpenAI-compatible always. */
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
  const cfg = readLaneConfig("cover");
  return callAndParse("cover", () => openAiChatCompletion(cfg, COVER_SYSTEM_PROMPT, payload), validateCoverCheckResponse);
}
