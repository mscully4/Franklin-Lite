---
id: proposal-00016
title: Docker port isolation for parallel integration test workers
status: implemented
created: 2026-04-21
source: user
---

## Problem

Franklin runs integration tests across multiple repos in parallel. Many repos spin up their own Docker Compose stack (postgres, opensearch, auth, etc.) with overlapping host ports. For example, both `developer-dashboard-service` and `entitlement-service` publish postgres on `5432:5432`. Running two such workers simultaneously causes port binding conflicts and test failures.

## Solution

Assign each worker a unique loopback IP from a pool (`127.0.0.2`–`127.0.0.254`). Before starting Docker, generate a `docker-compose.override.yml` that rebinds all published host ports to that IP. Inject matching env var overrides so the app's config points to the worker's IP instead of `localhost`.

**Why loopback IPs over port remapping:**
- Container-internal ports stay unchanged — inter-service communication is unaffected
- App config env vars (e.g. `APP_CONFIG_OPTION_PG_URL`) only need the host substituted, not the port
- Cleaner to reason about; less risk of colliding with unrelated host services on high port numbers

### Mechanics

1. **IP allocation via SQLite** — the supervisor claims an IP atomically when inserting the `running_tasks` row (using a SQLite transaction to select the lowest unclaimed IP from the pool). The IP is stored in a new `assigned_ip TEXT` column on `running_tasks` and released automatically when `removeRunningTask` is called. No separate table or JSON file needed — it rides the existing task lifecycle.

2. **Override generator** — reads the repo's `docker-compose.yml`, extracts all `ports:` bindings, and writes a `docker-compose.override.yml` scoping each to the assigned IP:
   ```yaml
   services:
     postgres:
       ports:
         - "127.0.0.2:5432:5432"
   ```
   The override file is written to the repo directory and deleted on cleanup.

3. **Env var injection** — scans the repo's config files and `build-dev.sh` for `APP_CONFIG_OPTION_*` variables referencing `localhost:PORT`. Rewrites them with the worker's assigned IP before invoking Maven. For repos where auto-detection is insufficient, a per-repo manifest in `knowledge/docker_port_manifests/` lists the env vars to override.

4. **Cleanup** — on worker exit, stop containers (`docker compose down`), delete the override file, and call `removeRunningTask` (which releases the IP as a side effect).

### Example (entitlement-service)

Worker assigned `127.0.0.3`:
- Generates override binding postgres to `127.0.0.3:5432:5432`
- Sets `APP_CONFIG_OPTION_PG_URL=127.0.0.3:5432` before `mvn clean verify`
- Parallel worker on `127.0.0.2` is fully isolated

## Changes Required

| File | Change |
|------|--------|
| `src/db.ts` | Add `assigned_ip TEXT` column to `running_tasks`; add `claimDockerIp()` (atomic select + insert) and expose IP in `getRunningTasks()` |
| `src/docker_override.ts` | New module: parse docker-compose ports, generate override file, inject env vars |
| `modes/worker_wrapper.md` | Instruct worker to use the assigned IP from its task context, generate override, and clean up on exit for any quest that runs `docker compose` |
| `knowledge/repos/<repo-name>/docker.md` | Per-repo docker config: which env vars to override and any non-standard port mappings. Seed with `entitlement-service` and `developer-dashboard-service`. |

## Setup: macOS loopback aliases

On Linux, all `127.x.x.x` addresses are routable to loopback by default. On macOS only `127.0.0.1` is configured; the rest need explicit aliases. These are configured once via a `LaunchDaemon` that runs at boot:

```xml
<!-- /Library/LaunchDaemons/com.franklin.loopback.plist -->
<key>ProgramArguments</key>
<array>
  <string>/bin/bash</string>
  <string>-c</string>
  <string>for i in $(seq 2 254); do ifconfig lo0 alias 127.0.0.$i; done</string>
</array>
<key>RunAtLoad</key><true/>
```

Franklin ships `scripts/setup-loopback.sh` that writes this plist and loads it with `sudo launchctl`. One-time setup; survives reboots.

Add `scripts/setup-loopback.sh` to the changes table and document in `README.md`.

## Open Questions

- **Pool exhaustion:** Handled by a cleanup pass in the supervisor cycle — any `running_tasks` row with an `assigned_ip` whose PID is no longer alive gets removed, freeing the IP. Same pattern already used for stale task recovery.
- **Repos that don't use `APP_CONFIG_OPTION_*`:** Some repos may configure DB URLs differently. The `knowledge/repos/<repo>/docker.md` file handles this; Franklin adds entries as he encounters new repos.
