import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { authState, openUsageLedger, storeApiKey } from "pi-typesafe";
import virtualModelExtension from "../.test-build/index.js";

function setup({ key = "test-key", decision = "balanced" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-virtual-model-test-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldKey = process.env.TYPESAFE_API_KEY;
  const caps = ["PI_TYPESAFE_MAX_REQUESTS_PER_DAY", "PI_TYPESAFE_MAX_INPUT_TOKENS_PER_DAY", "PI_TYPESAFE_MAX_USD_PER_DAY"];
  const oldCaps = caps.map(name => process.env[name]);
  for (const name of caps) delete process.env[name];
  process.env.PI_CODING_AGENT_DIR = dir;
  if (key === null) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = key;
  const configDir = join(dir, "extensions", "pi-virtual-model");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.toml"), `
[virtual_model]
provider = "openai-codex"
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
  virtualModelExtension({
    registerVirtualModel(value) { definition = value; },
    registerEntryRenderer() {},
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  });
  const models = Object.fromEntries(["small", "medium-model", "large"].map(id => [id, { id, provider: "openai-codex" }]));
  const ctx = {
    modelRegistry: { find: (provider, id) => provider === "openai-codex" ? models[id] : undefined },
    sessionManager: { getBranch: () => entries },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return Response.json({
      model: "jev-1.13.0",
      answers: { route: { type: "choice", choice: decision, confidence: 1, probabilities: { quick: decision === "quick" ? 1 : 0, balanced: decision === "balanced" ? 1 : 0, deep: decision === "deep" ? 1 : 0 } } },
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  };
  const user = { role: "user", content: "Fix the plugin", timestamp: 1 };
  const request = { model: { id: "auto" }, reason: "user", thinkingLevel: "high", messages: [user], signal: new AbortController().signal };
  return {
    route: request => definition.route(request, ctx), request, user, models, entries, calls, dir,
    restoreFetch() {
      globalThis.fetch = originalFetch;
      if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldDir;
      if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = oldKey;
      caps.forEach((name, index) => {
        if (oldCaps[index] === undefined) delete process.env[name];
        else process.env[name] = oldCaps[index];
      });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("chooses configured models for Jev difficulty", async () => {
  for (const [decision, expected] of [["quick", "small"], ["balanced", "medium-model"], ["deep", "large"]]) {
    const test = setup({ decision });
    try {
      const result = await test.route(test.request);
      assert.equal(result.model.id, expected);
      assert.equal(result.state.model, expected);
      assert.equal(result.state.thinkingLevel, result.thinkingLevel);
      assert.equal(result.thinkingLevel, { quick: "low", balanced: "medium", deep: "high" }[decision]);
      assert.equal(test.calls[0].url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(new Headers(test.calls[0].options.headers).get("authorization"), "Bearer test-key");
      const { body, options } = test.calls[0];
      assert.equal(options.method, "POST");
      assert.equal(new Headers(options.headers).get("content-type"), "application/json");
      assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
      assert.equal(body.model, "jev-latest");
      assert.equal(body.state.latest_request, "Fix the plugin");
      assert.equal(body.questions.route.type, "choice");
      assert.equal(typeof body.questions.route.instructions, "string");
      assert.deepEqual(Object.keys(body.questions.route.criteria).sort(), ["balanced", "deep", "quick"]);
      assert.match(body.questions.route.criteria.quick, /Fast tasks.*small.*low/);
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
      { answers: { route: { type: "choice", choice: "unknown" } } },
      { code: 0, data: { decision: "simple:low" } }]) {
      globalThis.fetch = async () => Response.json(payload);
      await assert.rejects(fixture.route(fixture.request), /TypeSafe returned/);
    }
  } finally { fixture.restoreFetch(); }
});

test("classifies each new user message and keeps the selection on continuations", async () => {
  const test = setup({ decision: "deep" });
  try {
    const selected = await test.route(test.request);
    const next = await test.route({ ...test.request, reason: "continuation", state: selected.state });
    assert.equal(next.model.id, "large");
    assert.equal(next.thinkingLevel, selected.thinkingLevel);
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

test("direct requests use Jev to classify the task", async () => {
  const test = setup({ decision: "deep" });
  try {
    const result = await test.route({ ...test.request, reason: "direct" });
    assert.equal(result.model.id, "large");
    assert.equal(result.thinkingLevel, "high");
    assert.equal(test.calls.length, 1);
  } finally { test.restoreFetch(); }
});

test("fails clearly if the Jev key is missing", async () => {
  const test = setup({ key: null });
  try {
    await assert.rejects(test.route(test.request), /No API key/);
  } finally { test.restoreFetch(); }
});

test("fails clearly for Jev HTTP errors or invalid candidate answers", async () => {
  const http = setup();
  try {
    globalThis.fetch = async () => new Response(null, { status: 401, statusText: "Unauthorized" });
    await assert.rejects(http.route(http.request), /HTTP 401/);
  } finally { http.restoreFetch(); }
  const invalid = setup({ decision: "unknown" });
  try {
    await assert.rejects(invalid.route(invalid.request), /TypeSafe returned/);
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
    await assert.rejects(fixture.route(fixture.request), /HTTP 401/);
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

test("persistent transient failures fall back to balanced and pin continuations", async () => {
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
      assert.equal(result.thinkingLevel, "medium");
      const continuation = await fixture.route({ ...fixture.request, reason: "continuation", state: result.state });
      assert.equal(continuation.model.id, "medium-model");
      assert.equal(attempts, 3);
    } finally { fixture.restoreFetch(); }
  }
});

test("uses the pi-typesafe login store without router credentials", async () => {
  const fixture = setup({ key: null });
  try {
    storeApiKey("stored-typesafe-key-12345");
    await fixture.route(fixture.request);
    assert.equal(new Headers(fixture.calls[0].options.headers).get("authorization"), "Bearer stored-typesafe-key-12345");
    assert.equal(authState().kind, "stored");
    assert.equal(authState().verified, true);
  } finally { fixture.restoreFetch(); }
});

test("environment credentials take precedence over the login store", async () => {
  const fixture = setup();
  try {
    storeApiKey("stored-typesafe-key-12345");
    await fixture.route(fixture.request);
    assert.equal(new Headers(fixture.calls[0].options.headers).get("authorization"), "Bearer test-key");
  } finally { fixture.restoreFetch(); }
});

test("records decisions in shared usage and continues beyond twenty attempts", async () => {
  const fixture = setup();
  try {
    for (let index = 0; index < 25; index += 1) await fixture.route(fixture.request);
    const totals = openUsageLedger().today();
    assert.equal(fixture.calls.length, 25);
    assert.equal(totals.requestsStarted, 25);
    assert.equal(totals.requestsSucceeded, 25);
    assert.equal(totals.inputTokens, 2500);
    assert.equal(totals.outputTokens, 500);
    assert.ok(totals.estimatedUsd > 0);
    assert.equal(authState().verified, true);
  } finally { fixture.restoreFetch(); }
});

test("authentication failures update pi-typesafe state without leaking upstream details", async () => {
  const fixture = setup();
  try {
    globalThis.fetch = async () => new Response("secret-upstream-body", { status: 401 });
    await assert.rejects(fixture.route(fixture.request), error => {
      assert.equal(error.code, "http");
      assert.equal(error.status, 401);
      assert.ok(!error.message.includes("secret-upstream-body"));
      return true;
    });
    assert.equal(authState().usable, false);
    assert.equal(authState().lastFailure.status, 401);
    assert.equal(openUsageLedger().today().requestsFailed, 1);
  } finally { fixture.restoreFetch(); }
});

test("honors explicit shared daily caps without retries or silent fallback", async () => {
  const fixture = setup();
  try {
    process.env.PI_TYPESAFE_MAX_REQUESTS_PER_DAY = "1";
    // Requests from another extension count toward the shared cap.
    openUsageLedger().recordStart();
    await assert.rejects(fixture.route(fixture.request), error => error.code === "budget");
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.entries.length, 0);
  } finally { fixture.restoreFetch(); }
});

test("an already cancelled request never reaches TypeSafe", async () => {
  const fixture = setup();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(fixture.route({ ...fixture.request, signal: controller.signal }), { name: "AbortError" });
    assert.equal(fixture.calls.length, 0);
    assert.equal(openUsageLedger().today().requestsStarted, 0);
  } finally { fixture.restoreFetch(); }
});
