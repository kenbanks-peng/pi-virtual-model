import { parse } from "smol-toml";
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
  apiKey: string | string[];
  provider: string;
  id: string;
  name: string;
  options: RouteOption[];
  fallback: string;
}

function defaultConfig(): VirtualModelConfig {
  return {
    provider: "openai-codex", id: "auto", name: "Auto",
    options: [
      { id: "quick", model: "gpt-6-luna", thinkingLevel: "low", description: "Simple questions and small, clear tasks." },
      { id: "balanced", model: "gpt-6.1-sol", thinkingLevel: "medium", description: "General tasks that need moderate reasoning." },
      { id: "deep", model: "gpt-6-astra", thinkingLevel: "medium", description: "Complex tasks that need careful reasoning." },
    ],
    fallback: "balanced", apiKey: ["printenv", "TYPESAFE_AI_KEY"],
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

function table(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`pi-virtual-model config: ${name} must be a table`);
  }
  return value as Record<string, unknown>;
}

function checkKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`pi-virtual-model config: unsupported ${name} key ${key}`);
  }
}

function parseString(value: unknown, key: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`pi-virtual-model config: ${key} must be a non-empty TOML string`);
}

function parseApiKey(value: unknown): string | string[] {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && !v.includes("\0")) && value[0].trim()) return value;
  throw new Error("pi-virtual-model config: api_key must be a non-empty string or command array of strings");
}

function validateOptions(options: RouteOption[], fallback: string): void {
  if (!options.length) throw new Error("pi-virtual-model config: options must contain at least one option");
  const ids = new Set<string>();
  for (const option of options) {
    if (!/^[a-z0-9_-]+$/.test(option.id) || ids.has(option.id)) throw new Error(`pi-virtual-model config: invalid or duplicate option id ${option.id}`);
    ids.add(option.id);
    if (!option.model) throw new Error(`pi-virtual-model config: option ${option.id} needs a model`);
    if (!(THINKING_LEVELS as readonly string[]).includes(option.thinkingLevel)) throw new Error(`pi-virtual-model config: option ${option.id} has unsupported thinking level ${option.thinkingLevel}`);
    if (!option.description) throw new Error(`pi-virtual-model config: option ${option.id} needs a description`);
  }
  if (!ids.has(fallback)) throw new Error(`pi-virtual-model config: option ${fallback} is not defined`);
}

export function parseConfigToml(source: string): VirtualModelConfig {
  const config = defaultConfig();
  let document: Record<string, unknown>;
  try {
    document = parse(source);
  } catch {
    // Parser errors can quote source lines containing credentials.
    throw new Error("pi-virtual-model config: invalid TOML syntax");
  }
  checkKeys(document, ["virtual_model", "routing"], "root");
  if (document.virtual_model !== undefined) {
    const identity = table(document.virtual_model, "virtual_model");
    checkKeys(identity, ["provider", "id", "name"], "virtual_model");
    for (const key of ["provider", "id", "name"] as const) {
      if (identity[key] !== undefined) config[key] = parseString(identity[key], key);
    }
  }
  if (document.routing !== undefined) {
    const routing = table(document.routing, "routing");
    if (routing.fallback !== undefined) config.fallback = parseString(routing.fallback, "fallback");
    if (routing.api_key !== undefined) config.apiKey = parseApiKey(routing.api_key);
    const options = Object.entries(routing).filter(([key]) => key !== "fallback" && key !== "api_key");
    if (options.length > 0) {
      config.options = options.map(([id, value]) => {
        const option = table(value, `routing.${id}`);
        checkKeys(option, ["model", "thinking_level", "description"], `routing.${id}`);
        return {
          id,
          model: parseString(option.model, `${id}.model`),
          thinkingLevel: parseString(option.thinking_level, `${id}.thinking_level`) as ThinkingLevel,
          description: parseString(option.description, `${id}.description`),
        };
      });
    }
  }
  validateOptions(config.options, config.fallback);
  return config;
}

export function loadConfig(path = globalConfigPath()): VirtualModelConfig {
  ensureGlobalConfig(path);
  return parseConfigToml(readFileSync(path, "utf8"));
}
