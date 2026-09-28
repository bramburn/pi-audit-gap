/**
 * Anthropic Messages Batches queue — durable spool + monitor.
 *
 * Why: the spec lane (Opus) is expensive; Anthropic's Batches API gives
 * 50% off at minutes-to-hours latency. Audit requests are not
 * latency-sensitive by design (checklists steer the worker whenever they
 * land), so batch is the DEFAULT operating mode for the spec lane when
 * AUDITGAP_SPEC_API=anthropic and AUDITGAP_SPEC_BATCH=1.
 *
 * Lifecycle of a job (.pi/audit-gap/queue/<jobId>.json):
 *
 *   pending-submit ──(submitPendingJobs groups all pending into ONE
 *        │            Anthropic batch; stores batch_id on each job)
 *        ▼
 *   submitted ──(pollSubmittedJobs, every N turns / M seconds)
 *        │            ├─ in_progress → update lastStatus, stay queued
 *        │            ├─ ended → fetch results URL, parse per-entry
 *        │            │   outcomes, mark done/failed, archive to done/
 *        │            └─ canceling → mark failed (never observed ending)
 *        ▼
 *   done | failed (archived under queue/done/)
 *
 * The client functions are injected so the state machine is unit-testable
 * without network. index.ts owns the cadence (turn-based) and routes
 * completed results into the same handlers as the direct path.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { buildAnthropicParams, type BatchEntryOutcome } from "./client.js";

export const QUEUE_REL = path.join(".pi", "audit-gap", "queue");

export type BatchJobKind = "spec-audit" | "gap-audit";
export type BatchJobState = "pending-submit" | "submitted" | "done" | "failed";

export interface BatchJob {
  id: string;
  kind: BatchJobKind;
  goalId: string;
  /** objective snapshot at enqueue time (spec jobs). */
  objective?: string;
  state: BatchJobState;
  batchId?: string;
  lastStatus?: string;
  result?: BatchEntryOutcome;
  createdAt: string;
  updatedAt: string;
}

/** Injected client surface (real one lives in client.ts). */
export interface BatchClient {
  submit(entries: Array<{ customId: string; params: Record<string, unknown> }>): Promise<{ batchId: string }>;
  status(batchId: string): Promise<{ status: "in_progress" | "canceling" | "ended"; resultsUrl?: string }>;
  results(resultsUrl: string): Promise<Map<string, BatchEntryOutcome>>;
}

export function queueDir(cwd: string): string {
  return path.resolve(cwd, QUEUE_REL);
}

