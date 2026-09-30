import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import virtualModelExtension from "../.test-build/index.js";

function setup({ key = "test-key", decision = "standard", configuredKey } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-virtual-model-test-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldKey = process.env.TYPESAFE_AI_KEY;
  process.env.PI_CODING_AGENT_DIR = dir;
  if (key === null) delete process.env.TYPESAFE_AI_KEY;
  else process.env.TYPESAFE_AI_KEY = key;
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
    return Response.json({
      model: "jev-1.13.0",
      answers: { route: { type: "choice", choice: decision.includes(":") ? decision : `${decision}:high`, confidence: 1, probabilities: {} } },
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  };
  const user = { role: "user", content: "Fix the plugin", timestamp: 1 };
  const request = { model: { id: "auto" }, reason: "user", thinkingLevel: "high", messages: [user], signal: new AbortController().signal };
  return {
    route: request => definition.route(request, ctx), request, user, models, entries, calls,
    restoreFetch() {
      globalThis.fetch = originalFetch;
      if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldDir;
      if (oldKey === undefined) delete process.env.TYPESAFE_AI_KEY;
      else process.env.TYPESAFE_AI_KEY = oldKey;
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
      assert.equal(test.calls[0].url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(test.calls[0].options.headers.Authorization, "Bearer test-key");
      const { body, options } = test.calls[0];
      assert.equal(options.method, "POST");
      assert.equal(options.headers["Content-Type"], "application/json");
      assert.equal(options.signal, test.request.signal);
      assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
      assert.equal(body.model, "jev-latest");
      assert.equal(body.state.latest_request, "Fix the plugin");
      assert.equal(body.questions.route.type, "choice");
      assert.equal(typeof body.questions.route.instructions, "string");
      assert.deepEqual(Object.keys(body.questions.route.criteria).sort(),
        ["simple", "standard", "complex"].flatMap(difficulty =>
          ["low", "medium", "high", "xhigh"].map(level => `${difficulty}:${level}`)).sort());
      assert.ok(Object.values(body.questions.route.criteria).every(value => typeof value === "string"));
    } finally { test.restoreFetch(); }
  }
});

test("rejects malformed or legacy Jev answers", async () => {
  const fixture = setup();
  try {
    for (const payload of [null, {}, { answers: null }, { answers: { route: null } },
      { answers: { route: { type: "score", choice: "simple:low" } } },
      { answers: { route: { type: "choice", choice: 1 } } },
      { answers: { route: { type: "choice", choice: "simple:unsupported" } } },
      { code: 0, data: { decision: "simple:low" } }]) {
      globalThis.fetch = async () => Response.json(payload);
      await assert.rejects(fixture.route(fixture.request), /Jev returned/);
    }
  } finally { fixture.restoreFetch(); }
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

test("recovers when Jev returns a temporary 502 before a successful decision", async () => {
  const fixture = setup();
  const successfulFetch = globalThis.fetch;
  let attempts = 0;
  try {
    globalThis.fetch = async (...args) => {
      attempts += 1;
      if (attempts === 1) return new Response(null, { status: 502, statusText: "Bad Gateway" });
      return successfulFetch(...args);
    };
    const result = await fixture.route(fixture.request);
    assert.equal(result.model.id, "medium-model");
    assert.equal(attempts, 2);
  } finally { fixture.restoreFetch(); }
});

test("does not retry rejected requests", async () => {
  const fixture = setup();
  let attempts = 0;
  try {
    globalThis.fetch = async () => {
      attempts += 1;
      return new Response(null, { status: 401, statusText: "Unauthorized" });
    };
    await assert.rejects(fixture.route(fixture.request), /401 Unauthorized/);
    assert.equal(attempts, 1);
  } finally { fixture.restoreFetch(); }
});

test("cancellation during backoff stops Jev retries", async () => {
  const fixture = setup();
  const controller = new AbortController();
  let attempts = 0;
  try {
    globalThis.fetch = async () => {
      attempts += 1;
      setTimeout(() => controller.abort(), 10);
      return new Response(null, { status: 502, statusText: "Bad Gateway" });
    };
    await assert.rejects(fixture.route({ ...fixture.request, signal: controller.signal }), { name: "AbortError" });
    assert.equal(attempts, 1);
  } finally { fixture.restoreFetch(); }
});

test("persistent transient failures fall back to standard and pin continuations", async () => {
  for (const status of [429, 502, 503, 504, 529]) {
    const fixture = setup();
    let attempts = 0;
    try {
      globalThis.fetch = async () => {
        attempts += 1;
        return new Response(null, { status });
      };
      const result = await fixture.route({ ...fixture.request, thinkingLevel: "low" });
      assert.equal(attempts, 3);
      assert.equal(result.model.id, "medium-model");
      assert.equal(result.thinkingLevel, "low");
      const continuation = await fixture.route({ ...fixture.request, reason: "continuation", state: result.state });
      assert.equal(continuation.model.id, "medium-model");
      assert.equal(attempts, 3);
    } finally { fixture.restoreFetch(); }
  }
});
