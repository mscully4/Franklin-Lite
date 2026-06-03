# Finance — Anomaly Detection

Check for unusual financial activity. Run weekly.

## Phase 1 — Gather Data

```bash
mmoney auth status
mmoney -f json transactions list --limit 100 > /tmp/finance-recent.json
mmoney -f json transactions list --start-date $(date -d '7 days ago' +%Y-%m-%d) --end-date $(date +%Y-%m-%d) --limit 100 > /tmp/finance-this-week.json
mmoney -f json transactions list --start-date $(date -d '37 days ago' +%Y-%m-%d) --end-date $(date -d '7 days ago' +%Y-%m-%d) --limit 100 > /tmp/finance-prior.json
mmoney -f json cashflow details > /tmp/finance-cashflow.json
```

## Phase 2 — Check Rules

Apply each rule with context awareness:

### Rule 1: New merchant, large charge
- Filter this-week transactions where amount < -500
- Check if merchant.name appears in prior.json
- Flag if merchant is new (no prior occurrences)

### Rule 2: Lone category spike
- For any transaction >$500 in absolute value this week
- Check if the same category has other transactions this week
- Flag if it's the only transaction in that category (isolated)

### Rule 3: Merchant amount outlier
- For each known merchant this week, compute the 3-month average from prior.json
- Flag if amount >2x the average

### Rule 4: Category overspend
- Compare this month's category spend vs prior month
- Flag if >30% increase month-over-month

### Rule 5: Income drop
- Compare sumIncome from cashflow vs prior month
- Flag if >20% drop

### Rule 6: Large uncategorized
- Find transactions >$500 with no category or generic category name

### Context awareness — do NOT flag:
- Hotel charges when flights/restaurants present same week (it's a trip)
- Large Amazon/Walmart/Target charges (normal retail variance)
- Known billers (utilities, mortgage, insurance, taxes)
- Payroll deposits (varying amounts are normal)

## Phase 3 — Report

If anomalies found, send to Discord:

```bash
cat > /tmp/discord-msg.txt << 'EOF'
<report>
EOF
npx tsx src/actions/discord-send.ts message --channel_id <channel_id> --file /tmp/discord-msg.txt
```

Format:
```
Anomaly Check — [Date]

• $X at [Merchant] — [why flagged, context]
• $Y at [Merchant] — [why flagged, context]

No other anomalies.
```

If no anomalies, do not message.
