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

test("reads phase models and thinking levels", () => {
  const config = parseConfigToml(`
[virtual_model]
provider = "other"
id = "phased"
name = "Phased"
thinking_levels = ["off", "high"]
[routing]
planning_model = "strong#model" # comment
implementation_model = "cheap"
direct_model = "summary"
direct_thinking_level = "low"
`);
  assert.equal(config.provider, "other");
  assert.equal(config.id, "phased");
  assert.equal(config.name, "Phased");
  assert.deepEqual(config.thinkingLevels, ["off", "high"]);
  assert.equal(config.planningModel, "strong#model");
  assert.equal(config.implementationModel, "cheap");
  assert.equal(config.directModel, "summary");
  assert.equal(config.directThinkingLevel, "low");
});

test("rejects unsupported or malformed settings", () => {
  for (const source of [
    '[routing]\nplanning_model = ""',
    '[routing]\nimplementation_model = 1',
    '[routing]\ndirect_thinking_level = "invalid"',
    '[virtual_model]\nthinking_levels = []',
    '[routing]\nlow_model = "old"',
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
    const custom = bundled.replace('planning_model = "gpt-6-astra"', 'planning_model = "custom"');
    writeFileSync(path, custom);
    ensureGlobalConfig(path);
    assert.equal(readFileSync(path, "utf8"), custom);
    assert.equal(loadConfig(path).planningModel, "custom");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
