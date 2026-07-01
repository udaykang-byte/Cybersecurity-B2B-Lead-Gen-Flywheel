# Reddit LinkedIn Lead Finder

A cybersecurity B2B lead-generation pipeline that scrapes Reddit and LinkedIn for IAM, PAM, DevSecOps, and GRC buying signals. It uses AI scoring to surface real conversations where potential customers describe pain points we solve, then enriches and qualifies those leads through a 7-step pipeline ending in HOT lead notifications.

## The Pipeline

```
Reddit:    Step 1: Scrape  →  Step 2: Filter  →  Step 3: Score  →  Step 3b: Sync to Supabase
LinkedIn:  Step 6: Scan LinkedIn (Jobs / People / Companies / Feed)
                                    ↓
                           Supabase (all signals)
                                    ↓
                    Step 7: Account Signals + Discogen → Qualify Accounts
                                    ↓
           Step 4: Review  →  Step 5: Enrich  →  Notify HOT Leads
```

## Setup

1. Copy `.env.example` to `.env` and fill in your API keys (Apify token required; Supabase, Discogen, Perplexity, Exa optional).
2. If using Supabase, run `supabase/migrations/001_initial_schema.sql` in the Supabase SQL Editor to create the schema.

```bash
cp .env.example .env
# edit .env with your keys
```

## Running

```bash
npm run scrape     # node scripts/reddit-scraper.js
npm run schedule   # node scripts/schedule.js
```

## Data & Privacy

**All scraped data is stored under `data/` and is gitignored — no personal data is committed.**

## Full Documentation

See **[GUIDE.md](./GUIDE.md)** for the complete team guide: all setup steps, every script, scoring logic, Supabase integration, LinkedIn scanning, account enrichment, and scheduling.
