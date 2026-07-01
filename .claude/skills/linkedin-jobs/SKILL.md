---
name: linkedin-jobs
description: Scan LinkedIn job postings for cybersecurity hiring signals via Apify
---

Run the LinkedIn jobs signal scanner. Searches LinkedIn job postings for hiring signals — extracts competitor tools (Okta, CyberArk, SailPoint...), compliance frameworks (SOC 2, ISO 27001, HIPAA...), and pain language from job descriptions. Scores each signal using the Intent Signals Playbook (/50 system).

Arguments provided: $ARGUMENTS

Run:
```bash
node Skills/linkedin-jobs.js $ARGUMENTS
```

If no arguments provided, show usage and ask for LinkedIn search URLs:
```
Usage: node Skills/linkedin-jobs.js <url1> [url2] [options]

Options:
  --topic <Name>          Topic directory for output (default: "LinkedIn")
  --count <N>             Max results per search URL (default: 25)
  --since <duration>      Only include results from last N days (e.g., 7d, 30d)
  --score-threshold <N>   Only output signals scoring >= N (default: 0)
  --dry-run               Print URLs and actor info without calling Apify

The URLs should be LinkedIn job search result URLs with your desired filters applied.
```

After the scan completes:
1. Report: total signals found, score distribution by urgency (Critical/High/Medium/Low)
2. Highlight any signal stacks (multiple signals from same company = higher priority)
3. Open the markdown report for review
4. Suggest running `/linkedin-companies` on detected companies for deeper enrichment
