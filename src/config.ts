import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface VirtualModelConfig {
  apiKey?: string | string[];
  provider: string;
  id: string;
  name: string;
  thinkingLevels: ThinkingLevel[];
  simpleModel: string;
  standardModel: string;
  complexModel: string;
  directModel: string;
  directThinkingLevel: ThinkingLevel;
}

function defaultConfig(): VirtualModelConfig {
  return {
    provider: "openai-codex",
    id: "auto",
    name: "Auto",
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    simpleModel: "gpt-6-luna",
    standardModel: "gpt-6-astra",
    complexModel: "gpt-6.1-sol",
    directModel: "gpt-6-luna",
    directThinkingLevel: "medium",
    apiKey: ["printenv", "JEV_API_KEY"],
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
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
  }
}

function stripComment(line: string): string {
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (character === "#" && !quoted) return line.slice(0, index).trim();
  }

  return line.trim();
}

function parseString(raw: string, key: string): string {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "string" && value.length > 0) return value;
  } catch {
    // Report one consistent configuration error below.
  }
  throw new Error(`pi-virtual-model config: ${key} must be a non-empty TOML string`);
}

function parseApiKey(raw: string): string | string[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && value.length > 0 &&
        value.every((item) => typeof item === "string" && !item.includes("\0")) &&
        value[0].trim()) return value;
  } catch {
    // Do not include the value in errors: it can contain credentials.
  }
  throw new Error("pi-virtual-model config: api_key must be a non-empty string or command array of strings");
}

function parseThinkingLevel(raw: string, key: string): ThinkingLevel {
  const value = parseString(raw, key);
  if ((THINKING_LEVELS as readonly string[]).includes(value)) return value as ThinkingLevel;
  throw new Error(`pi-virtual-model config: ${key} has unsupported thinking level ${value}`);
}

function parseThinkingLevels(raw: string): ThinkingLevel[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("pi-virtual-model config: thinking_levels must be a TOML string array");
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("pi-virtual-model config: thinking_levels must be a non-empty array");
  }

  return value.map((item) => {
    if (typeof item !== "string" || !(THINKING_LEVELS as readonly string[]).includes(item)) {
      throw new Error(`pi-virtual-model config: unsupported thinking level ${String(item)}`);
    }
    return item as ThinkingLevel;
  });
}

export function parseConfigToml(source: string): VirtualModelConfig {
  const config = defaultConfig();
  let section = "";

  for (const sourceLine of source.split(/\r?\n/)) {
    const line = stripComment(sourceLine);
    if (!line) continue;

    const sectionMatch = /^\[([a-z_]+)]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      if (section !== "virtual_model" && section !== "routing" && section !== "jev") {
        throw new Error(`pi-virtual-model config: unsupported section [${section}]`);
      }
      continue;
    }

    const assignment = /^([a-z_]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment) throw new Error(`pi-virtual-model config: unsupported line: ${sourceLine}`);
    const [, key, raw] = assignment;

    if (section === "jev") {
      if (key !== "api_key") throw new Error(`pi-virtual-model config: unsupported jev key ${key}`);
      config.apiKey = parseApiKey(raw);
      continue;
    }

    if (section === "virtual_model") {
      if (key === "provider") config.provider = parseString(raw, key);
      else if (key === "id") config.id = parseString(raw, key);
      else if (key === "name") config.name = parseString(raw, key);
      else if (key === "thinking_levels") config.thinkingLevels = parseThinkingLevels(raw);
      else throw new Error(`pi-virtual-model config: unsupported virtual_model key ${key}`);
      continue;
    }

    if (section === "routing") {
      if (key === "simple_model") {
        config.simpleModel = parseString(raw, key);
      } else if (key === "standard_model") {
        config.standardModel = parseString(raw, key);
      } else if (key === "complex_model") {
        config.complexModel = parseString(raw, key);
      } else if (key === "direct_model") {
        config.directModel = parseString(raw, key);
      } else if (key === "direct_thinking_level") {
        config.directThinkingLevel = parseThinkingLevel(raw, key);

      } else {
        throw new Error(`pi-virtual-model config: unsupported routing key ${key}`);
      }
      continue;
    }

    throw new Error(`pi-virtual-model config: key ${key} must be in a section`);
  }

  return config;
}

export function loadConfig(path = globalConfigPath()): VirtualModelConfig {
  ensureGlobalConfig(path);
  return parseConfigToml(readFileSync(path, "utf8"));
}
