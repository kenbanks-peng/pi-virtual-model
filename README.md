# pi-virtual-model

A phase-based virtual model router for Pi:

- Jev classifies each new request as simple, standard, or complex and selects the configured model.
- Tool follow-ups and retries stay on the selected model. Direct requests, such as compaction summaries, use the configured direct model.
- Jev rate-limit, gateway, and overload errors (429, 502, 503, 504, 529) are retried twice, after 250 ms and 500 ms. If all three attempts fail, the turn uses the configured standard model with the requested thinking level. Authentication errors and invalid responses still surface as errors.

The extension uses [TypeSafe's official Jev API](https://docs.typesafe.ai/api): `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`, and a Choice question for routing. Obtain a key from [TypeSafe](https://console.typesafe.ai).

Set `[jev].api_key` to a literal string or a command array that returns the TypeSafe key, for example `api_key = ["fnox", "get", "THE-KEY"]`. The default command reads the `TYPESAFE_AI_KEY` environment variable. The command runs when Jev classifies a request. The selected thinking level controls reasoning effort, not model selection.

On first load, the extension creates its global configuration at
`$PI_CODING_AGENT_DIR/extensions/pi-virtual-model/config.toml`. When
`PI_CODING_AGENT_DIR` is not set, it uses
`~/.pi/agent/extensions/pi-virtual-model/config.toml`. Edit that file to change
the virtual model identity, available thinking levels, simple/standard/complex
models, and direct-request settings. Restart Pi after a change.

## Try it

```bash
pi -e ./pi-virtual-model --model openai-codex/auto
```

Install it from this workspace with:

```bash
pi install ./pi-virtual-model
```
