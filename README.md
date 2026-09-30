# pi-virtual-model

A phase-based virtual model router for Pi:

- Jev selects a routing option (`quick`, `balanced`, or `deep` by default) for each new request. Each option specifies a model and thinking level.
- Tool follow-ups and retries stay on the selected model. Jev also selects a model for direct requests, such as compaction summaries.
- Jev rate-limit, gateway, and overload errors (429, 502, 503, 504, 529) are retried twice, after 250 ms and 500 ms. If all three attempts fail, the turn uses the configured `fallback`, including its thinking level. Authentication errors and invalid responses still surface as errors.

The extension uses [TypeSafe's official Jev API](https://docs.typesafe.ai/api): `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`, and a Choice question for routing. Obtain a key from [TypeSafe](https://console.typesafe.ai).

Set `[routing].api_key` to a literal string or a command array that returns the TypeSafe key, for example `api_key = ["fnox", "get", "THE-KEY"]`. The default command reads the `TYPESAFE_AI_KEY` environment variable. The command runs when Jev classifies a request. Each option’s thinking level controls its model’s reasoning effort.

On first load, the extension creates its global configuration at
`$PI_CODING_AGENT_DIR/extensions/pi-virtual-model/config.toml`. When
`PI_CODING_AGENT_DIR` is not set, it uses
`~/.pi/agent/extensions/pi-virtual-model/config.toml`. Edit that file to change
the virtual model identity and routing options. Restart
Pi after a change.

Routing options use standard TOML tables with named fields:

```toml
[virtual_model]
provider = "openai-codex"
id = "auto"
name = "Auto"

[routing]
api_key = ["printenv", "TYPESAFE_AI_KEY"]
fallback = "balanced"

[routing.quick]
model = "gpt-6-luna"
thinking_level = "low"
description = "Simple questions and small, clear tasks."

[routing.balanced]
model = "gpt-6.1-sol"
thinking_level = "medium"
description = "General tasks that need moderate reasoning."

[routing.deep]
model = "gpt-6-astra"
thinking_level = "medium"
description = "Complex tasks that need careful reasoning."
```

The table name is the option ID. `api_key` and `fallback` are reserved settings
under `[routing]`. Defining options replaces the default option set; `fallback`
must refer to a defined option. Existing configurations are preserved on startup.
Only the configuration format shown above is supported.

## Try it

```bash
pi -e ./pi-virtual-model --model openai-codex/auto
```

Install it from this workspace with:

```bash
pi install ./pi-virtual-model
```
