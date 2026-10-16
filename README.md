# pi-virtual-model

Automatically routes Pi requests to a model and thinking level. TypeSafe's Jev chooses among your configured options based on the task. Tool follow-ups and retries stay on the selected model.

## Install

```bash
pi install npm:pi-typesafe
pi install npm:@npm-ken/pi-virtual-model
```

Restart Pi, then authenticate with `/typesafe login` or set `TYPESAFE_API_KEY`. Get an API key from [TypeSafe](https://console.typesafe.ai).

## Configure

On first load, the extension creates:

```text
~/.pi/agent/extensions/pi-virtual-model/config.toml
```

If `PI_CODING_AGENT_DIR` is set, the file is under `$PI_CODING_AGENT_DIR/extensions/pi-virtual-model/config.toml` instead.

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

- Set `provider` and each option's `model` to models available in Pi under that provider.
- Each `[routing.<name>]` defines an option. Its description tells Jev when to choose it.
- `thinking_level` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; choose a level your model supports.
- Custom options replace the defaults. `fallback` must name a defined option; it is used after transient TypeSafe errors exhaust retries. Other errors are surfaced.

Restart Pi after editing the configuration.

## Use

Select **Auto** in Pi's model picker, or launch with:

```bash
pi --model openai-codex/auto
```

Use your configured provider and ID if you changed them. Send requests as usual; the extension selects the model and thinking level for each new turn.

Routing sends the latest user text (up to 16,000 characters), recent conversation text (up to 4,000 characters), and option descriptions to TypeSafe. It works independently of `/typesafe enable`. View shared usage totals with `/typesafe status`.