function jobPath(cwd: string, jobId: string): string {
  return path.join(queueDir(cwd), jobId + ".json");
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

let counter = 0;

export function enqueueJob(
  cwd: string,
  kind: BatchJobKind,
  goalId: string,
  params: Record<string, unknown>,
  objective?: string,
): BatchJob {
  const now = new Date().toISOString();
  const job: BatchJob = {
    id: "job-" + Date.now().toString(36) + "-" + String(counter++),
    kind,
    goalId,
    objective,
    state: "pending-submit",
    createdAt: now,
    updatedAt: now,
  };
  // The Anthropic request params travel inside the job file so a
  // session restart can still submit them.
  (job as unknown as Record<string, unknown>).params = params;
  atomicWriteJson(jobPath(cwd, job.id), job);
  return job;
}

/** Convenience: build the Anthropic request params for a spec/gap job. */
export function buildJobParams(input: {
  model: string;
  maxTokens: number;
  systemPrompt: string;
  userContent: string;
}): Record<string, unknown> {
  return buildAnthropicParams(input, input.systemPrompt, input.userContent);
}

export function listJobs(cwd: string, state?: BatchJobState): BatchJob[] {
  const dirs: string[] = [];
  // Active states live at the queue root; terminal states are archived
  // under queue/done/.
  if (!state || state === "pending-submit" || state === "submitted") {
    dirs.push(queueDir(cwd));
  }
  if (!state || state === "done" || state === "failed") {
    dirs.push(path.join(queueDir(cwd), "done"));
  }
  const out: BatchJob[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      try {
        const job = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as BatchJob;
        if (state && job.state !== state) continue;
        out.push(job);
      } catch {
        // Skip corrupt job files — a human can inspect them in place.
      }
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function saveJob(cwd: string, job: BatchJob): void {
  job.updatedAt = new Date().toISOString();
  atomicWriteJson(jobPath(cwd, job.id), job);
}

function archiveJob(cwd: string, job: BatchJob): void {
  const doneDir = path.join(queueDir(cwd), "done");
  fs.mkdirSync(doneDir, { recursive: true });
  atomicWriteJson(path.join(doneDir, job.id + ".json"), job);
  try {
    fs.unlinkSync(jobPath(cwd, job.id));
  } catch {
    // Already gone.
  }
}

export function jobParams(job: BatchJob): Record<string, unknown> {
  const params = (job as unknown as Record<string, unknown>).params;
  return (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
}

/**
 * Group every pending-submit job into ONE Anthropic batch submission.
 * Returns the number of jobs submitted (0 when nothing pending).
 */
export async function submitPendingJobs(cwd: string, client: BatchClient): Promise<number> {
  const pending = listJobs(cwd, "pending-submit");
  if (pending.length === 0) return 0;
  const entries = pending.map((job) => ({ customId: job.id, params: jobParams(job) }));
  const { batchId } = await client.submit(entries);
  for (const job of pending) {
    job.state = "submitted";
    job.batchId = batchId;
    job.lastStatus = "submitted";
    saveJob(cwd, job);
  }
  return pending.length;
}

export interface PolledJob {
  job: BatchJob;
  outcome: BatchEntryOutcome | null;
}

/**
 * Poll every submitted job. Jobs whose batch has ended are resolved
 * (result fetched once per batch), archived, and returned with their
 * outcome. In-progress jobs return null outcome and stay queued.
 * Status/result failures mark the job failed (retry by re-enqueueing).
 */
export async function pollSubmittedJobs(cwd: string, client: BatchClient): Promise<PolledJob[]> {
  const submitted = listJobs(cwd, "submitted");
  if (submitted.length === 0) return [];

  // Resolve ended batches once (many jobs share one batchId).
  const batchStatusCache = new Map<string, { status: "in_progress" | "canceling" | "ended"; resultsUrl?: string }>();
  const resultsCache = new Map<string, Map<string, BatchEntryOutcome>>();
  async function statusFor(batchId: string) {
    if (!batchStatusCache.has(batchId)) {
      batchStatusCache.set(batchId, await client.status(batchId));
    }
    return batchStatusCache.get(batchId)!;
  }
  async function resultsFor(resultsUrl: string) {
    if (!resultsCache.has(resultsUrl)) {
      resultsCache.set(resultsUrl, await client.results(resultsUrl));
    }
    return resultsCache.get(resultsUrl)!;
  }

  const resolved: PolledJob[] = [];
  for (const job of submitted) {
    const batchId = job.batchId;
    if (!batchId) {
      job.state = "failed";
      job.result = { ok: false, error: "submitted job missing batchId" };
      saveJob(cwd, job);
      archiveJob(cwd, job);
      resolved.push({ job, outcome: job.result });
      continue;
    }
    try {
      const st = await statusFor(batchId);
      if (st.status === "in_progress") {
        if (job.lastStatus !== "in_progress") {
          job.lastStatus = "in_progress";
          saveJob(cwd, job);
        }
        resolved.push({ job, outcome: null });
        continue;
      }
      if (st.status === "canceling") {
        job.state = "failed";
        job.lastStatus = "canceling";
        job.result = { ok: false, error: "batch canceled" };
        saveJob(cwd, job);
        archiveJob(cwd, job);
        resolved.push({ job, outcome: job.result });
        continue;
      }
      // ended
      if (!st.resultsUrl) {
        job.state = "failed";
        job.result = { ok: false, error: "batch ended without results_url" };
        saveJob(cwd, job);
        archiveJob(cwd, job);
        resolved.push({ job, outcome: job.result });
        continue;
      }
      const results = await resultsFor(st.resultsUrl);
      const outcome = results.get(job.id) ?? { ok: false, error: "no result entry for job" };
      job.state = outcome.ok ? "done" : "failed";
      job.lastStatus = "ended";
      job.result = outcome;
      saveJob(cwd, job);
      archiveJob(cwd, job);
      resolved.push({ job, outcome });
    } catch (err) {
      // Transient poll failure — keep the job queued; next pass retries.
      job.lastStatus = "poll-error: " + ((err as Error)?.message ?? String(err));
      saveJob(cwd, job);
      resolved.push({ job, outcome: null });
    }
  }
  return resolved;
}
