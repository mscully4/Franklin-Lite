# Multi-Provider Routing

Register multiple AI providers in `settings.json` and route tasks to the right
one automatically — by task type, or with a per-task override.

## Motivation

Franklin runs on a Claude Pro subscription (flat-rate quota) but can also reach
cheaper/faster providers (DeepSeek, Bedrock, local Ollama) via
`ANTHROPIC_BASE_URL`. Low-stakes tasks (DM replies, email notifications) don't
need Claude's full capability and burn quota unnecessarily. High-stakes tasks
(quests, code work) should always use Claude.

The goal is a single routing config that the task manager resolves at dispatch
time — no per-task wiring required.

## Design

### Provider registry (`state/settings.json`)

```json
"providers": {
  "claude": {
    "bin": "/usr/local/bin/claude",
    "env": {}
  },
  "deepseek": {
    "bin": "/usr/local/bin/claude",
    "env": {
      "ANTHROPIC_BASE_URL": "https://api.deepseek.com",
      "ANTHROPIC_API_KEY": "sk-..."
    }
  }
},
"default_provider": "claude"
```

Each provider entry specifies:
- `bin` — path to the Claude Code CLI binary (can be shared across providers)
- `env` — environment variables merged over the process env at spawn time

Since Claude Code supports `ANTHROPIC_BASE_URL`, providers like DeepSeek,
Bedrock, or local Ollama don't need a separate binary.

### Type-level routing

```json
"model_routing": {
  "dm_reply": "deepseek",
  "email_notify": "deepseek",
  "scheduled": "deepseek"
}
```

Applies to all tasks of that type unless overridden at the task level.

### Per-task override (scheduled tasks)

```json
{
  "id": "weekly-financial-summary",
  "type": "scheduled",
  "provider": "claude"
}
```

Explicit `provider` field on a scheduled task beats type-level routing.

### Resolution order (highest → lowest priority)

1. Task-level `provider` field
2. `model_routing[task.type]`
3. `default_provider`

### Spawn-time env merge

In `task-manager.ts`, when spawning a worker:

```typescript
const providerName = resolveProvider(task);
const provider = settings.providers?.[providerName];
const spawnEnv = { ...process.env, ...(provider?.env ?? {}) };
const bin = provider?.bin ?? settings.claude_bin;
// spawn bin with spawnEnv
```

## Files Changed

| File | Change |
|------|--------|
| `state/settings.json` | Add `providers`, `default_provider`, `model_routing` |
| `src/schemas.ts` | Add `ProviderEntry` schema, extend `SettingsSchema` |
| `src/config.ts` | Add `resolveProvider(task, settings)` helper |
| `src/supervisor/task-manager.ts` | Use provider bin + env at worker spawn |
| Scheduled task schema | Add optional `provider` field |

## Trade-offs

**Pros**
- Zero per-task wiring for the common case (type routing handles it)
- Adding a new provider is one JSON block in settings, no code change
- Works with any OpenAI-compatible backend via `ANTHROPIC_BASE_URL`
- Cost tracking already captures model used — provider routing is visible in logs

**Cons**
- Secrets (API keys) live in `state/settings.json` — already the pattern for
  other keys, but worth noting
- No automatic fallback if a provider is down (could be added later)
- Brain-level dynamic routing (choosing provider based on task content) is out
  of scope; this is static routing only

## Out of Scope

- Dynamic/brain-driven routing per task content
- Provider health checks or automatic failover
- Cost-budget enforcement (e.g., stop using Claude after $X/week)
