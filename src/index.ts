import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRoute,
  ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type RouteOption } from "./config.js";
import { indicateRoute, registerRouteIndicator } from "./indicator.js";

interface RoutingState {
  optionId: string;
  model: string;
  thinkingLevel: string;
}

type Request = ModelRouteRequest<RoutingState>;
type Message = Request["messages"][number];
type RouteChoice = RouteOption;
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
  const key = process.env.TYPESAFE_AI_KEY;
  if (!key) throw new Error("pi-virtual-model: Jev API key is missing; set TYPESAFE_AI_KEY or configure [jev].api_key");
  return key;
}

async function classifyRoute(request: Request, configuredKey: string | string[] | undefined, options: readonly RouteOption[]): Promise<RouteChoice | undefined> {
  const apiKey = getJevApiKey(configuredKey);

  const fetchOptions: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: request.signal,
    body: JSON.stringify({
      model: "jev-latest",
      state: {
        latest_request: lastUserText(request.messages).slice(0, MAX_CLASSIFIER_TEXT),
        recent_context: recentContext(request.messages),
      },
      questions: {
        route: {
          type: "choice",
          instructions: "Choose the least demanding option that can complete latest_request reliably. Use recent_context for context. Prioritize quality and task fit, then latency and cost. Consider each option's model, thinking level, and description.",
          criteria: Object.fromEntries(options.map((option) => [option.id, `${option.description} Model: ${option.model}. Thinking: ${option.thinkingLevel}.`])),
        },
      },
    }),
  };
  let response: Response;
  for (let attempt = 0; ; attempt += 1) {
    request.signal?.throwIfAborted();
    response = await fetch("https://api.typesafe.ai/v1/systemone", fetchOptions);
    if (![429, 502, 503, 504, 529].includes(response.status)) break;
    await response.body?.cancel();
    request.signal?.throwIfAborted();
    if (attempt === 2) return undefined;
    await delay(250 * 2 ** attempt, undefined, { signal: request.signal });
  }
  if (!response.ok) throw new Error(`pi-virtual-model: Jev model-route failed (${response.status} ${response.statusText})`);

  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object") throw new Error("pi-virtual-model: Jev returned an invalid response");
  const answers = (payload as { answers?: unknown }).answers;
  const route = answers && typeof answers === "object" ? (answers as { route?: unknown }).route : undefined;
  if (!route || typeof route !== "object" || (route as { type?: unknown }).type !== "choice") {
    throw new Error("pi-virtual-model: Jev returned an invalid route answer");
  }
  const selected = (route as { choice?: unknown }).choice;
  if (typeof selected !== "string") {
    throw new Error(`pi-virtual-model: Jev returned an unknown model candidate: ${String(selected)}`);
  }
  const option = options.find((candidate) => candidate.id === selected);
  if (!option) throw new Error(`pi-virtual-model: Jev returned an unknown model candidate: ${selected}`);
  return option;
}

export default function virtualModelExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  registerRouteIndicator(pi);

  function routeTo(
    request: Request,
    ctx: ExtensionContext,
    option: RouteOption,
    state?: RoutingState,
  ): ModelRoute<RoutingState> {
    const model = ctx.modelRegistry.find(config.provider, option.model);
    if (!model) throw new Error(`${config.provider}/${option.model} is not available`);
    if (request.reason !== "retry") indicateRoute(pi, ctx, model, option.thinkingLevel);
    return { model, thinkingLevel: option.thinkingLevel as Request["thinkingLevel"], state };
  }

  pi.registerVirtualModel<RoutingState>({
    provider: config.provider,
    id: config.id,
    name: config.name,
    thinkingLevels: [...new Set(config.options.map((option) => option.thinkingLevel))],
    async route(request, ctx) {
      if (request.reason === "direct") return routeTo(request, ctx, config.options.find((option) => option.id === config.directOption)!);

      if (request.reason === "retry" && request.failed) {
        return {
          model: request.failed.model,
          thinkingLevel: request.failed.thinkingLevel ?? request.thinkingLevel,
        };
      }

      // Route once per user turn. Keep continuations on the chosen physical model.
      if (request.reason !== "user" && request.state) {
        const option = config.options.find((candidate) => candidate.id === request.state!.optionId);
        if (!option) throw new Error(`pi-virtual-model: saved route option is no longer configured: ${request.state.optionId}`);
        return routeTo(request, ctx, option, request.state);
      }

      const choice = await classifyRoute(request, config.apiKey, config.options);
      const option = choice ?? config.options.find((candidate) => candidate.id === config.fallbackOption)!;
      const state = { optionId: option.id, model: option.model, thinkingLevel: option.thinkingLevel };
      return routeTo(request, ctx, option, state);
    },
  });
}
