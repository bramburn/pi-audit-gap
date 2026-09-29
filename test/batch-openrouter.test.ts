/** Tests for the OpenRouter Batch API transport (spec-lane batch queue). */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  batchApi,
  buildOpenRouterBatchPayload,
  openRouterBodyFromParams,
  openrouterBatchStatus,
  openrouterSubmitBatch,
  parseOpenRouterBatchStatus,
  parseOpenRouterResults,
  specBatchEnabled,
} from "../dist/client.js";
import { enqueueJob, listJobs, pollSubmittedJobs, submitPendingJobs } from "../dist/batch.js";

const SPEC_ENV_KEYS = [
  "AUDITGAP_SPEC_BASE_URL",
  "AUDITGAP_SPEC_API_KEY",
  "AUDITGAP_SPEC_MODEL",
  "AUDITGAP_SPEC_API",
  "AUDITGAP_SPEC_BATCH",
  "AUDITGAP_SPEC_BATCH_API",
  "VERIFIER_BASE_URL",
];

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const key of SPEC_ENV_KEYS) snap[key] = process.env[key];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const key of SPEC_ENV_KEYS) {
    if (snap[key] === undefined) delete process.env[key];
    else process.env[key] = snap[key];
  }
}

function useOpenRouterEnv(): void {
  process.env.AUDITGAP_SPEC_BASE_URL = "https://openrouter.ai/api/v1";
  process.env.AUDITGAP_SPEC_API_KEY = "sk-or-test";
  process.env.AUDITGAP_SPEC_MODEL = "anthropic/claude-opus-5.5";
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(handler: (url: string, init: RequestInit | undefined) => Promise<Response>): Array<{ url: string; init: RequestInit | undefined }> {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  (globalThis as Record<string, unknown>).fetch = (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return calls;
}

test("batchApi is explicit via env and derived from the base URL otherwise", () => {
  const snap = snapshotEnv();
  try {
    delete process.env.AUDITGAP_SPEC_BATCH_API;
    process.env.AUDITGAP_SPEC_BASE_URL = "https://openrouter.ai/api/v1";
    assert.equal(batchApi(), "openrouter");
    process.env.AUDITGAP_SPEC_BASE_URL = "https://api.anthropic.com/v1";
    assert.equal(batchApi(), "anthropic");
    delete process.env.AUDITGAP_SPEC_BASE_URL;
    process.env.VERIFIER_BASE_URL = "https://openrouter.ai/api/v1";
    assert.equal(batchApi(), "openrouter");
    process.env.AUDITGAP_SPEC_BATCH_API = "openrouter";
    assert.equal(batchApi(), "openrouter");
    process.env.AUDITGAP_SPEC_BATCH_API = "anthropic";
    assert.equal(batchApi(), "anthropic");
  } finally {
    restoreEnv(snap);
  }
});

test("specBatchEnabled allows an openai-transport spec lane on OpenRouter", () => {
  const snap = snapshotEnv();
  try {
    process.env.AUDITGAP_SPEC_BATCH = "1";
    useOpenRouterEnv();
    process.env.AUDITGAP_SPEC_API = "openai";
    assert.equal(specBatchEnabled(), true);
    process.env.AUDITGAP_SPEC_API = "anthropic";
    assert.equal(specBatchEnabled(), true);
    process.env.AUDITGAP_SPEC_BATCH = "0";
    assert.equal(specBatchEnabled(), false);
    // Non-OpenRouter OpenAI transport: no batch API to talk to.
    process.env.AUDITGAP_SPEC_BATCH = "1";
    process.env.AUDITGAP_SPEC_API = "openai";
    process.env.AUDITGAP_SPEC_BASE_URL = "https://api.deepseek.com/v1";
    assert.equal(specBatchEnabled(), false);
  } finally {
    restoreEnv(snap);
  }
});

test("openRouterBodyFromParams converts Anthropic-shaped params to a chat body", () => {
  const body = openRouterBodyFromParams({
    model: "anthropic/claude-opus-5.5",
    max_tokens: 8192,
    system: "You are strict.",
    messages: [{ role: "user", content: "hello" }],
    temperature: 0,
  });
  assert.deepEqual(body, {
    messages: [
      { role: "system", content: "You are strict." },
      { role: "user", content: "hello" },
    ],
    temperature: 0,
    response_format: { type: "json_object" },
    max_tokens: 8192,
  });
});

test("buildOpenRouterBatchPayload sets endpoint, model, and custom ids", () => {
  const payload = buildOpenRouterBatchPayload(
    [
      { customId: "job-1", params: { system: "s", messages: [{ role: "user", content: "u" }] } },
      { customId: "job-2", params: { messages: [{ role: "user", content: "u2" }] } },
    ],
    "anthropic/claude-opus-5.5",
  );
  assert.equal(payload.endpoint, "/v1/chat/completions");
  assert.equal(payload.model, "anthropic/claude-opus-5.5");
  const requests = payload.requests as Array<{ custom_id: string; body: Record<string, unknown> }>;
  assert.equal(requests.length, 2);
  assert.equal(requests[0].custom_id, "job-1");
  assert.equal((requests[0].body.messages as Array<{ role: string }>)[0].role, "system");
  assert.equal((requests[1].body.messages as Array<{ role: string }>)[0].role, "user");
});

test("parseOpenRouterResults handles array and record shapes, errors, and garbage", () => {
  // Array shape, chat-completions responses.
  const arrayForm = parseOpenRouterResults([
    { custom_id: "a", response: { choices: [{ message: { content: '{"verdict":"pass"}' } }] } },
    { custom_id: "b", error: { message: "model exploded" } },
    { custom_id: "c", error: "plain string error" },
    { custom_id: "d" },
    "garbage",
  ]);
  assert.deepEqual(arrayForm.get("a"), { ok: true, text: '{"verdict":"pass"}' });
  assert.equal(arrayForm.get("b")?.ok, false);
  assert.ok((arrayForm.get("b")?.error ?? "").includes("model exploded"));
  assert.equal(arrayForm.get("c")?.ok, false);
  assert.equal(arrayForm.get("d")?.ok, false);

  // Record shape keyed by custom_id.
  const recordForm = parseOpenRouterResults({
    x: { response: { choices: [{ message: { content: "hi" } }] } },
    y: { response: { content: [{ type: "text", text: "anthropic-shaped" }] } },
  });
  assert.deepEqual(recordForm.get("x"), { ok: true, text: "hi" });
  assert.deepEqual(recordForm.get("y"), { ok: true, text: "anthropic-shaped" });

  assert.equal(parseOpenRouterResults(undefined).size, 0);
  assert.equal(parseOpenRouterResults("nope").size, 0);
});

test("parseOpenRouterBatchStatus maps statuses and extracts inline outcomes", () => {
  assert.deepEqual(parseOpenRouterBatchStatus({ status: "validating" }), { status: "in_progress" });
  assert.deepEqual(parseOpenRouterBatchStatus({ status: "in_progress" }), { status: "in_progress" });
  assert.deepEqual(parseOpenRouterBatchStatus({ status: "processing" }), { status: "in_progress" });

  const completed = parseOpenRouterBatchStatus({
    status: "completed",
    results: [{ custom_id: "j1", response: { choices: [{ message: { content: "{}" } }] } }],
  });
  assert.equal(completed.status, "ended");
  assert.deepEqual(completed.outcomes?.get("j1"), { ok: true, text: "{}" });

  const failed = parseOpenRouterBatchStatus({ status: "failed", error: "provider down" });
  assert.equal(failed.status, "ended");
  assert.equal(failed.error, "provider down");

  const expired = parseOpenRouterBatchStatus({ status: "expired" });
  assert.equal(expired.status, "ended");
  assert.equal(expired.error, "batch expired");

  assert.throws(() => parseOpenRouterBatchStatus(null));
});

test("openrouterSubmitBatch posts to /batches and retries a 400 with the :batch variant", async () => {
  const snap = snapshotEnv();
  const originalFetch = globalThis.fetch;
  useOpenRouterEnv();
  try {
    const calls = stubFetch(async (_url, _init) => {
      if (calls.length === 1) return jsonResponse(400, { error: "no batch endpoint for model" });
      return jsonResponse(202, { id: "batch_or_1" });
    });
    const result = await openrouterSubmitBatch([
      { customId: "job-1", params: { system: "s", messages: [{ role: "user", content: "u" }] } },
    ]);
    assert.equal(result.batchId, "batch_or_1");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://openrouter.ai/api/v1/batches");
    const auth = (calls[0].init?.headers as Record<string, string>).Authorization;
    assert.equal(auth, "Bearer sk-or-test");
    const firstBody = JSON.parse(calls[0].init?.body as string);
    assert.equal(firstBody.model, "anthropic/claude-opus-5.5");
    const secondBody = JSON.parse(calls[1].init?.body as string);
    assert.equal(secondBody.model, "anthropic/claude-opus-5.5:batch");
    assert.equal(firstBody.endpoint, "/v1/chat/completions");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(snap);
  }
});

test("openrouterSubmitBatch does not retry when the model already has :batch, and surfaces HTTP errors", async () => {
  const snap = snapshotEnv();
  const originalFetch = globalThis.fetch;
  useOpenRouterEnv();
  try {
    process.env.AUDITGAP_SPEC_MODEL = "anthropic/claude-opus-5.5:batch";
    let calls = 0;
    stubFetch(async () => {
      calls++;
      return jsonResponse(200, { id: "batch_or_2" });
    });
    const result = await openrouterSubmitBatch([{ customId: "j", params: {} }]);
    assert.equal(result.batchId, "batch_or_2");
    assert.equal(calls, 1);

    stubFetch(async () => jsonResponse(500, { error: "boom" }));
    await assert.rejects(() => openrouterSubmitBatch([{ customId: "j", params: {} }]), /HTTP 500/);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(snap);
  }
});

test("openrouterBatchStatus polls /batches/{id} with Bearer auth", async () => {
  const snap = snapshotEnv();
  const originalFetch = globalThis.fetch;
  useOpenRouterEnv();
  try {
    const calls = stubFetch(async () =>
      jsonResponse(200, {
        status: "completed",
        results: { j1: { response: { choices: [{ message: { content: "text" } }] } } },
      }),
    );
    const result = await openrouterBatchStatus("batch_or_9");
    assert.equal(calls[0].url, "https://openrouter.ai/api/v1/batches/batch_or_9");
    assert.equal(result.status, "ended");
    assert.deepEqual(result.outcomes?.get("j1"), { ok: true, text: "text" });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(snap);
  }
});

test("pollSubmittedJobs resolves jobs from inline outcomes without a results URL", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "auditgap-orbatch-"));
  try {
    const job1 = enqueueJob(cwd, "spec-audit", "g1", { system: "s", messages: [] }, "objective 1");
    const job2 = enqueueJob(cwd, "gap-audit", "g1", { system: "s", messages: [] });
    const submitted = await submitPendingJobs(cwd, { submit: async () => ({ batchId: "b1" }) });
    assert.equal(submitted, 2);

    const resolved = await pollSubmittedJobs(cwd, {
      status: async () => ({
        status: "ended",
        outcomes: new Map([
          [job1.id, { ok: true, text: '{"checklist":[]}' }],
          [job2.id, { ok: false, error: "entry failed" }],
        ]),
      }),
      results: async () => {
        throw new Error("results() must not be called for inline outcomes");
      },
    });
    assert.equal(resolved.length, 2);
    const r1 = resolved.find((r) => r.job.id === job1.id)!;
    const r2 = resolved.find((r) => r.job.id === job2.id)!;
    assert.equal(r1.job.state, "done");
    assert.equal(r2.job.state, "failed");
    assert.equal(r2.outcome?.error, "entry failed");
    // Terminal jobs are archived; the active queue is empty.
    assert.equal(listJobs(cwd, "submitted").length, 0);
    assert.equal(listJobs(cwd, "done").length, 1);
    assert.equal(listJobs(cwd, "failed").length, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("pollSubmittedJobs marks jobs failed on a terminal batch-level error", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "auditgap-orbatch-"));
  try {
    enqueueJob(cwd, "spec-audit", "g1", { system: "s", messages: [] }, "objective");
    await submitPendingJobs(cwd, { submit: async () => ({ batchId: "b1" }) });
    const resolved = await pollSubmittedJobs(cwd, {
      status: async () => ({ status: "ended", error: "batch failed: provider down" }),
      results: async () => {
        throw new Error("must not be called");
      },
    });
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].job.state, "failed");
    assert.equal(resolved[0].outcome?.error, "batch failed: provider down");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
