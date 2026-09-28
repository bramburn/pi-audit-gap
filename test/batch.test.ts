/** Tests for the Anthropic batch queue state machine and transports. */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildJobParams,
  enqueueJob,
  listJobs,
  pollSubmittedJobs,
  submitPendingJobs,
  type BatchClient,
} from "../dist/batch.js";
import { buildAnthropicParams, parseAnthropicText, parseBatchResults } from "../dist/client.js";

async function withTempDir(fn: (cwd: string) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auditgap-batch-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PARAMS = { model: "claude-opus-5.5", max_tokens: 8192, messages: [] as unknown[] };

// --- transport shaping ------------------------------------------------------

test("buildAnthropicParams produces the /v1/messages shape", async () => {
  const p = buildAnthropicParams({ model: "claude-opus-5.5", maxTokens: 4096 }, "sys", "user");
  assert.equal(p.model, "claude-opus-5.5");
  assert.equal(p.max_tokens, 4096);
  assert.equal(p.system, "sys");
  assert.deepEqual(p.messages, [{ role: "user", content: "user" }]);
  assert.equal(p.temperature, 0);
  assert.equal("response_format" in p, false); // Anthropic has no such field
});

test("parseAnthropicText concatenates text blocks", async () => {
  const payload = { content: [{ type: "text", text: '{"a":1}' }] };
  assert.equal(parseAnthropicText(payload), '{"a":1}');
  assert.throws(() => parseAnthropicText({ content: [] }));
  assert.throws(() => parseAnthropicText(null));
});

test("parseBatchResults handles succeeded, error, and garbage lines", async () => {
  const body = [
    JSON.stringify({
      custom_id: "job-1",
      result: { type: "succeeded", message: { content: [{ type: "text", text: '{"checklist":[]}' }] } },
    }),
    JSON.stringify({ custom_id: "job-2", result: { type: "error", error: { message: "overloaded" } } }),
    "not json at all",
    JSON.stringify({ no_custom_id: true }),
  ].join("\n");
  const results = parseBatchResults(body);
  assert.equal(results.size, 2);
  assert.deepEqual(results.get("job-1"), { ok: true, text: '{"checklist":[]}' });
  assert.deepEqual(results.get("job-2"), { ok: false, error: "overloaded" });
});

// --- queue state machine ----------------------------------------------------

test("enqueue -> list roundtrip stores params durably", async () => {
  await withTempDir((cwd) => {
    const job = enqueueJob(cwd, "spec-audit", "g1", PARAMS, "build inbox");
    assert.equal(job.state, "pending-submit");
    const jobs = listJobs(cwd, "pending-submit");
    assert.equal(jobs.length, 1);
    assert.deepEqual((jobs[0] as unknown as Record<string, unknown>).params, PARAMS);
  });
});

test("submitPendingJobs groups pending jobs into ONE batch", async () => {
  await withTempDir((cwd) => {
    enqueueJob(cwd, "spec-audit", "g1", PARAMS, "a");
    enqueueJob(cwd, "gap-audit", "g1", PARAMS);
    let seenEntries = 0;
    const client: BatchClient = {
      submit: async (entries) => {
        seenEntries = entries.length;
        return { batchId: "batch-123" };
      },
      status: async () => ({ status: "in_progress" }),
      results: async () => new Map(),
    };
    return submitPendingJobs(cwd, client).then((n) => {
      assert.equal(n, 2);
      assert.equal(seenEntries, 2);
      assert.equal(listJobs(cwd, "pending-submit").length, 0);
      const submitted = listJobs(cwd, "submitted");
      assert.equal(submitted.length, 2);
      for (const j of submitted) assert.equal(j.batchId, "batch-123");
    });
  });
});

test("pollSubmittedJobs: in_progress stays queued", async () => {
  await withTempDir((cwd) => {
    enqueueJob(cwd, "spec-audit", "g1", PARAMS, "a");
    const client: BatchClient = {
      submit: async () => ({ batchId: "b1" }),
      status: async () => ({ status: "in_progress" }),
      results: async () => new Map(),
    };
    return submitPendingJobs(cwd, client)
      .then(() => pollSubmittedJobs(cwd, client))
      .then((resolved) => {
        assert.equal(resolved.length, 1);
        assert.equal(resolved[0].outcome, null);
        assert.equal(listJobs(cwd, "submitted").length, 1); // still queued
      });
  });
});

test("pollSubmittedJobs: ended batch resolves, archives, and routes outcomes", async () => {
  await withTempDir((cwd) => {
    const job = enqueueJob(cwd, "spec-audit", "g1", PARAMS, "a");
    const client: BatchClient = {
      submit: async () => ({ batchId: "b1" }),
      status: async () => ({ status: "ended", resultsUrl: "https://signed.example/results" }),
      results: async () => new Map([[job.id, { ok: true, text: '{"checklist":[{"id":"x","requirement":"r","acceptance_criteria":"ac"}],"risks":[]}' }]]),
    };
    return submitPendingJobs(cwd, client)
      .then(() => pollSubmittedJobs(cwd, client))
      .then((resolved) => {
        assert.equal(resolved.length, 1);
        assert.equal(resolved[0].outcome?.ok, true);
        assert.equal(listJobs(cwd, "submitted").length, 0);
        const done = listJobs(cwd, "done");
        assert.equal(done.length, 1);
      });
  });
});

test("pollSubmittedJobs: ended batch with missing entry marks job failed", async () => {
  await withTempDir((cwd) => {
    enqueueJob(cwd, "gap-audit", "g1", PARAMS);
    const client: BatchClient = {
      submit: async () => ({ batchId: "b1" }),
      status: async () => ({ status: "ended", resultsUrl: "https://signed.example/results" }),
      results: async () => new Map(), // no entry for our job
    };
    return submitPendingJobs(cwd, client)
      .then(() => pollSubmittedJobs(cwd, client))
      .then((resolved) => {
        assert.equal(resolved[0].outcome?.ok, false);
        assert.equal(listJobs(cwd, "failed").length, 1);
      });
  });
});

test("pollSubmittedJobs: transient status failure keeps the job queued", async () => {
  await withTempDir((cwd) => {
    enqueueJob(cwd, "spec-audit", "g1", PARAMS, "a");
    let statusCalls = 0;
    const client: BatchClient = {
      submit: async () => ({ batchId: "b1" }),
      status: async () => {
        statusCalls++;
        throw new Error("http 500");
      },
      results: async () => new Map(),
    };
    return submitPendingJobs(cwd, client)
      .then(() => pollSubmittedJobs(cwd, client))
      .then((resolved) => {
        assert.equal(resolved[0].outcome, null);
        assert.equal(listJobs(cwd, "submitted").length, 1);
        assert.ok(listJobs(cwd, "submitted")[0].lastStatus?.includes("poll-error"));
      });
  });
});

test("buildJobParams delegates to the Anthropic params shape", async () => {
  const p = buildJobParams({ model: "m", maxTokens: 1024, systemPrompt: "s", userContent: "u" });
  assert.equal(p.max_tokens, 1024);
  assert.equal(p.system, "s");
});
