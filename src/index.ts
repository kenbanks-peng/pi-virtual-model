import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRoute,
  ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";

interface RoutingState {
  phase: "planning" | "implementation";
}

const EDIT_TOOLS = new Set(["edit", "write"]);

/** Only successful edits after the latest user message start implementation. */
function editedThisTurn(messages: ModelRouteRequest["messages"]): boolean {
  let lastUser = messages.length - 1;
  while (lastUser >= 0 && messages[lastUser].role !== "user") lastUser -= 1;
  if (lastUser < 0) return false;

  return messages.slice(lastUser + 1).some((message) => {
    if (message.role !== "toolResult") return false;
    if (EDIT_TOOLS.has(message.toolName) && !message.isError) return true;
    // A codemode script can finish with an error after a nested edit succeeded.
    return (
      message.nestedCalls?.calls.some(
        (call) => EDIT_TOOLS.has(call.name) && call.status === "ok",
      ) ?? false
    );
  });
}

export default function virtualModelExtension(pi: ExtensionAPI): void {
  const config = loadConfig();

  function routeTo(
    request: ModelRouteRequest<RoutingState>,
    ctx: ExtensionContext,
    modelId: string,
    state?: RoutingState,
  ): ModelRoute<RoutingState> {
    const model = ctx.modelRegistry.find(config.provider, modelId);
    if (!model) throw new Error(`${config.provider}/${modelId} is not available`);
    return { model, thinkingLevel: request.thinkingLevel, state };
  }

  pi.registerVirtualModel<RoutingState>({
    provider: config.provider,
    id: config.id,
    name: config.name,
    thinkingLevels: config.thinkingLevels,
    route(request, ctx) {
      if (request.reason === "direct") {
        return {
          ...routeTo(request, ctx, config.directModel),
          thinkingLevel: config.directThinkingLevel,
        };
      }

      // Do not change phases while retrying a failed request.
      if (request.reason === "retry" && request.failed) {
        return {
          model: request.failed.model,
          thinkingLevel: request.failed.thinkingLevel ?? request.thinkingLevel,
        };
      }

      // A new user message starts a new planning phase, including steering messages.
      const state =
        request.reason === "user" || !request.state
          ? { phase: "planning" as const }
          : request.state;
      if (
        request.reason === "continuation" &&
        state.phase === "planning" &&
        editedThisTurn(request.messages)
      ) {
        return routeTo(request, ctx, config.implementationModel, { phase: "implementation" });
      }

      const modelId =
        state.phase === "planning" ? config.planningModel : config.implementationModel;
      return routeTo(request, ctx, modelId, state);
    },
  });
}
