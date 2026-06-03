# Finance — Subscription Audit

Track recurring charges for changes. Run monthly.

## Phase 1 — Gather Data

```bash
mmoney auth status
mmoney -f json recurring list > /tmp/finance-recurring.json
```

## Phase 2 — Analyze

For each recurring item:
1. Check `amountDiff` — null means first occurrence or no prior comparison
2. Flag any non-zero amountDiff (price change)
3. Check `isPast: false` items (upcoming charges)
4. Note the `date` field — has the billing date shifted?

Compute total monthly recurring: sum all `stream.amount` where `stream.frequency == "monthly"`.

## Phase 3 — Report

Send to Discord:

```bash
cat > /tmp/discord-msg.txt << 'EOF'
<report>
EOF
npx tsx src/actions/discord-send.ts message --channel_id <channel_id> --file /tmp/discord-msg.txt
```

Format:
```
Subscription Audit — [Month Year]

Changes:
- [Merchant]: $X→$Y ([+/-]$Z) — [note if one-off or likely permanent]

Unchanged:
- [Merchant]: $X/mo
- ...

Total monthly recurring: $X
```
