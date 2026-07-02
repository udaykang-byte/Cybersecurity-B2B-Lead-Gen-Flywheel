---
name: account-signals
description: Score and rank target accounts by cybersecurity buying signals using the Intent Signals Playbook model
---

Run the account signal scoring pipeline. Takes a CSV of target companies (LinkedIn URLs and/or domains), fans out across per-account signal adapters — Parallel.ai / Exa.ai news research (breach, funding, CISO hires, M&A, cloud migration), HHS OCR and Maine AG breach registries, SEC EDGAR full-text search, ransomware.live, Greenhouse/Lever/Ashby job boards, LinkedIn company enrichment, and existing local job/feed scan data — then scores each account with decayed, confidence-weighted signals against the calibrated Intent Signals Playbook model, detects high-value signal stacks, discovers likely decision-makers, and ranks accounts by urgency tier. Scoring weights, competitor lists, and ICP definitions come from a per-client config in `clients/<name>.json`.

Arguments provided: $ARGUMENTS

Run:
```bash
node scripts/account-signals.js $ARGUMENTS
```

If no arguments provided, show usage:
```
Usage: node scripts/account-signals.js <csv-file> [options]

CSV Format:
  URL-only (one per line):
    https://linkedin.com/company/acme-corp

  With metadata (auto-detects LinkedIn URL column):
    company_name,linkedin_url
    Acme Corp,https://linkedin.com/company/acme-corp

Options:
  --client <name>      Client config from clients/<name>.json (default: default)
  --min-score <N>       Only include accounts scoring >= N (default: 15)
  --no-enrich           Skip news/registry/job-board adapters, use local data only (faster, free)
  --no-linkedin         Skip LinkedIn Apify company enrichment
  --no-people           Skip decision-maker discovery
  --no-notify           Skip Slack/macOS notifications
  --dry-run             Show the plan without making API calls

Scoring tiers:
  CRITICAL (35-50): 24-48hr outreach
  HIGH     (28-34): 3-day / week 1 outreach
  MEDIUM   (22-27): Next batch
  LOW      (15-21): Monitor list

Examples:
  node scripts/account-signals.js target-accounts.csv
  node scripts/account-signals.js accounts.csv --client acme --min-score 28
  node scripts/account-signals.js urls.csv --no-enrich
```

After scoring completes:
1. Report the tier breakdown (CRITICAL / HIGH / MEDIUM / LOW counts)
2. List the top 5 accounts with their scores, detected signals, and why they're urgent
3. Highlight any high-value signal stacks detected (e.g. "New CISO + CyberArk JD = 47/50")
4. Tell the user where the full ranked report was saved (`data/AccountSignals/<timestamp>/ranked-accounts.md`, with per-account briefs under `accounts/<slug>.md`)
5. Note any signal sources that were unavailable this run (shown per-account under "Sources unavailable this run") and any accounts flagged for 24-48hr outreach
