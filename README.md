# pi-virtual-model

Automatically routes Pi requests to a model and thinking level. TypeSafe's Jev chooses among your configured options based on the task. Tool follow-ups and retries stay on the selected model.

## Install

```bash
pi install npm:@npm-ken/pi-virtual-model
```

Requires Pi 0.99.0 or newer. Restart Pi, then authenticate with Pi's `/login` → TypeSafe or set `TYPESAFE_API_KEY`. Get an API key from [TypeSafe](https://console.typesafe.ai). No additional extension is required.

Previously used `/typesafe login`? Sign in again through Pi: the old extension's credential store is separate and is not read.

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
- Custom options replace the defaults. `fallback` must name a defined option; it is used when Jev is missing, classification fails (including authentication errors), or its answer is not a configured option. Pi handles transient retries (up to two), with a 15-second timeout per attempt. Cancellation stops routing instead of selecting the fallback.

Restart Pi after editing the configuration.

## Use

The extension automatically selects **Auto** whenever a session starts (including resume and reload), even if it is absent from `enabledModels`. It does not change `settings.json` or your model shortlist. Provider authentication is required; if selection fails, Pi reports an extension error.

You can switch models afterward. Removing the extension stops automatic selection without requiring settings cleanup.

You can also select **Auto** in Pi's model picker, or launch with:

```bash
pi --model openai-codex/auto
```

Use your configured provider and ID if you changed them. Send requests as usual; the extension selects the model and thinking level for each new turn.

Routing sends the latest user text (up to 16,000 characters), recent conversation text (up to 4,000 characters), and option descriptions to TypeSafe. Calls use Pi's built-in `typesafe/jev-latest` classifier and provider authentication. The former extension's enable flag, daily caps, and usage ledger no longer apply. Classifier calls made during routing are not automatically added to Pi's session usage totals; TypeSafe still bills for them.
