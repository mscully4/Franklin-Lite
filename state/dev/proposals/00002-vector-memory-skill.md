---
id: proposal-00002
title: vector-memory Skill
status: approved
created: 2026-03-30
updated: 2026-03-30
---

## Problem

Proposal 00001 established that Franklin needs a vector store for semantic memory. Rather than building this as a Franklin-only module, it should be a shared skill in `~/DevEnv/skills/` so any Claude Code session can read and write to it — including CC sessions in code repos doing dev work.

This makes the vector store shared infrastructure: Franklin surfaces context from repo investigations, and CC sessions in repos can query Franklin's quest history and learnings.

## Design

### Storage

- **Engine:** Chroma (local, persists to disk)
- **Location:** `~/DevEnv/vector_store/` — alongside skills and other tooling, accessible from any CC session regardless of working directory
- **Collections:** Named by caller. Created on first use.

| Collection | Purpose | Primary writers | Primary readers |
|---|---|---|---|
| `franklin` | Quests, feedback, Slack summaries | Franklin | Franklin |
| `dev` | Bug investigations, PR context, code decisions | CC in repos | Franklin + CC |
| `knowledge` | Stable reference material | Either | Either |

### Embeddings

- **Model:** `text-embedding-3-small` (1536 dimensions)
- **Endpoint:** `https://api.circle.com/v1/platformai/proxy/openai/v1/embeddings`
- **Auth:** `circle-token token-only` — called fresh before each request (tokens expire in 1hr)

### Skill interface

The skill is invoked with a JSON payload via stdin or argument. Three operations:

**Upsert**
```json
{
  "op": "upsert",
  "collection": "franklin",
  "id": "quest-001",
  "content": "Full text to embed",
  "metadata": {
    "type": "quest | feedback | knowledge | slack_thread | dev",
    "source": "file path or permalink",
    "date": "ISO 8601"
  }
}
```

**Query**
```json
{
  "op": "query",
  "collection": "franklin",
  "text": "search query",
  "k": 5,
  "filter": { "type": "quest" }
}
```
Returns top-K results with content, metadata, and similarity score.

**Delete**
```json
{
  "op": "delete",
  "collection": "franklin",
  "id": "quest-001"
}
```

### Multi-collection query

Franklin should be able to query across all collections in a single call:
```json
{
  "op": "query",
  "collection": "*",
  "text": "search query",
  "k": 5
}
```
Returns top-K across all collections, with `collection` field on each result.

### Implementation language

Python — Chroma's SDK is Python-first, better maintained than the JS client.

### Skill file structure

```
~/DevEnv/skills/vector-memory/
  SKILL.md          — interface docs
  memory.py         — core logic (upsert, query, delete)
  requirements.txt  — chromadb, openai
  backfill.py       — one-time script to embed existing Franklin state
```

## Implementation Plan

1. Create `~/DevEnv/skills/vector-memory/` directory structure
2. Write `memory.py` — Chroma client init, `circle-token` auth, upsert/query/delete operations
3. Write `SKILL.md` — interface docs, examples, collection conventions
4. Write `backfill.py` — walks `state/quests/`, `state/feedback.md`, `knowledge/` and upserts everything
5. Test: upsert a quest log, query with related text, verify recall
6. Wire into Franklin's run loop (per proposal-00002 integration points)
7. Add instructions to CLAUDE.md for CC sessions in repos to upsert dev summaries

## Decisions

### 1. Backfill
Auto-on-empty, synchronous. On first invocation, if the store doesn't exist, run backfill inline before proceeding. With the current corpus (3 quests, sparse knowledge base) this is instantaneous. Revisit async if corpus grows to thousands of documents.

### 2. Dev collection — when to upsert
Upsert at concrete task completion events, not at session end. Triggers:
- PR opened → upsert the PR description + what changed and why
- Bug resolved → upsert root cause + fix
- Architectural decision made → upsert the decision + rationale

Tying to artifacts (PR, commit, decision) is deterministic. Asking CC to judge "is this session significant?" is too vague.

### 3. Chunking — embed the insight, not the container
The unit of storage is a **discrete learning**, not a document. One chunk per insight, tagged with its source in metadata.

| Source | What to embed | Trigger |
|---|---|---|
| Quest logs | Individual `info_received` and `learnings` entries | On write |
| `state/feedback.md` | Each feedback entry | On write |
| Slack thread summaries | The distilled summary from the subagent | After Slack polling |
| Knowledge base | One chunk per `##` section | On file mtime change |
| Dev sessions | PR descriptions, bug root causes, decisions | On task completion |

The source file path or permalink goes in metadata on every chunk — always traceable back to origin.

## References

- [Proposal 00001 — Vector Memory for Franklin](./00001-vector-memory.md)
- [Circle AI Proxy Docs](https://circlepay.atlassian.net/wiki/spaces/AI/pages/1949401130)
- [Chroma docs](https://docs.trychroma.com)
