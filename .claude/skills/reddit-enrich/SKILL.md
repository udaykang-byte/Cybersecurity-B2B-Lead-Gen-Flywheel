---
name: reddit-enrich
description: Enrich scored Reddit leads with profile history and Perplexity or Exa.ai research
---

Run the Reddit lead enrichment script. Reads a scored leads JSON file, extracts usernames from HOT/WARM leads, scrapes their full Reddit profile history via Apify, and optionally runs deep research via Exa.ai or Perplexity Sonar.

Arguments provided: $ARGUMENTS

Run:
```bash
node scripts/enrich-leads.js $ARGUMENTS
```

If no arguments provided, show usage and look for recent leads files:
```
Usage: node scripts/enrich-leads.js <leads-json-file> --topic <Name> [options]

Options:
  --topic <Name>        Topic directory (required)
  --tiers <HOT,WARM>    Comma-separated tier filter (default: HOT,WARM)
  --max-users <N>       Max users to enrich (default: 10)
  --max-items <N>       Max posts/comments per user profile (default: 100)
  --skip-scraped        Skip users with existing Profiles/ data
  --exa                 Use Exa.ai for prospect research (requires EXA_API_KEY)
                        Queries username + contextual keywords (tech stack, role, location)
                        from Reddit activity to find LinkedIn profiles and company news
  --exa-only            Skip Apify scraping, use cached profiles, run Exa research only
  --sherlock            Run Sherlock username search across 400+ platforms (pip install sherlock-project)
                        Finds GitHub, LinkedIn (username match), Twitter, HackerNews, Dev.to
                        If GitHub found, extracts real name/company to enhance Exa queries
                        Best used with --exa or --exa-only for full identity chain
  --research            Enable Perplexity deep research (requires PERPLEXITY_API_KEY)
  --research-only       Skip Apify scraping, use cached profiles, run research only
```

After enrichment completes:
1. Report how many profiles were scraped and enriched
2. Summarize key findings (company affiliations, expertise areas, pain points)
3. If --exa or --research was used, highlight the deep research insights and LinkedIn/contact finds
