# Finance — Categorization Fixes

Find miscategorized transactions and apply fixes. Run weekly.

## Phase 1 — Gather Data

```bash
mmoney auth status
mmoney -f json transactions list --start-date $(date -d '14 days ago' +%Y-%m-%d) --end-date $(date +%Y-%m-%d) --limit 100 > /tmp/finance-recent.json
mmoney -f json categories list > /tmp/finance-categories.json
```

## Phase 2 — Flag Suspicious Pairings

Look for:

1. **Merchant-category mismatch**
   - Gas station merchants (Shell, Exxon, Chevron, BP, 7-Eleven) not in "Auto & Transport" or "Gas"
   - Restaurant/fast-food merchants not in "Food & Dining"
   - Known subscription services not in appropriate category (Software, Entertainment, etc.)
   - Hardware stores (Home Depot, Lowe's) in "Food & Dining"

2. **Transfer miscategorization**
   - Venmo, Zelle, Cash App transactions in expense categories (should be "Transfer")

3. **Uncategorized**
   - Transactions with generic or empty category names

## Phase 3 — Present Batch

Send findings to Discord:

```bash
cat > /tmp/discord-msg.txt << 'EOF'
<report>
EOF
npx tsx src/actions/discord-send.ts message --channel_id <channel_id> --file /tmp/discord-msg.txt
```

Format:
```
Categorization Review — [Week]

1. [Merchant] | $X | "[current category]" → "[suggested category]"?
2. [Merchant] | $X | "[current category]" → "[suggested category]"?

Reply with numbers to fix ("fix 1 2") or "ignore all".
```

## Phase 4 — Apply Fixes

When user confirms (e.g., "fix 1 3"):

```bash
mmoney --allow-mutations transactions update <TXN_ID> --category-id <CORRECT_CATEGORY_ID>
```

Confirm each fix applied. Never auto-fix without user confirmation.
