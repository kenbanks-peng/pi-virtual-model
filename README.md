# pi-virtual-model

A virtual model router for Pi. It selects an OpenAI Codex model from the chosen thinking level:

- `low`: GPT-5.6 Luna
- `medium`: GPT-5.6 Terra
- `high` and `xhigh`: GPT-5.6 Sol

Tool continuations and retries stay on the model that started the turn. Direct tasks, such as compaction summaries, use Luna.

On first load, the extension creates its global configuration at
`$PI_CODING_AGENT_DIR/extensions/pi-virtual-model/config.toml`. When
`PI_CODING_AGENT_DIR` is not set, it uses
`~/.pi/agent/extensions/pi-virtual-model/config.toml`. Edit that file to change
the virtual model identity, available thinking levels, routed models, and
fallback thinking levels. Restart Pi after a change.

## Try it

```bash
pi -e ./pi-virtual-model --model openai-codex/auto
```

Install it from this workspace with:

```bash
pi install ./pi-virtual-model
```
