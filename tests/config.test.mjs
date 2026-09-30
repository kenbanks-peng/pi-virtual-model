import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureGlobalConfig, loadConfig, parseConfigToml } from "../.test-build/config.js";

const bundled = readFileSync(new URL("../config.toml", import.meta.url), "utf8");

test("bundled config and parser defaults agree", () => assert.deepEqual(parseConfigToml(bundled), parseConfigToml("")));

test("parses explicit route options and option references", () => {
  const config = parseConfigToml(`
[virtual_model]
provider = 'other'
[routing]
fallback = "balanced"
api_key = [
  "printf", # command
  'key',
]
[routing.quick]
model = "small"
thinking_level = "low"
description = "Fast tasks | including # characters"
[routing.balanced]
model = "large"
thinking_level = "medium"
description = """General tasks
with multiple lines"""
`);
  assert.equal(config.provider, "other");
  assert.equal(config.options[0].description, "Fast tasks | including # characters");
  assert.equal(config.options[1].description, "General tasks\nwith multiple lines");
  assert.deepEqual(config.options.map((o) => o.id), ["quick", "balanced"]);
  assert.equal(config.options[1].model, "large");
  assert.equal(config.options[1].thinkingLevel, "medium");
  assert.equal(config.fallback, "balanced");
  assert.deepEqual(config.apiKey, ["printf", "key"]);
});

test("rejects invalid options and unknown settings", () => {
  for (const source of [
    '[routing]\noptions = ["bad|m|invalid|description"]',
    '[routing]\noptions = ["same|m|low|a", "same|n|high|b"]',
    '[routing]\nunknown = "value"',
    '[routing]\napi_key = []',
    '[unknown]',
    '[jev]\napi_key = "old-key"',
    '[routing.options.quick]\nmodel = "m"\nthinking_level = "low"\ndescription = "d"',
    '[routing.balanced]',
    '[routing.balanced]\nmodel = "m"\nthinking_level = "invalid"\ndescription = "d"',
    '[routing.balanced]\nmodel = "m"\nthinking_level = "low"',
    '[routing.balanced]\nmodel = 42\nthinking_level = "low"\ndescription = "d"',
    '[routing.balanced]\nmodel = "m"\nthinking_level = "low"\ndescription = "d"\nunknown = true',
    '[routing.balanced]\n[routing.balanced]',
    '[routing."bad id"]\nmodel = "m"\nthinking_level = "low"\ndescription = "d"',
    'routing = false',
    '[routing]\nbalanced = "m"',
    '[routing]\napi_key = [42]',
  ]) assert.throws(() => parseConfigToml(source), /pi-virtual-model config:/);
});

test("creates bundled config without replacing user changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-virtual-model-config-"));
  const path = join(dir, "extensions", "config.toml");
  try {
    ensureGlobalConfig(path);
    assert.equal(readFileSync(path, "utf8"), bundled);
    assert.deepEqual(loadConfig(path), parseConfigToml(bundled));
    const custom = bundled.replace('fallback = "balanced"', 'fallback = "quick"');
    writeFileSync(path, custom);
    ensureGlobalConfig(path);
    assert.equal(readFileSync(path, "utf8"), custom);
    assert.equal(loadConfig(path).fallback, "quick");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("TOML syntax errors do not expose credentials", () => {
  assert.throws(() => parseConfigToml('[routing]\napi_key = "secret-value" trailing'), (error) => {
    assert.match(error.message, /pi-virtual-model config: invalid TOML syntax/);
    assert.ok(!error.message.includes("secret-value"));
    return true;
  });
});

test("routing settings alone retain default options", () => {
  const config = parseConfigToml('[routing]\nfallback = "quick"\napi_key = "custom-key"');
  assert.deepEqual(config.options, parseConfigToml("").options);
  assert.equal(config.fallback, "quick");
  assert.equal(config.apiKey, "custom-key");
});

test("custom routing tables replace the default option set", () => {
  const config = parseConfigToml(`
[routing]
fallback = "custom"
[routing.custom]
model = "my-model"
thinking_level = "off"
description = "Custom tasks"
`);
  assert.deepEqual(config.options, [{ id: "custom", model: "my-model", thinkingLevel: "off", description: "Custom tasks" }]);
});
