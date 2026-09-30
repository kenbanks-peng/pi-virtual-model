# pi-virtual-model

A phase-based virtual model router for Pi:

- Each new user message starts with Astra for planning and the first edit.
- After a successful `edit` or `write`, it switches to Luna for the rest of the turn.
- Retries keep the model that failed. Direct tasks, such as compaction summaries, use Luna.

The selected thinking level controls reasoning effort, not model selection. The router does not classify task difficulty. The phase follows the session branch and survives compaction. Each model switch can lose the prompt cache.

On first load, the extension creates its global configuration at
`$PI_CODING_AGENT_DIR/extensions/pi-virtual-model/config.toml`. When
`PI_CODING_AGENT_DIR` is not set, it uses
`~/.pi/agent/extensions/pi-virtual-model/config.toml`. Edit that file to change
the virtual model identity, available thinking levels, `planning_model`,
`implementation_model`, and direct-request settings. These phase settings replace
the old `off_model` through `max_model` table and fallback thinking levels.
Restart Pi after a change.

## Try it

```bash
pi -e ./pi-virtual-model --model openai-codex/auto
```

Install it from this workspace with:

```bash
pi install ./pi-virtual-model
```
