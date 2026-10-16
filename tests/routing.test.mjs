import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import virtualModelExtension from "../.test-build/index.js";

function setup({ decision = "balanced", virtualId = "auto", canSelect = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-virtual-model-test-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const configDir = join(dir, "extensions", "pi-virtual-model");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.toml"), `
[virtual_model]
provider = "openai-codex"
id = "${virtualId}"
[routing]
fallback = "balanced"
[routing.quick]
model = "small"
thinking_level = "low"
description = "Fast tasks"
[routing.balanced]
model = "medium-model"
thinking_level = "medium"
description = "General tasks"
[routing.deep]
model = "large"
thinking_level = "high"
description = "Complex tasks"
`);
  let definition;
  const entries = [];
  const calls = [];
  const lookups = [];
  const handlers = {};
  const selections = [];
  virtualModelExtension({
    on(event, handler) { handlers[event] = handler; },
    async setModel(model) { selections.push(model); return canSelect; },
    registerVirtualModel(value) { definition = value; },
    registerEntryRenderer() {},
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  });
  const models = Object.fromEntries(["small", "medium-model", "large"].map(id => [id, { id, provider: "openai-codex" }]));
  models[virtualId] = { id: virtualId, provider: "openai-codex" };
  const jev = { type: "classifier", provider: "typesafe", id: "jev-latest" };
  const registry = {
    find: (provider, id) => provider === "openai-codex" ? models[id] : undefined,
    findOfType(...args) { lookups.push(args); return jev; },
    async classify(model, input, options) {
      calls.push({ model, input, options });
      return {
        stopReason: "stop",
        answers: { route: { type: "choice", choice: decision, confidence: 1, probabilities: { [decision]: 1 } } },
      };
    },
  };
  const ctx = { modelRegistry: registry, sessionManager: { getBranch: () => entries } };
  const user = { role: "user", content: "Fix the plugin", timestamp: 1 };
  const request = { model: { id: "auto" }, reason: "user", thinkingLevel: "high", messages: [user], signal: new AbortController().signal };
  return {
    start: () => handlers.session_start({}, ctx), selections,
    route: request => definition.route(request, ctx), request, user, models, jev, registry, ctx, entries, calls, lookups, dir,
    cleanup() {
      if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldDir;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("selects the configured virtual model at session startup without consulting enabledModels", async () => {
  for (const virtualId of ["auto", "custom-auto"]) {
    const fixture = setup({ virtualId });
    try {
      assert.deepEqual(fixture.selections, []);
      await fixture.start();
      assert.deepEqual(fixture.selections, [fixture.models[virtualId]]);
      assert.equal(fixture.calls.length, 0);
    } finally { fixture.cleanup(); }
  }
});

test("reports authentication failure when startup selection is rejected", async () => {
  const fixture = setup({ canSelect: false });
  try {
    await assert.rejects(fixture.start(), /authenticate with \/login/);
    assert.deepEqual(fixture.selections, [fixture.models.auto]);
  } finally { fixture.cleanup(); }
});

test("reports a missing virtual model at startup without selecting another model", async () => {
  const fixture = setup();
  try {
    delete fixture.models.auto;
    await assert.rejects(fixture.start(), /pi-virtual-model: openai-codex\/auto is not available/);
    assert.deepEqual(fixture.selections, []);
  } finally { fixture.cleanup(); }
});

test("chooses configured routes through Pi's Jev classifier", async () => {
  for (const [decision, expected] of [["quick", "small"], ["balanced", "medium-model"], ["deep", "large"]]) {
    const fixture = setup({ decision });
    try {
      const result = await fixture.route(fixture.request);
      assert.equal(result.model.id, expected);
      assert.equal(result.state.model, expected);
      assert.equal(result.state.optionId, decision);
      assert.equal(result.state.thinkingLevel, result.thinkingLevel);
      assert.equal(result.thinkingLevel, { quick: "low", balanced: "medium", deep: "high" }[decision]);
      assert.deepEqual(fixture.lookups, [["classifier", "typesafe", "jev-latest"]]);
      const { model, input, options } = fixture.calls[0];
      assert.equal(model, fixture.jev);
      assert.deepEqual(options, { signal: fixture.request.signal, timeoutMs: 15_000, maxRetries: 2 });
      assert.equal(input.state.latest_request, "Fix the plugin");
      assert.equal(input.questions.route.type, "choice");
      assert.deepEqual(Object.keys(input.questions.route.criteria).sort(), ["balanced", "deep", "quick"]);
      assert.match(input.questions.route.criteria.quick, /Fast tasks.*small.*low/);
    } finally { fixture.cleanup(); }
  }
});

test("classifies each user turn but pins continuations", async () => {
  const fixture = setup({ decision: "deep" });
  try {
    const selected = await fixture.route(fixture.request);
    const next = await fixture.route({ ...fixture.request, reason: "continuation", state: selected.state });
    assert.equal(next.model.id, "large");
    assert.equal(next.thinkingLevel, selected.thinkingLevel);
    assert.equal(fixture.calls.length, 1);
    await fixture.route({ ...fixture.request, messages: [...fixture.request.messages, { role: "user", content: "Simple question" }], state: selected.state });
    assert.equal(fixture.calls.length, 2);
  } finally { fixture.cleanup(); }
});

test("physical model retries bypass Jev", async () => {
  const fixture = setup();
  try {
    const result = await fixture.route({ ...fixture.request, reason: "retry", failed: { model: fixture.models.large, thinkingLevel: "low" } });
    assert.equal(result.model.id, "large");
    assert.equal(result.thinkingLevel, "low");
    assert.equal(fixture.calls.length, 0);
  } finally { fixture.cleanup(); }
});

test("direct requests use Jev", async () => {
  const fixture = setup({ decision: "deep" });
  try {
    assert.equal((await fixture.route({ ...fixture.request, reason: "direct" })).model.id, "large");
    assert.equal(fixture.calls.length, 1);
  } finally { fixture.cleanup(); }
});

test("missing Jev uses fallback without a classifier call", async () => {
  const fixture = setup();
  try {
    fixture.registry.findOfType = () => undefined;
    assert.equal((await fixture.route(fixture.request)).model.id, "medium-model");
    assert.equal(fixture.calls.length, 0);
  } finally { fixture.cleanup(); }
});

test("classifier errors fall back once and pin continuations without exposing upstream details", async () => {
  const fixture = setup();
  let calls = 0;
  try {
    fixture.registry.classify = async () => {
      calls += 1;
      return { stopReason: "error", errorMessage: "secret-upstream-body", answers: {} };
    };
    const selected = await fixture.route(fixture.request);
    assert.equal(selected.model.id, "medium-model");
    assert.equal(selected.thinkingLevel, "medium");
    const continuation = await fixture.route({ ...fixture.request, reason: "continuation", state: selected.state });
    assert.equal(continuation.model.id, "medium-model");
    assert.equal(calls, 1); // Retries belong to Pi, not another outer loop.
    assert.ok(!JSON.stringify(fixture.entries).includes("secret-upstream-body"));
  } finally { fixture.cleanup(); }
});

test("missing, wrong-type, and unknown route answers use fallback", async () => {
  const fixture = setup();
  try {
    for (const answer of [undefined, null, { type: "score", score: 2 }, { type: "choice", choice: "unknown" }]) {
      fixture.registry.classify = async () => ({ stopReason: "stop", answers: { route: answer } });
      assert.equal((await fixture.route(fixture.request)).model.id, "medium-model");
    }
  } finally { fixture.cleanup(); }
});

test("already cancelled requests never reach the registry", async () => {
  const fixture = setup();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(fixture.route({ ...fixture.request, signal: controller.signal }), { name: "AbortError" });
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.lookups.length, 0);
  } finally { fixture.cleanup(); }
});

test("cancellation during classification stops routing rather than falling back", async () => {
  const fixture = setup();
  try {
    const controller = new AbortController();
    fixture.registry.classify = async () => {
      controller.abort();
      return { stopReason: "error", answers: {} };
    };
    await assert.rejects(fixture.route({ ...fixture.request, signal: controller.signal }), { name: "AbortError" });
    assert.equal(fixture.entries.length, 0);
  } finally { fixture.cleanup(); }
});

test("an aborted classifier result never selects fallback", async () => {
  const fixture = setup();
  try {
    fixture.registry.classify = async () => ({ stopReason: "aborted", answers: {} });
    await assert.rejects(fixture.route(fixture.request), { name: "AbortError" });
    assert.equal(fixture.entries.length, 0);
  } finally { fixture.cleanup(); }
});

test("preserves bounded user text and recent context", async () => {
  const fixture = setup();
  try {
    await fixture.route({ ...fixture.request, messages: [
      { role: "user", content: "Prior request" },
      { role: "assistant", content: [{ type: "text", text: "x".repeat(5000) }] },
      { role: "user", content: [{ type: "image", data: "ignored" }, { type: "text", text: "z".repeat(20_000) }] },
    ] });
    const { state } = fixture.calls[0].input;
    assert.equal(state.latest_request, "z".repeat(16_000));
    assert.equal(state.recent_context, "x".repeat(4_000));
  } finally { fixture.cleanup(); }
});

test("fails clearly when the selected physical model is missing", async () => {
  const fixture = setup();
  try {
    fixture.registry.find = () => undefined;
    await assert.rejects(fixture.route(fixture.request), /openai-codex\/medium-model is not available/);
  } finally { fixture.cleanup(); }
});

test("uses the real Pi registry, provider credentials, protocol and retries", async () => {
  const fixture = setup({ decision: "deep" });
  const originalFetch = globalThis.fetch;
  const oldKey = process.env.TYPESAFE_API_KEY;
  const calls = [];
  try {
    process.env.TYPESAFE_API_KEY = "environment-key";
    // Isolated Pi auth store: never read or modify the user's real credentials.
    writeFileSync(join(fixture.dir, "auth.json"), JSON.stringify({ typesafe: { type: "api_key", key: "pi-stored-key" } }));
    const runtime = await ModelRuntime.create({
      authPath: join(fixture.dir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const registry = new ModelRegistry(runtime);
    fixture.ctx.modelRegistry = registry;
    const find = registry.find.bind(registry);
    registry.find = (provider, id) => fixture.models[id] ?? find(provider, id);
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return new Response(null, { status: 502, headers: { "retry-after-ms": "1" } });
      return Response.json({
        model: "jev-latest",
        answers: { route: { type: "choice", choice: "deep", confidence: 1, probabilities: { quick: 0, balanced: 0, deep: 1 } } },
        usage: { input_tokens: 100, output_tokens: 20 },
      });
    };
    assert.equal((await fixture.route(fixture.request)).model.id, "large");
    assert.equal(calls.length, 2);
    assert.equal(String(calls[1].url), "https://api.typesafe.ai/v1/systemone");
    assert.equal(new Headers(calls[1].options.headers).get("authorization"), "Bearer pi-stored-key");
    const body = JSON.parse(calls[1].options.body);
    assert.equal(body.model, "jev-latest");
    assert.equal(body.state.latest_request, "Fix the plugin");
    assert.equal(body.questions.route.type, "choice");
  } finally {
    globalThis.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = oldKey;
    fixture.cleanup();
  }
});
