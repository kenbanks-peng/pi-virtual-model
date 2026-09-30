import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureGlobalConfig, loadConfig, parseConfigToml } from "../.test-build/config.js";

const bundled = readFileSync(new URL("../config.toml", import.meta.url), "utf8");

test("bundled config and parser defaults agree", () => assert.deepEqual(parseConfigToml(bundled), parseConfigToml("")));

test("parses explicit route options and option references", () => {
  const config = parseConfigToml(`[virtual_model]\nprovider = "other"\n[routing]\noptions = ["quick|small|low|Fast tasks", "balanced|large|medium|General tasks"]\ndirect_option = "quick"\nfallback_option = "balanced"\n[jev]\napi_key = ["printf", "key"]`);
  assert.equal(config.provider, "other");
  assert.deepEqual(config.options.map((o) => o.id), ["quick", "balanced"]);
  assert.equal(config.options[1].model, "large");
  assert.equal(config.options[1].thinkingLevel, "medium");
  assert.equal(config.directOption, "quick");
  assert.equal(config.fallbackOption, "balanced");
  assert.deepEqual(config.apiKey, ["printf", "key"]);
});

test("rejects invalid options and unknown settings", () => {
  for (const source of [
    '[routing]\noptions = ["bad|m|invalid|description"]',
    '[routing]\noptions = ["same|m|low|a", "same|n|high|b"]',
    '[routing]\ndirect_option = "missing"',
    '[routing]\ndirect_thinking_level = "low"',
    '[jev]\nunknown = "value"',
    '[jev]\napi_key = []',
    '[unknown]',
  ]) assert.throws(() => parseConfigToml(source), /pi-virtual-model config:/);
});

test("creates bundled config without replacing user changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-virtual-model-config-"));
  const path = join(dir, "extensions", "config.toml");
  try {
    ensureGlobalConfig(path);
    assert.equal(readFileSync(path, "utf8"), bundled);
    assert.deepEqual(loadConfig(path), parseConfigToml(bundled));
    const custom = bundled.replace('direct_option = "balanced"', 'direct_option = "quick"');
    writeFileSync(path, custom);
    ensureGlobalConfig(path);
    assert.equal(readFileSync(path, "utf8"), custom);
    assert.equal(loadConfig(path).directOption, "quick");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
