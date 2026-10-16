# pi-virtual-model

A phase-based virtual model router for Pi:

- Jev selects a routing option (`quick`, `balanced`, or `deep` by default) for each new request. Each option specifies a model and thinking level.
- Tool follow-ups and retries stay on the selected model. Jev also selects a model for direct requests, such as compaction summaries.
- Jev rate-limit, gateway, and overload errors (429, 502, 503, 504, 529) are retried twice, after 250 ms and 500 ms. If all three attempts fail, the turn uses the configured `fallback`, including its thinking level. Authentication errors and invalid responses still surface as errors.

The extension uses [pi-typesafe](https://github.com/DevMortimer/pi-typesafe)'s typed client and Choice question builder with `jev-latest`. pi-typesafe owns credentials, transport, timeouts, response validation, authentication state, and usage accounting. The router only supplies task context and routing policy, including transient-error retries.

Authenticate with `/typesafe login` or set `TYPESAFE_API_KEY` (environment takes precedence). Obtain a key from [TypeSafe](https://console.typesafe.ai). There is no router-specific key configuration or command execution.

Routing sends the latest user text (up to 16,000 characters), recent conversation text (up to 4,000 characters), and option descriptions to TypeSafe. Choosing the virtual model enables these requests independently of `/typesafe enable`, which controls only pi-typesafe's agent tool.

Routing attempts, input tokens, and estimated costs are recorded in pi-typesafe's shared daily ledger and authentication outcomes update its shared auth state. `/typesafe status` shows the daily totals; its session counters describe its own client, not this router. The router imposes no practical decision limit (`Number.MAX_SAFE_INTEGER` attempts per client) and sets no daily caps. Explicit `PI_TYPESAFE_MAX_*` daily caps still apply through pi-typesafe; a reached cap surfaces an error rather than silently disabling automatic routing. Each request has pi-typesafe's default 15-second timeout. Each option’s thinking level controls its model’s reasoning effort.

**Breaking change:** remove `[routing].api_key` from existing configuration files. Old key settings are rejected, not migrated.

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

The table name is the option ID. `fallback` is the only reserved setting
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
