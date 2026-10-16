import { setTimeout as delay } from "node:timers/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRoute,
  ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { choice, createTypeSafe, TypeSafeIntegrationError, type TypeSafe } from "pi-typesafe";
import { loadConfig, type RouteOption } from "./config.js";
import { indicateRoute, registerRouteIndicator } from "./indicator.js";

interface RoutingState {
  optionId: string;
  model: string;
  thinkingLevel: string;
}

type Request = ModelRouteRequest<RoutingState>;
type Message = Request["messages"][number];
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

async function classifyRoute(typesafe: TypeSafe, request: Request, options: readonly RouteOption[]): Promise<RouteOption | undefined> {
  const input = {
    state: {
      latest_request: lastUserText(request.messages).slice(0, MAX_CLASSIFIER_TEXT),
      recent_context: recentContext(request.messages),
    },
    questions: {
      route: choice(
        "Choose the least demanding option that can complete latest_request reliably. Use recent_context for context. Prioritize quality and task fit, then latency and cost. Consider each option's model, thinking level, and description.",
        Object.fromEntries(options.map((option) => [option.id, `${option.description} Model: ${option.model}. Thinking: ${option.thinkingLevel}.`])),
      ),
    },
  };
  for (let attempt = 0; ; attempt += 1) {
    request.signal?.throwIfAborted();
    try {
      const result = await typesafe.evaluate(input, { signal: request.signal });
      return options.find((option) => option.id === result.answers.route.choice)!;
    } catch (error) {
      request.signal?.throwIfAborted();
      if (!(error instanceof TypeSafeIntegrationError) || ![429, 502, 503, 504, 529].includes(error.status ?? 0)) throw error;
      if (attempt === 2) return undefined;
      await delay(250 * 2 ** attempt, undefined, { signal: request.signal });
    }
  }
}

export default function virtualModelExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  registerRouteIndicator(pi);
  let typesafe: TypeSafe | undefined;

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

      // The library requires a finite limit; do not impose a practical routing cap.
      typesafe ??= createTypeSafe({ maxRequests: Number.MAX_SAFE_INTEGER });
      const selected = await classifyRoute(typesafe, request, config.options);
      const option = selected ?? config.options.find((candidate) => candidate.id === config.fallback)!;
      const state = { optionId: option.id, model: option.model, thinkingLevel: option.thinkingLevel };
      return routeTo(request, ctx, option, state);
    },
  });
}
