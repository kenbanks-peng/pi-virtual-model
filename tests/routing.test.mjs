import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import virtualModelExtension from "../.test-build/index.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pi-virtual-model-test-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const configDir = join(dir, "extensions", "pi-virtual-model");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.toml"), `
[virtual_model]
provider = "openai-codex"
[routing]
planning_model = "planner"
implementation_model = "builder"
direct_model = "direct"
direct_thinking_level = "medium"
`);
  let definition;
  try {
    virtualModelExtension({ registerVirtualModel(value) { definition = value; } });
  } finally {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
  const models = Object.fromEntries(["planner", "builder", "direct"].map(id => [id, { id, provider: "openai-codex" }]));
  const ctx = { modelRegistry: { find: (provider, id) => provider === "openai-codex" ? models[id] : undefined } };
  const user = { role: "user", content: "Fix the plugin", timestamp: 1 };
  const request = { model: { id: "auto" }, reason: "user", thinkingLevel: "high", messages: [user] };
  return { route: request => definition.route(request, ctx), request, user, models };
}

function toolResult(toolName, isError = false, extra = {}) {
  return { role: "toolResult", toolCallId: "call-1", toolName, content: [], isError, timestamp: 2, ...extra };
}

function continuation(request, previous, messages) {
  return { ...request, reason: "continuation", state: previous.state, previous, messages };
}

for (const tool of ["edit", "write"]) {
  test(`switches to the implementation model after the first successful ${tool}`, () => {
    const { route, request, user } = setup();
    const plan = route(request);
    assert.equal(plan.model.id, "planner");
    const build = route(continuation(request, plan, [user, toolResult(tool)]));
    assert.equal(build.model.id, "builder");
    assert.equal(build.thinkingLevel, "high");
    assert.deepEqual(build.state, { phase: "implementation" });
  });
}

for (const result of [toolResult("read"), toolResult("bash"), toolResult("edit", true), toolResult("write", true)]) {
  test(`keeps planning after ${result.toolName} (error=${result.isError})`, () => {
    const { route, request, user } = setup();
    const plan = route(request);
    const next = route(continuation(request, plan, [user, result]));
    assert.equal(next.model.id, "planner");
    assert.equal(next.state, plan.state);
  });
}

test("uses the planning model at every selected thinking level", () => {
  const { route, request } = setup();
  for (const thinkingLevel of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    const plan = route({ ...request, thinkingLevel });
    assert.equal(plan.model.id, "planner");
    assert.equal(plan.thinkingLevel, thinkingLevel);
  }
});

test("keeps implementation state after transcript compaction and session resume", () => {
  const first = setup();
  const plan = first.route(first.request);
  const build = first.route(continuation(first.request, plan, [first.user, toolResult("edit")]));
  const { route, request, user } = setup();
  const restoredState = JSON.parse(JSON.stringify(build.state));
  const next = route({ ...continuation(request, build, [user]), state: restoredState });
  assert.equal(next.model.id, "builder");
  assert.equal(next.state, restoredState);
});

test("starts planning for a new user message and ignores earlier edits", () => {
  const { route, request, user, models } = setup();
  const newUser = { ...user, content: "Now fix another bug", timestamp: 3 };
  const newRequest = {
    ...request,
    state: { phase: "implementation" },
    previous: { model: models.builder, thinkingLevel: "high" },
    messages: [user, toolResult("edit"), newUser],
  };
  const plan = route(newRequest);
  assert.equal(plan.model.id, "planner");
  const next = route(continuation(newRequest, plan, [...newRequest.messages, toolResult("read")]));
  assert.equal(next.model.id, "planner");
});

test("retries keep the failed model and effort, even after a successful edit", () => {
  const { route, request, user, models } = setup();
  const state = { phase: "planning" };
  const retry = route({
    ...request,
    reason: "retry",
    state,
    messages: [user, toolResult("edit")],
    failed: { model: models.planner, thinkingLevel: "low" },
  });
  assert.equal(retry.model, models.planner);
  assert.equal(retry.thinkingLevel, "low");
  assert.equal(retry.state, undefined); // Pi retains the stored phase.
  const next = route({ ...continuation(request, retry, [user, toolResult("edit")]), state });
  assert.equal(next.model.id, "builder");
});

test("retries without a failed model use the stored phase", () => {
  const { route, request } = setup();
  assert.equal(route({ ...request, reason: "retry", state: { phase: "implementation" } }).model.id, "builder");
  assert.equal(route({ ...request, reason: "retry" }).model.id, "planner");
});

test("retries without recorded effort use the selected thinking level", () => {
  const { route, request, models } = setup();
  assert.equal(route({ ...request, reason: "retry", failed: { model: models.builder } }).thinkingLevel, "high");
});

test("direct requests use their own model and effort without changing phase", () => {
  const { route, request } = setup();
  const direct = route({ ...request, reason: "direct", state: { phase: "implementation" } });
  assert.equal(direct.model.id, "direct");
  assert.equal(direct.thinkingLevel, "medium");
  assert.equal(direct.state, undefined);
});

test("detects a successful nested edit even if the parent script failed", () => {
  const { route, request, user } = setup();
  const plan = route(request);
  const result = toolResult("codemode", true, {
    nestedCalls: { calls: [{ name: "edit", status: "ok" }], complete: false },
  });
  assert.equal(route(continuation(request, plan, [user, result])).model.id, "builder");
});

test("does not switch after failed or unfinished nested edits", () => {
  const { route, request, user } = setup();
  const plan = route(request);
  const result = toolResult("codemode", false, {
    nestedCalls: { calls: [{ name: "edit", status: "error" }, { name: "write", status: "unfinished" }], complete: false },
  });
  assert.equal(route(continuation(request, plan, [user, result])).model.id, "planner");
});

test("does not infer implementation from an edit without a user message", () => {
  const { route, request } = setup();
  assert.equal(route({ ...request, reason: "continuation", messages: [toolResult("edit")] }).model.id, "planner");
});

test("session branches keep independent phases", () => {
  const { route, request, user } = setup();
  const plan = route(request);
  const build = route(continuation(request, plan, [user, toolResult("edit")]));
  assert.equal(route(continuation(request, build, [user])).model.id, "builder");
  assert.equal(route(continuation(request, plan, [user])).model.id, "planner");
});

test("reports a missing model instead of choosing an unrelated one", () => {
  const { route, request, models } = setup();
  delete models.builder;
  assert.throws(() => route({ ...request, reason: "continuation", state: { phase: "implementation" } }), /openai-codex\/builder is not available/);
});
