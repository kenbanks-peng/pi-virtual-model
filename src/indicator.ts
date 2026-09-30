import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const ROUTE_ENTRY = "pi-virtual-model:route";

interface RouteIndicator {
  provider: string;
  model: string;
}

// Match pi-bar's model segment: #005b95 background, #cdd6f4 text,
// and its Powerline slanted ends. Keep this independent of pi-bar's installation.
const RESET = "\x1b[0m";
const EDGE = "\x1b[38;2;0;91;149m";
const FILL = "\x1b[48;2;0;91;149m\x1b[38;2;205;214;244m";

export function registerRouteIndicator(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<RouteIndicator>(ROUTE_ENTRY, (entry) => {
    const data = entry.data;
    if (!data) return undefined;
    // Model IDs come from configuration. Do not let control characters reach the terminal.
    const label = `  ${data.provider}:${data.model} `.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
    return {
      invalidate() {},
      render(width) {
        if (width < 3) return [];
        // Model identifiers are ASCII, so character length is terminal width.
        const text = label.length > width - 2 ? `${label.slice(0, width - 3)}…` : label;
        return [`${EDGE}\uE0BA${RESET}${FILL}${text}${RESET}${EDGE}\uE0BC${RESET}`];
      },
    };
  });
}

/** Persist a display-only entry once per user turn or model change. */
export function indicateRoute(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  model: { provider: string; id: string },
): void {
  // Use the active branch, not process-local state, so resume and forks work too.
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type === "message" && entry.message.role === "user") break;
    if (entry.type === "custom" && entry.customType === ROUTE_ENTRY) {
      const previous = entry.data as RouteIndicator | undefined;
      if (previous?.provider === model.provider && previous.model === model.id) return;
      break;
    }
  }
  pi.appendEntry<RouteIndicator>(ROUTE_ENTRY, { provider: model.provider, model: model.id });
}
