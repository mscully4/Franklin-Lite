# AWS Costs Playbook

Run a weekly AWS cost report and post it to Discord.

## Phase 1 — Gather data

Query AWS Cost Explorer for current month-to-date costs grouped by service:

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -d "$(date +%Y-%m-01)" +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --group-by Type=DIMENSION,Key=SERVICE
```

Query the same period from last month for comparison:

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -d "$(date +%Y-%m-01) -1 month" +%Y-%m-%d),End=$(date -d "$(date +%Y-%m-%d) -1 month" +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --group-by Type=DIMENSION,Key=SERVICE
```

## Phase 2 — Analyze

- **Top 5 services** by cost, with percentage of total
- **Spike detection**: compare each service's cost vs same period last month. Flag any >50% increase over $0.50 as a spike.
- **One-time cost identification**: note large costs present in previous month but absent in current (often domain renewals, annual charges)
- **Projection**: compute daily run rate and project full-month cost

## Phase 3 — Report

Format results and send to the Discord channel from the task context.

Template:
```
**📊 AWS Cost Report — <Month> MTD (through <Date>)**

**Total: $X.XX** (direction from comparison period)

**Top 5 services:**
1. **Service** — $X.XX (XX%)
2. ...

**Spike alerts:** (if any — service name, old vs new cost, possible cause)

**Projected full month:** ~$X.XX

<One-time cost notes if applicable>
```

## Phase 4 — Store results

Write `state/worker_results/<task_id>.json` with status `ok` and a one-line summary.
Update `state/scheduled_tasks.json` last_run timestamp for the `aws-costs` task.
