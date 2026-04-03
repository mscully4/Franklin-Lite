---
id: proposal-00001
title: Vector Memory for Franklin
status: approved
created: 2026-03-29
updated: 2026-03-30
---

## Problem

Franklin's knowledge is currently limited to what fits in the active context window. Quest logs, feedback, Slack thread summaries, and the knowledge base are stored as flat files — useful for reference, but not queryable by semantic similarity. As the corpus grows, Franklin has no way to surface relevant past context without manually loading every file.

## Research

### Embedding API
Circle's platform-ai proxy supports embedding models via `https://api.circle.com/v1/platformai/proxy/openai/v1/embeddings`.

- **Recommended model:** `text-embedding-3-small` (1536 dimensions, confirmed working)
- **Auth:** Short-lived Okta tokens via `circle-token token-only` (1hr expiry, auto-refresh)
- **Tested:** Both chat completions and embeddings endpoints confirmed live on 2026-03-29

Sources:
- Slack thread (C08KQ4MQ7UH/p1744817143648589) — Neil Kumar + Bhushit Agarwal, April 2025: confirmed embeddings work via platform-ai, `text-embedding-ada-002` originally used, `ai-proxy-stg.circle.com` was the working URL at the time
- Slack thread (C09AGM4C5EJ/p1767653161575919) — Timothy Baker + Arnold Chan, January 2026: `text-embedding-3-small` confirmed as supported in n8n; pgvector available as shared Circle-hosted Postgres instance
- Confluence: [Local Development using AI Proxy](https://circlepay.atlassian.net/wiki/spaces/AI/pages/1949401130) — current canonical docs, updated March 2026. Old `chatai.circle.com` endpoint removed end of 2025.

### Vector Store Options

| Option | Pros | Cons |
|---|---|---|
| **Chroma (local)** | No infra, fully private, runs offline, persists to disk | Requires local process running |
| **pgvector (Circle-hosted)** | Already running, no setup | All data company-wide visible — not appropriate for Franklin's private quest/memory data |

**Decision: Chroma (local).** Franklin's memory includes private quest details, Slack thread summaries, and personal feedback — company-wide visibility is a non-starter.

## Proposal

Add a local Chroma vector store to Franklin. On each run cycle, embed and upsert new content. During quest execution, query the store with the quest objective and inject top-K results as context before acting.

## Design

### Content types to embed

| Type | Source | When to upsert |
|---|---|---|
| Quest logs | `state/quests/` | On quest status change or new log entry |
| Feedback & learnings | `state/feedback.md` | On write |
| Knowledge base | `knowledge/` | On file change (lazy, checked on read) |
| Slack thread summaries | Subagent digest | After Slack polling step |

### Document schema (Chroma metadata)

```json
{
  "id": "quest-001",
  "content": "...",
  "metadata": {
    "type": "quest | feedback | knowledge | slack_thread",
    "source": "file path or permalink",
    "date": "ISO 8601"
  }
}
```

### Authentication

`circle-token` tokens expire after 1 hour. The memory module must call `circle-token token-only` fresh before each embedding request (not cached across cycles).

### Module interface (`franklin_memory.py` or `franklin_memory.ts`)

```
upsert(id, content, metadata)   — embed and store a document
query(text, k=5)                — return top-K semantically similar docs
delete(id)                      — remove a document
```

### Run loop integration

1. **After Step 2 (Slack digest):** upsert new thread summaries
2. **After Step 3 (quest file updates):** upsert changed quest logs
3. **Before Step 4 (quest execution):** query with quest objective → inject results as context
4. **After Step 6 (save state):** upsert feedback.md changes

## Implementation Plan

1. Install Chroma locally (`pip install chromadb`)
2. Build `franklin_memory.py` — Chroma client, `circle-token` auth, `upsert` / `query` / `delete`
3. Write a backfill script to embed existing quests + knowledge base on first run
4. Wire `upsert` calls into the run loop at the points above
5. Wire `query` into quest execution context injection
6. Test: upsert a quest log, query with a related phrase, verify recall

## Decisions

- **Vector store location:** `state/vector_store/` — consistent with other runtime state
- **k value:** 5 (start here, tune down if context gets noisy)
- **Knowledge base re-embedding:** triggered by file mtime — no reason to re-embed unchanged files
- **Implementation:** Extracted as a shared `vector-memory` skill in `~/DevEnv/skills/` (see proposal-00002). Franklin uses the `franklin` collection. Other CC sessions (repo work, dev investigations) write to a `dev` collection. Franklin queries across all collections it has access to.

## Notes

- pgvector (Circle-hosted) was considered and rejected — all data is company-wide visible, which is inappropriate for Franklin's private quest/memory data. Revisit if a private hosted option becomes available or if cross-machine access is needed in the future.
