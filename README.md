# Reddit + LinkedIn Lead Finder

A cybersecurity B2B lead-generation pipeline that scrapes Reddit and LinkedIn for **IAM, PAM, DevSecOps, and GRC** buying signals. It uses AI scoring to surface real conversations where potential customers describe pain points we solve, then enriches and qualifies those leads through a 7-step pipeline ending in HOT lead notifications.

## Highlights

- **Zero runtime dependencies** — pure Node.js (ESM, Node ≥ 20), built only on standard-library modules.
- **AI lead scoring** — pre-filters noise, then scores each prospect 1–10 (HOT / WARM / COLD) with tailored outreach suggestions.
- **Multi-source intent signals** — Reddit conversations + LinkedIn jobs, people (new CISO hires), companies, and post feeds, scored against an Intent Signals Playbook.
- **Account qualification** — FITS framework (Firmographic, Intent, Technographic, Structural) scoring on top of the raw signals.
- **Supabase data layer** — optional cross-topic deduplication and a unified account view (falls back to local dedup files when not configured).
- **Slash-command skills** — every stage is also exposed as a Claude Code skill under `.claude/skills/`.
- **Enrichment** — profile scraping plus Parallel.ai / Exa news research + free registries (HHS OCR, SEC EDGAR, ransomware.live, Maine AG) + Greenhouse/Lever/Ashby job boards (and optional Sherlock) to attach real names, companies, and contact paths.
- **Per-client playbooks** — scoring weights, competitor lists, and ICP live in `clients/<name>.json`; decayed, confidence-weighted scoring.

## The Pipeline

```
Reddit:    Step 1: Scrape  →  Step 2: Filter  →  Step 3: Score  →  Step 3b: Sync to Supabase
LinkedIn:  Step 6: Scan LinkedIn (Jobs / People / Companies / Feed)
                                    ↓
                           Supabase (all signals)
                                    ↓
                    Step 7: Account Signals (Parallel.ai/Exa + registries) → Qualify Accounts
                                    ↓
           Step 4: Review  →  Step 5: Enrich  →  Notify HOT Leads
```

## Project Structure

```
scripts/                 Node pipeline (scraper, scorer, enrich, LinkedIn scanners, schedule, notify)
  lib/                   Shared helpers (supabase, client-config, scoring, signals/*)
.claude/skills/          Claude Code slash-command wrappers for each stage
supabase/migrations/     Postgres schema (companies + signal tables, dedup constraints)
scrape-config.json       Topics, search URLs, and scheduled scans
GUIDE.md                 Full team guide (every command, flag, and workflow)
data/                    All generated output — gitignored, never committed
```

## Setup

1. Copy `.env.example` to `.env` and fill in your API keys (Apify token required; Supabase, Parallel.ai, Perplexity, Exa optional).
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

MIT — see [LICENSE](./LICENSE). Free to clone, use, modify, and adapt for your own lead-gen workflows.
