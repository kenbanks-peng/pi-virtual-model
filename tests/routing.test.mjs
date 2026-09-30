import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import virtualModelExtension from "../.test-build/index.js";

function setup({ key = "test-key", decision = "standard", configuredKey } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-virtual-model-test-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldKey = process.env.JEV_API_KEY;
  process.env.PI_CODING_AGENT_DIR = dir;
  if (key === null) delete process.env.JEV_API_KEY;
  else process.env.JEV_API_KEY = key;
  const configDir = join(dir, "extensions", "pi-virtual-model");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.toml"), `
[virtual_model]
provider = "openai-codex"
[routing]
simple_model = "small"
standard_model = "medium-model"
complex_model = "large"
direct_model = "direct"
direct_thinking_level = "medium"
${configuredKey ? `[jev]\napi_key = ${JSON.stringify(configuredKey)}\n` : ""}
`);
  let definition;
  const entries = [];
  const calls = [];
  virtualModelExtension({
    registerVirtualModel(value) { definition = value; },
    registerEntryRenderer() {},
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  });
  const models = Object.fromEntries(["small", "medium-model", "large", "direct"].map(id => [id, { id, provider: "openai-codex" }]));
  const ctx = {
    modelRegistry: { find: (provider, id) => provider === "openai-codex" ? models[id] : undefined },
    sessionManager: { getBranch: () => entries },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ code: 0, data: { decision } }) };
  };
  const user = { role: "user", content: "Fix the plugin", timestamp: 1 };
  const request = { model: { id: "auto" }, reason: "user", thinkingLevel: "high", messages: [user], signal: new AbortController().signal };
  return {
    route: request => definition.route(request, ctx), request, user, models, entries, calls,
    restoreFetch() {
      globalThis.fetch = originalFetch;
      if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldDir;
      if (oldKey === undefined) delete process.env.JEV_API_KEY;
      else process.env.JEV_API_KEY = oldKey;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("chooses configured models for Jev difficulty", async () => {
  for (const [decision, expected] of [["simple", "small"], ["standard", "medium-model"], ["complex", "large"]]) {
    const test = setup({ decision });
    try {
      const result = await test.route(test.request);
      assert.equal(result.model.id, expected);
      assert.equal(result.state.model, expected);
      assert.equal(result.thinkingLevel, "high");
      assert.match(test.calls[0].url, /api\/v1\/decisions\/model-route$/);
      assert.equal(test.calls[0].options.headers.Authorization, "Bearer test-key");
      assert.deepEqual(test.calls[0].body.candidates.map(candidate => candidate.id), ["simple", "standard", "complex"]);
    } finally { test.restoreFetch(); }
  }
});

test("resolves a configured command array for the Jev key", async () => {
  const test = setup({ key: null, configuredKey: ["printf", "%s", "configured-key"] });
  try {
    await test.route(test.request);
    assert.equal(test.calls[0].options.headers.Authorization, "Bearer configured-key");
  } finally { test.restoreFetch(); }
});

test("classifies each new user message and keeps the selection on continuations", async () => {
  const test = setup({ decision: "complex" });
  try {
    const selected = await test.route(test.request);
    const next = await test.route({ ...test.request, reason: "continuation", state: selected.state });
    assert.equal(next.model.id, "large");
    assert.equal(test.calls.length, 1);
    await test.route({ ...test.request, reason: "user", messages: [...test.request.messages, { role: "user", content: "Simple question" }] });
    assert.equal(test.calls.length, 2);
  } finally { test.restoreFetch(); }
});

test("retries stay on the failed model without another Jev call", async () => {
  const test = setup();
  try {
    const retry = await test.route({ ...test.request, reason: "retry", failed: { model: test.models.large, thinkingLevel: "low" } });
    assert.equal(retry.model.id, "large");
    assert.equal(retry.thinkingLevel, "low");
    assert.equal(test.calls.length, 0);
  } finally { test.restoreFetch(); }
});

test("direct requests use the configured direct model without classifying", async () => {
  const test = setup();
  try {
    const result = await test.route({ ...test.request, reason: "direct" });
    assert.equal(result.model.id, "direct");
    assert.equal(test.calls.length, 0);
  } finally { test.restoreFetch(); }
});

test("fails clearly if the Jev key is missing", async () => {
  const test = setup({ key: null });
  try {
    await assert.rejects(test.route(test.request), /api_key command failed/);
  } finally { test.restoreFetch(); }
});

test("fails clearly for Jev HTTP errors or invalid candidate answers", async () => {
  const http = setup();
  try {
    globalThis.fetch = async () => ({ ok: false, status: 401, statusText: "Unauthorized" });
    await assert.rejects(http.route(http.request), /Jev model-route failed \(401 Unauthorized\)/);
  } finally { http.restoreFetch(); }
  const invalid = setup({ decision: "unknown" });
  try {
    await assert.rejects(invalid.route(invalid.request), /unknown model candidate/);
  } finally { invalid.restoreFetch(); }
});
