import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface RouteOption {
  id: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  description: string;
}

export interface VirtualModelConfig {
  apiKey?: string | string[];
  provider: string;
  id: string;
  name: string;
  options: RouteOption[];
  directOption: string;
  fallbackOption: string;
}

function defaultConfig(): VirtualModelConfig {
  return {
    provider: "openai-codex", id: "auto", name: "Auto",
    options: [
      { id: "quick", model: "gpt-6-luna", thinkingLevel: "low", description: "Simple questions and small, clear tasks." },
      { id: "balanced", model: "gpt-6.1-sol", thinkingLevel: "medium", description: "General tasks that need moderate reasoning." },
      { id: "deep", model: "gpt-6-astra", thinkingLevel: "high", description: "Complex tasks that need careful reasoning." },
    ],
    directOption: "balanced", fallbackOption: "balanced", apiKey: ["printenv", "TYPESAFE_AI_KEY"],
  };
}

export function globalConfigPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "extensions", "pi-virtual-model", "config.toml");
}

export function ensureGlobalConfig(path = globalConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) return;
  try {
    const bundledConfig = readFileSync(new URL("../config.toml", import.meta.url), "utf8");
    writeFileSync(path, bundledConfig, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function stripComment(line: string): string {
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (escaped) { escaped = false; continue; }
    if (c === "\\" && quoted) { escaped = true; continue; }
    if (c === '"') quoted = !quoted;
    if (c === "#" && !quoted) return line.slice(0, i).trim();
  }
  return line.trim();
}

function parseString(raw: string, key: string): string {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "string" && value.length > 0) return value;
  } catch { /* Report one consistent configuration error below. */ }
  throw new Error(`pi-virtual-model config: ${key} must be a non-empty TOML string`);
}

function parseApiKey(raw: string): string | string[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && !v.includes("\0")) && value[0].trim()) return value;
  } catch { /* Do not include the value: it can contain credentials. */ }
  throw new Error("pi-virtual-model config: api_key must be a non-empty string or command array of strings");
}

function validateOptions(options: RouteOption[], directOption: string, fallbackOption: string): void {
  if (!options.length) throw new Error("pi-virtual-model config: options must contain at least one option");
  const ids = new Set<string>();
  for (const option of options) {
    if (!/^[a-z0-9_-]+$/.test(option.id) || ids.has(option.id)) throw new Error(`pi-virtual-model config: invalid or duplicate option id ${option.id}`);
    ids.add(option.id);
    if (!option.model) throw new Error(`pi-virtual-model config: option ${option.id} needs a model`);
    if (!(THINKING_LEVELS as readonly string[]).includes(option.thinkingLevel)) throw new Error(`pi-virtual-model config: option ${option.id} has unsupported thinking level ${option.thinkingLevel}`);
    if (!option.description) throw new Error(`pi-virtual-model config: option ${option.id} needs a description`);
  }
  for (const id of [directOption, fallbackOption]) if (!ids.has(id)) throw new Error(`pi-virtual-model config: option ${id} is not defined`);
}

export function parseConfigToml(source: string): VirtualModelConfig {
  const config = defaultConfig();
  let section = "";
  let options: RouteOption[] | undefined;
  for (const sourceLine of source.split(/\r?\n/)) {
    const line = stripComment(sourceLine);
    if (!line) continue;
    const sectionMatch = /^\[([a-z_]+)]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      if (!["virtual_model", "routing", "jev"].includes(section)) throw new Error(`pi-virtual-model config: unsupported section [${section}]`);
      continue;
    }
    const assignment = /^([a-z_]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment) throw new Error(`pi-virtual-model config: unsupported line: ${sourceLine}`);
    const [, key, raw] = assignment;
    if (section === "jev") {
      if (key !== "api_key") throw new Error(`pi-virtual-model config: unsupported jev key ${key}`);
      config.apiKey = parseApiKey(raw);
    } else if (section === "virtual_model") {
      if (key === "provider") config.provider = parseString(raw, key);
      else if (key === "id") config.id = parseString(raw, key);
      else if (key === "name") config.name = parseString(raw, key);
      else throw new Error(`pi-virtual-model config: unsupported virtual_model key ${key}`);
    } else if (section === "routing") {
      if (key === "options") {
        let values: unknown;
        try { values = JSON.parse(raw); } catch { throw new Error("pi-virtual-model config: options must be an array of strings"); }
        if (!Array.isArray(values)) throw new Error("pi-virtual-model config: options must be an array of strings");
        options = values.map((entry) => {
          if (typeof entry !== "string") throw new Error("pi-virtual-model config: each option must be a string");
          const [id, model, thinkingLevel, description, ...extra] = entry.split("|");
          if (!id || !model || !thinkingLevel || !description || extra.length) throw new Error("pi-virtual-model config: each option must be id|model|thinking_level|description");
          return { id, model, thinkingLevel: thinkingLevel as ThinkingLevel, description };
        });
      } else if (key === "direct_option") config.directOption = parseString(raw, key);
      else if (key === "fallback_option") config.fallbackOption = parseString(raw, key);
      else throw new Error(`pi-virtual-model config: unsupported routing key ${key}`);
    } else throw new Error(`pi-virtual-model config: key ${key} must be in a section`);
  }
  if (options) config.options = options;
  validateOptions(config.options, config.directOption, config.fallbackOption);
  return config;
}

export function loadConfig(path = globalConfigPath()): VirtualModelConfig {
  ensureGlobalConfig(path);
  return parseConfigToml(readFileSync(path, "utf8"));
}
