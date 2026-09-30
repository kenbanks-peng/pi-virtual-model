import { execFileSync } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRoute,
  ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { indicateRoute, registerRouteIndicator } from "./indicator.js";

interface RoutingState {
  model: string;
}

type Request = ModelRouteRequest<RoutingState>;
type Message = Request["messages"][number];
type Difficulty = "simple" | "standard" | "complex";
const MAX_CLASSIFIER_TEXT = 16_000;

function lastUserText(messages: readonly Message[]): string {
  let index = messages.length - 1;
  while (index >= 0 && messages[index].role !== "user") index -= 1;
  if (index < 0) return "";
  const content = messages[index].content;
  if (typeof content === "string") return content;
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function recentContext(messages: readonly Message[]): string {
  let userIndex = messages.length - 1;
  while (userIndex >= 0 && messages[userIndex].role !== "user") userIndex -= 1;
  const relevant = messages.slice(Math.max(0, userIndex - 4), userIndex);
  return relevant.map((message) => {
    if (message.role === "user") {
      const text = typeof message.content === "string"
        ? message.content
        : message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
      return `User: ${text}`;
    }
    if (message.role === "assistant") {
      const text = message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
      return text ? `Assistant: ${text}` : "";
    }
    return "";
  }).filter(Boolean).join("\n").slice(-4_000);
}

function getJevApiKey(configuredKey?: string | string[]): string {
  if (typeof configuredKey === "string") return configuredKey;
  if (configuredKey) {
    const [command, ...args] = configuredKey;
    try {
      const key = execFileSync(command, args, {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
        env: process.env,
      }).trim();
      if (key) return key;
    } catch {
      throw new Error("pi-virtual-model: Jev api_key command failed");
    }
    throw new Error("pi-virtual-model: Jev api_key command returned an empty value");
  }
  const key = process.env.JEV_API_KEY;
  if (!key) throw new Error("pi-virtual-model: Jev API key is missing; set JEV_API_KEY or configure [jev].api_key");
  return key;
}

async function classifyDifficulty(request: Request, configuredKey?: string | string[]): Promise<Difficulty> {
  const apiKey = getJevApiKey(configuredKey);

  const response = await fetch("https://www.jevai.org/api/v1/decisions/model-route", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: request.signal,
    body: JSON.stringify({
      task: [
        `Classify this latest user request by difficulty. Return the candidate that best fits the work requested.\nLatest request:\n${lastUserText(request.messages).slice(0, MAX_CLASSIFIER_TEXT)}`,
        recentContext(request.messages) ? `\nRecent context:\n${recentContext(request.messages)}` : "",
      ].join(""),
      candidates: [
        { id: "simple", description: "Simple work: a direct factual answer, small explanation, or trivial one-file edit. No substantial analysis or planning." },
        { id: "standard", description: "Standard work: a normal coding question, focused bug fix, modest feature, or routine review that needs some analysis." },
        { id: "complex", description: "Complex work: difficult debugging, cross-cutting changes, architecture, security-sensitive work, or tasks that need substantial reasoning and planning." },
      ],
      priorities: ["quality", "task_fit", "latency", "cost"],
      stakes: "Choose the least demanding candidate that can complete the request reliably.",
    }),
  });
  if (!response.ok) throw new Error(`pi-virtual-model: Jev model-route failed (${response.status} ${response.statusText})`);

  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object") throw new Error("pi-virtual-model: Jev returned an invalid response");
  const data = (payload as { data?: unknown }).data;
  const selected = data && typeof data === "object" ? (data as { decision?: unknown }).decision : undefined;
  if (selected !== "simple" && selected !== "standard" && selected !== "complex") {
    throw new Error(`pi-virtual-model: Jev returned an unknown model candidate: ${String(selected)}`);
  }
  return selected;
}

export default function virtualModelExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  registerRouteIndicator(pi);

  function routeTo(
    request: Request,
    ctx: ExtensionContext,
    modelId: string,
    state?: RoutingState,
  ): ModelRoute<RoutingState> {
    const model = ctx.modelRegistry.find(config.provider, modelId);
    if (!model) throw new Error(`${config.provider}/${modelId} is not available`);
    if (request.reason !== "retry") indicateRoute(pi, ctx, model);
    return { model, thinkingLevel: request.thinkingLevel, state };
  }

  pi.registerVirtualModel<RoutingState>({
    provider: config.provider,
    id: config.id,
    name: config.name,
    thinkingLevels: config.thinkingLevels,
    async route(request, ctx) {
      if (request.reason === "direct") return routeTo(request, ctx, config.directModel);

      if (request.reason === "retry" && request.failed) {
        return {
          model: request.failed.model,
          thinkingLevel: request.failed.thinkingLevel ?? request.thinkingLevel,
        };
      }

      // Route once per user turn. Keep continuations on the chosen physical model.
      if (request.reason !== "user" && request.state) {
        return routeTo(request, ctx, request.state.model, request.state);
      }

      const difficulty = await classifyDifficulty(request, config.apiKey);
      const modelId = {
        simple: config.simpleModel,
        standard: config.standardModel,
        complex: config.complexModel,
      }[difficulty];
      return routeTo(request, ctx, modelId, { model: modelId });
    },
  });
}
