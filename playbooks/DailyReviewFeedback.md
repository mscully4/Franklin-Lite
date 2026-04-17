# Daily Review — Feedback Handling

## When this applies

You are handling a `dm_reply` where `thread_context` contains a daily service health review, **or** you are running the `daily-health-review` scheduled task.

---

## Querying prior feedback (before publishing a review)

Before publishing the daily review, query vector memory for feedback from previous runs:

```bash
echo '{"op":"query","collection":"franklin","text":"daily review feedback service health","k":10}' | python3 ~/DevEnv/skills/vector-memory/memory.py
```

Incorporate any results with distance < 0.3 into how you format, filter, or prioritize the report.

---

## Storing feedback (from thread replies)

When someone replies in a daily-review thread with feedback, distill it into a one-sentence rule and upsert it:

```bash
echo '{"op":"upsert","collection":"franklin","id":"daily-review-feedback:<short-slug>","content":"<one sentence: the rule or preference>","metadata":{"type":"feedback","source":"daily-review","from":"<user who gave feedback>","date":"<ISO date>"}}' | python3 ~/DevEnv/skills/vector-memory/memory.py
```

### ID convention

Use a stable, descriptive slug so repeat feedback on the same topic **overwrites** rather than duplicates.

### Examples

| ID | Content |
|----|---------|
| `daily-review-feedback:ignore-isolated-latency` | Ignore isolated latency blips under 500ms — only flag sustained patterns |
| `daily-review-feedback:group-dlq-issues` | Group all DLQ issues under a single heading instead of per-service |
| `daily-review-feedback:skip-sepolia-latency` | ETH-Sepolia confirmation latency is always slow — don't flag unless over 30s |
