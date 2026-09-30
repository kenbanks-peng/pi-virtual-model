import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureGlobalConfig, loadConfig, parseConfigToml } from "../.test-build/config.js";

const bundled = readFileSync(new URL("../config.toml", import.meta.url), "utf8");

test("bundled config and parser defaults agree", () => {
  assert.deepEqual(parseConfigToml(bundled), parseConfigToml(""));
});

test("reads Jev key command array, difficulty models, and thinking levels", () => {
  const config = parseConfigToml(`
[virtual_model]
provider = "other"
id = "phased"
name = "Phased"
thinking_levels = ["off", "high"]
[routing]
simple_model = "small"
standard_model = "strong#model" # comment
complex_model = "reasoner"
direct_model = "summary"
direct_thinking_level = "low"
[jev]
api_key = ["fnox", "get", "THE-KEY"]
`);
  assert.equal(config.provider, "other");
  assert.equal(config.id, "phased");
  assert.equal(config.name, "Phased");
  assert.deepEqual(config.thinkingLevels, ["off", "high"]);
  assert.equal(config.simpleModel, "small");
  assert.equal(config.standardModel, "strong#model");
  assert.equal(config.complexModel, "reasoner");
  assert.equal(config.directModel, "summary");
  assert.equal(config.directThinkingLevel, "low");
  assert.deepEqual(config.apiKey, ["fnox", "get", "THE-KEY"]);
});

test("rejects unsupported or malformed settings", () => {
  for (const source of [
    '[routing]\nsimple_model = ""',
    '[routing]\ncomplex_model = 1',
    '[routing]\ndirect_thinking_level = "invalid"',
    '[virtual_model]\nthinking_levels = []',
    '[routing]\nlow_model = "old"',
    '[jev]\nunknown = "value"',
    '[jev]\napi_key = []',
    '[jev]\napi_key = ["fnox", 4]',
    '[unknown]',
  ]) assert.throws(() => parseConfigToml(source), /pi-virtual-model config:/);
});

test("creates the global phase config without replacing user changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-virtual-model-config-"));
  const path = join(dir, "extensions", "config.toml");
  try {
    ensureGlobalConfig(path);
    assert.equal(readFileSync(path, "utf8"), bundled);
    assert.deepEqual(loadConfig(path), parseConfigToml(bundled));
    const custom = bundled.replace('standard_model = "gpt-6-astra"', 'standard_model = "custom"');
    writeFileSync(path, custom);
    ensureGlobalConfig(path);
    assert.equal(readFileSync(path, "utf8"), custom);
    assert.equal(loadConfig(path).standardModel, "custom");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
