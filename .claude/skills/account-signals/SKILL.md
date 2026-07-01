---
name: account-signals
description: Score and rank target accounts by cybersecurity buying signals using the Intent Signals Playbook model
---

Run the account signal scoring pipeline. Takes a CSV of LinkedIn company URLs, gathers signals from LinkedIn enrichment, Exa.ai news research (breach, funding, CISO hires, M&A, cloud migration), HHS OCR breach data, and existing local job/feed scan data. Scores each account using the calibrated Intent Signals Playbook model (out of 50), detects high-value signal stacks, and ranks accounts by urgency tier.

Arguments provided: $ARGUMENTS

Run:
```bash
node Skills/account-signals.js $ARGUMENTS
```

If no arguments provided, show usage:
```
Usage: node Skills/account-signals.js <csv-file> [options]

CSV Format:
  URL-only (one per line):
    https://linkedin.com/company/acme-corp

  With metadata (auto-detects LinkedIn URL column):
    company_name,linkedin_url
    Acme Corp,https://linkedin.com/company/acme-corp

Options:
  --min-score <N>     Only include accounts scoring >= N (default: 15)
  --no-enrich         Skip Exa.ai research, use local data only (faster, free)
  --no-linkedin       Skip LinkedIn Apify enrichment
  --no-notify         Skip Slack/macOS notifications
  --dry-run           Show accounts without making API calls

Scoring tiers:
  CRITICAL (35-50): 24-48hr outreach
  HIGH     (28-34): 3-day / week 1 outreach
  MEDIUM   (22-27): Next batch
  LOW      (15-21): Monitor list

Examples:
  node Skills/account-signals.js target-accounts.csv
  node Skills/account-signals.js accounts.csv --min-score 28
  node Skills/account-signals.js urls.csv --no-enrich
```

After scoring completes:
1. Report the tier breakdown (CRITICAL / HIGH / MEDIUM / LOW counts)
2. List the top 5 accounts with their scores, detected signals, and why they're urgent
3. Highlight any high-value signal stacks detected (e.g. "New CISO + CyberArk JD = 47/50")
4. Tell the user where the full ranked report was saved (AccountSignals/<timestamp>/)
5. Note any accounts flagged for 24-48hr outreach
