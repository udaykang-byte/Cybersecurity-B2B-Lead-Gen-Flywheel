---
name: linkedin-companies
description: Enrich companies from a CSV of LinkedIn company URLs via Apify
---

Run the LinkedIn company enrichment scanner. Reads a CSV of target accounts with LinkedIn company URLs, scrapes each company page via Apify, and extracts employee count, growth signals, compliance certifications, and security hiring patterns. Merges scraped data with any metadata already in the CSV.

Arguments provided: $ARGUMENTS

Run:
```bash
node scripts/linkedin-companies.js $ARGUMENTS
```

If no arguments provided, show usage:
```
Usage: node scripts/linkedin-companies.js <csv-file> [options]

CSV Input:
  Accepts a CSV with a LinkedIn company URL column (auto-detected).
  - URL-only:  one URL per line
  - Full metadata:  company_name,linkedin_url,industry,employee_count,segment,...

Options:
  --topic <Name>          Topic directory for output (default: auto)
  --max-companies <N>     Cap how many companies to scrape (cost control, default: all)
  --skip-scraped          Skip companies already in LinkedIn/ output folder
  --dry-run               Print companies to scrape without calling Apify

Examples:
  node scripts/linkedin-companies.js target-accounts.csv --topic IdentityManagement
  node scripts/linkedin-companies.js accounts.csv --max-companies 10 --dry-run
```

After enrichment completes:
1. Report: companies enriched, segment distribution (A/B/C), signals found
2. Highlight companies with strongest signals (employee growth, compliance certs, security hires)
3. Open the markdown report for review
