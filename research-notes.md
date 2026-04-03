# YAAS Research Notes
_Date: 2026-03-25_

## What is YAAS?

**YAAS (yourself-as-a-service)** is a no-code autonomous agent setup built by Guangmian Kung at Circle. It uses:
- **Claude Code `/loop`** — runs on a configurable cron cycle (e.g. 1-minute loop)
- **Slack MCP** — for reading and posting to Slack on your behalf
- **A single `CLAUDE.md` file** — the agent's brain; defines identity, quests system, polling behavior, and MCP connections

It is _not_ a Claude Code skill — it's a `CLAUDE.md` file that turns a folder into an autonomous agent workspace.

## Setup

1. Create an empty folder (e.g. `~/YAAS/`)
2. Download the `CLAUDE.md` template from [this Google Drive folder](https://drive.google.com/drive/folders/1qgoPrQVNa0YFRiyYHJdF35Kd3t2z_iZp) and save it as `claude.md` in the folder
3. Open Claude Code in that folder and ask it to `Setup`, then `Run`
4. Ensure Slack MCP is configured — see [this #ai-coding thread](https://circlefin.slack.com/archives/C087VN6JYRW/p1772420510455519?thread_ts=1771956540.385759&cid=C087VN6JYRW) for setup instructions

## Key Links

- **YAAS `CLAUDE.md` template** (Google Drive): https://drive.google.com/drive/folders/1qgoPrQVNa0YFRiyYHJdF35Kd3t2z_iZp
- **Slack MCP setup** (#ai-coding thread): https://circlefin.slack.com/archives/C087VN6JYRW/p1772420510455519?thread_ts=1771956540.385759&cid=C087VN6JYRW
- **Google Workspace skill** (Coda): https://coda.io/d/AI-Circle_dpvLIPv3Lgt/Template-Library_su11AevQ#_lujPUdkX
- **`/loop` announcement article**: https://the-decoder.com/anthropic-turns-claude-code-into-a-background-worker-with-local-scheduled-tasks/
- **#ai-auto-agents-workgroup**: https://circle.enterprise.slack.com/archives/C0AK7DYCNKA
- **#circle-moltbook** (where agents post): https://circle.enterprise.slack.com/archives/C0AL7HVCVS7

## Known Issues / Notes

- Agent stops running when laptop is closed (no cloud hosting yet)
- Idle loops mostly just do a Slack MCP read of tracked threads, then sleep — token costs unknown but Guangmian is minimizing context window size
- Running via `cron`/`launchd` instead of `/loop` causes Slack MCP permission issues
- The `CLAUDE.md` uses a **"quests" system** for open-ended tasks

## Extensions / Forks

### Jared Stigter's "Mini-Me"
Jared forked YAAS and added:
- Multiple pollers
- Skill vs workflow separation
- Preferences separation
- A visual dashboard ("Mini-Me dashboard")
- Google CLI, Jira, and GitHub integrations

Code not yet publicly shared — DM sent to Jared on 2026-03-25 requesting access.

### Related Tools
- **`claudemon`** — terminal dashboard to monitor all Claude Code sessions, with macOS notifications for permission approvals. Repo: https://github.com/frank-hsu_crcl/circle-personal/tree/claudemon
- **`agent-deck`** (open source) — similar to claudemon: https://github.com/asheshgoplani/agent-deck

## Community

- **#circle-moltbook** — Circle's internal "social media for AI agents." Several employees have agents running and posting autonomously, including Guangmian Kung, Terence Yeo, Josh Grazen, Jared Blanchard, Stephen Fennell, and Logan Reese.
- **#ai-auto-agents-workgroup** — broader effort coordinating autonomous agents (laptop, CI/CD, cloud-hosted). TechOps evaluating k8s sandboxing and AWS Lambda MicroVM for cloud hosting.
