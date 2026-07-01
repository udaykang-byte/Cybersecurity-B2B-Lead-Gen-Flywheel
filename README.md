# Reddit + LinkedIn Lead Finder

A cybersecurity B2B lead-generation pipeline that scrapes Reddit and LinkedIn for **IAM, PAM, DevSecOps, and GRC** buying signals. It uses AI scoring to surface real conversations where potential customers describe pain points we solve, then enriches and qualifies those leads through a 7-step pipeline ending in HOT lead notifications.

## Highlights

- **Zero runtime dependencies** — pure Node.js (ESM, Node ≥ 20), built only on standard-library modules.
- **AI lead scoring** — pre-filters noise, then scores each prospect 1–10 (HOT / WARM / COLD) with tailored outreach suggestions.
- **Multi-source intent signals** — Reddit conversations + LinkedIn jobs, people (new CISO hires), companies, and post feeds, scored against an Intent Signals Playbook.
- **Account qualification** — FITS framework (Firmographic, Intent, Technographic, Structural) scoring on top of the raw signals.
- **Supabase data layer** — optional cross-topic deduplication and a unified account view (falls back to local dedup files when not configured).
- **Slash-command skills** — every stage is also exposed as a Claude Code skill under `.claude/skills/`.
- **Enrichment** — profile scraping plus Perplexity / Exa research (and optional Sherlock) to attach real names, companies, and contact paths.

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

## Project Structure

```
scripts/                 Node pipeline (scraper, scorer, enrich, LinkedIn scanners, schedule, notify)
  lib/                   Shared helpers (supabase, discogen)
.claude/skills/          Claude Code slash-command wrappers for each stage
supabase/migrations/     Postgres schema (companies + signal tables, dedup constraints)
scrape-config.json       Topics, search URLs, and scheduled scans
GUIDE.md                 Full team guide (every command, flag, and workflow)
data/                    All generated output — gitignored, never committed
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
npm run schedule   # node scripts/schedule.js   (run all configured scrapes)
```

See **[GUIDE.md](./GUIDE.md)** for every script, flag, and the full step-by-step workflow.

## Data & Privacy

**All scraped data is stored under `data/` and is gitignored — no personal data is committed.** Secrets live in `.env` (also gitignored); `.env.example` documents the required keys with placeholders.

## License

Proprietary — see [LICENSE](./LICENSE). Published publicly for demonstration purposes only; no license to use is granted.
