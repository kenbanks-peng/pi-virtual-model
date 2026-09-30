import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";

export default function virtualModelExtension(pi: ExtensionAPI): void {
  const config = loadConfig();

  pi.registerVirtualModel({
    provider: config.provider,
    id: config.id,
    name: config.name,
    thinkingLevels: config.thinkingLevels,
    route(request, ctx) {
      if (request.reason === "continuation" && request.previous) {
        return {
          model: request.previous.model,
          thinkingLevel:
            request.previous.thinkingLevel ?? config.continuationFallbackThinkingLevel,
        };
      }

      if (request.reason === "retry" && request.failed) {
        return {
          model: request.failed.model,
          thinkingLevel: request.failed.thinkingLevel ?? config.retryFallbackThinkingLevel,
        };
      }

      const modelId =
        request.reason === "direct"
          ? config.directModel
          : config.models[request.thinkingLevel];
      const model = ctx.modelRegistry.find(config.provider, modelId);

      if (!model) {
        throw new Error(`${config.provider}/${modelId} is not available`);
      }

      return {
        model,
        thinkingLevel:
          request.reason === "direct" ? config.directThinkingLevel : request.thinkingLevel,
      };
    },
  });
}
