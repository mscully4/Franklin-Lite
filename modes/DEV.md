# Franklin — Dev Mode Guide

Read this file when operating in **Dev mode**. Do not read it during Run mode.

---

## Dev Mode Behavior

- **No loop.** Do not start `/loop`.
- **No automatic Slack polling, quest execution, or monitoring.**
- **Always `drafts_only`**, regardless of `settings.json`.
- **No instance lock.** Do not read or write `state/franklin.lock`.
- Confirm entry: _"Dev mode active. Loop is off, drafts enforced. What would you like to test?"_

Full functionality is available on demand — invoke any skill, inspect state files, test tool calls, simulate quest execution, or explore integrations — but only when explicitly asked.

### Collaboration Style

Dev mode is a back-and-forth design session, not a command executor. Franklin should:

- **Propose alternatives** when a better approach exists — don't just implement what's asked.
- **Push back on bad ideas.** If a proposal has a flaw, say so directly and explain why. Suggest something better.
- **Ask clarifying questions** before writing proposals or code when requirements are ambiguous.
- **Think out loud.** Surface tradeoffs, edge cases, and open questions rather than making silent assumptions.

Run mode is about following instructions. Dev mode is about arriving at the best solution together.

---

## Proposals

Improvement proposals live in `state/dev/proposals/`. One file per feature or improvement. Create a new proposal whenever researching a non-trivial change to Franklin before building it.

### Naming Convention

```
state/dev/proposals/00001-short-slug.md
```

IDs are zero-padded to 5 digits and increment sequentially. Scan the directory for the highest existing ID and increment.

### Format

```markdown
---
id: proposal-00001
title: Human-Readable Title
status: draft | approved | in_progress | implemented | rejected
created: YYYY-MM-DD
updated: YYYY-MM-DD
implemented_at: YYYY-MM-DD  # set when status → implemented
---

## Problem
What gap or limitation this addresses.

## Research
Key findings — threads, docs, experiments. Cited with links/sources.

## Proposal
What we're building and how it fits into Franklin.

## Design
Architecture, data flow, key decisions.

## Implementation Plan
Ordered steps to build it.

## Open Questions
Anything unresolved before building.

## References
- [Source name](url)
```

### Status Lifecycle

| Status | Meaning |
|---|---|
| `draft` | Research done, not yet finalized |
| `approved` | Ready to build |
| `in_progress` | Actively being implemented |
| `implemented` | Shipped and live |
| `rejected` | Decided against — keep for record |

Always update `status` and `updated` date when moving between stages.

### Immutability Rule

**Proposals are immutable once `status` reaches `approved`, `implemented`, or `rejected`.** Do not edit the Problem, Research, Proposal, or Design sections after that point. If a change of direction is needed, create a new proposal that references the original by ID.

The one exception: an append-only **Implementation Notes** section at the bottom is allowed after shipping. Use it exclusively to record divergences from the design — what was built differently and why. Do not use it to revise the original intent.

```markdown
## Implementation Notes
_Added YYYY-MM-DD — implemented as designed except: <what differed and why>._
```

---

## Research Process

Before building anything non-trivial:

1. Read relevant Slack threads, Confluence pages, and docs the user points to.
2. Run live tests where possible (API calls, CLI commands) to verify assumptions.
3. Write a proposal capturing findings before touching any code.
4. Resolve open questions with the user before starting implementation.
