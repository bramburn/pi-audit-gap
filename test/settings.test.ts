/** Tests for /auditgap-settings persistence and env application. */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  applyLaneSelections,
  deriveTag,
  loadSettings,
  resetLaneEnvSnapshots,
  restoreLaneEnv,
  setLaneSelection,
  settingsPath,
} from "../dist/settings.js";
import { pickLaneModel, searchableSelect } from "../dist/model-picker.js";

const LANE_KEYS = [
  "AUDITGAP_SPEC_BASE_URL",
  "AUDITGAP_SPEC_API_KEY",
  "AUDITGAP_SPEC_MODEL",
  "AUDITGAP_SPEC_PROVIDER",
  "AUDITGAP_SPEC_API",
  "AUDITGAP_SPEC_BATCH",
  "AUDITGAP_COVER_BASE_URL",
  "AUDITGAP_COVER_API_KEY",
  "AUDITGAP_COVER_MODEL",
  "AUDITGAP_COVER_PROVIDER",
];

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "auditgap-settings-"));
}

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const key of LANE_KEYS) snap[key] = process.env[key];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const key of LANE_KEYS) {
    if (snap[key] === undefined) delete process.env[key];
    else process.env[key] = snap[key];
  }
}

/** Fake pi ModelRegistry: anthropic + openrouter + deepseek models with resolvable auth. */
function fakeRegistry(): {
  find(p: string, id: string): unknown;
  getApiKeyAndHeaders(model: unknown): Promise<unknown>;
} {
  return {
    find: (provider: string, modelId: string) => {
      if (provider === "anthropic" && modelId === "claude-opus-5-5") {
        return { api: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1" };
      }
      if (provider === "openrouter" && modelId === "deepseek/deepseek-chat") {
        return { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" };
      }
      if (provider === "deepseek" && modelId === "deepseek-chat") {
        return { api: "openai-completions", baseUrl: "https://api.deepseek.com/v1" };
      }
      return undefined;
    },
    getApiKeyAndHeaders: async (model: unknown) => {
      const baseUrl = (model as { baseUrl?: string }).baseUrl;
      return { ok: true, apiKey: "sk-test-123", ...(baseUrl ? { baseUrl } : {}) };
    },
  };
}

test("settings file roundtrip and path", () => {
  const cwd = tmpCwd();
  try {
    assert.equal(loadSettings(cwd), null);
    setLaneSelection(cwd, "cover", { provider: "openrouter", modelId: "deepseek/deepseek-chat" });
    setLaneSelection(cwd, "spec", { provider: "anthropic", modelId: "claude-opus-5-5", tag: "OPUS" });
    const loaded = loadSettings(cwd);
    assert.equal(loaded?.cover?.provider, "openrouter");
    assert.equal(loaded?.cover?.modelId, "deepseek/deepseek-chat");
    assert.equal(loaded?.spec?.tag, "OPUS");
    assert.ok(fs.existsSync(settingsPath(cwd)));
    assert.ok(settingsPath(cwd).includes(path.join(".pi", "audit-gap")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadSettings tolerates corrupt files and rejects other versions", () => {
  const cwd = tmpCwd();
  try {
    fs.mkdirSync(path.dirname(settingsPath(cwd)), { recursive: true });
    fs.writeFileSync(settingsPath(cwd), "not json {");
    assert.equal(loadSettings(cwd), null);
    fs.writeFileSync(settingsPath(cwd), JSON.stringify({ version: 2, spec: { provider: "a", modelId: "b" } }));
    assert.equal(loadSettings(cwd), null);
    fs.writeFileSync(
      settingsPath(cwd),
      JSON.stringify({ version: 1, spec: { provider: "a", modelId: "b" }, cover: { provider: "", modelId: "x" } }),
    );
    const loaded = loadSettings(cwd);
    assert.equal(loaded?.spec?.modelId, "b");
    assert.equal(loaded?.cover, undefined);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("setLaneSelection clears a lane and keeps the other", () => {
  const cwd = tmpCwd();
  try {
    setLaneSelection(cwd, "cover", { provider: "openrouter", modelId: "deepseek/deepseek-chat" });
    setLaneSelection(cwd, "spec", { provider: "anthropic", modelId: "claude-opus-5-5" });
    setLaneSelection(cwd, "spec", undefined);
    const loaded = loadSettings(cwd);
    assert.equal(loaded?.spec, undefined);
    assert.equal(loaded?.cover?.provider, "openrouter");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("deriveTag sanitizes provider names", () => {
  assert.equal(deriveTag("anthropic"), "ANTHROPIC");
  assert.equal(deriveTag("openrouter"), "OPENROUTER");
  assert.equal(deriveTag("open router!"), "OPENROUTER");
  assert.equal(deriveTag("  "), "LLM");
});

test("applyLaneSelections maps a stored cover model onto env vars", async () => {
  const snap = snapshotEnv();
  const cwd = tmpCwd();
  resetLaneEnvSnapshots();
  try {
    process.env.AUDITGAP_COVER_MODEL = "env-cover-model";
    process.env.AUDITGAP_COVER_BASE_URL = "https://env.example/v1";
    setLaneSelection(cwd, "cover", { provider: "openrouter", modelId: "deepseek/deepseek-chat" });

    const results = await applyLaneSelections(cwd, fakeRegistry());
    const cover = results.find((r) => r.lane === "cover");
    assert.equal(cover?.status, "applied");
    assert.equal(process.env.AUDITGAP_COVER_MODEL, "deepseek/deepseek-chat");
    assert.equal(process.env.AUDITGAP_COVER_BASE_URL, "https://openrouter.ai/api/v1");
    assert.equal(process.env.AUDITGAP_COVER_API_KEY, "sk-test-123");
    assert.equal(process.env.AUDITGAP_COVER_PROVIDER, "OPENROUTER");
    // Spec lane untouched (no stored selection, nothing to restore).
    assert.equal(process.env.AUDITGAP_SPEC_MODEL, snap.AUDITGAP_SPEC_MODEL ?? undefined);
  } finally {
    restoreEnv(snap);
    resetLaneEnvSnapshots();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("applyLaneSelections picks the transport from the model api and gates batch accordingly", async () => {
  const snap = snapshotEnv();
  const cwd = tmpCwd();
  resetLaneEnvSnapshots();
  try {
    process.env.AUDITGAP_SPEC_BATCH = "1";
    // OpenRouter base: the batch queue dispatches to OpenRouter's Batch
    // API, so the user's batch flag stays on for an openai-transport model.
    setLaneSelection(cwd, "spec", { provider: "openrouter", modelId: "deepseek/deepseek-chat" });
    await applyLaneSelections(cwd, fakeRegistry());
    assert.equal(process.env.AUDITGAP_SPEC_API, "openai");
    assert.equal(process.env.AUDITGAP_SPEC_BATCH, "1");

    // Non-OpenRouter OpenAI base: the native Anthropic batch transport
    // would 404 there — batch is forced off.
    setLaneSelection(cwd, "spec", { provider: "deepseek", modelId: "deepseek-chat" });
    await applyLaneSelections(cwd, fakeRegistry());
    assert.equal(process.env.AUDITGAP_SPEC_API, "openai");
    assert.equal(process.env.AUDITGAP_SPEC_BATCH, "0");

    // Anthropic model: native transport, batch flag restored.
    setLaneSelection(cwd, "spec", { provider: "anthropic", modelId: "claude-opus-5-5" });
    await applyLaneSelections(cwd, fakeRegistry());
    assert.equal(process.env.AUDITGAP_SPEC_API, "anthropic");
    assert.equal(process.env.AUDITGAP_SPEC_MODEL, "claude-opus-5-5");
    assert.equal(process.env.AUDITGAP_SPEC_PROVIDER, "ANTHROPIC");
    assert.equal(process.env.AUDITGAP_SPEC_BATCH, "1");
  } finally {
    restoreEnv(snap);
    resetLaneEnvSnapshots();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("applyLaneSelections restores original env when selection is cleared or model is missing", async () => {
  const snap = snapshotEnv();
  const cwd = tmpCwd();
  resetLaneEnvSnapshots();
  try {
    process.env.AUDITGAP_COVER_MODEL = "env-cover-model";
    process.env.AUDITGAP_COVER_BASE_URL = "https://env.example/v1";
    setLaneSelection(cwd, "cover", { provider: "openrouter", modelId: "deepseek/deepseek-chat" });
    await applyLaneSelections(cwd, fakeRegistry());
    assert.equal(process.env.AUDITGAP_COVER_MODEL, "deepseek/deepseek-chat");

    // Unknown model -> report missing, env restored.
    setLaneSelection(cwd, "cover", { provider: "ghost", modelId: "nope" });
    const missing = await applyLaneSelections(cwd, fakeRegistry());
    assert.equal(missing.find((r) => r.lane === "cover")?.status, "missing");
    assert.equal(process.env.AUDITGAP_COVER_MODEL, "env-cover-model");
    assert.equal(process.env.AUDITGAP_COVER_BASE_URL, "https://env.example/v1");

    // Cleared selection -> env stays restored.
    setLaneSelection(cwd, "cover", undefined);
    await applyLaneSelections(cwd, fakeRegistry());
    assert.equal(process.env.AUDITGAP_COVER_MODEL, "env-cover-model");

    // Auth resolution failure -> failed + restore.
    setLaneSelection(cwd, "cover", { provider: "openrouter", modelId: "deepseek/deepseek-chat" });
    const badRegistry = { find: fakeRegistry().find, getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) };
    const failed = await applyLaneSelections(cwd, badRegistry);
    assert.equal(failed.find((r) => r.lane === "cover")?.status, "failed");
    assert.equal(process.env.AUDITGAP_COVER_MODEL, "env-cover-model");
  } finally {
    restoreEnv(snap);
    resetLaneEnvSnapshots();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("restoreLaneEnv is a no-op when the lane was never overridden", () => {
  const snap = snapshotEnv();
  resetLaneEnvSnapshots();
  try {
    assert.equal(restoreLaneEnv("spec"), false);
    assert.equal(restoreLaneEnv("cover"), false);
  } finally {
    restoreEnv(snap);
    resetLaneEnvSnapshots();
  }
});

test("searchableSelect falls back to flat select outside TUI mode", async () => {
  let selectTitle = "";
  let selectOptions: string[] = [];
  const ctx = {
    mode: "rpc",
    ui: {
      select: async (title: string, options: string[]) => {
        selectTitle = title;
        selectOptions = options;
        return options[1];
      },
      custom: async () => {
        throw new Error("custom must not be used headless");
      },
    },
  };
  const picked = await searchableSelect(ctx, {
    title: "Pick",
    items: [
      { value: "a/1", label: "a/1" },
      { value: "b/2", label: "b/2" },
    ],
  });
  assert.equal(selectTitle, "Pick");
  assert.deepEqual(selectOptions, ["a/1", "b/2"]);
  assert.equal(picked?.value, "b/2");

  const cancelled = await searchableSelect(
    { mode: "print", ui: { select: async () => undefined, custom: async () => undefined } },
    { title: "Pick", items: [{ value: "a/1", label: "a/1" }] },
  );
  assert.equal(cancelled, undefined);
});

test("pickLaneModel filters to chat models with auth and maps the choice back", async () => {
  let selectTitle = "";
  const catalog = {
    getModelsOfType: () => [
      { id: "claude-opus-5-5", provider: "anthropic", api: "anthropic-messages" },
      { id: "dall-e-3", provider: "openai", type: "image" },
      { id: "deepseek/deepseek-chat", provider: "openrouter", api: "openai-completions" },
    ],
    hasConfiguredAuth: () => true,
  };
  const ctx = {
    mode: "print",
    ui: {
      select: async (title: string, options: string[]) => {
        selectTitle = title;
        assert.deepEqual(options, ["anthropic/claude-opus-5-5", "openrouter/deepseek/deepseek-chat"]);
        return "anthropic/claude-opus-5-5";
      },
      custom: async () => undefined,
    },
  };
  const choice = await pickLaneModel(ctx, catalog, "spec");
  assert.equal(choice?.provider, "anthropic");
  assert.equal(choice?.modelId, "claude-opus-5-5");
  assert.ok(selectTitle.includes("spec"));
});

test("pickLaneModel returns undefined on empty catalogue or cancel", async () => {
  const empty = await pickLaneModel(
    { mode: "print", ui: { select: async () => "x", custom: async () => undefined } },
    { getAvailable: () => [] },
    "cover",
  );
  assert.equal(empty, undefined);
  const cancelled = await pickLaneModel(
    {
      mode: "print",
      ui: {
        select: async (_t: string, options: string[]) => (options.length > 0 ? undefined : "x"),
        custom: async () => undefined,
      },
    },
    { getAvailable: () => [{ id: "m", provider: "p" }] },
    "cover",
  );
  assert.equal(cancelled, undefined);
});
